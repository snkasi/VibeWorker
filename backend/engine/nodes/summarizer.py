"""Summarizer 节点 — 计划完成后注入总结上下文。

清除计划状态，注入总结消息，让图回到 agent_node 做最终回复。
"""
import logging
from typing import Any

from langchain_core.messages import SystemMessage
from langchain_core.runnables import RunnableConfig

from engine.state import AgentState

logger = logging.getLogger(__name__)


async def summarizer_node(state: AgentState, config: RunnableConfig) -> dict[str, Any]:
    """总结节点。

    1. 收集所有 past_steps 的执行结果
    2. 构建总结上下文消息
    3. 清除 plan_data 和步骤状态
    4. 图回到 agent_node → agent 看到总结后生成最终回复
    """
    sid = state.get("session_id", "unknown")
    plan_data = state.get("plan_data")
    past_steps = state.get("past_steps", [])

    plan_title = plan_data.get("title", "计划") if plan_data else "计划"
    plan_id = plan_data.get("plan_id", "") if plan_data else ""

    # 构建总结上下文
    steps_summary = "\n".join(
        f"- 步骤 {i+1} [{title}]: {response[:200]}"
        for i, (title, response) in enumerate(past_steps)
    )

    summary_message = SystemMessage(
        content=f"""计划「{plan_title}」已执行完毕，以下是各步骤的执行结果：

{steps_summary}

请根据以上执行结果，生成一个主要面向用户的总结报告。如果有比较关键的任务未最最终完成目标，额外说明原因和建议。"""
    )

    logger.info("[%s] 计划总结: plan_id=%s, 步骤数=%d", sid, plan_id, len(past_steps))

    # 标记所有步骤完成的事件
    pending_events = []
    if plan_data:
        for step in plan_data.get("steps", []):
            if isinstance(step, dict) and step.get("status") == "pending":
                pending_events.append({
                    "type": "plan_updated",
                    "plan_id": plan_id,
                    "step_id": step["id"],
                    "status": "completed",
                })

    return {
        "messages": [summary_message],
        "plan_data": None,
        "current_step_index": 0,
        "past_steps": [],  # 注意：使用 operator.add 的 reset 需要特殊处理
        "agent_outcome": None,
        "replan_action": None,
        "pending_events": pending_events,
    }
