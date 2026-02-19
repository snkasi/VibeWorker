"""条件边路由函数 — 控制 StateGraph 中节点之间的流转。

每个路由函数接收当前图状态，返回下一个节点名称或 END。
"""
import logging

from langgraph.graph import END

from engine.state import AgentState

logger = logging.getLogger(__name__)


def route_after_agent(state: AgentState) -> str:
    """Agent 节点后的路由。

    plan_create → plan_gate
    respond → END
    """
    outcome = state.get("agent_outcome", "respond")
    if outcome == "plan_create" and state.get("plan_data"):
        logger.debug("Agent 路由: → plan_gate (检测到 plan_create)")
        return "plan_gate"
    logger.debug("Agent 路由: → END (直接回复)")
    return END


def route_after_plan_gate(state: AgentState, *, approval_enabled: bool = False) -> str:
    """Plan Gate 节点后的路由。

    审批启用 → approval
    审批禁用 → executor
    """
    if approval_enabled:
        return "approval"
    return "executor"


def route_after_approval(state: AgentState) -> str:
    """Approval 节点后的路由。

    已批准 → executor
    已拒绝 → agent（告知拒绝）
    """
    plan_data = state.get("plan_data")
    if plan_data is None:
        # 计划被清除 = 被拒绝
        logger.info("计划被拒绝，路由回 agent")
        return "agent"
    return "executor"


def route_after_replanner(state: AgentState) -> str:
    """Replanner 节点后的路由。

    finish → summarizer
    continue/revise → executor
    """
    action = state.get("replan_action", "continue")
    if action == "finish":
        return "summarizer"
    return "executor"
