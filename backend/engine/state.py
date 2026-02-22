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


def normalize_step_text(step) -> str:
    """标准化单个步骤：从各种格式（字符串 / dict）中提取步骤文本。

    LLM 可能返回纯字符串 "读取文件"，也可能返回 dict 如 {"step": "读取文件"}。
    此函数统一提取为纯文本。
    """
    if isinstance(step, dict):
        return (
            step.get("step")
            or step.get("title")
            or step.get("description")
            or str(next(iter(step.values()), ""))
        ).strip()
    return str(step).strip()


def build_plan_steps(raw_steps: list) -> list[PlanStep]:
    """从 LLM 返回的原始步骤列表构建标准化的 PlanStep 列表。

    将各种格式（字符串 / dict）统一转换为 PlanStep 结构。
    """
    return [
        {"id": i + 1, "title": normalize_step_text(s), "status": "pending"}
        for i, s in enumerate(raw_steps)
    ]


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

    # Agent 阶段上下文摘要（plan_gate 构建，executor 使用）
    # 包含用户原始请求 + Agent 在创建计划前的工具调用结果摘要
    plan_context: Optional[str]

    # 元数据（在图入口设置，整个流程共享）
    session_id: str
    system_prompt: str
