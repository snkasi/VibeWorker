"""图状态 Schema — 统一 StateGraph 的状态定义。

所有节点共享的 AgentState TypedDict，使用 LangGraph 的
add_messages reducer 自动累积消息。
"""
import operator
from typing import Annotated, Literal, Optional, Sequence

from langchain_core.messages import BaseMessage
from langgraph.graph.message import add_messages
from typing_extensions import TypedDict


class PlanStep(TypedDict):
    """计划步骤。"""
    id: int
    title: str
    status: Literal["pending", "running", "completed", "failed"]


class PlanData(TypedDict, total=False):
    """计划数据。"""
    plan_id: str
    title: str
    steps: list[PlanStep]


class AgentState(TypedDict, total=False):
    """统一的图状态 Schema。

    所有节点通过读写此状态进行通信。
    """
    # 核心消息（使用 add_messages reducer 自动累积）
    messages: Annotated[Sequence[BaseMessage], add_messages]

    # Agent 节点输出
    agent_outcome: Optional[str]       # "respond" | "plan_create"
    agent_iterations: int

    # 计划数据
    plan_data: Optional[PlanData]
    current_step_index: int

    # 步骤执行历史（executor 追加，summarizer 重置）
    past_steps: list[tuple[str, str]]

    # Executor 节点输出
    step_response: str

    # Replanner 决策
    replan_action: Optional[str]       # "continue" | "revise" | "finish"

    # 侧通道 SSE 事件（plan_created/updated/revised 等）
    pending_events: Annotated[list[dict], operator.add]

    # 元数据（在图入口设置，整个流程共享）
    session_id: str
    system_prompt: str
