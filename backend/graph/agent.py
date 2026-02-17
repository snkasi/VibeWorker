"""Agent Graph - LangChain Agent orchestration with LangGraph runtime."""
import logging
import re
import time
from typing import Optional, Callable, Annotated, TypedDict
from uuid import uuid4

from langchain_openai import ChatOpenAI
from langchain_core.messages import HumanMessage, AIMessage, SystemMessage
from langgraph.prebuilt import create_react_agent

from config import settings
from prompt_builder import build_system_prompt
from tools import get_all_tools

logger = logging.getLogger(__name__)

# SSE callback for security approval requests
_sse_approval_callback: Optional[Callable] = None


def set_sse_approval_callback(callback: Optional[Callable]) -> None:
    """Set the SSE callback used by SecurityGate for approval requests."""
    global _sse_approval_callback
    _sse_approval_callback = callback
    try:
        from security import security_gate
        security_gate.set_sse_callback(callback)
    except Exception:
        pass


def create_llm() -> ChatOpenAI:
    """Create and configure the LLM instance using model pool."""
    from model_pool import resolve_model
    cfg = resolve_model("llm")
    return ChatOpenAI(
        model=cfg["model"],
        api_key=cfg["api_key"],
        base_url=cfg["api_base"],
        temperature=settings.llm_temperature,
        max_tokens=settings.llm_max_tokens,
        streaming=True,
    )


def create_agent_graph():
    """
    Create the Agent using LangGraph's create_react_agent.

    This uses the modern LangGraph prebuilt agent which provides:
    - ReAct-style reasoning loop
    - Automatic tool calling
    - Streaming support
    """
    llm = create_llm()
    tools = get_all_tools()
    system_prompt = build_system_prompt()

    # Create agent using LangGraph prebuilt
    agent = create_react_agent(
        model=llm,
        tools=tools,
        prompt=system_prompt,
    )

    return agent


def _serialize_debug_messages(input_data) -> str:
    """Serialize LLM input messages for debug display."""
    messages = input_data.get("messages", [])
    if messages and isinstance(messages[0], list):
        messages = messages[0]
    parts = []
    for msg in messages:
        role = type(msg).__name__
        content = str(msg.content) if hasattr(msg, "content") else str(msg)
        parts.append(f"[{role}]\n{content}")
    return "\n---\n".join(parts)


async def run_agent(
    message: str,
    session_history: list[dict],
    stream: bool = True,
    debug: bool = False,
):
    """
    Run the agent with a user message.

    Args:
        message: User's input message.
        session_history: Previous conversation history.
        stream: Whether to stream the response.

    Yields:
        Event dicts with type and content for SSE streaming.
    """
    # If LLM cache is disabled, use original logic
    if not settings.enable_llm_cache:
        async for event in _run_agent_no_cache(message, session_history, stream, debug):
            yield event
        return

    # LLM cache is enabled - prepare cache key parameters
    system_prompt = build_system_prompt()

    # Convert session history to simplified format for cache key
    recent_history = []
    for msg in session_history[-3:]:  # Last 3 messages
        recent_history.append({
            "role": msg.get("role", ""),
            "content": msg.get("content", "")[:500],  # Truncate to 500 chars
        })

    cache_key_params = {
        "system_prompt": system_prompt,
        "recent_history": recent_history,
        "current_message": message,
        "model": settings.llm_model,
        "temperature": settings.llm_temperature,
    }

    # Use LLM cache with streaming
    from cache import llm_cache

    async def generator():
        async for event in _run_agent_no_cache(message, session_history, stream, debug):
            yield event

    async for event in llm_cache.get_or_generate(
        key_params=cache_key_params,
        generator_func=generator,
        stream=stream,
    ):
        yield event


async def _run_agent_no_cache(
    message: str,
    session_history: list[dict],
    stream: bool = True,
    debug: bool = False,
):
    """
    Run the agent without caching (internal implementation).

    Args:
        message: User's input message.
        session_history: Previous conversation history.
        stream: Whether to stream the response.

    Yields:
        Event dicts with type and content for SSE streaming.
    """
    agent = create_agent_graph()

    # Build messages from session history
    messages = []
    for msg in session_history:
        role = msg.get("role", "")
        content = msg.get("content", "")
        if role == "user":
            messages.append(HumanMessage(content=content))
        elif role == "assistant":
            messages.append(AIMessage(content=content))

    # Add current user message
    messages.append(HumanMessage(content=message))

    input_state = {"messages": messages}

    # Config with increased recursion limit (default is 25)
    config = {"recursion_limit": settings.agent_recursion_limit}

    if stream:
        is_task_mode = settings.agent_mode == "task"
        debug_tracking = {}  # run_id → tracking info

        async for event in agent.astream_events(input_state, version="v2", config=config):
            kind = event.get("event", "")
            metadata = event.get("metadata", {})

            if kind == "on_chat_model_stream":
                # Token-level streaming
                chunk = event.get("data", {}).get("chunk", None)
                if chunk and hasattr(chunk, "content") and chunk.content:
                    yield {
                        "type": "token",
                        "content": chunk.content,
                    }

            elif kind == "on_chat_model_start":
                run_id = event.get("run_id", "")
                node = metadata.get("langgraph_node", "")
                input_data = event.get("data", {}).get("input", {})
                input_messages = _serialize_debug_messages(input_data)
                debug_tracking[run_id] = {
                    "start_time": time.time(),
                    "node": node,
                    "input": input_messages,
                }
                # Send LLM start event for real-time debug display
                from model_pool import resolve_model
                model_name = resolve_model("llm").get("model", "unknown")
                yield {
                    "type": "llm_start",
                    "call_id": run_id[:12],
                    "node": node,
                    "model": model_name,
                    "input": input_messages[:5000],
                }

            elif kind == "on_chat_model_end":
                run_id = event.get("run_id", "")
                tracked = debug_tracking.pop(run_id, None)
                if tracked:
                    output_msg = event.get("data", {}).get("output", None)
                    duration_ms = int((time.time() - tracked["start_time"]) * 1000)

                    tokens = {}
                    if output_msg and hasattr(output_msg, "usage_metadata") and output_msg.usage_metadata:
                        um = output_msg.usage_metadata
                        tokens = {
                            "input_tokens": getattr(um, "input_tokens", None) or (um.get("input_tokens") if isinstance(um, dict) else None),
                            "output_tokens": getattr(um, "output_tokens", None) or (um.get("output_tokens") if isinstance(um, dict) else None),
                            "total_tokens": getattr(um, "total_tokens", None) or (um.get("total_tokens") if isinstance(um, dict) else None),
                        }

                    output_text = str(output_msg.content) if output_msg and hasattr(output_msg, "content") else ""

                    from model_pool import resolve_model
                    model_name = resolve_model("llm").get("model", "unknown")

                    yield {
                        "type": "llm_end",
                        "call_id": run_id[:12],
                        "node": tracked["node"],
                        "model": model_name,
                        "duration_ms": duration_ms,
                        "input_tokens": tokens.get("input_tokens"),
                        "output_tokens": tokens.get("output_tokens"),
                        "total_tokens": tokens.get("total_tokens"),
                        "input": tracked["input"][:5000],
                        "output": output_text[:3000],
                    }

            elif kind == "on_tool_start":
                # Tool call started
                if debug:
                    run_id = event.get("run_id", "")
                    debug_tracking[f"tool_{run_id}"] = {"start_time": time.time()}
                tool_name = event.get("name", "")
                tool_input = event.get("data", {}).get("input", {})
                yield {
                    "type": "tool_start",
                    "tool": tool_name,
                    "input": str(tool_input),
                }

            elif kind == "on_tool_end":
                # Tool call finished
                tool_name = event.get("name", "")
                tool_output = event.get("data", {}).get("output", "")

                # Extract actual content from tool output
                # LangGraph may wrap the output in an object with a 'content' attribute
                if hasattr(tool_output, 'content'):
                    output_str = str(tool_output.content)
                else:
                    output_str = str(tool_output)

                # Limit output size
                output_str = output_str[:2000]

                # Check for cache marker
                is_cached = output_str.startswith('[CACHE_HIT]')
                if is_cached:
                    logger.info(f"✓ Cache hit for tool: {tool_name}")

                duration_ms = None
                if debug:
                    run_id = event.get("run_id", "")
                    tracked = debug_tracking.pop(f"tool_{run_id}", None)
                    if tracked:
                        duration_ms = int((time.time() - tracked["start_time"]) * 1000)

                yield {
                    "type": "tool_end",
                    "tool": tool_name,
                    "output": output_str,
                    "cached": is_cached,  # Add cached flag
                    "duration_ms": duration_ms,
                }

        yield {"type": "done"}

    else:
        # Non-streaming mode
        result = await agent.ainvoke(input_state, config=config)
        final_messages = result.get("messages", [])
        if final_messages:
            last_msg = final_messages[-1]
            yield {
                "type": "message",
                "content": last_msg.content if hasattr(last_msg, "content") else str(last_msg),
            }
        yield {"type": "done"}
