"""Plan Gate 节点 — 计划门控。

轻量节点：发出 plan_created 侧通道事件，重置步骤索引。
"""
import logging
from typing import Any

from langchain_core.runnables import RunnableConfig

from engine.state import AgentState

logger = logging.getLogger(__name__)


async def plan_gate_node(state: AgentState, config: RunnableConfig) -> dict[str, Any]:
    """计划门控节点。

    - 发出 plan_created 侧通道事件
    - 初始化步骤执行索引
    """
    plan_data = state.get("plan_data")
    if not plan_data:
        logger.warning("plan_gate 被调用但 plan_data 为空")
        return {}

    logger.info("计划门控: plan_id=%s, title=%s, steps=%d",
                plan_data.get("plan_id"), plan_data.get("title"),
                len(plan_data.get("steps", [])))

    return {
        "current_step_index": 0,
        "pending_events": [{
            "type": "plan_created",
            "plan": plan_data,
        }],
    }
