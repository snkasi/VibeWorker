"""Approval 节点 — 使用 LangGraph interrupt 暂停图等待人工审批。

图暂停后，runner 层检测到中断并发送 plan_approval_request SSE 事件。
用户 POST /api/plan/approve 后，runner 层 Command(resume=...) 恢复图。
"""
import logging
from typing import Any

from langchain_core.runnables import RunnableConfig
from langgraph.types import interrupt

from engine.state import AgentState

logger = logging.getLogger(__name__)


async def approval_node(state: AgentState, config: RunnableConfig) -> dict[str, Any]:
    """审批节点。

    使用 interrupt() 暂停图执行，等待外部 resume。
    resume 值格式: {"approved": True/False}
    """
    plan_data = state.get("plan_data")
    if not plan_data:
        logger.warning("approval 节点被调用但 plan_data 为空")
        return {}

    plan_id = plan_data.get("plan_id", "unknown")
    logger.info("等待计划审批: plan_id=%s", plan_id)

    # interrupt() 暂停图执行
    # 传递计划信息供 runner 层构建 SSE 事件
    result = interrupt({
        "plan_id": plan_id,
        "title": plan_data.get("title", ""),
        "steps": plan_data.get("steps", []),
    })

    # resume 后执行到这里
    approved = result.get("approved", False) if isinstance(result, dict) else bool(result)

    if approved:
        logger.info("计划已批准: plan_id=%s", plan_id)
        return {
            "pending_events": [{
                "type": "plan_approval_resolved",
                "plan_id": plan_id,
                "approved": True,
            }],
        }
    else:
        logger.info("计划被拒绝: plan_id=%s", plan_id)
        # 清除 plan_data → route_after_approval 会路由回 agent
        from langchain_core.messages import AIMessage
        return {
            "plan_data": None,
            "messages": [AIMessage(content="用户已拒绝执行该计划。")],
            "pending_events": [{
                "type": "plan_approval_resolved",
                "plan_id": plan_id,
                "approved": False,
            }],
        }
