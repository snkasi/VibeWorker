<p align="center">
  <img src="frontend/public/logo.png" alt="VibeWorker Logo" width="120" />
</p>

<h1 align="center">VibeWorker</h1>

<p align="center">
  <strong>A Local AI Worker that Remembers, Learns, and Evolves</strong>
</p>

<p align="center">
  <a href="https://github.com/user/vibeworker/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License" /></a>
  <a href="https://www.python.org/downloads/"><img src="https://img.shields.io/badge/python-3.10%2B-blue.svg" alt="Python" /></a>
  <a href="https://nextjs.org/"><img src="https://img.shields.io/badge/Next.js-14%2B-black.svg" alt="Next.js" /></a>
  <a href="https://modelcontextprotocol.io/"><img src="https://img.shields.io/badge/MCP-compatible-green.svg" alt="MCP" /></a>
</p>

<p align="center">
  <a href="./README_CN.md">中文文档</a> · <a href="#quick-start">Quick Start</a> · <a href="#architecture">Architecture</a> · <a href="#api-reference">API Reference</a>
</p>

---

VibeWorker is a lightweight, local-first AI Agent system built with Python. It features **file-based memory**, **plugin-style skills**, and **full transparency**. It remembers your preferences and history, continuously learns new capabilities through pluggable skills, and helps you tackle any task — from information retrieval and data processing to code execution and file management.

## Highlights

- **Unified Agent Engine** — Hybrid LangGraph StateGraph architecture with seamless ReAct ↔ Plan execution switching
- **File-first Memory** — All memories stored as human-readable JSON files on your local filesystem
- **4-Layer Memory System** — Working → Short-term → Long-term → Procedural, with smart consolidation, salience scoring, time decay, and implicit recall
- **Skills as Plugins** — Drop a `SKILL.md` folder and the agent learns new capabilities instantly
- **Skills Store** — Browse, search, and install 500+ community skills from [skills.sh](https://skills.sh/)
- **MCP Integration** — Connect to any MCP Server and dynamically inject tools into the agent
- **Two-tier Cache** — L1 in-memory + L2 disk cache, delivering 10–100x faster responses and significant API cost savings
- **Security Sandbox** — Security gate, tool approval, audit logging, rate limiting, and optional Docker isolation
- **Data Isolation** — User data lives in `~/.vibeworker/`, completely separate from source code
- **Full Transparency** — Every prompt assembly, tool call, and memory operation is fully observable

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | FastAPI (Python 3.10+) |
| Agent Engine | LangGraph StateGraph |
| LLM Interface | LangChain 1.x (OpenAI API compatible) |
| RAG | LlamaIndex (Hybrid Search) |
| MCP | MCP Python SDK (Anthropic official, `mcp>=1.0.0`) |
| Frontend | Next.js 14+ (App Router), TypeScript |
| UI Components | Shadcn/UI + Tailwind CSS v4 |
| Code Editor | Monaco Editor |
| Storage | Local filesystem (no MySQL/Redis) |

## Quick Start

### One-click Launch (Recommended)

```bash
# Linux / macOS / Git Bash
./start.sh              # Start frontend & backend
./start.sh stop         # Stop all
./start.sh restart      # Restart
./start.sh status       # Check status

# Windows CMD
start.bat               # Start frontend & backend
start.bat stop          # Stop all
start.bat restart       # Restart
start.bat status        # Check status
```

### Manual Setup

**Backend** (runs on `http://localhost:8088`)

```bash
cd backend
pip install -r requirements.txt
python app.py
```

**Frontend** (runs on `http://localhost:3000`)

```bash
cd frontend
npm install
npm run dev
```

## Architecture

### Agent Orchestration Engine

VibeWorker uses a unified LangGraph `StateGraph` engine. All user requests enter through a ReAct Agent, which can autonomously escalate to a Plan execution mode for complex tasks.

```
              ┌──────────────────────────────────────┐
              │                                      │
              ▼                                      │
        ┌──────────┐   "respond"    ┌─────┐          │
START → │  agent   │ ────────────→ │ END │          │
        └──────────┘               └─────┘          │
              │                                      │
              │ "plan_create"                         │
              ▼                                      │
        ┌──────────┐                                 │
        │plan_gate │                                 │
        └──────────┘                                 │
           │      │                                  │
  approval │      │ no approval                      │
           ▼      │                                  │
     ┌──────────┐ │                                  │
     │ approval │ │                                  │
     └──────────┘ │                                  │
       │     │    │                                  │
  approved  rejected                                 │
       │     │    │                                  │
       ▼     └────┘                                  │
     ┌──────────────┐                                │
     │   executor   │                                │
     └──────────────┘                                │
              │                                      │
              ▼                                      │
     ┌──────────────┐                                │
     │  replanner   │                                │
     └──────────────┘                                │
        │    │    │                                   │
 continue  revise  finish                            │
        │    │    │                                   │
        ▼    ▼    ▼                                  │
   [executor] ┌──────────┐                           │
              │summarizer│ ──────────────────────────┘
              └──────────┘
```

**Phase 1 — ReAct Agent (Unified Entry Point):** Handles all user requests with full access to 8 Core Tools + `plan_create` + MCP tools. Simple queries get direct answers; complex tasks trigger Phase 2 via `plan_create`.

**Phase 2 — Plan Execution Loop (Auto-triggered):**
1. **Approval Gate** (optional): When `plan_require_approval=true`, waits for user confirmation
2. **Executor**: Spawns an isolated ReAct sub-agent per step, preventing context bloat
3. **Replanner**: Evaluates after each step — `continue` / `revise` / `finish`
4. **Summarizer**: Compiles results and returns to the agent for final response

**Configuration-driven**: Control node behavior, parameters, and tool sets via `graph_config.yaml` — no code changes needed.

### Core Tools

| Tool | Function | Details |
|------|----------|---------|
| `terminal` | Shell command execution | Sandboxed with `root_dir` restriction + command blacklist |
| `python_repl` | Python code execution | Via `langchain_experimental` |
| `fetch_url` | Web content fetching | BeautifulSoup → clean Markdown output |
| `read_file` | File reading | Restricted to `root_dir` |
| `search_knowledge_base` | RAG knowledge retrieval | LlamaIndex Hybrid Search |
| `memory_write` | Memory writing | Long-term memory / daily logs, with salience scoring |
| `memory_search` | Memory search | Semantic + keyword search with time decay |
| `plan_create` | Create execution plan | Triggers Phase 2 plan execution mode |

## Memory System

VibeWorker features a 4-layer memory architecture inspired by [Mem0](https://mem0.ai/):

### Four Layers

| Layer | Description | Storage |
|-------|-------------|---------|
| **Working Memory** | Current conversation context | In-memory (messages) |
| **Short-Term Memory** | Daily logs, archived after 30 days | `memory/logs/YYYY-MM-DD.json` |
| **Long-Term Memory** | Persistent memories with smart consolidation | `memory/memory.json` |
| **Procedural Memory** | Tool usage experience learned from failures | `memory/memory.json` (procedural) |

### Key Features

- **Smart Consolidation**: LLM automatically decides ADD / UPDATE / DELETE / NOOP when new memories arrive, preventing duplicates
- **Salience Scoring**: 0.0–1.0 importance scores, high-salience memories get priority recall
- **Time Decay**: Exponential decay curve (λ=0.05, 50% at 14 days), recent memories weighted higher
- **Implicit Recall**: Auto-retrieves top-3 relevant memories + procedural knowledge at conversation start
- **Procedural Learning**: Automatically learns from tool failures, accumulating usage experience
- **Auto-archival**: 30-day summary archival, 60-day cleanup

### Memory Categories

| Category | Purpose | Examples |
|----------|---------|---------|
| `preferences` | User preferences | Prefers certain airlines, coding style |
| `facts` | Important facts | API endpoints, tech stack details |
| `tasks` | Task reminders | To-dos, scheduled reminders |
| `reflections` | Reflective summaries | Lessons learned |
| `procedural` | Procedural experience | Tool usage tips, environment quirks |
| `general` | General information | Miscellaneous |

## Skills System

VibeWorker skills follow an **instruction-following** paradigm — skills are teaching manuals that show the agent how to use core tools to accomplish tasks, not pre-written functions.

### Workflow

1. **Perceive**: Agent sees `available_skills` in System Prompt
2. **Decide**: Matches user request to the appropriate skill
3. **Learn**: Reads `SKILL.md` via `read_file()` to load instructions
4. **Execute**: Dynamically calls Core Tools (Terminal / Python / Fetch) to complete the task

### Skills Store

Integrated with the [skills.sh](https://skills.sh/) ecosystem, offering 500+ community skills:

- Browse and search skills by category
- One-click install to your local `skills/` directory
- Built-in translation support for skill documentation
- CLI tool support (`scripts/skills.sh` / `scripts/skills.bat`)

## MCP Integration

VibeWorker acts as an MCP Client, connecting to external MCP Servers and dynamically injecting tools into the agent.

- **Transport**: `stdio` (local process) | `sse` (remote HTTP)
- **Tool Wrapping**: Each MCP tool → LangChain `StructuredTool`, named `mcp_{server}_{tool}`
- **Independent Cache**: MCP tools have their own L1+L2 cache, hits prefixed with `[CACHE_HIT]`
- **Configuration**: Manage via `mcp_servers.json` or the frontend MCP panel

## Cache System

Two-tier caching architecture (L1 in-memory + L2 disk) for significant performance gains and API cost savings.

| Cache Type | Default | TTL | Purpose |
|-----------|---------|-----|---------|
| URL | Enabled | 1h | Web request results |
| LLM | Disabled | 24h | Agent responses |
| Prompt | Enabled | 10min | System Prompt assembly |
| Translation | Enabled | 7d | Translation API results |
| MCP Tools | Enabled | 1h | MCP tool call results |

### Performance Gains

| Operation | Without Cache | With Cache | Improvement |
|-----------|--------------|------------|-------------|
| Web requests | ~500–2000ms | ~10–50ms | **10–100x** |
| LLM calls | ~2000–5000ms | ~100–300ms | **10–20x** |
| Translation API | ~1000–2000ms | ~5–20ms | **50–200x** |

### Adding Cache to Custom Tools

```python
from cache import cached_tool

@cached_tool("my_tool", ttl=1800)  # Cache for 30 minutes
def my_tool(query: str) -> str:
    # Your tool logic
    return result
```

## Security

| Module | Function |
|--------|----------|
| `security/gate.py` | Security gate — blocks high-risk operations |
| `security/classifier.py` | Request risk level classification |
| `security/tool_wrapper.py` | Pre-execution security wrapper for tools |
| `security/audit.py` | Operation audit logging |
| `security/rate_limiter.py` | Rate limiting |
| `security/docker_sandbox.py` | Docker sandbox isolation |

The frontend shows an approval dialog before executing high-risk tools, with options to Allow, Deny, or Allow All for the current session.

## Frontend UI

IDE-style three-panel resizable layout:

```
┌──────────────────────────────────────────────────┐
│ TopBar: VibeWorker | Status | Settings | Inspector│
├────────────┬───────────────────────┬─────────────┤
│  Sidebar   │     Chat Stage       │  Inspector   │
│  (256px)   │    (flexible)        │  (384px)     │
│  Sessions  │  Messages + Tools    │  Monaco      │
│  Memory    │  Thinking + Markdown │  Editor      │
│  Skills    │  Plan Cards          │              │
│  MCP/Cache │  Code Highlighting   │              │
└────────────┴───────────────────────┴─────────────┘
```

- **Sidebar**: Session management / Memory panel (Memory + Diary + Persona) / Skills list / MCP management / Cache panel
- **Chat Stage**: Conversation flow + tool call visualization (Chinese labels + Emoji) + plan cards + cache indicators
- **Inspector**: Monaco Editor for live editing SKILL.md / config files, with one-click translation
- **Settings Dialog**: General / Model (pool + assignments) / Memory / Tasks / Cache / Security — 6 tabs

## Project Structure

```
vibeworker/
├── backend/                       # FastAPI backend (source code)
│   ├── app.py                     # App entry point (Port 8088)
│   ├── config.py                  # Pydantic Settings configuration
│   ├── model_pool.py              # Model pool management (CRUD + scenario assignment)
│   ├── prompt_builder.py          # Dynamic System Prompt assembly
│   ├── sessions_manager.py        # Session management
│   ├── session_context.py         # Session context (isolated temp directories)
│   ├── engine/                    # Agent orchestration engine (StateGraph)
│   │   ├── runner.py              # Top-level orchestrator (single entry point)
│   │   ├── graph_builder.py       # StateGraph construction & compilation
│   │   ├── stream_adapter.py      # SSE event stream adapter
│   │   └── nodes/                 # Graph nodes (agent/executor/replanner, etc.)
│   ├── memory/                    # Memory system v2
│   │   ├── manager.py             # Core manager (CRUD, stats)
│   │   ├── search.py              # Search (vector + keyword + decay)
│   │   ├── consolidator.py        # Smart consolidation
│   │   ├── session_reflector.py   # Session-level reflection
│   │   └── archiver.py            # Log archival
│   ├── tools/                     # 8 Core Tools
│   ├── cache/                     # L1+L2 cache system
│   ├── security/                  # Security sandbox module
│   ├── mcp_module/                # MCP Client integration
│   ├── pricing/                   # Cost calculation (OpenRouter)
│   ├── store/                     # Skills store module
│   └── user_default/              # First-run templates → ~/.vibeworker/
│
├── frontend/                      # Next.js 14+ frontend
│   └── src/
│       ├── app/                   # layout + page + globals.css
│       ├── components/
│       │   ├── chat/              # ChatPanel + PlanCard + ApprovalDialog
│       │   ├── sidebar/           # Sidebar + MemoryPanel + McpPanel + CachePanel
│       │   ├── editor/            # InspectorPanel (Monaco)
│       │   ├── settings/          # SettingsDialog (6 tabs)
│       │   ├── store/             # Skills store components
│       │   ├── debug/             # Debug panel
│       │   └── ui/                # Shadcn/UI base components
│       └── lib/
│           ├── api.ts             # API client
│           └── sessionStore.ts    # Session state management
│
├── ~/.vibeworker/                 # User data directory (isolated from source)
│   ├── .env                       # Global config
│   ├── model_pool.json            # Model pool config
│   ├── mcp_servers.json           # MCP server config
│   ├── sessions/                  # Session records
│   ├── memory/                    # Memory storage (memory.json + logs/)
│   ├── skills/                    # Installed skills
│   ├── workspace/                 # System Prompts
│   ├── tmp/                       # Session temp working directories
│   ├── knowledge/                 # RAG knowledge base
│   ├── storage/                   # Index persistence
│   └── .cache/                    # Cache storage
│
├── scripts/                       # CLI tools
├── start.sh / start.bat           # One-click launch scripts
└── README.md
```

## API Reference

### Core

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/chat` | POST | SSE streaming chat |
| `/api/sessions` | GET/POST/DELETE | Session management |
| `/api/files` | GET/POST | File read/write |
| `/api/files/tree` | GET | File tree structure |
| `/api/skills` | GET/DELETE | Skills management |
| `/api/settings` | GET/PUT | Global configuration |
| `/api/health` | GET | Health check |

### Model Pool

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/model-pool` | GET/POST | List models + add model |
| `/api/model-pool/{id}` | PUT/DELETE | Update / delete model |
| `/api/model-pool/assignments` | PUT | Scenario assignment (llm/embedding/translate) |
| `/api/model-pool/{id}/test` | POST | Test model connection |

### Memory

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/memory/entries` | GET/POST/DELETE | Memory entry CRUD |
| `/api/memory/search` | POST | Search memories (with time decay) |
| `/api/memory/consolidate` | POST | Smart consolidation (ADD/UPDATE/DELETE/NOOP) |
| `/api/memory/procedural` | GET | Procedural memories |
| `/api/memory/archive` | POST | Archive old logs |
| `/api/memory/daily-logs` | GET | Daily log list |
| `/api/memory/daily-logs/{date}` | GET/DELETE | Specific date log |
| `/api/memory/stats` | GET | Memory statistics |
| `/api/memory/reindex` | POST | Rebuild search index |
| `/api/memory/rolling-summary` | GET/PUT | Rolling summary |

### MCP

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/mcp/servers` | GET | List servers and status |
| `/api/mcp/servers/{name}` | POST/PUT/DELETE | Server CRUD |
| `/api/mcp/servers/{name}/connect` | POST | Connect to server |
| `/api/mcp/servers/{name}/disconnect` | POST | Disconnect from server |
| `/api/mcp/tools` | GET | List all MCP tools |

### Cache

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/cache/stats` | GET | Cache statistics |
| `/api/cache/clear` | POST | Clear cache (url/llm/prompt/translate/all) |
| `/api/cache/cleanup` | POST | Clean up expired cache |

### Skills Store

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/store/skills` | GET | Remote skills list |
| `/api/store/search` | GET | Search skills |
| `/api/store/skills/{name}` | GET | Skill details |
| `/api/store/install` | POST | Install a skill |
| `/api/store/categories` | GET | Category list |
| `/api/translate` | POST | Translate content |

## Environment Variables

Model configuration is managed by the model pool (`~/.vibeworker/model_pool.json`). The `.env` file only holds global parameters:

```env
# Global parameters
LLM_TEMPERATURE=0.7
LLM_MAX_TOKENS=4096

# Memory system v2
MEMORY_CONSOLIDATION_ENABLED=true     # Smart consolidation
MEMORY_REFLECTION_ENABLED=true        # Reflective memory
MEMORY_IMPLICIT_RECALL_ENABLED=true   # Implicit recall
MEMORY_ARCHIVE_DAYS=30                # Archive threshold (days)
MEMORY_DECAY_LAMBDA=0.05              # Decay coefficient

# Cache
ENABLE_URL_CACHE=true
ENABLE_LLM_CACHE=false
ENABLE_PROMPT_CACHE=true
ENABLE_TRANSLATE_CACHE=true
MCP_ENABLED=true
MCP_TOOL_CACHE_TTL=3600
```

## CLI Tools

```bash
# Linux / macOS
./scripts/skills.sh list              # List local skills
./scripts/skills.sh search <query>    # Search remote skills
./scripts/skills.sh install <name>    # Install a skill

# Windows
scripts\skills.bat list
scripts\skills.bat search <query>
scripts\skills.bat install <name>
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.
