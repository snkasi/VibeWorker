# VibeWorker 记忆系统 v2 架构文档

## 概述

记忆系统 v2 是对原有简单文件存储（MEMORY.md + Daily Logs）的全面升级，借鉴 Mem0 的三阶段管道架构，实现本地化的智能记忆管理。

### 核心改进

| 特性 | v1 (旧版) | v2 (新版) |
|------|----------|----------|
| 存储格式 | MEMORY.md (Markdown) | memory.json (结构化 JSON) |
| 记忆更新 | 只能删除重建 | ADD/UPDATE/DELETE/NOOP 智能决策 |
| 重要性评分 | 无 | salience (0.0-1.0) |
| 时间衰减 | 无 | 指数衰减曲线 |
| 主动召回 | 无 | 隐式召回 (对话开始时自动检索) |
| 程序性记忆 | 无 | procedural 分类 (工具使用经验) |
| 日志格式 | .md | .json (结构化) |
| 自动归档 | 无 | 30天摘要归档，60天清理 |
| 反思系统 | 无 | 会话结束时自动反思 (1 次 LLM 调用) |

---

## 一、四层记忆架构

```
┌─────────────────────────────────────────────────────────────────┐
│                    Working Memory (工作记忆)                      │
│  当前对话上下文 + 最近 N 条消息（已有，在 messages 中）              │
└─────────────────────────────────────────────────────────────────┘
                              ↓ 会话结束时自动反思
┌─────────────────────────────────────────────────────────────────┐
│                 Short-Term Memory (短期记忆)                      │
│  Daily Logs: memory/logs/YYYY-MM-DD.json                        │
│  自动摘要归档 / 30天自动清理                                       │
└─────────────────────────────────────────────────────────────────┘
                              ↓ 周期性整合（consolidation）
┌─────────────────────────────────────────────────────────────────┐
│                  Long-Term Memory (长期记忆)                      │
│  memory.json (结构化 + 人类可读格式化)                             │
│  支持 ADD / UPDATE / DELETE 语义决策                              │
│  分类：preferences / facts / tasks / reflections / procedural    │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│               Procedural Memory (程序性记忆)                      │
│  存储工具使用经验、环境特性、失败教训                               │
│  例如：fetch_url 对动态网页无效、Windows 脚本需 .bat              │
│  作为 long-term memory 的 procedural 分类                        │
└─────────────────────────────────────────────────────────────────┘
```

---

## 二、文件格式设计

### 2.1 memory.json（长期记忆主文件）

```json
{
  "version": 2,
  "last_updated": "2026-02-21T10:30:00Z",
  "rolling_summary": "用户是一名 Python 开发者，偏好简洁代码风格，使用 Windows 系统...",

  "memories": [
    {
      "id": "a1b2c3d4",
      "category": "preferences",
      "content": "用户偏好东方航空，尤其是早班机",
      "salience": 0.85,
      "created_at": "2026-02-21T10:30:00Z",
      "last_accessed": "2026-02-21T14:00:00Z",
      "access_count": 3,
      "source": "user_explicit"
    },
    {
      "id": "e5f6g7h8",
      "category": "procedural",
      "content": "fetch_url 工具对动态渲染网页（如 React/Vue SPA）无效，需提示用户使用浏览器插件获取内容",
      "salience": 0.9,
      "created_at": "2026-02-20T15:20:00Z",
      "last_accessed": "2026-02-21T09:00:00Z",
      "access_count": 5,
      "source": "auto_reflection",
      "context": {
        "tool": "fetch_url",
        "error_type": "dynamic_content",
        "learned_from": "session_abc123"
      }
    }
  ]
}
```

### 2.2 logs/YYYY-MM-DD.json（每日日志）

```json
{
  "date": "2026-02-21",
  "entries": [
    {
      "time": "14:30:00",
      "type": "event",
      "content": "完成了项目 API 文档编写"
    },
    {
      "time": "15:45:00",
      "type": "auto_extract",
      "content": "用户喜欢在下午3点开会",
      "category": "preferences"
    },
    {
      "time": "16:20:00",
      "type": "reflection",
      "content": "fetch_url 对 https://example.com 失败，该站点是 React SPA",
      "tool": "fetch_url",
      "error": "empty_content"
    }
  ],
  "summary": null,
  "archived": false
}
```

---

## 三、分类说明（6 大类）

| 分类 | 说明 | 示例 |
|------|------|------|
| `preferences` | 用户偏好、习惯 | 喜欢东航、代码风格简洁 |
| `facts` | 重要事实 | API 地址、项目技术栈 |
| `tasks` | 任务备忘 | 待办事项、提醒 |
| `reflections` | 反思总结 | 经验教训（非工具相关） |
| `procedural` | **程序性记忆（新增）** | 工具使用经验、环境特性 |
| `general` | 通用信息 | 其他 |

---

## 四、核心机制

### 4.1 双路径记忆写入

**路径 1: Agent 主动写入**
```
Agent 调用 memory_write 工具
    ↓
consolidator.consolidate_memory()
    ↓
LLM 决策：ADD / UPDATE / DELETE / NOOP
    ↓
写入 memory.json 或 daily log
```

**路径 2: 会话结束时自动反思**
```
会话结束
    ↓
session_reflector.reflect_on_session(messages)
    ↓
1 次 LLM 调用 → 提取 + 整合决策
    ↓
返回：ADD / UPDATE / NOOP 操作列表
    ↓
批量写入 memory.json
```

### 4.2 记忆整合决策（Mem0-Inspired）

当新记忆需要写入时，系统使用 LLM 决策：

```
新记忆：{candidate_content}
分类：{category}

已有相似记忆：
1. [id={id1}] {content1} (salience={s1})
2. [id={id2}] {content2} (salience={s2})

请选择操作：
- ADD: 新记忆是全新信息
- UPDATE <id>: 更新/补充已有记忆
- DELETE <id>: 与已有记忆矛盾，删除旧的
- NOOP: 已存在或无需记录
```

**consolidator.py 负责：**
- Agent 通过 `memory_write` 工具主动写入记忆时的整合决策
- 搜索相似记忆 → LLM 决策 → 执行操作

**session_reflector.py 负责：**
- 会话结束时的自动反思 + 整合
- 1 次 LLM 调用完成：提取值得记住的内容 + 整合决策（ADD/UPDATE/NOOP）
- 支持多条记忆批量处理

### 4.3 重要性评分 + 时间衰减

```python
def compute_relevance(memory, query_embedding, now):
    """
    综合相关性 = 语义相似度 × 重要性 × 时间衰减
    """
    semantic = cosine_similarity(memory.embedding, query_embedding)
    days_old = (now - memory.last_accessed).days
    decay = math.exp(-0.05 * days_old)  # 14 天衰减到 50%

    return semantic * memory.salience * decay
```

### 4.4 隐式召回

对话开始时，基于首条消息自动检索 top-3 相关记忆 + procedural memory 注入到 System Prompt。

### 4.5 程序性记忆（Procedural Memory）

**触发场景：**

| 场景 | 触发条件 | 记录内容 |
|------|---------|---------|
| 工具失败 | `fetch_url` 返回空内容 | 该 URL 是动态网页，需用其他方式 |
| 脚本执行错误 | `terminal` 报 bash 语法错误 | 用户是 Windows，用 PowerShell |
| 重复尝试 | 同类错误出现 2+ 次 | 合并为通用规则 |
| 用户纠正 | 用户说「下次不要这样」 | 记录为显式规则 |

**实现方式：**
- 会话结束时，`session_reflector` 分析工具调用失败模式
- 自动生成 procedural 类型记忆
- 下次对话通过隐式召回注入到 System Prompt

### 4.6 日志自动归档

- **30 天后**：LLM 生成摘要 → 重要内容提升为长期记忆
- **60 天后**：删除原始日志文件

---

## 五、模块结构

```
backend/memory/
├── __init__.py              # 模块入口，导出 memory_manager 单例
├── models.py                # 数据模型（MemoryEntry, DailyLog 等）
├── manager.py               # 核心管理器（CRUD + 迁移 + 统计）
├── search.py                # 搜索逻辑（向量 + 关键词 + 衰减）
├── session_reflector.py     # 会话反思器（1 次 LLM 调用完成提取+整合）
├── consolidator.py          # 整合器（Agent memory_write 工具的 ADD/UPDATE/DELETE 决策）
├── archiver.py              # 日志归档（摘要 + 清理）
└── ARCHITECTURE.md          # 本文档
```

### 模块职责详解

**manager.py (核心管理器)**
- CRUD 操作：add_memory(), update_memory(), delete_memory(), list_memories()
- 日志管理：write_daily_log(), get_daily_logs()
- 统计信息：get_stats()
- 自动迁移：v1 → v2 格式转换
- 滚动摘要管理

**search.py (搜索引擎)**
- 语义搜索：向量相似度计算
- 关键词搜索：关键词匹配
- 时间衰减：指数衰减曲线
- 隐式召回：对话开始时自动检索
- 分类筛选：按 category 过滤

**session_reflector.py (会话反思器)**
- 会话结束时自动调用：`reflect_on_session(messages)`
- **1 次 LLM 调用**完成：
  - 提取值得记住的内容（偏好、事实、经验教训）
  - 对每条提取内容决策：ADD / UPDATE / NOOP
- 返回操作列表：`[(action, content, category, salience, existing_id), ...]`
- 支持 procedural 记忆自动识别（工具使用经验）

**consolidator.py (整合器)**
- Agent 通过 `memory_write` 工具主动写入时调用
- 搜索相似记忆（语义 + 关键词）
- LLM 决策：ADD / UPDATE / DELETE / NOOP
- 执行操作并返回结果

**archiver.py (归档器)**
- 定期扫描旧日志（30天+）
- LLM 生成摘要
- 重要内容提升为长期记忆
- 60天后删除原始日志

---

## 六、反思系统简化

### 6.1 旧版架构（已废弃）

```
extractor.py              # 对话中自动提取记忆
reflector.py              # 工具失败时分析
reflection_strategies.py  # 多种反思策略
reflection_dispatcher.py  # Hook 系统 + 事件分发
```

**问题：**
- 4 个文件，职责重叠
- Hook 系统复杂，难以维护
- 写入路径多达 5+，难以追踪
- 配置项分散（`memory_auto_extract`, `memory_reflection_enabled`）

### 6.2 新版架构（当前）

```
session_reflector.py      # 唯一反思模块，1 次 LLM 调用完成所有工作
consolidator.py           # Agent 主动写入时的整合决策
```

**优势：**
- 只有 2 条写入路径，清晰可控
- 会话反思集中化：1 个函数，1 次 LLM 调用
- 配置项简化：只需 `memory_session_reflect_enabled`
- 移除 Hook 系统，减少复杂度

### 6.3 反思触发时机

| 场景 | 触发模块 | 调用时机 |
|------|----------|---------|
| Agent 主动写入 | consolidator | `memory_write` 工具调用时 |
| 会话结束反思 | session_reflector | 会话结束时（POST /api/chat 返回前） |

---

## 七、API 接口

### 新增 API

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/memory/consolidate` | POST | 手动触发记忆整合 |
| `/api/memory/archive` | POST | 手动触发日志归档 |
| `/api/memory/procedural` | GET | 获取程序性记忆列表 |
| `/api/memory/rolling-summary` | GET/PUT | 管理滚动摘要 |

### 更新的 API

| 端点 | 变更 |
|------|------|
| `GET /api/memory/entries` | 返回 memory.json 内容，含 salience/access_count |
| `POST /api/memory/entries` | 支持 salience 参数 |
| `POST /api/memory/search` | 新增 `use_decay` 和 `category` 参数 |

---

## 八、配置项

```bash
# Memory v2 核心配置
MEMORY_SESSION_REFLECT_ENABLED=true   # 会话反思开关（替代旧的 auto_extract + reflection_enabled）
MEMORY_CONSOLIDATION_ENABLED=true     # 智能整合开关
MEMORY_ARCHIVE_DAYS=30                # 归档阈值（天）
MEMORY_DELETE_DAYS=60                 # 删除阈值（天）
MEMORY_DECAY_LAMBDA=0.05              # 衰减系数（14天衰减到50%）
MEMORY_IMPLICIT_RECALL_ENABLED=true   # 隐式召回开关
MEMORY_IMPLICIT_RECALL_TOP_K=3        # 隐式召回数量

# 继承自 v1
MEMORY_DAILY_LOG_DAYS=2               # Prompt 加载日志天数
MEMORY_MAX_PROMPT_TOKENS=4000         # 记忆 Token 预算
MEMORY_INDEX_ENABLED=true             # 语义搜索索引开关
```

**配置项变更说明：**
- ❌ 废弃：`MEMORY_AUTO_EXTRACT`（旧版实时提取，已移除）
- ❌ 废弃：`MEMORY_REFLECTION_ENABLED`（旧版反思开关，已移除）
- ✅ 新增：`MEMORY_SESSION_REFLECT_ENABLED`（会话结束时自动反思，默认 true）

---

## 九、存储目录

```
~/.vibeworker/
└── memory/
    ├── memory.json              # 长期记忆（替代 MEMORY.md）
    ├── memory.json.bak          # 自动备份
    └── logs/
        ├── 2026-02-21.json
        └── 2026-02-20.json
```

---

## 十、自动迁移

首次启动时，系统自动执行以下迁移：

1. **MEMORY.md → memory.json**
   - 解析旧格式条目
   - 转换为结构化 JSON
   - 旧文件备份为 `MEMORY.md.migrated`

2. **logs/*.md → logs/*.json**
   - 逐文件迁移
   - 旧文件备份为 `*.md.migrated`

迁移过程完全自动，无需用户干预。

---

## 十一、工具集成

### memory_write 工具

```python
memory_write(
    content="...",           # 记忆内容
    category="preferences",  # 分类
    write_to="memory",       # memory | daily
    salience=0.8            # 重要性 (0.0-1.0)
)
```

**执行流程：**
1. Agent 调用工具
2. `consolidator.consolidate_memory()` 搜索相似记忆
3. LLM 决策：ADD / UPDATE / DELETE / NOOP
4. 写入 memory.json 或 daily log

### memory_search 工具

```python
memory_search(
    query="...",            # 搜索查询
    top_k=5,                # 返回数量
    use_decay=True,         # 使用时间衰减
    category="preferences"  # 分类过滤（可选）
)
```

---

## 十二、前端适配

### MemoryPanel 更新

- 新增 `procedural`（程序）分类筛选
- 显示重要性标记（⭐ 高重要性记忆）
- 显示访问次数
- 搜索结果展示相关度得分

### Inspector 兼容

memory.json 可在右侧 Monaco Editor 中查看和编辑（支持 JSON 语法高亮）。

---

## 十三、验证方式

1. **自动迁移**：启动后检查 memory.json 是否生成，MEMORY.md.migrated 是否存在
2. **会话反思**：对话结束后检查 memory.json 是否新增记忆（source="auto_reflection"）
3. **程序性记忆**：工具失败后检查是否有 procedural 记录
4. **智能整合**：添加相似记忆时验证是否触发 UPDATE
5. **时间衰减**：memory_search 返回结果按 salience × 衰减排序
6. **日志归档**：30 天后的日志自动摘要，前端展示正常

---

## 十四、性能优化

### 14.1 向量索引

- 使用 FAISS 或 LlamaIndex 向量存储
- 启动时加载索引（`storage/memory_index/`）
- 增量更新：新增记忆时实时更新索引

### 14.2 缓存策略

- 嵌入缓存：相同内容复用 embedding
- LLM 决策缓存：相似场景复用决策结果（需谨慎）
- 搜索结果缓存：短期内相同查询复用结果

### 14.3 批量处理

- 会话反思：1 次 LLM 调用处理多条记忆
- 日志归档：批量处理多天日志

---

## 参考资料

- [Mem0 文档](https://docs.mem0.ai/)
- [LangGraph Memory](https://langchain-ai.github.io/langgraph/concepts/memory/)
- [LlamaIndex](https://docs.llamaindex.ai/)
