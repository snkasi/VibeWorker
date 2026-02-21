<p align="center">
  <img src="frontend/public/logo.png" alt="VibeWorker Logo" width="120" />
</p>

<h1 align="center">VibeWorker 超级数字员工</h1>

<p align="center">
  <strong>能记忆、能学习、不断进化的本地 AI 数字员工</strong>
</p>

<p align="center">
  <a href="https://github.com/user/vibeworker/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License" /></a>
  <a href="https://www.python.org/downloads/"><img src="https://img.shields.io/badge/python-3.10%2B-blue.svg" alt="Python" /></a>
  <a href="https://nextjs.org/"><img src="https://img.shields.io/badge/Next.js-14%2B-black.svg" alt="Next.js" /></a>
  <a href="https://modelcontextprotocol.io/"><img src="https://img.shields.io/badge/MCP-compatible-green.svg" alt="MCP" /></a>
  <img src="https://img.shields.io/tokei/lines/github/EntropyFlux/VibeWorker" alt="Lines of code" />
</p>

<p align="center">
  <a href="./README.md">English</a> · <a href="#快速开始">快速开始</a> · <a href="#架构概览">架构概览</a> · <a href="#api-接口">API 接口</a>
</p>

---

VibeWorker 是一个基于 Python 的轻量级本地 AI Agent 系统。文件即记忆、技能即插件、透明可控。它能记住你的偏好和历史，通过插件式技能不断学习新能力，帮你处理各类任务——信息检索、数据处理、代码执行、文件管理等。

## 核心特性

- **统一 Agent 编排引擎** — 基于 LangGraph StateGraph 的混合架构，ReAct 对话 + Plan 执行无缝切换
- **文件即记忆 (File-first Memory)** — 所有记忆以 JSON 文件形式存储在本地，人类可读可编辑
- **记忆系统 v2** — 四层记忆架构 + 智能整合 + 重要性评分 + 时间衰减 + 程序性记忆 + 隐式召回
- **技能即插件 (Skills as Plugins)** — 通过文件夹结构管理能力，拖入即用
- **技能商店 (Skills Store)** — 集成 [skills.sh](https://skills.sh/) 生态，一键浏览、搜索、安装 500+ 社区技能
- **MCP 集成** — 作为 MCP Client 连接外部 MCP Server，动态注入工具
- **智能缓存系统** — 双层缓存（L1 内存 + L2 磁盘），响应速度提升 10-100x，节省 API 成本
- **安全沙箱** — 安全门控 + 工具审批 + 审计日志 + 速率限制
- **数据目录隔离** — 用户数据存储在 `~/.vibeworker/`，与项目源码完全分离
- **透明可控** — 所有 Prompt 拼接、工具调用、记忆读写完全透明

## 技术栈

| 层级 | 技术 |
|------|------|
| 后端框架 | FastAPI (Python 3.10+) |
| Agent 编排引擎 | LangGraph StateGraph（统一图拓扑） |
| LLM 接口 | LangChain 1.x（兼容 OpenAI API 格式） |
| RAG 引擎 | LlamaIndex (Hybrid Search) |
| MCP 集成 | MCP Python SDK (Anthropic 官方, `mcp>=1.0.0`) |
| 前端框架 | Next.js 14+ (App Router), TypeScript |
| UI 组件 | Shadcn/UI + Tailwind CSS v4 |
| 代码编辑器 | Monaco Editor |
| 存储 | 本地文件系统（无 MySQL/Redis） |

## 快速开始

### 一键启动（推荐）

```bash
# Linux/macOS/Git Bash
./start.sh              # 启动前后端
./start.sh stop         # 停止
./start.sh restart      # 重启
./start.sh status       # 查看状态

# Windows CMD
start.bat               # 启动前后端
start.bat stop          # 停止
start.bat restart       # 重启
start.bat status        # 查看状态
```

### 手动启动

**后端启动**（运行在 `http://localhost:8088`）

```bash
cd backend
pip install -r requirements.txt
python app.py
```

**前端启动**（运行在 `http://localhost:3000`）

```bash
cd frontend
npm install
npm run dev
```

## 架构概览

### Agent 编排引擎

VibeWorker 采用统一的 LangGraph `StateGraph` 编排引擎，以 ReAct Agent 为唯一入口，当任务需要结构化执行时自动切换到 Plan 执行模式。

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

**Phase 1 — ReAct Agent（统一入口）**：所有用户请求由 ReAct Agent 处理，拥有全部工具（8 个 Core Tools + `plan_create` + MCP 工具）。简单任务直接回答，复杂任务自主调用 `plan_create` 触发 Phase 2。

**Phase 2 — Plan Execution Loop（自动触发）**：
1. **Approval Gate**（可选）：`plan_require_approval=true` 时等待用户确认
2. **Executor**：为每个步骤创建独立 ReAct 子 Agent，隔离 Context 防止膨胀
3. **Replanner**：每步完成后评估，支持 `continue` / `revise` / `finish` 三种决策
4. **Summarizer**：计划完成后总结结果，回到 Agent 生成最终回复

**配置化控制**：通过 `graph_config.yaml` 控制节点开关、参数和工具集，无需改代码。

### 内置工具 (Core Tools)

| 工具 | 功能 | 要点 |
|------|------|------|
| `terminal` | Shell 命令执行 | `root_dir` 沙箱限制 + 黑名单拦截 |
| `python_repl` | Python 代码执行 | `langchain_experimental` |
| `fetch_url` | 网页内容获取 | BeautifulSoup 清洗为 Markdown |
| `read_file` | 文件读取 | `root_dir` 限制 |
| `search_knowledge_base` | RAG 知识库检索 | LlamaIndex Hybrid Search |
| `memory_write` | 记忆写入 | 支持长期记忆 / 每日日志，含 salience 评分 |
| `memory_search` | 记忆搜索 | 语义搜索 + 关键词 + 时间衰减 |
| `plan_create` | 创建执行计划 | 触发 Phase 2 计划执行模式 |

## 记忆系统 v2

VibeWorker 采用四层记忆架构，借鉴 [Mem0](https://mem0.ai/) 的智能记忆管理理念：

### 四层架构

| 层级 | 说明 | 存储 |
|------|------|------|
| **Working Memory** | 当前对话上下文 | 内存 (messages) |
| **Short-Term Memory** | 每日日志，30 天归档 | `memory/logs/YYYY-MM-DD.json` |
| **Long-Term Memory** | 持久记忆，智能整合 | `memory/memory.json` |
| **Procedural Memory** | 工具使用经验 | `memory/memory.json` (procedural) |

### 核心特性

- **智能整合 (Consolidation)**：新记忆写入时 LLM 自动决策 ADD / UPDATE / DELETE / NOOP，避免重复
- **重要性评分 (Salience)**：0.0-1.0 评分，高重要性记忆优先召回
- **时间衰减**：指数衰减曲线（λ=0.05，14 天衰减到 50%），新记忆权重更高
- **隐式召回**：对话开始时自动检索 top-3 相关记忆 + 程序性记忆注入 System Prompt
- **程序性记忆**：自动从工具失败中学习，积累使用经验
- **自动归档**：30 天摘要归档，60 天清理

### 记忆分类

| 分类 | 用途 | 示例 |
|------|------|------|
| `preferences` | 用户偏好 | 喜欢东航、代码风格简洁 |
| `facts` | 重要事实 | API 地址、项目技术栈 |
| `tasks` | 任务备忘 | 待办事项、提醒 |
| `reflections` | 反思总结 | 经验教训 |
| `procedural` | 程序经验 | 工具使用心得、环境特性 |
| `general` | 通用信息 | 其他 |

## Skills 系统

VibeWorker 的 Agent Skills 遵循 **Instruction-following** 范式——Skills 本质上是教 Agent 如何使用基础工具完成任务的说明书，而非预先写好的函数。

### 工作流程

1. **感知**：Agent 在 System Prompt 中看到 `available_skills` 列表
2. **决策**：匹配用户请求与对应技能
3. **学习**：调用 `read_file(SKILL.md)` 读取操作说明
4. **执行**：动态调用 Core Tools (Terminal/Python/Fetch) 完成任务

### 技能商店

集成 [skills.sh](https://skills.sh/) 生态系统，提供 500+ 社区技能：

- 浏览和搜索技能，按分类筛选
- 一键安装到本地 `skills/` 目录
- 支持一键翻译技能文档为中文
- CLI 工具支持（`scripts/skills.sh` / `scripts/skills.bat`）

## MCP 集成

VibeWorker 作为 MCP Client，连接外部 MCP Server，将工具动态注入 Agent。

- **传输方式**：`stdio`（本地进程）| `sse`（远程 HTTP）
- **工具包装**：每个 MCP 工具 → LangChain `StructuredTool`，名称格式 `mcp_{server}_{tool}`
- **独立缓存**：MCP 工具含独立 L1+L2 缓存，命中返回 `[CACHE_HIT]` 前缀
- **配置管理**：通过 `mcp_servers.json` 或前端 MCP 面板管理

## 缓存系统

双层缓存架构（L1 内存 + L2 磁盘），显著提升性能并节省 API 成本。

| 缓存类型 | 默认 | TTL | 用途 |
|---------|------|-----|------|
| URL 缓存 | 开启 | 1h | 网页请求结果 |
| LLM 缓存 | 关闭 | 24h | Agent 响应 |
| Prompt 缓存 | 开启 | 10min | System Prompt 拼接 |
| 翻译缓存 | 开启 | 7d | 翻译 API 结果 |
| MCP 工具缓存 | 开启 | 1h | MCP 工具调用结果 |

### 性能提升

| 操作 | 无缓存 | 有缓存 | 提升 |
|------|--------|--------|------|
| 网页请求 | ~500-2000ms | ~10-50ms | **10-100x** |
| LLM 调用 | ~2000-5000ms | ~100-300ms | **10-20x** |
| 翻译 API | ~1000-2000ms | ~5-20ms | **50-200x** |

### 为自定义工具添加缓存

```python
from cache import cached_tool

@cached_tool("my_tool", ttl=1800)  # 缓存 30 分钟
def my_tool(query: str) -> str:
    # 你的工具逻辑
    return result
```

## 安全系统

| 模块 | 功能 |
|------|------|
| `security/gate.py` | 安全门控，拦截高风险操作 |
| `security/classifier.py` | 请求风险等级分类 |
| `security/tool_wrapper.py` | 工具执行前安全包装 |
| `security/audit.py` | 操作审计日志 |
| `security/rate_limiter.py` | 速率限制 |
| `security/docker_sandbox.py` | Docker 沙箱隔离 |

前端支持高风险工具执行前弹出审批对话框，可选择「允许」「拒绝」「本次会话均允许」。

## 前端界面

IDE 风格三栏可拖拽布局：

```
┌──────────────────────────────────────────────────┐
│ TopBar: VibeWorker | 状态指示 | 设置 | Inspector  │
├────────────┬───────────────────────┬─────────────┤
│  Sidebar   │     Chat Stage       │  Inspector   │
│  (256px)   │    (自适应)           │  (384px)     │
│  会话列表   │  消息流+工具调用      │  Monaco      │
│  记忆面板   │  思考链+Markdown     │  Editor      │
│  技能/MCP  │  计划卡片+审批       │              │
│  缓存管理   │  代码高亮            │              │
└────────────┴───────────────────────┴─────────────┘
```

- **Sidebar**：会话管理 / 记忆面板（记忆+日记+人格三 Tab）/ 技能列表 / MCP 管理 / 缓存面板
- **Chat Stage**：对话流 + 工具调用可视化（中文标签+Emoji）+ 计划卡片 + 缓存指示器
- **Inspector**：Monaco Editor 实时编辑 SKILL.md / 配置文件，支持一键翻译
- **设置弹窗**：通用 / 模型（模型池+场景分配）/ 记忆 / 任务 / 缓存 / 安全 六 Tab

## 项目结构

```
vibeworker/
├── backend/                       # FastAPI 后端（只读源码）
│   ├── app.py                     # 应用入口 (Port 8088)
│   ├── config.py                  # Pydantic Settings 配置
│   ├── model_pool.py              # 模型池管理（CRUD + 场景分配）
│   ├── prompt_builder.py          # System Prompt 动态拼接
│   ├── sessions_manager.py        # 会话管理
│   ├── session_context.py         # 会话上下文（临时目录隔离）
│   ├── engine/                    # Agent 编排引擎（StateGraph）
│   │   ├── runner.py              # 顶层编排器（唯一入口）
│   │   ├── graph_builder.py       # StateGraph 构建与编译
│   │   ├── stream_adapter.py      # SSE 事件流适配
│   │   └── nodes/                 # 图节点（agent/executor/replanner 等）
│   ├── memory/                    # 记忆系统 v2
│   │   ├── manager.py             # 核心管理器（CRUD、统计）
│   │   ├── search.py              # 搜索（向量+关键词+衰减）
│   │   ├── consolidator.py        # 智能整合
│   │   ├── session_reflector.py   # 会话级反思
│   │   └── archiver.py            # 日志归档
│   ├── tools/                     # 8 个 Core Tools
│   ├── cache/                     # L1+L2 缓存系统
│   ├── security/                  # 安全沙箱模块
│   ├── mcp_module/                # MCP Client 集成
│   ├── pricing/                   # 成本计算（OpenRouter）
│   ├── store/                     # 技能商店模块
│   └── user_default/              # 首次运行模板 → ~/.vibeworker/
│
├── frontend/                      # Next.js 14+ 前端
│   └── src/
│       ├── app/                   # layout + page + globals.css
│       ├── components/
│       │   ├── chat/              # ChatPanel + PlanCard + ApprovalDialog
│       │   ├── sidebar/           # Sidebar + MemoryPanel + McpPanel + CachePanel
│       │   ├── editor/            # InspectorPanel (Monaco)
│       │   ├── settings/          # SettingsDialog（六 Tab）
│       │   ├── store/             # 技能商店组件
│       │   ├── debug/             # 调试面板
│       │   └── ui/                # Shadcn/UI 基础组件
│       └── lib/
│           ├── api.ts             # API 客户端
│           └── sessionStore.ts    # 会话状态管理
│
├── ~/.vibeworker/                 # 用户数据目录（与源码隔离）
│   ├── .env                       # 全局参数配置
│   ├── model_pool.json            # 模型池配置
│   ├── mcp_servers.json           # MCP 服务器配置
│   ├── sessions/                  # 会话记录
│   ├── memory/                    # 记忆存储（memory.json + logs/）
│   ├── skills/                    # 已安装技能
│   ├── workspace/                 # System Prompts
│   ├── tmp/                       # 会话临时工作目录
│   ├── knowledge/                 # RAG 知识库
│   ├── storage/                   # 索引持久化
│   └── .cache/                    # 缓存存储
│
├── scripts/                       # CLI 工具
├── start.sh / start.bat           # 一键启动脚本
└── README.md
```

## API 接口

### 核心接口

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/chat` | POST | SSE 流式对话 |
| `/api/sessions` | GET/POST/DELETE | 会话管理 |
| `/api/files` | GET/POST | 文件读写 |
| `/api/files/tree` | GET | 文件树结构 |
| `/api/skills` | GET/DELETE | 技能管理 |
| `/api/settings` | GET/PUT | 全局配置 |
| `/api/health` | GET | 健康检查 |

### 模型池接口

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/model-pool` | GET/POST | 模型列表 + 添加模型 |
| `/api/model-pool/{id}` | PUT/DELETE | 更新 / 删除模型 |
| `/api/model-pool/assignments` | PUT | 场景分配（llm/embedding/translate） |
| `/api/model-pool/{id}/test` | POST | 测试模型连接 |

### 记忆管理接口

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/memory/entries` | GET/POST/DELETE | 记忆条目 CRUD |
| `/api/memory/search` | POST | 搜索记忆（支持时间衰减） |
| `/api/memory/consolidate` | POST | 智能整合（ADD/UPDATE/DELETE/NOOP） |
| `/api/memory/procedural` | GET | 程序性记忆 |
| `/api/memory/archive` | POST | 归档旧日志 |
| `/api/memory/daily-logs` | GET | 每日日志列表 |
| `/api/memory/daily-logs/{date}` | GET/DELETE | 指定日期日志 |
| `/api/memory/stats` | GET | 记忆统计 |
| `/api/memory/reindex` | POST | 重建搜索索引 |
| `/api/memory/rolling-summary` | GET/PUT | 滚动摘要 |

### MCP 接口

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/mcp/servers` | GET | 列出 Server 及状态 |
| `/api/mcp/servers/{name}` | POST/PUT/DELETE | Server CRUD |
| `/api/mcp/servers/{name}/connect` | POST | 连接 Server |
| `/api/mcp/servers/{name}/disconnect` | POST | 断开 Server |
| `/api/mcp/tools` | GET | 所有 MCP 工具列表 |

### 缓存管理接口

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/cache/stats` | GET | 缓存统计信息 |
| `/api/cache/clear` | POST | 清空缓存（url/llm/prompt/translate/all） |
| `/api/cache/cleanup` | POST | 清理过期缓存 |

### 技能商店接口

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/store/skills` | GET | 远程技能列表 |
| `/api/store/search` | GET | 搜索技能 |
| `/api/store/skills/{name}` | GET | 技能详情 |
| `/api/store/install` | POST | 安装技能 |
| `/api/store/categories` | GET | 分类列表 |
| `/api/translate` | POST | 翻译内容 |

## 环境变量

模型配置由模型池统一管理（`~/.vibeworker/model_pool.json`），`.env` 仅存放全局参数：

```env
# 全局参数
LLM_TEMPERATURE=0.7
LLM_MAX_TOKENS=4096

# 记忆系统 v2
MEMORY_CONSOLIDATION_ENABLED=true     # 智能整合
MEMORY_REFLECTION_ENABLED=true        # 反思记忆
MEMORY_IMPLICIT_RECALL_ENABLED=true   # 隐式召回
MEMORY_ARCHIVE_DAYS=30                # 归档阈值（天）
MEMORY_DECAY_LAMBDA=0.05              # 衰减系数

# 缓存配置
ENABLE_URL_CACHE=true
ENABLE_LLM_CACHE=false
ENABLE_PROMPT_CACHE=true
ENABLE_TRANSLATE_CACHE=true
MCP_ENABLED=true
MCP_TOOL_CACHE_TTL=3600
```

## CLI 工具

```bash
# Linux/macOS
./scripts/skills.sh list              # 列出本地技能
./scripts/skills.sh search <query>    # 搜索远程技能
./scripts/skills.sh install <name>    # 安装技能

# Windows
scripts\skills.bat list
scripts\skills.bat search <query>
scripts\skills.bat install <name>
```

## 参与贡献

欢迎贡献代码！请随时提交 Pull Request。

1. Fork 本仓库
2. 创建特性分支（`git checkout -b feature/amazing-feature`）
3. 提交更改（`git commit -m 'Add some amazing feature'`）
4. 推送到分支（`git push origin feature/amazing-feature`）
5. 发起 Pull Request

## 开源协议

本项目采用 MIT 协议 — 详见 [LICENSE](LICENSE) 文件。
