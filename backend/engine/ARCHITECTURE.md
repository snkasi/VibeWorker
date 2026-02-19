# Engine 架构文档 — 统一 StateGraph 编排引擎

## 概述

VibeWorker 的 Agent 编排引擎使用一个统一的 LangGraph `StateGraph` 替代旧的两阶段（DirectMode + PlanMode）架构。所有节点共享同一个图状态 (`AgentState`)，通过条件边路由实现灵活的流转控制。

### 核心改进

1. **单一图拓扑**：一个 StateGraph 覆盖对话、计划、执行、重规划和总结的完整流程
2. **循环回退**：计划执行完后 agent 可以总结结果、创建新计划或继续交互
3. **配置化控制**：`graph_config.yaml` 控制节点开关、参数和工具集，无需改代码
4. **LangGraph 原生特性**：利用 `interrupt()` 实现人工审批，`MemorySaver` 支持 checkpoint
5. **侧通道事件**：`pending_events` 机制替代 asyncio.Queue，事件在主流中传递

---

## 目录结构

```
engine/
├── __init__.py          # 公共 API 导出
├── runner.py            # 顶层编排器 (run_agent 唯一入口)
├── graph_builder.py     # StateGraph 构建与编译
├── graph_config.yaml    # 图配置文件
├── config_loader.py     # YAML 配置加载 + 默认值合并
├── state.py             # AgentState TypedDict 定义
├── edges.py             # 条件边路由函数
├── tool_resolver.py     # 配置 → 工具列表解析
├── stream_adapter.py    # astream_events → 标准化 SSE 事件
├── events.py            # 事件类型常量 + 构建函数
├── context.py           # RunContext 每请求上下文
├── messages.py          # 会话历史消息转换
├── llm_factory.py       # LLM 工厂（配置指纹缓存）
├── middleware/           # 中间件包（DebugMiddleware 等）
└── nodes/               # 图节点实现
    ├── __init__.py      # 导出所有节点
    ├── agent.py         # 主 ReAct 循环
    ├── plan_gate.py     # 计划门控
    ├── approval.py      # 人工审批 (interrupt)
    ├── executor.py      # 步骤执行器
    ├── replanner.py     # 重规划评估
    └── summarizer.py    # 计划完成总结
```

---

## 图拓扑

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
  enabled  │      │                                  │
           ▼      │                                  │
     ┌──────────┐ │                                  │
     │ approval │ │                                  │
     └──────────┘ │                                  │
       │     │    │                                  │
  approved  rejected                                 │
       │     │    │                                  │
       │     └────┼───→ [agent] (回到 agent 告知拒绝) │
       ▼          ▼                                  │
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
              (回到 agent 做最终总结)
```

---

## 图状态 Schema (`state.py`)

```python
class AgentState(TypedDict, total=False):
    messages: Annotated[Sequence[BaseMessage], add_messages]  # 核心消息流
    agent_outcome: Optional[str]       # "respond" | "plan_create"
    agent_iterations: int
    plan_data: Optional[PlanData]      # 计划数据
    current_step_index: int
    past_steps: Annotated[list[tuple[str, str]], operator.add]
    step_response: str
    replan_action: Optional[str]       # "continue" | "revise" | "finish"
    pending_events: Annotated[list[dict], operator.add]  # SSE 侧通道事件
    session_id: str
    system_prompt: str
```

---

## 配置化设计 (`graph_config.yaml`)

```yaml
graph:
  nodes:
    agent:
      max_iterations: 50
      tools: ["all"]
    planner:
      enabled: true
    approval:
      enabled: false
    executor:
      max_iterations: 30
      max_steps: 8
      tools: ["core", "mcp"]
    replanner:
      enabled: true
      skip_on_success: true
    summarizer:
      enabled: true
  settings:
    recursion_limit: 100
```

工具规格支持三种写法：
- `["all"]` — 全部工具
- `["core", "mcp"]` — 按类别
- `["terminal", "read_file"]` — 按名称

---

## 节点说明

### agent_node
手写 ReAct 循环（不使用 `create_react_agent` 黑盒）。循环调用 `llm.bind_tools().ainvoke()` → 执行工具 → 反馈结果。检测到 `plan_create` 时解析计划数据并路由到 `plan_gate`。

### plan_gate_node
轻量门控：发出 `plan_created` 侧通道事件，初始化步骤索引。

### approval_node
使用 `langgraph.types.interrupt()` 暂停图。Runner 层检测到中断后发送审批请求 SSE 事件，等待用户 POST /api/plan/approve，然后 `Command(resume=...)` 恢复图。

### executor_node
为当前步骤运行独立 ReAct 循环。使用受限工具集（无 plan_create）。消息列表与主 messages 分离，仅追加摘要，防止上下文膨胀。

### replanner_node
复用 `ReplanDecision` Pydantic 模型。启发式预检跳过 LLM 调用（仅剩 1 步 / 最后一步成功）。LLM 评估返回 continue / revise / finish。

### summarizer_node
注入总结上下文消息，清除 plan_data，重置状态 → 图回到 agent_node。Agent 看到总结后自然生成最终回复。

---

## 流式输出 (`stream_adapter.py`)

`stream_graph_events()` 处理 `graph.astream_events(version="v2")`：
- `on_chat_model_stream` → token 事件
- `on_chat_model_start/end` → llm_start/llm_end 事件
- `on_tool_start/end` → tool_start/tool_end 事件
- `on_chain_end` → 提取 `pending_events`（plan_created/updated/revised 等侧通道事件）

---

## 执行流程

```
1. run_agent(message, history, ctx)
2. → load_graph_config() + get_or_build_graph()
3. → resolve_tools() 注入到 config.configurable
4. → 构建 input_state {messages, system_prompt, ...}
5. → stream_graph_events(graph, input_state, config)
6. → 检查 interrupt → 等待审批 → Command(resume=...) → 继续流式
7. → yield build_done()
```
