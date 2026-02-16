# VibeWorker 开发需求文档 (PRD)
## 一、项目介绍
### 1. 功能与目标定位
**VibeWorker** 是一个基于 **Python** 构建的、轻量级且高度透明的 AI 数字员工 Agent 系统。
本项目不追求构建庞大的 SaaS 平台，而是致力于打造一个**运行在本地的、拥有“真实记忆”的智能数字员工**。它可以帮助用户处理各类任务，包括但不限于信息检索、数据处理、代码执行、文件管理等。其核心差异化定位在于：

+ **文件即记忆 (File-first Memory)**：摒弃不透明的向量数据库，回归最原始、最通用的 Markdown/JSON 文件系统。用户的每一次对话、Agent 的每一次反思，都以人类可读的文件形式存在。
+ **技能即插件 (Skills as Plugins)**：遵循 Anthropic 的 Agent Skills 范式，通过文件夹结构管理能力，实现“拖入即用”的技能扩展。
+ **透明可控**：所有的 System Prompt 拼接逻辑、工具调用过程、记忆读写操作对开发者完全透明，拒绝“黑盒”Agent。

### 2. 项目核心技术架构
本项目要求完全采用 **前后端分离** 架构，后端作为纯 API 服务运行。

+ **后端语言**：Python 3.10+ (强制使用 Type Hinting)。
+ **Web 框架**：**FastAPI** (提供 RESTful 接口，支持异步处理)。
+ **Agent 编排引擎**：**LangChain 1.x (Stable Release)**。
    - **核心 API**：必须使用 `**create_agent**` API (`from langchain.agents import create_agent`)。这是 LangChain 1.0 版本发布的最新标准 API，用于构建基于 Graph 运行时的 Agent。
    - **核心说明**：严禁使用旧版的 `AgentExecutor` 或早期的 `create_react_agent`（旧链式结构）。`create_agent` 底层虽然基于 LangGraph 运行时，但提供了更简洁的标准化接口，本项目应紧跟这一最新范式。
+ **RAG 检索引擎**：**LlamaIndex (LlamaIndex Core)**。
    - 用于处理非结构化文档的混合检索（Hybrid Search），作为 Agent 的知识外挂。
+ **模型接口**：兼容 OpenAI API 格式（支持 OpenRouter, Zenmux 等聚合模型平台，并且也支持用户自己配置API地址和Key）。
+ **数据存储**：本地文件系统 (Local File System) 为主，不引入 MySQL/Redis 等重型依赖。
+ **数据目录隔离 ✅ 已实现**：所有用户可写数据（会话、记忆、技能、配置等）存储在 `~/.vibeworker/` 目录，与项目源码完全分离。`DATA_DIR` 环境变量支持自定义，但内置安全校验确保数据目录不会指向项目源码目录内（如意外设为 `.` 或相对路径时自动回退到 `~/.vibeworker/`）。
+ **会话级临时目录隔离 ✅ 已实现**：
    - 每个会话拥有独立的工作目录 `~/.vibeworker/tmp/{session_id}/`
    - `terminal` 和 `python_repl` 工具的 cwd 自动切换到当前会话的临时目录
    - 通过 `session_context.py` 模块级变量管理会话上下文（避免 ContextVar 在线程池中不传播的问题）
    - 会话隔离确保多会话并发时文件操作不互相干扰
+ **智能缓存系统** ✅ 已实现：
    - 双层缓存架构（L1 内存 + L2 磁盘）
    - 支持 URL 缓存、LLM 缓存、Prompt 缓存、翻译缓存
    - 通用工具缓存装饰器，可为任何工具添加缓存能力
    - 显著提升响应速度（10-100x）并节省 API 成本

## 二、内置工具
VibeWorker 在启动时，除了加载用户自定义的 Skills 外，必须内置以下 7 个核心基础工具（Core Tools）。根据"优先使用 LangChain 原生工具"的原则，技术选型更新如下：

### 1. 命令行操作工具 (Command Line Interface)
+ **功能描述**：允许 Agent 在受限的安全环境下执行 Shell 命令。
+ **实现逻辑**：
    - **直接使用 LangChain 内置工具**：`langchain_community.tools.ShellTool`。
    - **配置要求**：
        * 初始化时需配置 `root_dir` 限制操作范围（沙箱化），防止 Agent 修改系统关键文件。
        * 需预置黑名单拦截高危指令（如 `rm -rf /`）。
+ **工具名称**：`terminal`。

### 2. Python 代码解释器 (Python REPL)
+ **功能描述**：赋予 Agent 逻辑计算、数据处理和脚本执行的能力。
+ **实现逻辑**：
    - **直接使用 LangChain 内置工具**：`langchain_experimental.tools.PythonREPLTool`。
    - **配置要求**：
        * 该工具会自动创建一个临时的 Python 交互环境。
        * **注意**：由于 `PythonREPLTool` 位于 `experimental` 包中，需确保依赖项安装正确。
+ **工具名称**：`python_repl`。

### 3. Fetch 网络信息获取
+ **功能描述**：用于获取指定 URL 的网页内容，Agent 联网的核心。
+ **实现逻辑**：
    - **直接使用 LangChain 内置工具**：`langchain_community.tools.RequestsGetTool`。
    - **增强配置 (Wrapper)**：
        * 原生 `RequestsGetTool` 返回的是原始 HTML，Token 消耗巨大。
        * **必须封装**：建议继承该类或创建一个 Wrapper，在获取内容后使用 `BeautifulSoup` 或 `html2text` 库清洗数据，仅返回 Markdown 或纯文本内容。
+ **工具名称**：`fetch_url`。

### 4. 文件读取工具 (File Reader)
+ **功能描述**：用于精准读取本地指定文件的内容。这是 Agent Skills 机制的核心依赖，用于读取 `SKILL.md` 的详细说明。
+ **实现逻辑**：
    - **直接使用 LangChain 内置工具**：`langchain_community.tools.file_management.ReadFileTool`。
    - **配置要求**：
        * 必须设置 `root_dir` 为项目根目录，严禁 Agent 读取项目以外的系统文件。
+ **工具名称**：`read_file`。

### 5. RAG 检索工具 (Hybrid Retrieval)
+ **功能描述**：当用户询问具体的知识库内容（非对话历史）时，Agent 可调用此工具进行深度检索。
+ **技术选型**：**LlamaIndex**。
+ **实现逻辑**：
    - **索引构建**：支持扫描指定目录（如 `knowledge/`）下的 PDF/MD/TXT 文件，构建本地索引。
    - **混合检索**：必须实现 **Hybrid Search**（关键词检索 BM25 + 向量检索 Vector Search）。
    - **持久化**：索引文件需持久化存储在本地（`storage/`）。
+ **工具名称**：`search_knowledge_base`。

### 6. 记忆写入工具 (Memory Write) ✅ 已实现
+ **功能描述**：Agent 专用记忆写入工具，替代原有的 `terminal echo >>` 方式，提供格式校验、自动去重和分类管理。
+ **实现逻辑**：
    - 自定义 LangChain `@tool` 实现，调用 `MemoryManager` 核心类。
    - **写入模式**：
        * `write_to="memory"` → 写入 `MEMORY.md` 对应分类章节（preferences/facts/tasks/reflections/general）
        * `write_to="daily"` → 追加到今天的 Daily Log（`memory/logs/YYYY-MM-DD.md`）
    - **自动去重**：相同内容不会重复写入。
    - **格式规范**：条目自动添加日期和唯一 ID（`- [YYYY-MM-DD][id] 内容`）。
+ **工具名称**：`memory_write`。

### 7. 记忆搜索工具 (Memory Search) ✅ 已实现
+ **功能描述**：跨所有记忆文件（MEMORY.md + Daily Logs）进行语义搜索或关键词搜索。
+ **实现逻辑**：
    - **优先使用** LlamaIndex VectorStoreIndex 进行语义搜索（复用现有 Embedding 配置）。
    - **降级方案**：当向量索引不可用时（Embedding 未配置、依赖缺失），自动降级为纯 Python 关键词匹配搜索。
    - **索引持久化**：向量索引存储在 `storage/memory_index/`，重启可复用。
    - **索引重建**：通过 `POST /api/memory/reindex` 或 `rebuild_memory_index()` 强制重建。
+ **工具名称**：`memory_search`。

## 三、智能缓存系统 ✅ 已实现
### 1. 缓存系统概述
VibeWorker 内置智能缓存系统，通过双层缓存架构（L1 内存 + L2 磁盘）显著提升性能并节省 API 成本。所有缓存以 JSON 文件形式存储在本地 `.cache/` 目录，完全透明可审计。

**核心特性：**
- **双层缓存架构**：L1 内存缓存（毫秒级访问）+ L2 磁盘缓存（持久化，进程重启后可复用）
- **多种缓存类型**：URL 缓存、LLM 缓存、Prompt 缓存、翻译缓存、通用工具缓存
- **智能失效策略**：基于 TTL（Time-To-Live）自动过期，LRU（Least Recently Used）淘汰
- **可视化指示器**：前端显示 ⚡ 图标，一目了然
- **灵活配置**：通过 `.env` 精细控制每种缓存的开关和 TTL
- **通用装饰器**：通过 `@cached_tool` 装饰器可为任何工具添加缓存能力

### 2. 缓存类型与配置

| 缓存类型 | 默认开关 | 默认 TTL | 存储位置 | 用途 |
|---------|---------|----------|----------|------|
| **URL 缓存** | ✅ 开启 | 1 小时 | `.cache/url/` | 网页请求结果 |
| **LLM 缓存** | ❌ 关闭 | 24 小时 | `.cache/llm/` | Agent 响应（默认关闭以保持探索性） |
| **Prompt 缓存** | ✅ 开启 | 10 分钟 | `.cache/prompt/` | System Prompt 拼接结果 |
| **翻译缓存** | ✅ 开启 | 7 天 | `.cache/translate/` | 翻译 API 结果 |
| **工具缓存** | 可选 | 自定义 | `.cache/tool_*/` | 任何自定义工具 |

**环境变量配置：**
```bash
# 开关控制
ENABLE_URL_CACHE=true
ENABLE_LLM_CACHE=false          # 默认关闭
ENABLE_PROMPT_CACHE=true
ENABLE_TRANSLATE_CACHE=true

# TTL 配置（秒）
URL_CACHE_TTL=3600              # 1 小时
LLM_CACHE_TTL=86400             # 24 小时
PROMPT_CACHE_TTL=600            # 10 分钟
TRANSLATE_CACHE_TTL=604800      # 7 天

# 内存缓存限制
CACHE_MAX_MEMORY_ITEMS=100      # L1 缓存最大条目数

# 磁盘缓存限制
CACHE_MAX_DISK_SIZE_MB=5120     # 最大 5GB
```

### 3. 缓存工作原理

**双层缓存架构：**
```
Application Layer (Tools / Agent)
    ↓
L1 Cache (Memory)
- Python dict + TTL
- LRU eviction
- 毫秒级访问
    ↓ (Miss)
L2 Cache (Disk)
- JSON files in .cache/
- 2-level directory structure
- 持久化，进程重启后可复用
    ↓ (Miss)
Original Source (API/File/etc.)
```

**缓存键生成策略：**
- **URL 缓存**：`SHA256(url)`
- **LLM 缓存**：`SHA256(system_prompt_hash + recent_history + message + model + temperature)`
- **Prompt 缓存**：`SHA256(file_mtimes)`（基于文件修改时间，文件变化自动失效）
- **翻译缓存**：`SHA256(content + target_language)`
- **工具缓存**：`SHA256(tool_name + args + kwargs)`

### 4. 为自定义工具添加缓存

使用通用装饰器 `@cached_tool`，只需一行代码：

```python
from cache import cached_tool

@cached_tool("my_tool", ttl=1800)  # 缓存 30 分钟
def my_tool(query: str) -> str:
    """自定义工具"""
    # 工具逻辑
    return result
```

**与 LangChain 工具结合：**
```python
from langchain_core.tools import tool
from cache import cached_tool

@tool
@cached_tool("search_tool", ttl=1800)
def search_tool(query: str) -> str:
    """搜索工具（带缓存）"""
    # 搜索逻辑
    return results
```

### 5. 缓存最佳实践

**✅ 应该缓存的操作：**
- 外部 API 调用（慢、有速率限制）
- 网页抓取（相同 URL 重复访问）
- 数据库查询（重复查询相同数据）
- 计算密集型操作（结果确定）

**❌ 不应该缓存的操作：**
- 命令执行（`terminal`、`bash`）- 每次可能产生不同结果
- 代码执行（`python_repl`）- 有副作用
- 写操作（`write_file`）- 有副作用
- 发送操作（`send_email`）- 有副作用
- 实时数据查询（`get_current_time`）- 必须最新
- 随机生成（`random_number`）- 每次应该不同

**详细文档：**
- `backend/TOOL_CACHE_GUIDE.md` - 使用指南
- `backend/CACHE_BEST_PRACTICES.md` - 最佳实践
- `UNIVERSAL_TOOL_CACHE.md` - 通用工具缓存说明

### 6. 性能提升

| 操作 | 无缓存 | 有缓存（命中） | 提升 |
|------|--------|---------------|------|
| **网页请求** | ~500-2000ms | ~10-50ms | **10-100x** |
| **LLM 调用** | ~2000-5000ms | ~100-300ms（模拟流） | **10-20x** |
| **Prompt 拼接** | ~50-100ms | ~1-5ms | **10-50x** |
| **翻译 API** | ~1000-2000ms | ~5-20ms | **50-200x** |

**总体效果：**
- 重复查询场景：响应速度提升 **10-100 倍**
- Token 消耗：减少 **50-90%**（LLM 缓存开启时）
- 用户体验：相同问题秒级响应

## 四、VibeWorker 的 Agent Skills 系统
### 1. Agent Skills 基础功能介绍
VibeWorker 的 Agent Skills 遵循 **"Instruction-following" (指令遵循)** 范式，而非传统的 "Function-calling" (函数调用) 范式。这意味着 Skills 本质上是**教会 Agent 如何使用基础工具（如 Python/Terminal）去完成任务的说明书**，而不是预先写好的 Python 函数。

Agent Skills 以文件夹形式存在于 `backend/skills/` 目录下。


### 2. Agent Skills 载入与执行流程
#### 2.1 Agent Skills 读取流程 (Bootstrap)
在 Agent 启动或会话开始时，系统扫描 `skills` 文件夹，读取每个 `SKILL.md` 的元数据（Frontmatter），并将其汇总生成 `SKILLS_SNAPSHOT.md`。

`**SKILLS_SNAPSHOT.md**`** 示例：**

```plain
<available_skills>  
  <skill>  
    <name>get_weather</name>  
    <description>获取指定城市的实时天气信息</description>  
    <location>./backend/skills/get_weather/SKILL.md</location> 
  </skill>
</available_skills>
```

_注意：_`_location_`_ 使用相对路径。_

#### 2.2 Agent Skills 调用流程 (Execution)
这是本系统最独特的地方：

1. **感知**：Agent 在 System Prompt 中看到 `available_skills` 列表。
2. **决策**：当用户请求“查询北京天气”时，Agent 发现 `get_weather` 技能匹配。
3. **行动 (Tool Call)**：Agent **不调用**`get_weather()` 函数（因为它不存在），而是调用 `**read_file(path="./backend/skills/get_weather/SKILL.md")**`。
4. **学习与执行**：Agent 读取 Markdown 内容，理解操作步骤（例如：“使用 fetch_url 访问某天气 API” 或 “使用 python_repl 运行以下代码”），然后**动态调用 Core Tools** (Terminal/Python) 来完成任务。

### 3. Agent Skills 的一些特性
#### 3.1 兼容Claude Code
本工程的Agent Skills 需要能兼容本地的Claude Code插件（即如果本地安装了ClaudeCode，同样允许用户可以使用到安装在ClaudeCode里的Skill，如果用户没有安装Claude Code则无影响）

#### 3.2 技能商店 (Skills Store) ✅ 已实现
提供一个技能商店，集成 [skills.sh](https://skills.sh/) 生态系统：

**功能特性：**
- 浏览 500+ 社区技能
- 按分类筛选（工具、数据、网络、自动化、集成等）
- 关键词搜索技能
- 一键安装到本地 `skills/` 目录
- 分页展示（每页 12 个技能）
- 查看技能详情和 SKILL.md 内容

**技术实现：**
- 后端 `backend/store/` 模块负责与 skills.sh 交互
- 从 skills.sh 页面提取技能数据（通过正则匹配嵌入的 JSON）
- 从 GitHub 原始内容获取 SKILL.md 文件
- 前端 `frontend/src/components/store/` 提供商店 UI

**CLI 工具：**
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

#### 3.3 技能翻译功能 ✅ 已实现
编辑器支持一键将 SKILL.md 文件翻译为中文：
- 点击翻译按钮，调用 LLM 进行智能翻译
- 仅翻译描述性内容，保留代码块、URL、变量名等
- 翻译过程中显示加载动画
- 支持撤销更改恢复原文


## 五、VibeWorker 对话记忆管理系统设计
### 1. 本地优先原则
所有记忆文件（Markdown/JSON）均存储在本地文件系统，确保完全的数据主权和可解释性。不使用任何外部数据库（无 SQLite/Redis/向量数据库），搜索索引仅为派生层，可从源文件重建。

### 2. 记忆架构 ✅ 已实现

参考 OpenClaw 架构，VibeWorker 采用双层记忆系统：

#### 2.1 长期记忆 (MEMORY.md)
+ **路径**：`backend/memory/MEMORY.md`
+ **性质**：跨会话持久信息，按分类组织
+ **分类**：
    - `preferences`（用户偏好）：用户习惯、喜好、工作方式
    - `facts`（重要事实）：项目信息、环境配置、关键事实
    - `tasks`（任务备忘）：待办事项、提醒、截止日期
    - `reflections`（反思日志）：经验教训、改进建议
    - `general`（通用记忆）：其他值得记住的信息
+ **条目格式**：`- [YYYY-MM-DD][entry_id] 内容描述`
+ **写入方式**：Agent 通过 `memory_write` 工具写入，**禁止** `terminal echo >>` 方式

#### 2.2 每日日志 (Daily Logs)
+ **路径**：`backend/memory/logs/YYYY-MM-DD.md`
+ **性质**：短期情景记忆，按天自动分文件
+ **用途**：任务执行摘要、临时事项、日程计划、对话中发现的重要信息
+ **条目格式**：`- [HH:MM] 内容描述`
+ **System Prompt 注入**：自动加载今天+昨天的日志（可配置天数）

#### 2.3 记忆搜索
+ **语义搜索**：基于 LlamaIndex VectorStoreIndex（复用现有 Embedding 配置），索引持久化到 `storage/memory_index/`
+ **降级方案**：无 Embedding 配置时，自动降级为关键词匹配搜索
+ **搜索范围**：MEMORY.md + 所有 Daily Logs

#### 2.4 自动记忆提取（可选，默认关闭）
+ **触发时机**：每次对话结束后（SSE `done` 事件后）
+ **工作原理**：取最近 3 轮对话，用 LLM 提取偏好/事实/任务，写入当天 Daily Log 并标记 `[auto]` 前缀
+ **配置**：`MEMORY_AUTO_EXTRACT=false`（默认关闭，避免额外 LLM 成本）

#### 2.5 记忆管理器 (MemoryManager)
核心类 `backend/memory_manager.py`，提供以下能力：
+ MEMORY.md 结构化解析、条目增删、去重
+ Daily Log 追加写入、读取、列表
+ 记忆统计信息
+ 自动提取 Hook

### 3. 系统提示词 (System Prompt) 构成
System Prompt 由以下部分动态拼接而成（按顺序）：

1. `SKILLS_SNAPSHOT.md` (能力列表)
2. `SOUL.md` (核心设定)
3. `IDENTITY.md` (自我认知)
4. `USER.md` (用户画像)
5. `AGENTS.md` (行为准则 & **记忆操作指南**)
6. `MEMORY.md` (长期记忆) + **Daily Logs (今天+昨天日志)**

**截断策略**：
+ 单文件超 20k 字符时截断并添加 `...[truncated]`
+ 记忆部分有独立的 Token 预算（`MEMORY_MAX_PROMPT_TOKENS`，默认 4000 tokens），优先级：MEMORY.md > 今天日志 > 昨天日志，超出预算时从最旧内容开始截断

### 4. AGENTS.md 的默认配置 (核心修正)
由于 Agent 默认并不知道它是通过"阅读文件"来学习技能的，因此必须在初始化时生成一个包含明确指令的 `AGENTS.md`。

+ **必须包含的元指令 (Meta-Instructions)**：
    - 技能调用协议（SKILL PROTOCOL）
    - 技能创建协议（SKILL CREATION PROTOCOL）
    - **记忆协议（MEMORY PROTOCOL）**：
        * 声明 `memory_write` 和 `memory_search` 两个专用工具
        * 说明长期记忆 vs 每日日志的使用场景
        * **必须**使用 `memory_write` 写入记忆，**禁止** `terminal echo >>`
        * **必须**使用 `memory_search` 搜索历史记忆
    - 对话协议（CHAT PROTOCOL）

### 5. 记忆配置项 ✅ 已实现

```bash
MEMORY_AUTO_EXTRACT=false       # 自动提取记忆（默认关闭）
MEMORY_DAILY_LOG_DAYS=2         # System Prompt 中加载最近几天的日志
MEMORY_MAX_PROMPT_TOKENS=4000   # 记忆在 Prompt 中的 Token 上限
MEMORY_INDEX_ENABLED=true       # 记忆语义搜索索引开关
```

### 6. 会话存储 (Sessions)
+ **路径**：`backend/sessions/{session_name}.json`
+ **格式**：标准 JSON 数组，包含 `user`, `assistant`, `tool` (function calls) 类型的完整消息记录。

## 六、后端 API 接口规范 (FastAPI)
后端服务作为独立进程运行，负责 Agent 逻辑、文件读写和状态管理。

+ **服务端口**：`8088`
+ **基础 URL**：`http://localhost:8088`

### 1. 核心对话接口
+ **Endpoint**: `POST /api/chat`
+ **功能**: 发送用户消息，获取 Agent 回复。
+ **Request**:

```plain
{
  "message": "查询一下北京的天气",
  "session_id": "main_session",
  "stream": true
}
```

+ **Response**: 支持 **SSE (Server-Sent Events)** 流式输出，实时推送 Agent 的思考过程 (Thought/Tool Calls) 和最终回复。

### 2. 文件管理接口 (用于前端编辑器)
+ **Endpoint**: `GET /api/files` - 读取指定文件内容（Query: `path=memory/MEMORY.md`）。
+ **Endpoint**: `POST /api/files` - 保存文件修改（Body: `{ "path": "...", "content": "..." }`）。
+ **Endpoint**: `GET /api/files/tree` - 获取项目文件树结构（Query: `root=`，可选子目录）。

### 3. 会话管理接口
+ **Endpoint**: `GET /api/sessions` - 获取所有历史会话列表。
+ **Endpoint**: `GET /api/sessions/{session_id}` - 获取指定会话的消息记录。
+ **Endpoint**: `POST /api/sessions` - 创建新会话。
+ **Endpoint**: `DELETE /api/sessions/{session_id}` - 删除指定会话。

### 4. 技能管理接口
+ **Endpoint**: `GET /api/skills` - 获取所有已安装技能列表（含 name, description, location）。
+ **Endpoint**: `DELETE /api/skills/{skill_name}` - 删除指定技能（删除整个技能文件夹）。

### 5. 知识库接口
+ **Endpoint**: `POST /api/knowledge/rebuild` - 强制重建 RAG 知识库索引。

### 6. 模型池接口 ✅ 已实现

模型配置统一由模型池管理（`~/.vibeworker/model_pool.json`），替代原有 `.env` 中分散的模型配置。

+ **Endpoint**: `GET /api/model-pool` - 获取模型池列表和场景分配。
    - 返回：`{ "models": [...], "assignments": { "llm": "id", "embedding": "id", "translate": "id" } }`
    - API Key 自动脱敏（前4后4，中间 `***`）
+ **Endpoint**: `POST /api/model-pool` - 添加模型。
    - Body: `{ "name": "GPT-4o", "api_key": "sk-...", "api_base": "https://...", "model": "gpt-4o" }`
+ **Endpoint**: `PUT /api/model-pool/{model_id}` - 更新模型配置。
    - 脱敏格式的 api_key 不会覆盖原值
+ **Endpoint**: `DELETE /api/model-pool/{model_id}` - 删除模型。
    - 已分配给场景的模型不可删除（409），需先重新分配
+ **Endpoint**: `PUT /api/model-pool/assignments` - 更新场景分配。
    - Body: `{ "llm": "model_id", "embedding": "model_id", "translate": "model_id" }`
    - 变更后自动清除 Prompt 缓存
+ **Endpoint**: `POST /api/model-pool/{model_id}/test` - 测试模型连接。
    - 发送短提示词测试连通性，返回模型回复

**自动迁移**：首次访问时自动从 `.env` 中的 `OPENAI_API_KEY`/`EMBEDDING_*`/`TRANSLATE_*` 迁移到模型池，相同 key+base 合并为一条。

### 7. 设置管理接口
+ **Endpoint**: `GET /api/settings` - 获取当前全局配置（Temperature、Max Tokens、记忆、缓存、安全等），数据读取自 `~/.vibeworker/.env`。
+ **Endpoint**: `PUT /api/settings` - 更新全局配置，写回 `.env` 文件。
+ **说明**：模型 API Key/Base/Model 已由模型池管理，`.env` 仅存放全局参数和非模型配置。
+ **安全写入保护 ✅ 已实现**：写入前校验目标路径不在项目源码目录（`PROJECT_ROOT`）内。

### 8. 健康检查
+ **Endpoint**: `GET /api/health` - 返回后端状态、版本号和当前模型名称。

### 8. 技能商店接口 ✅ 已实现
+ **Endpoint**: `GET /api/store/skills` - 获取远程技能列表。
    - Query 参数：`category`（分类筛选）、`page`（页码）、`page_size`（每页数量）
    - 返回：技能列表、总数、版本号
+ **Endpoint**: `GET /api/store/search` - 搜索技能。
    - Query 参数：`q`（搜索关键词）
    - 返回：匹配的技能列表
+ **Endpoint**: `GET /api/store/skills/{name}` - 获取技能详情。
    - 返回：技能元数据、SKILL.md 内容、所需工具等
+ **Endpoint**: `POST /api/store/install` - 安装技能。
    - Body: `{ "skill_name": "...", "version": "..." }`
    - 返回：安装状态和消息
+ **Endpoint**: `POST /api/skills/{skill_name}/update` - 更新已安装技能。
+ **Endpoint**: `GET /api/store/categories` - 获取可用分类列表。

### 9. 翻译接口 ✅ 已实现
+ **Endpoint**: `POST /api/translate` - 翻译内容为中文。
    - Body: `{ "content": "...", "target_language": "zh-CN" }`
    - 返回：`{ "status": "ok", "translated": "...", "source_language": "en", "target_language": "zh-CN" }`
    - 说明：使用 LLM 进行智能翻译，仅翻译描述性文本，保留代码块和技术标识符。

### 10. 记忆管理接口 ✅ 已实现
+ **Endpoint**: `GET /api/memory/entries` - 列出 MEMORY.md 条目。
    - Query 参数：`category`（分类筛选，可选）、`page`（页码）、`page_size`（每页数量）
    - 返回：条目列表（含 entry_id, content, category, timestamp）、总数、分页信息
+ **Endpoint**: `POST /api/memory/entries` - 添加记忆条目。
    - Body: `{ "content": "...", "category": "preferences" }`
    - 返回：创建的条目详情（含自动生成的 entry_id）
+ **Endpoint**: `DELETE /api/memory/entries/{entry_id}` - 删除单条记忆。
+ **Endpoint**: `GET /api/memory/daily-logs` - 列出所有 Daily Log 文件。
    - 返回：日志列表（含 date, path, size），按日期倒序
+ **Endpoint**: `GET /api/memory/daily-logs/{date}` - 获取指定日期的日志内容。
    - 返回：`{ "date": "2026-02-15", "content": "..." }`
+ **Endpoint**: `DELETE /api/memory/daily-logs/{date}` - 删除指定日期的日志文件。
    - 返回：`{ "status": "ok", "deleted": "2026-02-15" }`
    - 注：与 GET 合并为 `api_route` 实现，避免 Starlette 同路径不同方法的路由冲突
+ **Endpoint**: `POST /api/memory/search` - 搜索记忆。
    - Body: `{ "query": "...", "top_k": 5 }`
    - 返回：搜索结果（语义搜索优先，降级为关键词匹配）
+ **Endpoint**: `GET /api/memory/stats` - 记忆统计信息。
    - 返回：总条目数、各分类计数、日志文件数、配置状态
+ **Endpoint**: `POST /api/memory/reindex` - 强制重建记忆搜索索引。

### 11. 缓存管理接口 ✅ 已实现
+ **Endpoint**: `GET /api/cache/stats` - 获取缓存统计信息。
    - 返回：各类缓存的命中率、未命中数、占用大小等统计数据
    - 包含：URL 缓存、LLM 缓存、Prompt 缓存、翻译缓存的详细统计
+ **Endpoint**: `POST /api/cache/clear` - 清空缓存。
    - Query 参数：`cache_type`（url/llm/prompt/translate/all，默认 all）
    - 返回：清理结果和状态
+ **Endpoint**: `POST /api/cache/cleanup` - 清理过期缓存。
    - 自动清理所有过期的缓存文件
    - 返回：清理数量和状态

## 七、前端开发要求
### 1. 设计理念与布局架构
前端采用 **IDE（集成开发环境）风格**，**可拖拽调整宽度的三栏式布局**。

+ **左侧 (Sidebar)**：导航 (Chat/Memory/Skills/Cache) + 会话列表。
    - 宽度范围：200px ~ 400px（默认 256px），可拖拽调整。
    - **默认选中最新会话 ✅ 已实现**：页面首次加载时自动选中最近修改的会话（后端按 `st_mtime` 降序排列），替代硬编码的 `main_session` 默认值。
    - 会话标题：最多显示两行，超出截断；无消息的新会话显示「新会话」。
    - 技能列表：每项右侧显示删除按钮（hover 可见），点击弹出确认后删除。
    - **记忆面板 ✅ 已实现**：三 Tab 设计
        * **记忆 Tab**：持久记忆条目管理，分类筛选（全部/偏好/事实/任务/反思/通用）+ 搜索 + 添加/删除
        * **日记 Tab**：按日期倒序列出 Daily Log 文件，点击在 Inspector 中打开，支持删除日志文件（hover 显示删除图标）
        * **人格 Tab**：Agent 人格定义文件快捷入口（MEMORY.md/SOUL.md/IDENTITY.md/USER.md/AGENTS.md）
    - **会话列表滑动选中动画 ✅ 已实现**：选中会话时显示平滑滑动的高亮背景指示器，跟随选中项移动
+ **中间 (Stage)**：对话流 + **思考链可视化** (Collapsible Thoughts)。
    - 宽度自适应填充剩余空间。
    - **工具调用友好化展示**：
        * 工具名称映射为中文标签 + Emoji（如 `read_file` -> 📄 读取文件、`memory_write` -> 💾 存储记忆、`memory_search` -> 🧠 搜索记忆）。
        * 输入参数从 JSON 中提取关键信息作为摘要显示。
        * 展开详情后，Input 和 Output 均使用 Markdown 渲染（代码块语法高亮、标题、列表等），`\n` 自动转换为实际换行。
    - **工具审批增强 ✅ 已实现**：
        * 高风险工具（terminal、python_repl 等）执行前弹出审批对话框
        * 支持「允许」「拒绝」「本次会话均允许」三种选择
        * 「本次会话均允许」将该工具加入会话白名单，后续调用自动批准，无需重复确认
    - **缓存指示器** ✅ 已实现：
        * 工具调用使用缓存时，显示 ⚡ 图标（灰色半透明，不显眼）。
        * 鼠标悬停显示「使用缓存」提示。
        * 自动检测后端返回的 `[CACHE_HIT]` 标记或 `cached: true` 字段。
+ **右侧 (Inspector)**：Monaco Editor，用于实时查看/编辑正在使用的 `SKILL.md` 或 `MEMORY.md`。
    - 宽度范围：280px ~ 600px（默认 384px），可拖拽调整。
+ **分隔条**：宽 4px，hover 显示蓝色半透明高亮，拖拽中高亮加深。

### 2. 技术栈
+ **框架**: Next.js 14+ (App Router), TypeScript
+ **UI**: Shadcn/UI, Tailwind CSS v4, Lucide Icons
+ **Editor**: Monaco Editor (配置为 Light Theme)
+ **Markdown 渲染**: react-markdown + remark-gfm
+ **代码语法高亮**: react-syntax-highlighter (Prism, oneLight 主题)
+ **字体**: Google Fonts (Inter + JetBrains Mono)，通过 layout.tsx 中 link 标签引入

### 3. UI/UX 风格规范
+ **色调**: **浅色 Apple 风格 (Frosty Glass)**。
    - 背景：纯白/极浅灰 (`#fafafa`)，高透毛玻璃效果。
    - 强调色：**支付宝蓝** (Alipay Blue) 或 **阿里橙**。
+ **导航栏**: 顶部固定，半透明。
    - 左侧：**"VibeWorker"** + 版本号
    - 右侧：后端状态指示器（在线/离线）+ ⚙️ 设置按钮（弹窗配置 LLM/Embedding 模型参数）+ Inspector 开关按钮
+ **设置弹窗 (Settings Dialog)**：
    - 点击导航栏设置按钮打开，分「通用」「模型」「记忆」「任务」「缓存」「安全」六个 Tab。
    - **通用 Tab**：显示数据目录路径（只读）、主题切换（明亮/暗黑）。
    - **模型 Tab ✅ 已实现**：模型池架构，替代原有分散的模型配置。
        * **模型池列表**：显示所有已配置模型，支持添加（弹窗表单）、编辑、删除、测试连接。
        * **场景分配**：通过下拉选择为「主模型」「Embedding」「翻译」三个场景分配模型，即时生效。
        * **全局参数**：Temperature 和 Max Tokens，跟随「保存配置」按钮写入 `.env`。
        * 模型配置存储在 `~/.vibeworker/model_pool.json`，与 `.env` 分离。
    - **记忆 Tab ✅ 已实现**：配置自动提取开关、语义搜索索引开关、日志加载天数、记忆 Token 预算。
    - 保存后自动关闭弹窗，全局配置写入后端 `.env` 文件。
+ **代码块样式**：
    - 工具调用详情中的代码块采用浅色背景（`#f6f8fb`）+ 蓝色左边条 + Prism 语法高亮。
    - 使用 JetBrains Mono 等宽字体，字号 `0.7rem`。


## 八、启动与运行 ✅ 已实现

### 1. 一键启动脚本
项目根目录提供跨平台启动脚本，支持前后端同时启动/停止/重启：

**Linux/macOS/Git Bash:**
```bash
./start.sh              # 启动前后端
./start.sh stop         # 停止所有服务
./start.sh restart      # 重启所有服务
./start.sh status       # 查看运行状态
./start.sh logs backend # 查看后端日志
./start.sh backend restart  # 仅重启后端
./start.sh frontend restart # 仅重启前端
```

**Windows CMD:**
```cmd
start.bat               # 启动前后端
start.bat stop          # 停止所有服务
start.bat restart       # 重启所有服务
start.bat status        # 查看运行状态
```

**脚本特性：**
- 自动检测并激活 Python 虚拟环境（venv/.venv）
- PID 管理，避免重复启动
- 优雅终止进程，超时后强制终止
- 日志文件保存在 `.pids/` 目录
- 彩色状态输出（Bash 版本）

### 2. 手动启动
```bash
# 后端 (http://localhost:8088)
cd backend && pip install -r requirements.txt && python app.py

# 前端 (http://localhost:3000)
cd frontend && npm install && npm run dev
```

## 九、项目目录结构参考
建议 Claude Code 按照以下结构进行初始化：

```plain
vibeworker/
├── backend/                    # FastAPI + LangChain/LangGraph（只读源码）
│   ├── app.py                  # 入口文件 (Port 8088)
│   ├── config.py               # Pydantic Settings（含数据目录安全校验）
│   ├── model_pool.py           # 模型池管理（CRUD、场景分配、resolve_model）✅
│   ├── prompt_builder.py       # System Prompt 动态拼接
│   ├── sessions_manager.py     # 会话管理器
│   ├── memory_manager.py       # 记忆管理中心（MemoryManager 核心类）✅
│   ├── session_context.py      # 会话上下文管理（session_id → 临时目录映射）✅
│   ├── requirements.txt
│   ├── user_default/           # 首次运行模板，自动复制到 ~/.vibeworker/
│   │   ├── .env                # 环境变量模板（API Key 等）
│   │   ├── mcp_servers.json    # MCP 服务器默认配置
│   │   ├── memory/
│   │   │   └── MEMORY.md       # 长期记忆初始模板
│   │   ├── workspace/          # System Prompt 模板
│   │   │   ├── SOUL.md         # 核心设定
│   │   │   ├── IDENTITY.md     # 自我认知
│   │   │   ├── USER.md         # 用户画像
│   │   │   └── AGENTS.md       # 行为准则 & 记忆协议
│   │   └── knowledge/
│   │       └── README.md       # 知识库说明
│   ├── cache/                  # 智能缓存系统 ✅
│   │   ├── __init__.py         # 缓存模块入口（导出全局缓存实例）
│   │   ├── base.py             # 基础缓存类接口
│   │   ├── memory_cache.py     # L1 内存缓存（LRU + TTL）
│   │   ├── disk_cache.py       # L2 磁盘缓存（JSON 存储）
│   │   ├── url_cache.py        # URL 专用缓存
│   │   ├── llm_cache.py        # LLM 专用缓存（含流式处理）
│   │   ├── prompt_cache.py     # Prompt 拼接缓存
│   │   ├── translate_cache.py  # 翻译缓存
│   │   └── tool_cache_decorator.py # 通用工具缓存装饰器
│   ├── store/                  # 技能商店模块 ✅
│   │   ├── __init__.py         # SkillsStore 核心逻辑 (skills.sh 集成)
│   │   └── models.py           # Pydantic 模型 (RemoteSkill, SkillDetail 等)
│   ├── tools/                  # Core Tools 实现（7 个内置工具，只读）
│   │   ├── memory_write_tool.py    # 记忆写入工具 ✅
│   │   ├── memory_search_tool.py   # 记忆搜索工具 ✅
│   │   └── ...                 # terminal, python_repl, fetch_url, read_file, rag
│   ├── mcp_module/             # MCP 集成模块（避免与 pip 包冲突）
│   ├── security/               # 安全沙箱模块
│   └── graph/                  # LangGraph Agent 编排
│       └── agent.py            # create_agent 配置
│
├── ~/.vibeworker/              # 用户数据目录（所有可写数据，与源码隔离）
│   ├── .env                    # 用户环境变量（全局参数，首次从 user_default/.env 复制）
│   ├── model_pool.json         # 模型池配置（模型列表+场景分配）✅
│   ├── mcp_servers.json        # MCP 服务器配置
│   ├── sessions/               # JSON 会话记录
│   ├── memory/                 # 记忆存储
│   │   ├── MEMORY.md           # 长期记忆（按分类组织的结构化条目）
│   │   └── logs/               # Daily Logs（每日日志，YYYY-MM-DD.md）
│   ├── skills/                 # Agent Skills（本地已安装技能）
│   ├── workspace/              # System Prompts (SOUL.md, AGENTS.md, etc.)
│   ├── tmp/                    # 会话临时工作目录（每个会话独立子目录）✅
│   ├── knowledge/              # RAG 知识库文档
│   ├── storage/                # 索引持久化存储
│   ├── .cache/                 # 缓存存储 (url/ llm/ prompt/ translate/ tool_*/)
│   └── logs/                   # 应用日志
│
├── frontend/                   # Next.js 14+ (App Router)
│   ├── src/
│   │   ├── app/
│   │   │   ├── layout.tsx      # 根布局 (字体引入)
│   │   │   ├── page.tsx        # 三栏可拖拽布局
│   │   │   └── globals.css     # 全局 CSS 主题与组件样式
│   │   ├── components/
│   │   │   ├── chat/           # ChatPanel (对话流 + 工具调用可视化)
│   │   │   ├── sidebar/        # Sidebar (会话/记忆/技能导航 + 商店入口)
│   │   │   ├── MemoryPanel.tsx # 记忆面板（三 Tab：记忆/日记/人格）✅
│   │   │   ├── editor/         # InspectorPanel (Monaco Editor + 翻译功能)
│   │   │   ├── store/          # 技能商店组件 ✅
│   │   │   │   ├── SkillsStoreDialog.tsx  # 商店弹窗主组件
│   │   │   │   ├── SkillCard.tsx          # 技能卡片
│   │   │   │   └── SkillDetail.tsx        # 技能详情页
│   │   │   ├── settings/       # SettingsDialog (模型配置弹窗)
│   │   │   └── ui/             # Shadcn/UI 基础组件
│   │   └── lib/
│   │       ├── api.ts          # API 客户端 (含 Store/Translate API)
│   │       └── sessionStore.ts # 会话状态管理
│   └── package.json
│
├── scripts/                    # CLI 工具 ✅
│   ├── skills.sh               # Linux/macOS 技能管理脚本
│   └── skills.bat              # Windows 技能管理脚本
│
├── start.sh                    # 启动脚本 (Linux/macOS/Git Bash) ✅
├── start.bat                   # 启动脚本 (Windows CMD) ✅
└── README.md
```

**数据目录隔离说明：**
- `backend/` 为只读源码目录（`PROJECT_ROOT`），不存储任何用户数据
- `~/.vibeworker/` 为用户数据目录（`DATA_DIR`），可通过环境变量自定义
- 首次运行时，`config.py` 自动将 `user_default/` 下的模板复制到 `~/.vibeworker/`
- 安全校验：`DATA_DIR` 不允许指向 `PROJECT_ROOT` 内部，否则自动回退到 `~/.vibeworker/`

