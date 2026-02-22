"""Replanner 节点 — 重规划评估。

每个步骤执行后评估是否需要调整计划：
- continue: 继续下一步
- revise: 修改剩余步骤
- finish: 提前完成
"""
import logging
from typing import Any, Optional

from langchain_core.runnables import RunnableConfig
from pydantic import BaseModel, Field

from engine.llm_factory import get_llm
from engine.state import AgentState

logger = logging.getLogger(__name__)


class ReplanDecision(BaseModel):
    """Replanner LLM 的结构化输出。"""
    action: str = Field(description="决策动作: continue / revise / finish")
    response: str = Field(default="", description="当 action=finish 时的最终回复")
    revised_steps: list[str] = Field(default_factory=list, description="当 action=revise 时的新步骤列表")
    reason: str = Field(default="", description="决策原因")


async def replanner_node(state: AgentState, config: RunnableConfig) -> dict[str, Any]:
    """重规划评估节点。

    1. 启发式预检：常规情况跳过 LLM 调用
    2. LLM 结构化输出：continue / revise / finish
    3. revise 时更新 plan_data.steps，发出 plan_revised 事件
    """
    sid = state.get("session_id", "unknown")

    graph_config = config.get("configurable", {}).get("graph_config", {})
    node_config = graph_config.get("graph", {}).get("nodes", {}).get("replanner", {})
    skip_on_success = node_config.get("skip_on_success", True)

    plan_data = state.get("plan_data")
    if not plan_data:
        return {"replan_action": "finish"}

    steps = plan_data.get("steps", [])
    step_index = state.get("current_step_index", 0)
    past_steps = state.get("past_steps", [])
    plan_id = plan_data.get("plan_id", "")
    plan_title = plan_data.get("title", "")

    remaining = len(steps) - step_index

    # 无剩余步骤 → 完成
    if remaining <= 0:
        return {"replan_action": "finish"}

    # 启发式预检
    if _should_skip_replan(past_steps, step_index, len(steps), skip_on_success):
        return {"replan_action": "continue"}

    # LLM 评估
    decision = await _evaluate_replan(plan_title, steps, past_steps, step_index, sid, config=config)

    if decision is None:
        return {"replan_action": "continue"}

    result: dict[str, Any] = {"replan_action": decision.action}
    pending_events = []

    if decision.action == "finish":
        # 将剩余步骤标记为已完成（跳过）
        for i in range(step_index, len(steps)):
            s = steps[i]
            step_sid = s["id"] if isinstance(s, dict) else i + 1
            pending_events.append({
                "type": "plan_updated",
                "plan_id": plan_id,
                "step_id": step_sid,
                "status": "completed",
            })

        if decision.response:
            from langchain_core.messages import AIMessage
            result["messages"] = [AIMessage(content=decision.response)]

    elif decision.action == "revise" and decision.revised_steps:
        # 构建新步骤列表
        new_steps = [
            {"id": step_index + i + 1, "title": s.strip(), "status": "pending"}
            for i, s in enumerate(decision.revised_steps)
        ]

        # 更新 plan_data（保留已完成的步骤 + 新步骤）
        updated_plan = dict(plan_data)
        updated_plan["steps"] = steps[:step_index] + new_steps
        result["plan_data"] = updated_plan

        pending_events.append({
            "type": "plan_revised",
            "plan_id": plan_id,
            "revised_steps": new_steps,
            "keep_completed": step_index,
            "reason": decision.reason,
        })

    if pending_events:
        result["pending_events"] = pending_events

    return result


def _should_skip_replan(
    past_steps: list[tuple[str, str]],
    step_index: int,
    total: int,
    skip_on_success: bool,
) -> bool:
    """启发式预检：常规情况下跳过 LLM Replan 调用。

    核心逻辑：
    - 最后一步失败时，即使仅剩 1 步也不跳过（需要 LLM 评估是否调整策略）
    - 最后一步成功 + 仅剩 1 步 → 直接继续执行
    - 最后一步成功 + 配置允许跳过 → 直接继续执行
    """
    # 检查最后一步是否包含错误
    last_step_failed = False
    if past_steps:
        last_response = past_steps[-1][1]
        # 匹配常见错误标识：[ERROR]、Exception、Traceback、failed
        error_indicators = ["[ERROR]", "Exception:", "Traceback", "Error:", "failed"]
        last_step_failed = any(indicator in last_response for indicator in error_indicators)

    # 最后一步失败时，始终触发 LLM 评估（即使仅剩 1 步）
    if last_step_failed:
        return False

    # 仅剩 1 步且上一步成功 → 无需重规划
    if total - step_index <= 1:
        return True

    # 上一步成功且配置允许跳过 → 正常继续
    if skip_on_success:
        return True

    return False


async def _evaluate_replan(
    plan_title: str,
    steps: list,
    past_steps: list[tuple[str, str]],
    current_index: int,
    sid: str = "unknown",
    config: dict = None,
) -> Optional[ReplanDecision]:
    """调用 LLM 进行重规划评估。"""
    remaining_steps = steps[current_index:]

    past_str = "\n".join(
        f"步骤 {i+1} [{s}]: {r[:200]}" for i, (s, r) in enumerate(past_steps)
    )
    remaining_str = "\n".join(
        f"步骤 {(s['id'] if isinstance(s, dict) else current_index + i + 1)}: "
        f"{(s['title'] if isinstance(s, dict) else str(s))}"
        for i, s in enumerate(remaining_steps)
    )

    replan_prompt = f"""你是一个计划评估专家。请根据当前执行进度评估是否需要调整计划。

计划标题：{plan_title}

已完成的步骤：
{past_str}

剩余步骤：
{remaining_str}

请选择一个动作：
- **continue**: 剩余步骤合理，继续执行下一步
- **revise**: 根据已完成步骤的结果，需要修改剩余步骤
- **finish**: 任务目标已经达成，无需继续执行剩余步骤

请以 JSON 格式回复。"""

    try:
        llm = get_llm(streaming=False)
        structured_llm = llm.with_structured_output(ReplanDecision)
        decision = await structured_llm.ainvoke(replan_prompt, config=config)
        logger.info("[%s][REPLANNER] 决策: %s - %s", sid, decision.action, decision.reason)
        return decision
    except Exception as e:
        logger.warning("[%s][REPLANNER] 评估失败，降级为继续执行: %s", sid, e)
        return None
