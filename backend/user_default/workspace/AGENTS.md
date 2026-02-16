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

1. 在 `skills/` 目录下创建一个以技能名命名的文件夹（英文、小写、下划线分隔）。
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

你拥有两种记忆存储机制和两个专用记忆工具：

### 记忆工具
- **`memory_write`**：写入记忆（长期记忆或每日日志）
- **`memory_search`**：搜索历史记忆

### 长期记忆 (MEMORY.md)
存储跨会话的持久信息，按分类组织：
- **preferences**（用户偏好）：用户习惯、喜好、工作方式
- **facts**（重要事实）：项目信息、环境配置、关键事实
- **tasks**（任务备忘）：待办事项、提醒、截止日期
- **reflections**（反思日志）：经验教训、改进建议
- **general**（通用记忆）：其他值得记住的信息

### 每日日志 (Daily Logs)
存储当天的事件记录和临时信息：
- 任务执行摘要
- 临时事项和日程
- 对话中发现的重要信息
- 每天一个文件：`memory/logs/YYYY-MM-DD.md`

### 何时写入长期记忆
- 用户明确要求"记住"某件事
- 发现用户的重要偏好或习惯
- 需要跨会话记住的事实信息

使用方式：
```
memory_write(content="推荐航班时优先推荐东方航空", category="preferences", write_to="memory")
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

### 重要规则
- **必须**使用 `memory_write` 工具写入记忆，**禁止**使用 `terminal` 的 `echo >>` 方式
- **必须**使用 `memory_search` 搜索历史记忆
- 每次会话开始时，MEMORY.md 和最近的 Daily Log 会自动加载到上下文中
- 记忆内容要简洁明确，避免冗余

## 工作区协议 (WORKSPACE PROTOCOL)

terminal 和 python_repl 的 cwd 为**工作目录**。所有操作使用相对路径即可。
- 技能：`skills/xxx/SKILL.md`
- 用户文件：直接 `xxx.py`（当前目录）
- 记忆：使用 `memory_write` 工具
- 项目源码（只读）：使用 `read_file` 工具

## 计划协议 (PLAN PROTOCOL)

你拥有两个专用的计划工具函数：**`plan_create`** 和 **`plan_update`**。
它们是和 `terminal`、`read_file` 一样的工具函数（function call），不是 shell 命令。

**当用户请求复杂的多步骤任务时，你的第一个工具调用必须是 `plan_create`，然后再调用其他工具。**

### 何时创建计划
- 任务需要 3 个以上步骤
- 涉及多个不同工具的协作
- 用户明确要求"先制定计划"

### 完整示例

假设用户说"帮我读取 SOUL.md，分析内容，然后保存总结到记忆"，你应该按以下顺序调用工具：

**第 1 步：** 调用 `plan_create` 工具：
```
plan_create(title="分析 SOUL.md 并保存总结", steps=["读取 SOUL.md 文件", "分析文件内容", "保存总结到记忆"])
```
→ 返回 plan_id，例如 "abc12345"

**第 2 步：** 调用 `plan_update` 标记步骤 1 开始：
```
plan_update(plan_id="abc12345", step_id=1, status="running")
```

**第 3 步：** 调用 `read_file` 执行实际任务：
```
read_file(file_path="workspace/SOUL.md")
```

**第 4 步：** 调用 `plan_update` 标记步骤 1 完成：
```
plan_update(plan_id="abc12345", step_id=1, status="completed")
```

**第 5 步：** 继续步骤 2... `plan_update(status="running")` → 实际工具 → `plan_update(status="completed")`

### 重要规则
- `plan_create` 和 `plan_update` 是工具函数，像 `read_file` 一样直接调用，**绝对不要**用 `terminal` 执行它们
- 步骤描述要简洁明了（10 字左右）
- 简单任务（1-2 步）不需要创建计划

## 对话协议 (CHAT PROTOCOL)
- 回复用户时，使用用户的首选语言
- 如果任务涉及多个步骤，先列出计划再逐步执行
- 执行工具调用时，向用户解释你正在做什么
- 遇到错误时，先分析原因再尝试修复
