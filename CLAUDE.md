# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## 项目简介

**VibeWorker** — 基于 Python 的轻量级本地 AI Agent 系统。文件即记忆、技能即插件、透明可控。

## 技术栈

| 组件 | 技术 |
|------|------|
| 后端 | FastAPI (Python 3.10+) |
| Agent 编排 | LangChain 1.x + LangGraph |
| RAG | LlamaIndex (Hybrid Search) |
| 前端 | Next.js 14+ (App Router), Shadcn/UI, Tailwind CSS v4, Monaco Editor |
| MCP | MCP Python SDK (Anthropic 官方, `mcp>=1.0.0`) |
| 存储 | 本地文件系统（无 MySQL/Redis） |

## 开发命令

```bash
# 后端 (http://localhost:8088)
cd backend && pip install -r requirements.txt && python app.py

# 前端 (http://localhost:3000)
cd frontend && npm install && npm run dev

# 构建检查
cd frontend && npm run build
```

---

## 后端架构
注意： 所有代码注释使用中文

### 1. Agent 编排引擎（混合架构）

**目录：** `backend/engine/`（Agent 编排引擎，详见 `engine/ARCHITECTURE.md`）


### 2. Core Tools（7 个内置工具，`backend/tools/`）

| 工具 | 功能 | 要点 |
|------|------|------|
| terminal | Shell 命令（受限沙箱） | `root_dir` 限制 + 黑名单拦截 |
| python_repl | Python 执行 | `langchain_experimental` 包 |
| fetch_url | 网页获取 | BeautifulSoup 清洗为 Markdown |
| read_file | 读取文件 | `root_dir` 限制 |
| search_knowledge_base | RAG 检索 | LlamaIndex, `knowledge/` → `storage/` |
| memory_write | 记忆写入 | `write_to="memory"/"daily"`, 支持 `salience` |
| memory_search | 记忆搜索 | 语义搜索 + 关键词 + 时间衰减 |

### 3. 缓存系统（`backend/cache/`）

双层架构：L1 内存（dict+TTL+LRU, 100 项）+ L2 磁盘（JSON 文件, 两级目录, 5GB LRU 淘汰）

| 缓存类型 | 默认 | TTL | 目录 |
|---------|------|-----|------|
| URL | 开 | 1h | `.cache/url/` |
| LLM | 关 | 24h | `.cache/llm/` |
| Prompt | 开 | 10min | `.cache/prompt/` |
| 翻译 | 开 | 7d | `.cache/translate/` |
| MCP 工具 | 开 | 1h | `.cache/tool_mcp_*/` |

缓存键均为 SHA256。LLM 缓存支持流式模拟（逐字符 yield + 10ms 延迟）。`@cached_tool` 装饰器可为任意工具添加缓存。

```bash
# .env 缓存配置
ENABLE_URL_CACHE=true
ENABLE_LLM_CACHE=false
ENABLE_PROMPT_CACHE=true
ENABLE_TRANSLATE_CACHE=true
MCP_ENABLED=true
MCP_TOOL_CACHE_TTL=3600
CACHE_MAX_MEMORY_ITEMS=100
CACHE_MAX_DISK_SIZE_MB=5120
```

### 4. Skills 系统（`backend/skills/`）

Skills 是**教学说明书**，Agent 通过 `read_file(SKILL.md)` 学习步骤，再调用 Core Tools 执行。

```
backend/skills/{skill_name}/SKILL.md   # 必须含 YAML Frontmatter (name + description)
```

加载流程：扫描目录 → 读取 Frontmatter → 生成 SKILLS_SNAPSHOT XML → 注入 System Prompt

### 5. MCP 集成（`backend/mcp_module/`）

VibeWorker 作为 MCP Client，连接外部 MCP Server，将工具动态注入 Agent。

**⚠ 模块目录为 `mcp_module/`（非 `mcp/`），避免与 pip 包冲突。**

```
mcp_module/
├── __init__.py       # 导出 MCPManager 单例 (mcp_manager)
├── config.py         # mcp_servers.json 读写
├── manager.py        # 连接管理、工具发现、生命周期
└── tool_wrapper.py   # MCP 工具 → LangChain StructuredTool（含 L1+L2 缓存）
```

**配置文件 `backend/mcp_servers.json`：**
```json
{
  "servers": {
    "filesystem": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"],
      "enabled": true,
      "description": "本地文件系统"
    },
    "search": {
      "transport": "sse",
      "url": "http://localhost:3001/sse",
      "enabled": true
    }
  }
}
```

**传输方式：** `stdio`（本地进程: command+args+env）| `sse`（远程 HTTP: url+headers）

**MCPManager 方法：** `initialize()` / `shutdown()` / `connect_server(name)` / `disconnect_server(name)` / `get_all_mcp_tools()` / `get_server_status()` / `get_server_tools(name)`

**工具包装：** 每个 MCP 工具 → LangChain `StructuredTool`，名称格式 `mcp_{server}_{tool}`，含独立 L1+L2 缓存，命中返回 `[CACHE_HIT]` 前缀。

**生命周期：** app.py lifespan 中启动/关闭。单个 server 错误不影响其他 server 或 Core Tools。`get_all_tools()` 自动追加 MCP 工具。

### 6. System Prompt 拼接（`backend/workspace/`）

拼接顺序：`SKILLS_SNAPSHOT.xml` → `SOUL.md` → `IDENTITY.md` → `USER.md` → `AGENTS.md` → `memory.json` → Daily Logs → 隐式召回

- 超长截断 + `...[truncated]`
- 记忆独立 Token 预算（`MEMORY_MAX_PROMPT_TOKENS`, 默认 4000）
- 隐式召回：对话开始时自动检索相关记忆 + procedural memory
- `prompt_builder.py` 负责拼接

### 7. 会话管理

存储：`backend/sessions/{session_name}.json`（JSON 数组，含 user/assistant/tool 消息）

### 8. 模型池（`backend/model_pool.py`）

集中式模型配置管理，存储在 `~/.vibeworker/model_pool.json`。

```json
{
  "models": [
    { "id": "a1b2c3", "name": "GPT-4o", "api_key": "sk-...", "api_base": "https://api.openai.com/v1", "model": "gpt-4o" }
  ],
  "assignments": { "llm": "a1b2c3", "embedding": "a1b2c3", "translate": "a1b2c3" }
}
```

- **模型池 CRUD**：`list_models()` / `add_model()` / `update_model()` / `delete_model()`
- **场景分配**：`llm` / `embedding` / `translate` 三个场景各自引用池中模型 ID
- **`resolve_model(scenario)`**：核心函数，所有模型消费者调用。优先用池配置，无分配时回退 `.env`
- **自动迁移**：首次访问时自动从 `.env` 迁移已有配置到池中，相同 key+base 合并
- **API key 脱敏**：列表返回时前4后4中间 `***`，更新时脱敏值不覆盖原值

### 9. 配置管理（`backend/config.py`，Pydantic Settings）

关键配置：`llm_temperature/max_tokens`、`memory_*`、`mcp_enabled`、`mcp_tool_cache_ttl`

`.env` 仅存放全局参数（Temperature、Max Tokens）和非模型配置，模型 API Key/Base/Model 由模型池管理

---

## 后端 API（`http://localhost:8088`）

```
# 对话
POST /api/chat                           # SSE 流式对话

# 文件
GET  /api/files?path=...                 # 读取文件
POST /api/files                          # 保存文件
GET  /api/files/tree?root=...            # 文件树

# 会话
GET    /api/sessions                     # 列表
GET    /api/sessions/{id}                # 获取
POST   /api/sessions                     # 创建
DELETE /api/sessions/{id}                # 删除

# 技能
GET    /api/skills                       # 列表
DELETE /api/skills/{name}                # 删除

# 知识库
POST /api/knowledge/rebuild              # 重建索引

# 记忆 (v2)
GET    /api/memory/entries               # 列出条目（含 salience/access_count）
POST   /api/memory/entries               # 添加条目（支持 salience）
DELETE /api/memory/entries/{id}          # 删除条目
GET    /api/memory/daily-logs            # 日志列表
GET    /api/memory/daily-logs/{date}     # 指定日期日志
POST   /api/memory/search               # 搜索（支持 use_decay/category）
GET    /api/memory/stats                 # 统计
POST   /api/memory/reindex              # 重建索引
POST   /api/memory/consolidate          # 智能整合（ADD/UPDATE/DELETE/NOOP）
POST   /api/memory/archive              # 归档旧日志
GET    /api/memory/procedural           # 程序性记忆
GET/PUT /api/memory/rolling-summary     # 滚动摘要

# MCP
GET    /api/mcp/servers                  # 列出 Server 及状态
POST   /api/mcp/servers/{name}           # 添加 Server
PUT    /api/mcp/servers/{name}           # 更新 Server
DELETE /api/mcp/servers/{name}           # 删除 Server
POST   /api/mcp/servers/{name}/connect   # 连接
POST   /api/mcp/servers/{name}/disconnect # 断开
GET    /api/mcp/tools                    # 所有 MCP 工具
GET    /api/mcp/servers/{name}/tools     # 指定 Server 工具

# 缓存
GET  /api/cache/stats                    # 统计
POST /api/cache/clear?type=url           # 清空 (url/llm/prompt/translate/all)
POST /api/cache/cleanup                  # 清理过期

# 模型池
GET    /api/model-pool                   # 获取模型列表 + 分配
POST   /api/model-pool                   # 添加模型
PUT    /api/model-pool/assignments       # 更新场景分配
POST   /api/model-pool/{id}/test         # 测试模型连接
PUT    /api/model-pool/{id}              # 更新模型
DELETE /api/model-pool/{id}              # 删除模型

# 设置
GET /api/settings                        # 获取（含记忆/缓存/MCP 配置）
PUT /api/settings                        # 更新（写入 .env）

# 健康检查
GET /api/health
```

---

## 前端架构

### 布局（IDE 风格三栏可拖拽）

```
┌──────────────────────────────────────────────────┐
│ TopBar: VibeWorker v0.1.0 | 状态 | ⚙️ | 📄       │
├────────────┬───────────────────────┬─────────────┤
│  Sidebar   │     Chat Stage       │  Inspector   │
│  (256px)   │    (自适应)           │  (384px)     │
│  对话/记忆  │  消息流+工具调用      │  Monaco      │
│  技能/MCP  │  思考链+Markdown     │  Editor      │
│  缓存      │  代码高亮            │              │
└────────────┴───────────────────────┴─────────────┘
```

### 组件结构

```
frontend/src/
├── app/                    # layout.tsx, page.tsx, globals.css
├── components/
│   ├── chat/               # ChatPanel（消息流+工具调用，MCP 工具显示为 🔌 MCP: tool）
│   ├── sidebar/            # Sidebar + MemoryPanel + McpPanel + McpServerDialog + CachePanel
│   ├── editor/             # InspectorPanel (Monaco)
│   ├── settings/           # SettingsDialog（通用/模型/记忆/缓存 四 Tab）
│   └── ui/                 # Shadcn/UI 基础组件
└── lib/api.ts              # API 客户端
```

### UI 规范

- 色调：浅色 Apple 风格，毛玻璃效果，支持暗黑模式
- 工具调用：Core Tools 中文+Emoji，MCP 工具 🔌 MCP: {name}
- 设置弹窗六 Tab：通用（主题）、模型（模型池+场景分配+全局参数）、记忆、任务、缓存、安全

---

## 项目目录

```
backend/
├── app.py, config.py, model_pool.py, prompt_builder.py, sessions_manager.py, memory_manager.py, plan_approval.py
├── requirements.txt, mcp_servers.json
├── memory/                 # 记忆系统 v2 模块
│   ├── __init__.py, models.py, manager.py, search.py
│   ├── session_reflector.py, consolidator.py, archiver.py
├── sessions/               # JSON 会话
├── skills/                 # SKILL.md 文件夹
├── workspace/              # SOUL.md, IDENTITY.md, USER.md, AGENTS.md
├── tools/                  # 7 个 Core Tools + __init__.py (get_all_tools)
├── mcp_module/             # __init__.py, config.py, manager.py, tool_wrapper.py
├── engine/                 # Agent 编排引擎（Phase 1 + Phase 2，详见 engine/ARCHITECTURE.md）
├── cache/                  # L1+L2 缓存模块 + tool_cache_decorator.py
├── .cache/                 # 缓存存储 (url/ llm/ prompt/ translate/ tool_mcp_*/)
├── knowledge/              # RAG 文档
└── storage/                # 索引持久化

frontend/src/
├── app/ (layout, page, globals.css)
├── components/ (chat/, sidebar/, editor/, settings/, ui/)
└── lib/api.ts
```

---

## 开发指南

**基础配置修改：** 修改所有通用配置文件的时候需要检查user_default/init_user.md文件，确保初始化配置同步

**添加 Tool：** `backend/tools/{name}_tool.py` → `__init__.py` 导出 → `get_all_tools()` 添加

**创建 Skill：** `backend/skills/{name}/SKILL.md`（含 YAML Frontmatter），自动发现

**配置 MCP：** 编辑 `mcp_servers.json` 或前端 MCP 面板。`MCP_ENABLED` / `MCP_TOOL_CACHE_TTL` 控制开关和缓存

**修改 Prompt：** 编辑 `backend/workspace/` 下文件，无需重启。拼接逻辑在 `prompt_builder.py`

**调试：**
- System Prompt：检查日志 `prompt_builder.py` 输出
- 会话历史：`backend/sessions/{id}.json`
- RAG 索引：`POST /api/knowledge/rebuild` 或删除 `storage/`
- MCP：`GET /api/mcp/servers` 查状态，日志搜 `MCP server '{name}' connected`
- 缓存：`GET /api/cache/stats`，`POST /api/cache/clear?type=all`

---

## 代码规范

**注释语言：** 所有代码注释（行内注释、块注释）和 docstring **必须使用中文**。技术术语、变量名、API 名称等标识符保持英文原文。

示例：
```python
# ✅ 正确
def get_llm(streaming: bool = True) -> ChatOpenAI:
    """获取或创建 ChatOpenAI 实例。配置未变时复用缓存。"""
    # 根据配置指纹判断是否需要创建新实例
    fp = _config_fingerprint()

# ❌ 错误
def get_llm(streaming: bool = True) -> ChatOpenAI:
    """Get or create a ChatOpenAI instance."""
    # Check config fingerprint
    fp = _config_fingerprint()
```

---

## 约束

✅ 用 LangChain 1.x `create_agent` | Skills 含 Frontmatter | 文件存储优先 | `mcp_module/` 避免包名冲突 | 所有注释使用中文

❌ 旧版 AgentExecutor | 数据库存 Session/Memory | Skills 无 Frontmatter | Prompt 中写 Python 调用 | 英文注释

---

## 参考

- [LangChain](https://python.langchain.com/docs/agents/) | [LangGraph](https://langchain-ai.github.io/langgraph/) | [LlamaIndex](https://docs.llamaindex.ai/)
- [Next.js](https://nextjs.org/docs) | [FastAPI](https://fastapi.tiangolo.com/)
- [MCP 规范](https://modelcontextprotocol.io/) | [MCP Python SDK](https://github.com/modelcontextprotocol/python-sdk)
