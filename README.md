# VibeWorker 超级数字员工

<p align="center">
  <strong>Your Local AI Digital Worker with Real Memory</strong>
</p>

---

VibeWorker 是一个轻量级且高度透明的 AI 数字员工 Agent 系统。它运行在本地，拥有"真实记忆"，可以帮助你处理各类任务——信息检索、数据处理、代码执行、文件管理等。

## 核心特性

- **文件即记忆 (File-first Memory)** — 所有记忆以 JSON 文件形式存储，人类可读可编辑
- **记忆系统 v2** — 四层记忆架构 + 智能整合 + 重要性评分 + 时间衰减 + 程序性记忆
- **技能即插件 (Skills as Plugins)** — 通过文件夹结构管理能力，拖入即用
- **技能商店 (Skills Store)** — 集成 [skills.sh](https://skills.sh/) 生态，一键浏览、搜索、安装 500+ 社区技能
- **智能缓存系统** — 双层缓存（内存+磁盘），显著提升响应速度（10-100x），节省 API 成本
- **透明可控** — 所有 Prompt 拼接、工具调用、记忆读写完全透明

## 技术栈

| 层级 | 技术 |
|------|------|
| 后端框架 | FastAPI (Python 3.10+) |
| Agent 引擎 | LangChain 1.x + LangGraph |
| RAG 引擎 | LlamaIndex |
| 前端框架 | Next.js 14+ (App Router) |
| UI 组件 | Shadcn/UI + Tailwind CSS |
| 代码编辑器 | Monaco Editor |

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

**后端启动**

```bash
cd backend
pip install -r requirements.txt
python app.py
```

后端将在 `http://localhost:8088` 启动。

**前端启动**

```bash
cd frontend
npm install
npm run dev
```

前端将在 `http://localhost:3000` 启动。

## 功能截图

### 技能商店

技能商店集成了 [skills.sh](https://skills.sh/) 生态系统，提供 500+ 社区技能：

- 浏览和搜索技能
- 按分类筛选（工具、数据、网络、自动化等）
- 一键安装到本地
- 支持技能翻译为中文

### 编辑器

Monaco Editor 支持：
- 实时编辑 SKILL.md / MEMORY.md 文件
- 语法高亮（Markdown、Python、JSON 等）
- 一键翻译技能文档为中文
- Ctrl+S 快捷保存

## 项目结构

```
vibeworker/
├── backend/                # FastAPI + LangChain/LangGraph
│   ├── app.py              # 入口文件
│   ├── config.py           # 配置管理
│   ├── store/              # 技能商店模块
│   │   ├── __init__.py     # SkillsStore 核心逻辑
│   │   └── models.py       # Pydantic 模型
│   ├── cache/              # 缓存系统模块
│   │   ├── memory_cache.py # L1 内存缓存
│   │   ├── disk_cache.py   # L2 磁盘缓存
│   │   ├── url_cache.py    # URL 缓存
│   │   ├── llm_cache.py    # LLM 缓存
│   │   └── tool_cache_decorator.py  # 通用工具缓存装饰器
│   ├── memory/             # 记忆存储
│   ├── sessions/           # 会话记录
│   ├── skills/             # Agent Skills
│   ├── workspace/          # System Prompts
│   ├── tools/              # Core Tools
│   ├── graph/              # Agent 编排
│   ├── knowledge/          # RAG 知识库
│   ├── storage/            # 索引持久化
│   └── requirements.txt
├── frontend/               # Next.js 14+
│   ├── src/
│   │   ├── app/
│   │   ├── components/
│   │   │   ├── chat/       # 对话面板
│   │   │   ├── sidebar/    # 侧边栏导航
│   │   │   ├── editor/     # Monaco 编辑器
│   │   │   ├── store/      # 技能商店组件
│   │   │   ├── settings/   # 设置弹窗
│   │   │   └── ui/         # Shadcn 基础组件
│   │   └── lib/
│   │       └── api.ts      # API 客户端
│   └── package.json
├── scripts/                # CLI 工具
│   ├── skills.sh           # Linux/macOS 技能管理脚本
│   └── skills.bat          # Windows 技能管理脚本
└── README.md
```

## CLI 工具

提供命令行工具管理技能：

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

## API 接口

### 核心接口

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/chat` | POST | 对话接口（支持 SSE 流式） |
| `/api/sessions` | GET/POST/DELETE | 会话管理 |
| `/api/files` | GET/POST | 文件读写 |
| `/api/skills` | GET/DELETE | 技能管理 |
| `/api/settings` | GET/PUT | 配置管理 |

### 技能商店接口

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/store/skills` | GET | 获取远程技能列表 |
| `/api/store/search` | GET | 搜索技能 |
| `/api/store/skills/{name}` | GET | 获取技能详情 |
| `/api/store/install` | POST | 安装技能 |
| `/api/translate` | POST | 翻译内容为中文 |

### 记忆管理接口

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/memory/entries` | GET/POST/DELETE | 记忆条目管理 |
| `/api/memory/search` | POST | 搜索记忆（支持时间衰减） |
| `/api/memory/consolidate` | POST | 智能记忆整合 |
| `/api/memory/procedural` | GET | 获取程序性记忆 |
| `/api/memory/archive` | POST | 归档旧日志 |
| `/api/memory/daily-logs` | GET/DELETE | 每日日志管理 |

### 缓存管理接口

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/cache/stats` | GET | 获取缓存统计信息 |
| `/api/cache/clear` | POST | 清空缓存（支持按类型） |
| `/api/cache/cleanup` | POST | 清理过期缓存 |

## 环境变量

在 `backend/.env` 中配置：

```env
LLM_API_KEY=your_api_key
LLM_API_BASE=https://api.openai.com/v1
LLM_MODEL=gpt-4o
LLM_TEMPERATURE=0.7
LLM_MAX_TOKENS=4096

EMBEDDING_API_KEY=your_api_key
EMBEDDING_API_BASE=https://api.openai.com/v1
EMBEDDING_MODEL=text-embedding-3-small

# 记忆系统 v2 配置
MEMORY_CONSOLIDATION_ENABLED=true     # 智能整合开关
MEMORY_REFLECTION_ENABLED=true        # 反思记忆开关
MEMORY_IMPLICIT_RECALL_ENABLED=true   # 隐式召回开关
MEMORY_ARCHIVE_DAYS=30                # 归档阈值（天）
MEMORY_DECAY_LAMBDA=0.05              # 衰减系数

# 缓存配置（可选）
ENABLE_URL_CACHE=true              # URL 缓存（默认开启）
ENABLE_LLM_CACHE=false             # LLM 缓存（默认关闭）
ENABLE_PROMPT_CACHE=true           # Prompt 缓存（默认开启）
ENABLE_TRANSLATE_CACHE=true        # 翻译缓存（默认开启）

URL_CACHE_TTL=3600                 # URL 缓存时间：1 小时
LLM_CACHE_TTL=86400                # LLM 缓存时间：24 小时
PROMPT_CACHE_TTL=600               # Prompt 缓存时间：10 分钟
TRANSLATE_CACHE_TTL=604800         # 翻译缓存时间：7 天
```

## 记忆系统 v2

VibeWorker 采用四层记忆架构，借鉴 Mem0 的智能记忆管理理念：

### 四层架构

| 层级 | 说明 | 存储 |
|------|------|------|
| **Working Memory** | 当前对话上下文 | 内存 (messages) |
| **Short-Term Memory** | 每日日志，30天归档 | `logs/YYYY-MM-DD.json` |
| **Long-Term Memory** | 持久记忆，智能整合 | `memory.json` |
| **Procedural Memory** | 工具使用经验 | `memory.json` (procedural) |

### 核心特性

- **智能整合**：ADD/UPDATE/DELETE/NOOP 语义决策，避免重复记忆
- **重要性评分 (salience)**：0.0-1.0 评分，高重要性记忆优先召回
- **时间衰减**：指数衰减曲线（14天衰减到50%），新记忆权重更高
- **隐式召回**：对话开始时自动检索相关记忆注入 System Prompt
- **程序性记忆**：自动从工具失败中学习，积累使用经验
- **自动归档**：30天摘要归档，60天清理

### 记忆分类

| 分类 | 用途 | 示例 |
|------|------|------|
| `preferences` | 用户偏好 | 喜欢东航、代码风格简洁 |
| `facts` | 重要事实 | API 地址、项目技术栈 |
| `tasks` | 任务备忘 | 待办事项、提醒 |
| `reflections` | 反思总结 | 经验教训 |
| `procedural` | 程序经验 | 工具使用心得、环境特性 |
| `general` | 通用信息 | 其他 |

详细文档：`backend/memory/ARCHITECTURE.md`

---

## 缓存系统

VibeWorker 内置智能缓存系统，显著提升性能并节省 API 成本。

### 特性

- **双层缓存架构**：L1 内存缓存（毫秒级）+ L2 磁盘缓存（持久化）
- **多种缓存类型**：URL、LLM、Prompt、翻译、通用工具缓存
- **可视化指示器**：前端显示 ⚡ 图标，一目了然
- **灵活配置**：通过 `.env` 精细控制每种缓存
- **自动清理**：定时清理过期缓存 + LRU 淘汰

### 性能提升

| 操作 | 无缓存 | 有缓存 | 提升 |
|------|--------|--------|------|
| 网页请求 | ~500-2000ms | ~10-50ms | **10-100x** |
| LLM 调用 | ~2000-5000ms | ~100-300ms | **10-20x** |
| 翻译 API | ~1000-2000ms | ~5-20ms | **50-200x** |

### 为自定义工具添加缓存

只需一行装饰器：

```python
from cache import cached_tool

@cached_tool("my_tool", ttl=1800)  # 缓存 30 分钟
def my_tool(query: str) -> str:
    # 你的工具逻辑
    return result
```

详细文档：
- `backend/TOOL_CACHE_GUIDE.md` - 使用指南
- `backend/CACHE_BEST_PRACTICES.md` - 最佳实践

## License

MIT
