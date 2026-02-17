"""VibeWorker Backend - FastAPI Application Entry Point

Run with: python app.py
Server starts at: http://localhost:8088
"""
import json
import logging
import asyncio
from pathlib import Path
from typing import Optional
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import uvicorn

from config import settings, PROJECT_ROOT, reload_settings
from sessions_manager import session_manager
from session_context import set_session_id
from graph.agent import run_agent, set_sse_approval_callback
from tools.plan_tool import set_plan_sse_callback, set_plan_event_loop
from tools.rag_tool import rebuild_index
from memory_manager import memory_manager

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("vibeworker")


# ============================================
# Lifespan Event Handler
# ============================================
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Lifespan event handler for startup and shutdown."""
    # Startup
    settings.ensure_dirs()
    logger.info("VibeWorker Backend started on port %d", settings.port)
    logger.info("Verifying code version: Hot-Reload Patch Applied")
    logger.info("Project root: %s", PROJECT_ROOT)
    logger.info("Data directory: %s", settings.get_data_path())

    # Initialize Security Gate
    try:
        from security import security_gate, docker_sandbox
        security_gate.configure(
            security_level=settings.security_level,
            approval_timeout=settings.security_approval_timeout,
            audit_enabled=settings.security_audit_enabled,
        )
        if settings.security_docker_enabled:
            docker_sandbox.configure(
                enabled=True,
                network=settings.security_docker_network,
            )
        logger.info(f"Security gate initialized: level={settings.security_level}")
    except Exception as e:
        logger.warning(f"Security module initialization failed (non-fatal): {e}")

    # Initialize MCP servers
    if settings.mcp_enabled:
        try:
            from mcp_module import mcp_manager
            await mcp_manager.initialize()
            logger.info("MCP module initialized")
        except Exception as e:
            logger.warning(f"MCP initialization failed (non-fatal): {e}")

    # Start cache cleanup task
    async def cleanup_loop():
        """Periodic cache cleanup every hour."""
        while True:
            await asyncio.sleep(3600)  # 1 hour
            try:
                logger.info("Running periodic cache cleanup...")
                from cache import url_cache, llm_cache, prompt_cache, translate_cache

                for cache in [url_cache, llm_cache, prompt_cache, translate_cache]:
                    cache.l1.cleanup_expired()
                    cache.l2.cleanup_expired()
                    cache.l2.cleanup_lru()

                logger.info("Periodic cache cleanup completed")

            except Exception as e:
                logger.error(f"Periodic cache cleanup failed: {e}")

    # Start cleanup task in background
    cleanup_task = asyncio.create_task(cleanup_loop())
    logger.info("Cache cleanup task started (runs every hour)")

    yield

    # Shutdown
    cleanup_task.cancel()
    logger.info("Cache cleanup task stopped")

    # Shutdown MCP servers
    if settings.mcp_enabled:
        try:
            from mcp_module import mcp_manager
            await mcp_manager.shutdown()
            logger.info("MCP module shut down")
        except Exception as e:
            logger.warning(f"MCP shutdown error: {e}")


# ============================================
# FastAPI Application
# ============================================
app = FastAPI(
    title="VibeWorker API",
    description="VibeWorker - Your Local AI Digital Worker with Real Memory",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS - Allow frontend (Next.js dev server)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://localhost:3001",
        "http://127.0.0.1:3000",
        "http://127.0.0.1:3001",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================
# Request/Response Models
# ============================================
class ChatRequest(BaseModel):
    message: str
    session_id: str = "main_session"
    stream: bool = True
    debug: bool = False


class FileWriteRequest(BaseModel):
    path: str
    content: str


class SessionCreateRequest(BaseModel):
    session_id: Optional[str] = None


# ============================================
# API Routes: Chat
# ============================================
@app.post("/api/chat")
async def chat(request: ChatRequest):
    """
    Send a user message and get Agent response.
    Supports SSE (Server-Sent Events) streaming.
    """
    if not request.message.strip():
        raise HTTPException(status_code=400, detail="Message cannot be empty")

    # Set session context for tools (tmp dir, etc.)
    set_session_id(request.session_id)

    # Ensure session exists
    session_manager.create_session(request.session_id)

    # Save user message
    session_manager.save_message(request.session_id, "user", request.message)

    # Get session history (exclude the message we just saved, it's already in the input)
    history = session_manager.get_session(request.session_id)[:-1]

    if request.stream:
        return StreamingResponse(
            _stream_agent_response(request.message, history, request.session_id, request.debug),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )
    else:
        # Non-streaming mode
        full_response = ""
        tool_calls_log = []
        async for event in run_agent(request.message, history, stream=False):
            if event["type"] == "message":
                full_response = event["content"]
            elif event["type"] == "tool_start":
                tool_calls_log.append({
                    "tool": event["tool"],
                    "input": event.get("input", ""),
                })
            elif event["type"] == "tool_end":
                is_cached = event.get("cached", False)
                for tc in tool_calls_log:
                    if tc["tool"] == event["tool"] and "output" not in tc:
                        tc["output"] = event.get("output", "")
                        if is_cached:
                            tc["cached"] = True
                        break

        # Save assistant response
        session_manager.save_message(
            request.session_id, "assistant", full_response,
            tool_calls=tool_calls_log if tool_calls_log else None,
        )

        return {
            "response": full_response,
            "session_id": request.session_id,
            "tool_calls": tool_calls_log,
        }


async def _stream_agent_response(message: str, history: list, session_id: str, debug: bool = False):
    """Generator for SSE streaming."""
    # Restore session context inside the async generator
    set_session_id(session_id)

    full_response = ""
    tool_calls_log = []
    debug_calls_log = []  # Collect debug events for persistence

    # Queue for approval requests from SecurityGate
    approval_queue: asyncio.Queue = asyncio.Queue()

    async def sse_approval_callback(event_data: dict):
        """Callback invoked by SecurityGate to send approval requests via SSE."""
        await approval_queue.put(event_data)

    # Queue for plan events from Plan tools
    plan_queue: asyncio.Queue = asyncio.Queue()

    async def sse_plan_callback(event_data: dict):
        """Callback invoked by plan tools to send plan events via SSE."""
        await plan_queue.put(event_data)

    # Register SSE callbacks
    set_sse_approval_callback(sse_approval_callback)
    set_plan_sse_callback(sse_plan_callback)
    set_plan_event_loop(asyncio.get_event_loop())

    try:
        # Wrap the agent stream to interleave approval events
        agent_gen = run_agent(message, history, stream=True, debug=debug)
        agent_task = asyncio.ensure_future(_next_event(agent_gen))

        while True:
            # Check for approval events in queue
            while not approval_queue.empty():
                try:
                    approval_event = approval_queue.get_nowait()
                    sse_data = json.dumps(approval_event, ensure_ascii=False)
                    yield f"data: {sse_data}\n\n"
                except asyncio.QueueEmpty:
                    break

            # Check for plan events in queue
            while not plan_queue.empty():
                try:
                    plan_event = plan_queue.get_nowait()
                    sse_data = json.dumps(plan_event, ensure_ascii=False)
                    yield f"data: {sse_data}\n\n"
                except asyncio.QueueEmpty:
                    break

            # Wait for next agent event or approval event
            if agent_task.done():
                try:
                    event = agent_task.result()
                except StopAsyncIteration:
                    break

                # Process the agent event (same as before)
                event_type = event.get("type", "")

                if event_type == "token":
                    content = event.get("content", "")
                    full_response += content
                    sse_data = json.dumps({"type": "token", "content": content}, ensure_ascii=False)
                    yield f"data: {sse_data}\n\n"

                elif event_type == "tool_start":
                    tool_calls_log.append({
                        "tool": event["tool"],
                        "input": event.get("input", ""),
                    })
                    sse_data = json.dumps({
                        "type": "tool_start",
                        "tool": event["tool"],
                        "input": event.get("input", ""),
                    }, ensure_ascii=False)
                    yield f"data: {sse_data}\n\n"

                elif event_type == "tool_end":
                    is_cached = event.get("cached", False)
                    for tc in tool_calls_log:
                        if tc["tool"] == event["tool"] and "output" not in tc:
                            tc["output"] = event.get("output", "")
                            if is_cached:
                                tc["cached"] = True
                            break
                    tool_end_data = {
                        "type": "tool_end",
                        "tool": event["tool"],
                        "output": event.get("output", "")[:1000],
                        "cached": is_cached,
                        "duration_ms": event.get("duration_ms"),
                    }
                    sse_data = json.dumps(tool_end_data, ensure_ascii=False)
                    yield f"data: {sse_data}\n\n"
                    if debug and event.get("duration_ms") is not None:
                        debug_calls_log.append(tool_end_data)

                elif event_type == "debug_llm_call":
                    sse_data = json.dumps(event, ensure_ascii=False)
                    yield f"data: {sse_data}\n\n"
                    debug_calls_log.append(event)

                elif event_type == "done":
                    # Save assistant response to session
                    if full_response:
                        session_manager.save_message(
                            session_id, "assistant", full_response,
                            tool_calls=tool_calls_log if tool_calls_log else None,
                        )

                    # Save debug calls if any
                    if debug_calls_log:
                        session_manager.save_debug_calls(session_id, debug_calls_log)

                    # Auto-extract memories if enabled
                    if settings.memory_auto_extract:
                        try:
                            recent_messages = session_manager.get_session(session_id)[-6:]
                            asyncio.create_task(memory_manager.auto_extract(recent_messages))
                        except Exception as e:
                            logger.warning(f"Auto-extract hook failed: {e}")

                    sse_data = json.dumps({"type": "done"}, ensure_ascii=False)
                    yield f"data: {sse_data}\n\n"
                    break

                # Start next event fetch
                agent_task = asyncio.ensure_future(_next_event(agent_gen))
            else:
                # Wait a bit before checking again
                await asyncio.sleep(0.01)
                # Also flush any pending approval events
                while not approval_queue.empty():
                    try:
                        approval_event = approval_queue.get_nowait()
                        sse_data = json.dumps(approval_event, ensure_ascii=False)
                        yield f"data: {sse_data}\n\n"
                    except asyncio.QueueEmpty:
                        break
                # Also flush any pending plan events
                while not plan_queue.empty():
                    try:
                        plan_event = plan_queue.get_nowait()
                        sse_data = json.dumps(plan_event, ensure_ascii=False)
                        yield f"data: {sse_data}\n\n"
                    except asyncio.QueueEmpty:
                        break

    except Exception as e:
        logger.error(f"Error in agent stream: {e}", exc_info=True)
        error_data = json.dumps({"type": "error", "content": str(e)}, ensure_ascii=False)
        yield f"data: {error_data}\n\n"
    finally:
        set_sse_approval_callback(None)
        set_plan_sse_callback(None)


async def _next_event(gen):
    """Helper to get next event from async generator."""
    return await gen.__anext__()


# ============================================
# API Routes: Security / Approval
# ============================================
class ApprovalRequest(BaseModel):
    request_id: str
    approved: bool


@app.post("/api/approve")
async def approve_tool(request: ApprovalRequest):
    """Approve or deny a pending tool execution request."""
    try:
        from security import security_gate
        resolved = security_gate.resolve_approval(request.request_id, request.approved)
        if resolved:
            return {"status": "ok", "request_id": request.request_id, "approved": request.approved}
        else:
            raise HTTPException(status_code=404, detail="Approval request not found or expired")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to process approval: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/security/status")
async def security_status():
    """Get current security configuration and status."""
    try:
        from security import security_gate, rate_limiter, docker_sandbox
        return {
            "security_level": security_gate.security_level.value,
            "pending_approvals": security_gate.get_pending_count(),
            "rate_limits": rate_limiter.get_stats(),
            "docker_available": docker_sandbox.available if settings.security_docker_enabled else None,
        }
    except Exception as e:
        return {
            "security_level": settings.security_level,
            "error": str(e),
        }


# ============================================
# API Routes: File Management
# ============================================
@app.get("/api/files")
async def read_file(path: str = Query(..., description="Relative file path")):
    """Read the content of a file. Resolves relative paths against data_dir first, then PROJECT_ROOT."""
    data_path = settings.get_data_path()
    # Try data_dir first, then PROJECT_ROOT
    file_path = (data_path / path).resolve()
    if not file_path.exists():
        file_path = (PROJECT_ROOT / path).resolve()

    # Security check: must be within data_dir or PROJECT_ROOT
    in_data = False
    in_project = False
    try:
        file_path.relative_to(data_path)
        in_data = True
    except ValueError:
        pass
    try:
        file_path.relative_to(PROJECT_ROOT)
        in_project = True
    except ValueError:
        pass
    if not in_data and not in_project:
        raise HTTPException(status_code=403, detail="Access denied: path outside allowed directories")

    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File not found")

    if not file_path.is_file():
        raise HTTPException(status_code=400, detail="Path is not a file")

    try:
        content = file_path.read_text(encoding="utf-8")
        return {"path": path, "content": content}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error reading file: {e}")


@app.post("/api/files")
async def write_file(request: FileWriteRequest):
    """Save content to a file within the data directory."""
    data_path = settings.get_data_path()
    file_path = (data_path / request.path).resolve()

    # Security check: only allow writes within data_dir
    try:
        file_path.relative_to(data_path)
    except ValueError:
        raise HTTPException(status_code=403, detail="Access denied: can only write to data directory")

    try:
        file_path.parent.mkdir(parents=True, exist_ok=True)
        file_path.write_text(request.content, encoding="utf-8")
        return {"status": "ok", "path": request.path}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error writing file: {e}")


@app.get("/api/files/tree")
async def file_tree(root: str = Query("", description="Root directory to list")):
    """Get file tree for the sidebar file explorer (defaults to data directory)."""
    data_path = settings.get_data_path()
    base = data_path / root if root else data_path
    base = base.resolve()

    # Allow data_dir or PROJECT_ROOT
    in_data = False
    in_project = False
    try:
        base.relative_to(data_path)
        in_data = True
    except ValueError:
        pass
    try:
        base.relative_to(PROJECT_ROOT)
        in_project = True
    except ValueError:
        pass
    if not in_data and not in_project:
        raise HTTPException(status_code=403, detail="Access denied")

    ref_base = data_path if in_data else PROJECT_ROOT

    if not base.exists():
        raise HTTPException(status_code=404, detail="Directory not found")

    def _build_tree(dir_path: Path, depth: int = 0, max_depth: int = 3) -> list:
        if depth > max_depth:
            return []
        items = []
        try:
            for entry in sorted(dir_path.iterdir()):
                # Skip hidden files and __pycache__
                if entry.name.startswith(".") or entry.name == "__pycache__":
                    continue
                rel = str(entry.relative_to(ref_base)).replace("\\", "/")
                if entry.is_dir():
                    children = _build_tree(entry, depth + 1, max_depth)
                    items.append({
                        "name": entry.name,
                        "path": rel,
                        "type": "directory",
                        "children": children,
                    })
                else:
                    items.append({
                        "name": entry.name,
                        "path": rel,
                        "type": "file",
                        "size": entry.stat().st_size,
                    })
        except PermissionError:
            pass
        return items

    return _build_tree(base)


# ============================================
# API Routes: Session Management
# ============================================
@app.get("/api/sessions")
async def list_sessions():
    """Get all historical session list."""
    sessions = session_manager.list_sessions()
    return {"sessions": sessions}


@app.get("/api/sessions/{session_id}")
async def get_session(session_id: str):
    """Get messages and debug calls for a specific session."""
    session_data = session_manager.get_session_data(session_id)
    return {
        "session_id": session_id,
        "messages": session_data.get("messages", []),
        "debug_calls": session_data.get("debug_calls", []),
    }


@app.post("/api/sessions")
async def create_session(request: SessionCreateRequest):
    """Create a new session."""
    session_id = session_manager.create_session(request.session_id)
    return {"session_id": session_id}


@app.delete("/api/sessions/{session_id}")
async def delete_session(session_id: str):
    """Delete a session."""
    success = session_manager.delete_session(session_id)
    if not success:
        raise HTTPException(status_code=404, detail="Session not found")
    return {"status": "ok"}


@app.post("/api/sessions/{session_id}/generate-title")
async def generate_session_title(session_id: str):
    """
    Generate a title for a session based on the first user message.
    Uses LLM to create a concise, descriptive title.
    """
    from graph.agent import create_llm

    messages = session_manager.get_session(session_id)
    if not messages:
        raise HTTPException(status_code=404, detail="Session not found or empty")

    # Get first user message
    first_user_msg = None
    for msg in messages:
        if msg.get("role") == "user":
            first_user_msg = msg.get("content", "")
            break

    if not first_user_msg:
        raise HTTPException(status_code=400, detail="No user message found")

    try:
        # Use LLM to generate a concise title
        llm = create_llm()
        prompt = f"""请为以下对话生成一个简短的标题（5-15个字）。
标题应该准确概括用户的问题或需求，使用中文。
只返回标题文字，不要有引号或其他符号。

用户消息：
{first_user_msg[:500]}

标题："""

        response = await llm.ainvoke(prompt)
        title = response.content.strip()

        # Limit title length
        if len(title) > 30:
            title = title[:30] + "..."

        # Save title to session
        session_manager.set_title(session_id, title)

        return {"session_id": session_id, "title": title}

    except Exception as e:
        logger.error(f"Error generating title: {e}")
        # Fallback: use first 15 chars of message
        fallback_title = first_user_msg[:15] + ("..." if len(first_user_msg) > 15 else "")
        session_manager.set_title(session_id, fallback_title)
        return {"session_id": session_id, "title": fallback_title}


# ============================================
# API Routes: Skills Management
# ============================================
@app.get("/api/skills")
async def list_skills():
    """List all available skills."""
    from prompt_builder import generate_skills_snapshot, _parse_skill_frontmatter

    skills = []
    if settings.skills_dir.exists():
        for skill_dir in sorted(settings.skills_dir.iterdir()):
            if not skill_dir.is_dir():
                continue
            skill_md = skill_dir / "SKILL.md"
            if not skill_md.exists():
                continue
            name, description = _parse_skill_frontmatter(skill_md)
            if not name:
                name = skill_dir.name
            try:
                rel_path = str(skill_md.relative_to(settings.get_data_path())).replace("\\", "/")
            except ValueError:
                rel_path = str(skill_md.relative_to(PROJECT_ROOT)).replace("\\", "/")
            skills.append({
                "name": name,
                "description": description,
                "location": rel_path,
            })

    return {"skills": skills}


@app.delete("/api/skills/{skill_name}")
async def delete_skill(skill_name: str):
    """Delete a skill by removing its folder."""
    import shutil

    # Sanitize skill name
    safe_name = "".join(c for c in skill_name if c.isalnum() or c in "_-")
    skill_dir = settings.skills_dir / safe_name

    if not skill_dir.exists():
        raise HTTPException(status_code=404, detail=f"Skill '{skill_name}' not found")

    # Security: ensure it's within skills directory
    try:
        skill_dir.resolve().relative_to(settings.skills_dir.resolve())
    except ValueError:
        raise HTTPException(status_code=403, detail="Access denied")

    try:
        shutil.rmtree(skill_dir)
        return {"status": "ok", "deleted": skill_name}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error deleting skill: {e}")


# ============================================
# API Routes: Skills Store
# ============================================
from store import SkillsStore
from store.models import InstallRequest, RemoteSkill

# Initialize skills store - integrates with skills.sh ecosystem
skills_store = SkillsStore(
    skills_dir=settings.skills_dir,
    cache_ttl=settings.store_cache_ttl,
)


@app.get("/api/store/skills")
async def list_store_skills(
    category: Optional[str] = Query(None, description="Filter by category"),
    page: int = Query(1, ge=1, description="Page number"),
    page_size: int = Query(20, ge=1, le=100, description="Items per page"),
):
    """List available skills from remote registry."""
    try:
        result = await skills_store.list_remote_skills(
            category=category,
            page=page,
            page_size=page_size,
        )
        return result.model_dump()
    except Exception as e:
        logger.error(f"Failed to list store skills: {e}")
        raise HTTPException(status_code=503, detail=f"Failed to fetch skills: {e}")


@app.get("/api/store/search")
async def search_store_skills(q: str = Query(..., min_length=1, description="Search query")):
    """Search skills by name, description, or tags."""
    try:
        results = await skills_store.search_skills(q)
        return {"query": q, "results": [r.model_dump() for r in results]}
    except Exception as e:
        logger.error(f"Failed to search skills: {e}")
        raise HTTPException(status_code=503, detail=f"Search failed: {e}")


@app.get("/api/store/skills/{skill_name}")
async def get_store_skill_detail(skill_name: str):
    """Get detailed information about a specific skill."""
    try:
        detail = await skills_store.get_skill_detail(skill_name)
        if detail is None:
            raise HTTPException(status_code=404, detail=f"Skill '{skill_name}' not found")
        return detail.model_dump()
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get skill detail: {e}")
        raise HTTPException(status_code=503, detail=f"Failed to fetch skill detail: {e}")


@app.post("/api/store/install")
async def install_store_skill(request: InstallRequest):
    """Install a skill from remote registry."""
    try:
        result = await skills_store.install_skill(
            name=request.skill_name,
            version=request.version,
        )
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        logger.error(f"Failed to install skill: {e}")
        raise HTTPException(status_code=500, detail=f"Installation failed: {e}")


@app.post("/api/skills/{skill_name}/update")
async def update_installed_skill(skill_name: str):
    """Update an installed skill to the latest version."""
    try:
        result = await skills_store.update_skill(skill_name)
        return result
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Failed to update skill: {e}")
        raise HTTPException(status_code=500, detail=f"Update failed: {e}")


@app.get("/api/store/categories")
async def get_store_categories():
    """Get available skill categories."""
    return {"categories": skills_store.get_categories()}


# ============================================
# API Routes: Memory Management
# ============================================
class MemoryEntryRequest(BaseModel):
    content: str
    category: str = "general"


class MemorySearchRequest(BaseModel):
    query: str
    top_k: int = 5


@app.get("/api/memory/entries")
async def list_memory_entries(
    category: Optional[str] = Query(None, description="Filter by category"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
):
    """List MEMORY.md entries with optional category filter and pagination."""
    try:
        entries = memory_manager.get_entries(category=category)
        total = len(entries)
        start = (page - 1) * page_size
        end = start + page_size
        return {
            "entries": entries[start:end],
            "total": total,
            "page": page,
            "page_size": page_size,
        }
    except Exception as e:
        logger.error(f"Failed to list memory entries: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/memory/entries")
async def add_memory_entry(request: MemoryEntryRequest):
    """Add a new memory entry to MEMORY.md."""
    if not request.content.strip():
        raise HTTPException(status_code=400, detail="Content cannot be empty")
    try:
        entry = memory_manager.add_entry(request.content, request.category)
        return {"status": "ok", "entry": entry}
    except Exception as e:
        logger.error(f"Failed to add memory entry: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/memory/entries/{entry_id}")
async def delete_memory_entry(entry_id: str):
    """Delete a single memory entry by ID."""
    success = memory_manager.delete_entry(entry_id)
    if not success:
        raise HTTPException(status_code=404, detail="Entry not found")
    return {"status": "ok", "deleted": entry_id}


@app.get("/api/memory/daily-logs")
async def list_daily_logs():
    """List all daily log files."""
    logs = memory_manager.list_daily_logs()
    return {"logs": logs}


@app.api_route("/api/memory/daily-logs/{date}", methods=["GET", "DELETE"])
async def daily_log_by_date(date: str, request: Request):
    """Get or delete a specific daily log."""
    if request.method == "DELETE":
        success = memory_manager.delete_daily_log(date)
        if not success:
            raise HTTPException(status_code=404, detail=f"No log found for {date}")
        return {"status": "ok", "deleted": date}
    else:
        content = memory_manager.read_daily_log(date)
        if not content:
            raise HTTPException(status_code=404, detail=f"No log found for {date}")
        return {"date": date, "content": content}


@app.post("/api/memory/search")
async def search_memory(request: MemorySearchRequest):
    """Search across all memory files."""
    if not request.query.strip():
        raise HTTPException(status_code=400, detail="Query cannot be empty")
    try:
        from tools.memory_search_tool import memory_search as ms_tool
        result = ms_tool.invoke({"query": request.query, "top_k": request.top_k})
        return {"query": request.query, "result": result}
    except Exception as e:
        logger.error(f"Memory search failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/memory/stats")
async def get_memory_stats():
    """Get memory statistics."""
    try:
        stats = memory_manager.get_stats()
        return stats
    except Exception as e:
        logger.error(f"Failed to get memory stats: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/memory/reindex")
async def reindex_memory():
    """Force rebuild the memory search index."""
    try:
        from tools.memory_search_tool import rebuild_memory_index
        result = rebuild_memory_index()
        return {"status": "ok", "message": result}
    except Exception as e:
        logger.error(f"Failed to reindex memory: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ============================================
# API Routes: Knowledge Base
# ============================================
@app.post("/api/knowledge/rebuild")
async def rebuild_knowledge_base():
    """Force rebuild the RAG knowledge base index."""
    result = rebuild_index()
    return {"status": result}


# ============================================
# Translation API
# ============================================
class TranslateRequest(BaseModel):
    content: str
    target_language: str = "zh-CN"


@app.post("/api/translate")
async def translate_content(request: TranslateRequest):
    """Translate skill description content to target language using LLM."""
    from langchain_openai import ChatOpenAI

    if not request.content.strip():
        raise HTTPException(status_code=400, detail="Content cannot be empty")

    # Check cache first
    try:
        from cache import translate_cache
        cached = translate_cache.get_translation(
            request.content, request.target_language
        )
        if cached is not None:
            logger.info(f"✓ Translation cache hit: {request.target_language}")
            return cached
    except Exception as e:
        logger.warning(f"Translation cache error (falling back to translate): {e}")

    try:
        # Use model pool to resolve translation model config
        from model_pool import resolve_model as _resolve
        _cfg = _resolve("translate")
        api_key = _cfg["api_key"]
        api_base = _cfg["api_base"]
        model = _cfg["model"]

        llm = ChatOpenAI(
            api_key=api_key,
            base_url=api_base,
            model=model,
            temperature=0.2,
        )

        # Precise translation prompt - only translate descriptions, keep code intact
        prompt = f"""你是一个专业的技术文档翻译专家。请将以下 SKILL.md 文件翻译成中文。

**严格遵守以下规则：**

1. **必须翻译的内容：**
   - YAML frontmatter 中的 `description` 字段值
   - 标题（# ## ### 等）
   - 段落描述文字
   - 列表项中的说明文字
   - 注释文字

2. **绝对不能翻译的内容：**
   - YAML frontmatter 中的 `name` 字段（保持英文）
   - 代码块（``` 包裹的内容）内的所有代码
   - 行内代码（`包裹的内容`）
   - URL 链接
   - 文件路径
   - 命令行指令
   - 变量名、函数名、API 名称
   - JSON/YAML 结构中的 key 名

3. **格式要求：**
   - 保持原有的 Markdown 格式结构不变
   - 保持代码块的语言标识（如 ```python）
   - 保持缩进和空行

原文：
{request.content}

请直接输出翻译后的完整内容，不要添加任何解释："""

        response = await llm.ainvoke(prompt)
        translated = response.content

        # Clean up potential markdown code block wrapper from LLM response
        if translated.startswith("```") and translated.endswith("```"):
            lines = translated.split("\n")
            if len(lines) > 2:
                translated = "\n".join(lines[1:-1])

        result = {
            "status": "ok",
            "translated": translated,
            "source_language": "auto",
            "target_language": request.target_language,
            "model": model,
        }

        # Cache the result
        try:
            from cache import translate_cache
            translate_cache.cache_translation(
                request.content, request.target_language, result
            )
            logger.debug(f"✓ Translation cached: {request.target_language}")
        except Exception as e:
            logger.warning(f"Failed to cache translation: {e}")

        return result
    except Exception as e:
        logger.error(f"Translation failed: {e}")
        raise HTTPException(status_code=500, detail=f"Translation failed: {e}")


# ============================================
# Health Check
# ============================================
@app.get("/api/health")
async def health_check():
    """Health check endpoint."""
    return {
        "status": "ok",
        "version": "0.1.0",
        "model": settings.llm_model,
    }


# ============================================
# Settings API
# ============================================
class SettingsUpdateRequest(BaseModel):
    openai_api_key: Optional[str] = None
    openai_api_base: Optional[str] = None
    llm_model: Optional[str] = None
    llm_temperature: Optional[float] = None
    llm_max_tokens: Optional[int] = None
    embedding_api_key: Optional[str] = None
    embedding_api_base: Optional[str] = None
    embedding_model: Optional[str] = None
    # Translation model (optional, falls back to main LLM if not set)
    translate_api_key: Optional[str] = None
    translate_api_base: Optional[str] = None
    translate_model: Optional[str] = None
    # Cache configuration
    enable_url_cache: Optional[bool] = None
    enable_llm_cache: Optional[bool] = None
    enable_prompt_cache: Optional[bool] = None
    enable_translate_cache: Optional[bool] = None
    url_cache_ttl: Optional[int] = None
    llm_cache_ttl: Optional[int] = None
    prompt_cache_ttl: Optional[int] = None
    translate_cache_ttl: Optional[int] = None
    cache_max_memory_items: Optional[int] = None
    cache_max_disk_size_mb: Optional[int] = None
    # Memory configuration
    memory_auto_extract: Optional[bool] = None
    memory_daily_log_days: Optional[int] = None
    memory_max_prompt_tokens: Optional[int] = None
    memory_index_enabled: Optional[bool] = None
    # MCP configuration
    mcp_enabled: Optional[bool] = None
    mcp_tool_cache_ttl: Optional[int] = None
    # Plan configuration
    plan_enabled: Optional[bool] = None
    # Security configuration
    security_enabled: Optional[bool] = None
    security_level: Optional[str] = None
    security_approval_timeout: Optional[float] = None
    security_audit_enabled: Optional[bool] = None
    security_ssrf_protection: Optional[bool] = None
    security_sensitive_file_protection: Optional[bool] = None
    security_python_sandbox: Optional[bool] = None
    security_rate_limit_enabled: Optional[bool] = None
    security_docker_enabled: Optional[bool] = None
    security_docker_network: Optional[str] = None
    # Data directory
    data_dir: Optional[str] = None


def _read_env_file() -> dict:
    """Read user .env file from data directory and parse into dict."""
    env_path = settings.get_env_path()
    logger.debug(f"Reading settings from: {env_path}")
    result = {}
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                key, _, value = line.partition("=")
                result[key.strip()] = value.strip()
    return result


def _write_env_file(env_dict: dict) -> None:
    """Write dict back to user .env file, preserving comments and structure."""
    env_path = settings.get_env_path()
    # Safety: refuse to write inside project directory
    try:
        env_path.relative_to(PROJECT_ROOT)
        logger.error(f"Refusing to write .env inside project directory: {env_path}")
        return
    except ValueError:
        pass  # Good: outside project root
    logger.info(f"Writing settings to: {env_path}")
    lines = []
    if env_path.exists():
        original_lines = env_path.read_text(encoding="utf-8").splitlines()
        updated_keys = set()
        for line in original_lines:
            stripped = line.strip()
            if stripped and not stripped.startswith("#") and "=" in stripped:
                key = stripped.split("=", 1)[0].strip()
                if key in env_dict:
                    lines.append(f"{key}={env_dict[key]}")
                    updated_keys.add(key)
                else:
                    lines.append(line)
            else:
                lines.append(line)
        # Add any new keys not already in file
        for key, value in env_dict.items():
            if key not in updated_keys:
                lines.append(f"{key}={value}")
    else:
        for key, value in env_dict.items():
            lines.append(f"{key}={value}")
    env_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


@app.get("/api/settings")
async def get_settings():
    """Get current model configuration from .env."""
    env = _read_env_file()
    return {
        "openai_api_key": env.get("OPENAI_API_KEY", ""),
        "openai_api_base": env.get("OPENAI_API_BASE", ""),
        "llm_model": env.get("LLM_MODEL", ""),
        "llm_temperature": float(env.get("LLM_TEMPERATURE", "0.7")),
        "llm_max_tokens": int(env.get("LLM_MAX_TOKENS", "4096")),
        "embedding_api_key": env.get("EMBEDDING_API_KEY", ""),
        "embedding_api_base": env.get("EMBEDDING_API_BASE", ""),
        "embedding_model": env.get("EMBEDDING_MODEL", ""),
        # Translation model config
        "translate_api_key": env.get("TRANSLATE_API_KEY", ""),
        "translate_api_base": env.get("TRANSLATE_API_BASE", ""),
        "translate_model": env.get("TRANSLATE_MODEL", ""),
        # Cache configuration
        "enable_url_cache": env.get("ENABLE_URL_CACHE", "true").lower() == "true",
        "enable_llm_cache": env.get("ENABLE_LLM_CACHE", "false").lower() == "true",
        "enable_prompt_cache": env.get("ENABLE_PROMPT_CACHE", "true").lower() == "true",
        "enable_translate_cache": env.get("ENABLE_TRANSLATE_CACHE", "true").lower() == "true",
        "url_cache_ttl": int(env.get("URL_CACHE_TTL", "3600")),
        "llm_cache_ttl": int(env.get("LLM_CACHE_TTL", "86400")),
        "prompt_cache_ttl": int(env.get("PROMPT_CACHE_TTL", "600")),
        "translate_cache_ttl": int(env.get("TRANSLATE_CACHE_TTL", "604800")),
        "cache_max_memory_items": int(env.get("CACHE_MAX_MEMORY_ITEMS", "100")),
        "cache_max_disk_size_mb": int(env.get("CACHE_MAX_DISK_SIZE_MB", "5120")),
        # Memory configuration
        "memory_auto_extract": env.get("MEMORY_AUTO_EXTRACT", "false").lower() == "true",
        "memory_daily_log_days": int(env.get("MEMORY_DAILY_LOG_DAYS", "2")),
        "memory_max_prompt_tokens": int(env.get("MEMORY_MAX_PROMPT_TOKENS", "4000")),
        "memory_index_enabled": env.get("MEMORY_INDEX_ENABLED", "true").lower() == "true",
        # MCP configuration
        "mcp_enabled": env.get("MCP_ENABLED", "true").lower() == "true",
        "mcp_tool_cache_ttl": int(env.get("MCP_TOOL_CACHE_TTL", "3600")),
        # Plan configuration
        "plan_enabled": env.get("PLAN_ENABLED", "true").lower() == "true",
        # Security configuration
        "security_enabled": env.get("SECURITY_ENABLED", "true").lower() == "true",
        "security_level": env.get("SECURITY_LEVEL", "standard"),
        "security_approval_timeout": float(env.get("SECURITY_APPROVAL_TIMEOUT", "60")),
        "security_audit_enabled": env.get("SECURITY_AUDIT_ENABLED", "true").lower() == "true",
        "security_ssrf_protection": env.get("SECURITY_SSRF_PROTECTION", "true").lower() == "true",
        "security_sensitive_file_protection": env.get("SECURITY_SENSITIVE_FILE_PROTECTION", "true").lower() == "true",
        "security_python_sandbox": env.get("SECURITY_PYTHON_SANDBOX", "true").lower() == "true",
        "security_rate_limit_enabled": env.get("SECURITY_RATE_LIMIT_ENABLED", "true").lower() == "true",
        "security_docker_enabled": env.get("SECURITY_DOCKER_ENABLED", "false").lower() == "true",
        "security_docker_network": env.get("SECURITY_DOCKER_NETWORK", "none"),
        # Data directory
        "data_dir": env.get("DATA_DIR", "~/.vibeworker/"),
    }


@app.put("/api/settings")
async def update_settings(request: SettingsUpdateRequest):
    """Update model configuration in .env file."""
    env = _read_env_file()
    update_map = {
        "OPENAI_API_KEY": request.openai_api_key,
        "OPENAI_API_BASE": request.openai_api_base,
        "LLM_MODEL": request.llm_model,
        "LLM_TEMPERATURE": str(request.llm_temperature) if request.llm_temperature is not None else None,
        "LLM_MAX_TOKENS": str(request.llm_max_tokens) if request.llm_max_tokens is not None else None,
        "EMBEDDING_API_KEY": request.embedding_api_key,
        "EMBEDDING_API_BASE": request.embedding_api_base,
        "EMBEDDING_MODEL": request.embedding_model,
        # Translation model
        "TRANSLATE_API_KEY": request.translate_api_key,
        "TRANSLATE_API_BASE": request.translate_api_base,
        "TRANSLATE_MODEL": request.translate_model,
        # Cache configuration
        "ENABLE_URL_CACHE": str(request.enable_url_cache).lower() if request.enable_url_cache is not None else None,
        "ENABLE_LLM_CACHE": str(request.enable_llm_cache).lower() if request.enable_llm_cache is not None else None,
        "ENABLE_PROMPT_CACHE": str(request.enable_prompt_cache).lower() if request.enable_prompt_cache is not None else None,
        "ENABLE_TRANSLATE_CACHE": str(request.enable_translate_cache).lower() if request.enable_translate_cache is not None else None,
        "URL_CACHE_TTL": str(request.url_cache_ttl) if request.url_cache_ttl is not None else None,
        "LLM_CACHE_TTL": str(request.llm_cache_ttl) if request.llm_cache_ttl is not None else None,
        "PROMPT_CACHE_TTL": str(request.prompt_cache_ttl) if request.prompt_cache_ttl is not None else None,
        "TRANSLATE_CACHE_TTL": str(request.translate_cache_ttl) if request.translate_cache_ttl is not None else None,
        "CACHE_MAX_MEMORY_ITEMS": str(request.cache_max_memory_items) if request.cache_max_memory_items is not None else None,
        "CACHE_MAX_DISK_SIZE_MB": str(request.cache_max_disk_size_mb) if request.cache_max_disk_size_mb is not None else None,
        # Memory configuration
        "MEMORY_AUTO_EXTRACT": str(request.memory_auto_extract).lower() if request.memory_auto_extract is not None else None,
        "MEMORY_DAILY_LOG_DAYS": str(request.memory_daily_log_days) if request.memory_daily_log_days is not None else None,
        "MEMORY_MAX_PROMPT_TOKENS": str(request.memory_max_prompt_tokens) if request.memory_max_prompt_tokens is not None else None,
        "MEMORY_INDEX_ENABLED": str(request.memory_index_enabled).lower() if request.memory_index_enabled is not None else None,
        # MCP configuration
        "MCP_ENABLED": str(request.mcp_enabled).lower() if request.mcp_enabled is not None else None,
        "MCP_TOOL_CACHE_TTL": str(request.mcp_tool_cache_ttl) if request.mcp_tool_cache_ttl is not None else None,
        # Plan configuration
        "PLAN_ENABLED": str(request.plan_enabled).lower() if request.plan_enabled is not None else None,
        # Security configuration
        "SECURITY_ENABLED": str(request.security_enabled).lower() if request.security_enabled is not None else None,
        "SECURITY_LEVEL": request.security_level if request.security_level is not None else None,
        "SECURITY_APPROVAL_TIMEOUT": str(request.security_approval_timeout) if request.security_approval_timeout is not None else None,
        "SECURITY_AUDIT_ENABLED": str(request.security_audit_enabled).lower() if request.security_audit_enabled is not None else None,
        "SECURITY_SSRF_PROTECTION": str(request.security_ssrf_protection).lower() if request.security_ssrf_protection is not None else None,
        "SECURITY_SENSITIVE_FILE_PROTECTION": str(request.security_sensitive_file_protection).lower() if request.security_sensitive_file_protection is not None else None,
        "SECURITY_PYTHON_SANDBOX": str(request.security_python_sandbox).lower() if request.security_python_sandbox is not None else None,
        "SECURITY_RATE_LIMIT_ENABLED": str(request.security_rate_limit_enabled).lower() if request.security_rate_limit_enabled is not None else None,
        "SECURITY_DOCKER_ENABLED": str(request.security_docker_enabled).lower() if request.security_docker_enabled is not None else None,
        "SECURITY_DOCKER_NETWORK": request.security_docker_network if request.security_docker_network is not None else None,
        # Data directory
        "DATA_DIR": request.data_dir if request.data_dir is not None else None,
    }
    for env_key, value in update_map.items():
        if value is not None:
            env[env_key] = value
    _write_env_file(env)
    reload_settings()
    # Clear prompt cache so new settings (e.g. model change) take effect immediately
    try:
        from cache import prompt_cache
        prompt_cache.clear()
    except Exception:
        pass
    logger.info("Settings reloaded after update (prompt cache cleared)")
    return {"status": "ok", "message": "Settings saved and applied."}


class TestModelRequest(BaseModel):
    api_key: Optional[str] = None
    api_base: Optional[str] = None
    model: Optional[str] = None
    model_type: str = "llm"  # "llm", "embedding", "translate"


@app.post("/api/settings/test")
async def test_model_connection(request: TestModelRequest):
    """Test model connectivity by sending a short prompt."""
    from langchain_openai import ChatOpenAI

    # Determine which config to use based on model_type
    if request.model_type == "embedding":
        api_key = request.api_key or settings.embedding_api_key or settings.llm_api_key
        api_base = request.api_base or settings.embedding_api_base or settings.llm_api_base
        model = request.model or settings.embedding_model or settings.llm_model
    elif request.model_type == "translate":
        api_key = request.api_key or settings.translate_api_key or settings.llm_api_key
        api_base = request.api_base or settings.translate_api_base or settings.llm_api_base
        model = request.model or settings.translate_model or settings.llm_model
    else:
        api_key = request.api_key or settings.llm_api_key
        api_base = request.api_base or settings.llm_api_base
        model = request.model or settings.llm_model

    if not api_key:
        raise HTTPException(status_code=400, detail="API Key is required")

    try:
        llm = ChatOpenAI(
            api_key=api_key,
            base_url=api_base,
            model=model,
            temperature=0,
            max_tokens=20,
            timeout=15,
        )
        response = await llm.ainvoke("简洁的回答我你是什么模型？")
        reply = response.content[:100] if response.content else ""
        return {"status": "ok", "reply": reply, "model": model}
    except Exception as e:
        import json
        error_msg = str(e)
        # Try to parse JSON error from LLM provider
        try:
            # Common pattern: "Error code: 404 - {'error': ...}"
            if " - {" in error_msg:
                json_part = error_msg.split(" - {", 1)[1]
                # Re-add the brace if split consumed it (it didn't, but let's be safe)
                if not json_part.startswith("{"):
                    json_part = "{" + json_part
                
                # Cleaning up potential trailing chars if any
                # But simple parsing:
                err_obj = json.loads(json_part.replace("'", '"')) # Simple heuristic
                if "error" in err_obj and "message" in err_obj["error"]:
                    error_msg = f"Provider Error: {err_obj['error']['message']}"
        except:
            pass
            
        # Truncate long error messages
        if len(error_msg) > 200:
            error_msg = error_msg[:200] + "..."
            
        # Return 200 with error status so frontend receives the JSON
        # This is better than raising 502 which might be masked as "Unknown error"
        return {"status": "error", "message": error_msg, "model": model}


# ============================================
# API Routes: MCP Management
# ============================================
class McpServerRequest(BaseModel):
    transport: str  # "stdio" or "sse"
    command: Optional[str] = None
    args: Optional[list[str]] = None
    env: Optional[dict[str, str]] = None
    url: Optional[str] = None
    headers: Optional[dict[str, str]] = None
    enabled: bool = True
    description: str = ""


@app.get("/api/mcp/servers")
async def list_mcp_servers():
    """List all MCP servers with their connection status."""
    try:
        from mcp_module import mcp_manager
        servers = mcp_manager.get_server_status()
        return {"servers": servers}
    except Exception as e:
        logger.error(f"Failed to list MCP servers: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/mcp/servers/{name}")
async def add_mcp_server(name: str, request: McpServerRequest):
    """Add a new MCP server configuration."""
    from mcp_module.config import get_server, set_server

    if get_server(name):
        raise HTTPException(status_code=409, detail=f"Server '{name}' already exists")

    config = request.model_dump(exclude_none=True)
    set_server(name, config)

    # Auto-connect if enabled
    if config.get("enabled", True) and settings.mcp_enabled:
        try:
            from mcp_module import mcp_manager
            await mcp_manager.connect_server(name)
        except Exception as e:
            logger.warning(f"Auto-connect failed for '{name}': {e}")

    return {"status": "ok", "name": name}


@app.put("/api/mcp/servers/{name}")
async def update_mcp_server(name: str, request: McpServerRequest):
    """Update an existing MCP server configuration."""
    from mcp_module.config import get_server, set_server
    from mcp_module import mcp_manager

    if not get_server(name):
        raise HTTPException(status_code=404, detail=f"Server '{name}' not found")

    # Disconnect first
    try:
        await mcp_manager.disconnect_server(name)
    except Exception:
        pass

    config = request.model_dump(exclude_none=True)
    set_server(name, config)

    # Reconnect if enabled
    if config.get("enabled", True) and settings.mcp_enabled:
        try:
            await mcp_manager.connect_server(name)
        except Exception as e:
            logger.warning(f"Reconnect failed for '{name}': {e}")

    return {"status": "ok", "name": name}


@app.delete("/api/mcp/servers/{name}")
async def delete_mcp_server(name: str):
    """Delete an MCP server."""
    from mcp_module.config import delete_server as cfg_delete
    from mcp_module import mcp_manager

    # Disconnect first
    try:
        await mcp_manager.disconnect_server(name)
    except Exception:
        pass

    if not cfg_delete(name):
        raise HTTPException(status_code=404, detail=f"Server '{name}' not found")

    return {"status": "ok", "deleted": name}


@app.post("/api/mcp/servers/{name}/connect")
async def connect_mcp_server(name: str):
    """Manually connect to an MCP server."""
    from mcp_module import mcp_manager

    try:
        await mcp_manager.connect_server(name)
        return {"status": "ok", "name": name}
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Connection failed: {e}")


@app.post("/api/mcp/servers/{name}/disconnect")
async def disconnect_mcp_server(name: str):
    """Manually disconnect an MCP server."""
    from mcp_module import mcp_manager

    try:
        await mcp_manager.disconnect_server(name)
        return {"status": "ok", "name": name}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Disconnect failed: {e}")


@app.get("/api/mcp/tools")
async def list_all_mcp_tools():
    """List all discovered MCP tools across all connected servers."""
    from mcp_module import mcp_manager

    all_tools = []
    status = mcp_manager.get_server_status()
    for srv_name, srv_info in status.items():
        if srv_info.get("status") == "connected":
            for tool in mcp_manager.get_server_tools(srv_name):
                all_tools.append({**tool, "server": srv_name})
    return {"tools": all_tools}


@app.get("/api/mcp/servers/{name}/tools")
async def list_server_mcp_tools(name: str):
    """List tools for a specific MCP server."""
    from mcp_module import mcp_manager

    tools = mcp_manager.get_server_tools(name)
    return {"server": name, "tools": tools}


# ============================================
# API Routes: Model Pool
# ============================================
class ModelPoolAddRequest(BaseModel):
    name: str
    api_key: str
    api_base: str
    model: str


class ModelPoolUpdateRequest(BaseModel):
    name: Optional[str] = None
    api_key: Optional[str] = None
    api_base: Optional[str] = None
    model: Optional[str] = None


class AssignmentsUpdateRequest(BaseModel):
    llm: Optional[str] = None
    embedding: Optional[str] = None
    translate: Optional[str] = None


@app.get("/api/model-pool")
async def get_model_pool():
    """Get all models and current scenario assignments."""
    from model_pool import list_models, get_assignments
    return {
        "models": list_models(),
        "assignments": get_assignments(),
    }


@app.post("/api/model-pool")
async def add_pool_model(request: ModelPoolAddRequest):
    """Add a new model to the pool."""
    from model_pool import add_model
    try:
        model = add_model(
            name=request.name,
            api_key=request.api_key,
            api_base=request.api_base,
            model=request.model,
        )
        return {"status": "ok", "model": {**model, "api_key": "***"}}
    except Exception as e:
        logger.error(f"Failed to add model: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.put("/api/model-pool/assignments")
async def update_model_assignments(request: AssignmentsUpdateRequest):
    """Update scenario-to-model assignments."""
    from model_pool import update_assignments, invalidate_cache
    try:
        assignments = {}
        if request.llm is not None:
            assignments["llm"] = request.llm
        if request.embedding is not None:
            assignments["embedding"] = request.embedding
        if request.translate is not None:
            assignments["translate"] = request.translate

        update_assignments(assignments)

        # Clear prompt cache so new model takes effect
        try:
            from cache import prompt_cache
            prompt_cache.clear()
        except Exception:
            pass

        logger.info(f"Model assignments updated: {assignments}")
        return {"status": "ok", "assignments": assignments}
    except (ValueError, KeyError) as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.error(f"Failed to update assignments: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/model-pool/{model_id}/test")
async def test_pool_model(model_id: str):
    """Test a model from the pool by sending a short prompt."""
    from langchain_openai import ChatOpenAI
    from model_pool import get_model

    model_config = get_model(model_id)
    if not model_config:
        raise HTTPException(status_code=404, detail=f"Model '{model_id}' not found")

    api_key = model_config.get("api_key", "")
    api_base = model_config.get("api_base", "")
    model_name = model_config.get("model", "")

    if not api_key:
        raise HTTPException(status_code=400, detail="Model has no API key configured")

    try:
        llm = ChatOpenAI(
            api_key=api_key,
            base_url=api_base,
            model=model_name,
            temperature=0,
            max_tokens=20,
            timeout=15,
        )
        response = await llm.ainvoke("简洁的回答我你是什么模型？")
        reply = response.content[:100] if response.content else "连接成功（模型无文本回复）"
        return {"status": "ok", "reply": reply, "model": model_name}
    except Exception as e:
        error_msg = str(e)
        if len(error_msg) > 200:
            error_msg = error_msg[:200] + "..."
        return {"status": "error", "message": error_msg, "model": model_name}


@app.put("/api/model-pool/{model_id}")
async def update_pool_model(model_id: str, request: ModelPoolUpdateRequest):
    """Update an existing model configuration."""
    from model_pool import update_model
    try:
        updated = update_model(
            model_id,
            name=request.name,
            api_key=request.api_key,
            api_base=request.api_base,
            model=request.model,
        )
        return {"status": "ok", "model": {**updated, "api_key": "***"}}
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.error(f"Failed to update model: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/model-pool/{model_id}")
async def delete_pool_model(model_id: str):
    """Delete a model from the pool."""
    from model_pool import delete_model
    try:
        delete_model(model_id)
        return {"status": "ok", "deleted": model_id}
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.error(f"Failed to delete model: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ============================================
# Cache Management
# ============================================
def _get_core_cache_map() -> dict:
    """Get the 4 core cache instances."""
    from cache import url_cache, llm_cache, prompt_cache, translate_cache
    return {
        "url": url_cache,
        "llm": llm_cache,
        "prompt": prompt_cache,
        "translate": translate_cache,
    }


def _discover_tool_cache_types() -> list[str]:
    """Discover tool_* cache directories in .cache/."""
    cache_dir = settings.cache_dir
    if not cache_dir.exists():
        return []
    return [
        d.name for d in sorted(cache_dir.iterdir())
        if d.is_dir() and d.name.startswith("tool_")
    ]


def _get_tool_disk_cache(tool_type: str):
    """Create a DiskCache instance for a tool_* cache directory."""
    from cache.disk_cache import DiskCache
    # tool_* directories are stored directly under cache_dir with their full name
    # DiskCache expects cache_dir/cache_type, so we pass cache_dir and the type name
    return DiskCache(
        cache_dir=settings.cache_dir,
        cache_type=tool_type,
        default_ttl=3600,
        max_size_mb=settings.cache_max_disk_size_mb,
    )


@app.get("/api/cache/stats")
async def get_cache_stats():
    """Get cache statistics for all cache types including tool caches."""
    try:
        core_map = _get_core_cache_map()
        stats = {}
        for name, cache in core_map.items():
            stats[name] = cache.get_stats()

        # Discover and include tool_* caches
        for tool_type in _discover_tool_cache_types():
            dc = _get_tool_disk_cache(tool_type)
            stats[tool_type] = {
                "enabled": True,
                "ttl": dc.default_ttl,
                "l1": {"hits": 0, "misses": 0, "hit_rate": 0, "size": 0, "max_size": 0},
                "l2": dc.get_stats(),
            }

        return {
            "status": "ok",
            "cache_stats": stats,
        }
    except Exception as e:
        logger.error(f"Failed to get cache stats: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/cache/clear")
async def clear_cache(cache_type: str = Query(default="all")):
    """
    Clear cache by type.

    Args:
        cache_type: Cache type to clear (url, llm, prompt, translate, tool_*, all)
    """
    try:
        core_map = _get_core_cache_map()
        cleared = {}

        if cache_type == "all":
            # Clear all core caches
            for name, cache in core_map.items():
                result = cache.clear()
                cleared[name] = result
                logger.info(f"Cleared {name} cache: {result}")
            # Clear all tool_* caches
            for tool_type in _discover_tool_cache_types():
                dc = _get_tool_disk_cache(tool_type)
                count = dc.clear()
                cleared[tool_type] = {"l2_cleared": count}
                logger.info(f"Cleared {tool_type} cache: {count}")
        elif cache_type in core_map:
            result = core_map[cache_type].clear()
            cleared[cache_type] = result
            logger.info(f"Cleared {cache_type} cache: {result}")
        elif cache_type.startswith("tool_"):
            dc = _get_tool_disk_cache(cache_type)
            count = dc.clear()
            cleared[cache_type] = {"l2_cleared": count}
            logger.info(f"Cleared {cache_type} cache: {count}")
        else:
            raise HTTPException(status_code=400, detail=f"Invalid cache type: {cache_type}")

        return {
            "status": "ok",
            "cache_type": cache_type,
            "cleared": cleared,
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to clear cache: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/cache/entries")
async def list_cache_entries(
    cache_type: str = Query(...),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
):
    """List cache entries for a specific cache type with pagination."""
    try:
        core_map = _get_core_cache_map()

        if cache_type in core_map:
            disk_cache = core_map[cache_type].l2
        elif cache_type.startswith("tool_"):
            disk_cache = _get_tool_disk_cache(cache_type)
        else:
            raise HTTPException(status_code=400, detail=f"Invalid cache type: {cache_type}")

        result = disk_cache.list_entries(page=page, page_size=page_size)

        return {
            "status": "ok",
            "cache_type": cache_type,
            **result,
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to list cache entries: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/cache/entries/{cache_type}/{key}")
async def delete_cache_entry(cache_type: str, key: str):
    """Delete a single cache entry by type and key."""
    try:
        core_map = _get_core_cache_map()

        l1_deleted = False
        l2_deleted = False

        if cache_type in core_map:
            cache = core_map[cache_type]
            l1_deleted = cache.l1.delete(key)
            l2_deleted = cache.l2.delete(key)
        elif cache_type.startswith("tool_"):
            dc = _get_tool_disk_cache(cache_type)
            l2_deleted = dc.delete(key)
        else:
            raise HTTPException(status_code=400, detail=f"Invalid cache type: {cache_type}")

        if not l1_deleted and not l2_deleted:
            raise HTTPException(status_code=404, detail="Cache entry not found")

        return {
            "status": "ok",
            "cache_type": cache_type,
            "key": key,
            "l1_deleted": l1_deleted,
            "l2_deleted": l2_deleted,
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to delete cache entry: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/cache/cleanup")
async def cleanup_cache():
    """Cleanup expired cache entries and perform LRU eviction if needed."""
    try:
        core_map = _get_core_cache_map()
        cleanup_results = {}

        # Cleanup L1 (memory) for core caches
        for name, cache in core_map.items():
            expired_count = cache.l1.cleanup_expired()
            cleanup_results[f"{name}_l1_expired"] = expired_count

        # Cleanup L2 (disk) - expired + LRU for core caches
        for name, cache in core_map.items():
            expired_count = cache.l2.cleanup_expired()
            lru_count = cache.l2.cleanup_lru()
            cleanup_results[f"{name}_l2_expired"] = expired_count
            cleanup_results[f"{name}_l2_lru"] = lru_count

        # Cleanup tool_* caches (disk only)
        for tool_type in _discover_tool_cache_types():
            dc = _get_tool_disk_cache(tool_type)
            expired_count = dc.cleanup_expired()
            lru_count = dc.cleanup_lru()
            cleanup_results[f"{tool_type}_l2_expired"] = expired_count
            cleanup_results[f"{tool_type}_l2_lru"] = lru_count

        logger.info(f"Cache cleanup completed: {cleanup_results}")

        return {
            "status": "ok",
            "cleanup_results": cleanup_results,
        }

    except Exception as e:
        logger.error(f"Failed to cleanup cache: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ============================================
# Entry Point
# ============================================
if __name__ == "__main__":
    uvicorn.run(
        "app:app",
        host=settings.host,
        port=settings.port,
        reload=True,
        log_level="info",
    )
