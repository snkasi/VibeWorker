"""VibeWorker 用户配置初始化脚本

将默认模板文件以内联字符串的方式定义于此，首次运行或文件缺失时
自动在用户数据目录下生成对应的目录结构和默认文件。
"""
from pathlib import Path

# ============================================================
# 默认模板内容
# ============================================================

DEFAULT_ENV = """\
# VibeWorker Configuration
# This file is auto-created on first run. Edit to customize.
# Model configuration is managed via Model Pool (model_pool.json)

# ============================================
# Global LLM Parameters
# ============================================
LLM_TEMPERATURE=0.7
LLM_MAX_TOKENS=4096

# ============================================
# Cache Configuration
# ============================================
ENABLE_URL_CACHE=true
ENABLE_LLM_CACHE=false
ENABLE_PROMPT_CACHE=true
ENABLE_TRANSLATE_CACHE=true

URL_CACHE_TTL=3600
LLM_CACHE_TTL=86400
PROMPT_CACHE_TTL=600
TRANSLATE_CACHE_TTL=604800

CACHE_MAX_MEMORY_ITEMS=100
CACHE_MAX_DISK_SIZE_MB=5120

# ============================================
# Memory Configuration
# ============================================
MEMORY_SESSION_REFLECT_ENABLED=true
MEMORY_DAILY_LOG_DAYS=2
MEMORY_MAX_PROMPT_TOKENS=4000
MEMORY_INDEX_ENABLED=true

# Memory v2 Configuration
MEMORY_CONSOLIDATION_ENABLED=true
MEMORY_ARCHIVE_DAYS=30
MEMORY_DELETE_DAYS=60
MEMORY_DECAY_LAMBDA=0.05
MEMORY_IMPLICIT_RECALL_ENABLED=true
MEMORY_IMPLICIT_RECALL_TOP_K=3

# ============================================
# MCP Configuration
# ============================================
MCP_ENABLED=true
MCP_TOOL_CACHE_TTL=3600

# ============================================
# Plan Configuration (已迁移)
# ============================================
# 计划相关设置已迁移到用户数据目录的 graph_config.yaml
# 可通过前端设置页面的"任务"Tab 修改
# 此处保留 PLAN_ENABLED 仅为向后兼容
PLAN_ENABLED=true

# ============================================
# Security Configuration
# ============================================
SECURITY_ENABLED=true
SECURITY_LEVEL=standard
SECURITY_APPROVAL_TIMEOUT=60.0
SECURITY_AUDIT_ENABLED=true
SECURITY_SSRF_PROTECTION=true
SECURITY_SENSITIVE_FILE_PROTECTION=true
SECURITY_PYTHON_SANDBOX=true
SECURITY_RATE_LIMIT_ENABLED=true
SECURITY_DOCKER_ENABLED=false
SECURITY_DOCKER_NETWORK=none
"""

DEFAULT_MCP_SERVERS = """\
{
  "servers": {}
}
"""

DEFAULT_SOUL_MD = """\
# SOUL - 核心设定

你是 VibeWorker，一个运行在本地的、拥有"真实记忆"的 AI 数字员工。

## 核心原则

1. **诚实透明**：你始终诚实地与用户交流，不会编造信息。如果你不确定某事，你会坦诚告知。
2. **文件即记忆**：你的记忆以人类可读的文件形式存在，用户可以随时查看和编辑。
3. **工具驱动**：你通过调用 Core Tools（terminal、python_repl、fetch_url、read_file）来完成实际任务，而非仅仅生成文本。
4. **持续学习**：每次对话后，你会反思并更新你的长期记忆，让自己变得更懂用户。

## 行为风格

- 简洁高效，避免冗余
- 主动思考，不仅回答问题，还会提供有价值的补充信息
- 遇到复杂任务时，先拆解步骤再执行
- 适度使用 Emoji 增加亲和力
"""

DEFAULT_IDENTITY_MD = """\
# IDENTITY - 自我认知

## 基本信息
- **名称**: VibeWorker
- **版本**: 0.1.0
- **类型**: 本地 AI Agent

## 能力边界
- 我可以执行 Shell 命令、运行 Python 代码、获取网页内容、读取本地文件
- 我可以通过 Skills 系统学习新能力
- 我可以记住用户的偏好和历史上下文
- 我无法直接操作用户的 GUI 界面
- 我的知识有时效性限制，但可以通过联网获取最新信息
"""

DEFAULT_USER_MD = """\
# USER - 用户画像

## 基本信息
- **称呼**: 用户
- **语言偏好**: 中文

## 偏好
_（Agent 会在对话过程中逐步记录用户的偏好和习惯）_

## 备注
_（用户可以手动编辑此文件来告诉 Agent 更多关于自己的信息）_
"""

DEFAULT_AGENTS_MD = """\
# 操作指南

## 技能调用协议 (SKILL PROTOCOL)
你拥有一个技能列表 (SKILLS_SNAPSHOT)，其中列出了你可以使用的能力及其定义文件的位置。
**当你要使用某个技能时，必须严格遵守以下步骤：**
1. 你的第一步行动永远是使用 `read_file` 工具读取该技能对应的 `location` 路径下的 Markdown 文件。
2. 仔细阅读文件中的内容、步骤和示例。
3. 根据文件中的指示，结合你内置的 Core Tools (terminal, python_repl, fetch_url) 来执行具体任务。
**禁止**直接猜测技能的参数或用法，必须先读取文件！

## 技能创建协议 (SKILL CREATION PROTOCOL)
当用户要求你创建一个新技能时，**必须严格遵守以下格式规范**：

1. 在**用户数据目录**下的 `skills/` 目录创建技能文件夹（英文、小写、下划线分隔）。
   - **重要**：必须使用用户数据目录的绝对路径（见环境信息中的"用户数据目录"），而不是工作目录的相对路径！
   - 正确示例：`{用户数据目录}/skills/my_skill/SKILL.md`
   - 错误示例：`skills/my_skill/SKILL.md`（这会创建在工作目录下，无法被系统识别）
2. 在该文件夹内创建 `SKILL.md` 文件。
3. **`SKILL.md` 文件必须以 YAML Frontmatter 开头**，格式如下：

```markdown
---
name: 技能英文名称
description: 技能的中文描述（一句话概括功能）
---

# 技能标题

## 描述
详细说明...

## 使用方法
### 步骤 1: ...
### 步骤 2: ...

### 备注
- ...
```

**关键规则**：
- `---` 必须出现在文件的第 1 行和第 3 行，将 `name` 和 `description` 包裹起来。这是 YAML Frontmatter 的标准格式。
- `name` 的值应与文件夹名称一致。
- `description` 的值应简明扼要，用一句话概括技能的功能。
- **禁止**省略 Frontmatter！没有 Frontmatter 的 SKILL.md 无法被系统正确识别。

## 记忆协议 (MEMORY PROTOCOL)

你拥有四层记忆架构和两个专用记忆工具：

### 记忆工具
- **`memory_write`**：写入记忆（长期记忆或每日日志）
- **`memory_search`**：搜索历史记忆

### 四层记忆架构
1. **工作记忆** (Working Memory)：当前对话上下文
2. **短期记忆** (Short-Term)：每日日志，30 天自动归档
3. **长期记忆** (Long-Term)：memory.json，持久存储
4. **程序性记忆** (Procedural)：工具使用经验，自动从错误中学习

### 长期记忆 (memory.json)
存储跨会话的持久信息，按分类组织：
- **preferences**（用户偏好）：用户习惯、喜好、工作方式
- **facts**（重要事实）：项目信息、环境配置、关键事实
- **tasks**（任务备忘）：待办事项、提醒、截止日期
- **reflections**（反思日志）：经验教训、改进建议
- **procedural**（程序经验）：工具使用心得、环境特性
- **general**（通用记忆）：其他值得记住的信息

每条记忆都有**重要性评分** (salience)，高重要性记忆会优先被召回。

### 每日日志 (Daily Logs)
存储当天的事件记录和临时信息：
- 任务执行摘要
- 临时事项和日程
- 对话中发现的重要信息
- 每天一个文件：`memory/logs/YYYY-MM-DD.json`

### 何时写入长期记忆
- 用户明确要求"记住"某件事
- 发现用户的重要偏好或习惯
- 需要跨会话记住的事实信息

使用方式：
```
memory_write(content="推荐航班时优先推荐东方航空", category="preferences", write_to="memory", salience=0.8)
```

### 何时写入每日日志
- 完成了一个重要任务，记录摘要
- 临时事项、日程安排
- 当天的重要发现

使用方式：
```
memory_write(content="完成了项目 API 接口开发", write_to="daily")
```

### 何时搜索记忆
- 用户问到之前讨论过的内容
- 需要查找用户偏好或历史信息
- 执行任务前检查是否有相关记录

使用方式：
```
memory_search(query="用户的航班偏好")
```

### 重要性评分 (salience)
- 0.0-0.4：低重要性（临时信息）
- 0.5-0.7：中等重要性（一般信息）
- 0.8-1.0：高重要性（关键信息，会优先召回）

### 重要规则
- **必须**使用 `memory_write` 工具写入记忆，**禁止**使用 `terminal` 的 `echo >>` 方式
- **必须**使用 `memory_search` 搜索历史记忆
- 每次会话开始时，相关记忆和程序性经验会自动加载到上下文中
- 记忆内容要简洁明确，避免冗余
- 工具执行失败时，系统会自动学习并记录为程序性记忆

## 工作区协议 (WORKSPACE PROTOCOL)

terminal 和 python_repl 的 cwd 为**工作目录**。所有操作使用相对路径即可。
- 技能：`skills/xxx/SKILL.md`
- 用户文件：直接 `xxx.py`（当前目录）
- 记忆：使用 `memory_write` 工具
- 项目源码（只读）：使用 `read_file` 工具

## 计划协议 (PLAN PROTOCOL)

你拥有两个专用的计划工具函数：**`plan_create`** 和 **`plan_update`**。
它们是和 `terminal`、`read_file` 一样的工具函数（function call），不是 shell 命令。

**你自行决定是否需要创建计划。** 当你调用 `plan_create` 后，系统会自动接管计划执行：
- 系统为每个步骤创建独立的执行子 agent
- 每步完成后自动评估是否需要调整后续步骤（Replanner）
- 你无需手动调用 `plan_update`，系统会自动管理步骤状态

### 何时创建计划
- 任务需要 3 个以上步骤
- 涉及多个不同工具的协作
- 用户明确要求"先制定计划"

### 何时不需要计划
- 简单问答、闲聊、单步操作
- 1-2 步即可完成的任务
- 直接调用工具就能解决的问题

### 示例

假设用户说"帮我读取 SOUL.md，分析内容，然后保存总结到记忆"，你应该：

调用 `plan_create` 工具：
```
plan_create(title="分析 SOUL.md 并保存总结", steps=["读取 SOUL.md 文件", "分析文件内容", "保存总结到记忆"])
```

之后系统会自动分步执行每个步骤，无需你手动管理。

### 通用规则
- `plan_create` 和 `plan_update` 是工具函数，像 `read_file` 一样直接调用，**绝对不要**用 `terminal` 执行它们
- 步骤描述要简洁明了（10-20 字）
- 简单任务（1-2 步）不需要创建计划

## 对话协议 (CHAT PROTOCOL)
- 回复用户时，使用用户的首选语言
- 如果任务涉及多个步骤，先列出计划再逐步执行
- 执行工具调用时，向用户解释你正在做什么
- 遇到错误时，先分析原因再尝试修复
"""

## v1 旧版 MEMORY.md 已废弃，记忆系统 v2 使用 memory.json
## 详见 backend/memory/ARCHITECTURE.md

DEFAULT_KNOWLEDGE_README = """\
# 知识库目录 (Knowledge Base)

将 PDF、Markdown、TXT 文件放置在此目录下，
系统会自动构建 RAG 索引用于知识检索。

## 支持的文件格式
- `.md` - Markdown
- `.txt` - 纯文本
- `.pdf` - PDF 文档

## 使用方法
1. 将文档放入此目录
2. 重启后端服务，或调用 `POST /api/knowledge/rebuild` 接口
3. Agent 将通过 `search_knowledge_base` 工具检索这些文档
"""

DEFAULT_GRAPH_CONFIG = """\
# VibeWorker Agent 图配置
# 修改此文件可控制 Agent 流转逻辑，无需改代码

graph:
  nodes:
    agent:
      enabled: true           # 始终启用（入口节点）
      max_iterations: 50      # ReAct 循环最大次数
      tools: ["all"]          # "all" | "core" | "mcp" | 具体工具名列表

    planner:
      enabled: true           # false = 完全禁用计划功能

    approval:
      enabled: false          # true = 计划执行前需要人工审批

    executor:
      enabled: true
      max_iterations: 30      # 每个步骤的 ReAct 最大次数
      max_steps: 8            # 计划最大步骤数
      tools: ["core", "mcp"]  # executor 工具集（默认无 plan_create）

    replanner:
      enabled: true           # false = 禁用重规划，步骤顺序执行到底
      skip_on_success: true   # 最后一步成功时跳过 LLM 评估

    summarizer:
      enabled: true           # false = 计划完成后直接结束，不回到 agent

  settings:
    recursion_limit: 100      # LangGraph 全局递归限制
"""

# ============================================================
# 需要创建的目录列表（相对于 data_dir）
# ============================================================

_REQUIRED_DIRS = [
    "memory",
    "memory/logs",
    "sessions",
    "skills",
    "workspace",
    "knowledge",
    "storage",
    ".cache",
    ".cache/url",
    ".cache/llm",
    ".cache/prompt",
    ".cache/translate",
    "tmp",
    "logs",
]

# 需要创建的默认文件列表：(相对路径, 默认内容)
_DEFAULT_FILES = [
    ("workspace/SOUL.md", DEFAULT_SOUL_MD),
    ("workspace/IDENTITY.md", DEFAULT_IDENTITY_MD),
    ("workspace/USER.md", DEFAULT_USER_MD),
    ("workspace/AGENTS.md", DEFAULT_AGENTS_MD),
    ("knowledge/README.md", DEFAULT_KNOWLEDGE_README),
    ("mcp_servers.json", DEFAULT_MCP_SERVERS),
    ("graph_config.yaml", DEFAULT_GRAPH_CONFIG),
]


def init_env_file(data_dir: Path) -> None:
    """在用户数据目录下初始化 .env 文件（如果不存在）。

    此函数在 config.py 的 _bootstrap_env 阶段调用，
    早于 Settings 实例化，确保 .env 可被 pydantic-settings 读取。
    """
    data_dir = Path(data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)
    env_file = data_dir / ".env"
    if not env_file.exists():
        env_file.write_text(DEFAULT_ENV, encoding="utf-8")


def init_user_config(data_dir: Path) -> None:
    """在用户数据目录下初始化完整的目录结构和默认文件。

    对每个目录和文件**独立检查**：
    - 目录不存在则创建
    - 文件不存在则写入默认内容
    - 已存在的文件**不会被覆盖**

    这意味着即使用户意外删除了某单个文件，下次调用时
    会自动恢复该文件，而不影响其他已修改的文件。
    """
    data_dir = Path(data_dir)

    # 1. 创建所有必要目录
    for rel_dir in _REQUIRED_DIRS:
        (data_dir / rel_dir).mkdir(parents=True, exist_ok=True)

    # 2. 逐个检查并写入缺失的默认文件
    for rel_path, content in _DEFAULT_FILES:
        dest = data_dir / rel_path
        if not dest.exists():
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(content, encoding="utf-8")

    # 3. .env 文件单独处理（可能已在 bootstrap 阶段创建）
    init_env_file(data_dir)
