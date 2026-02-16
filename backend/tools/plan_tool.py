"""Plan Tool - Create and update execution plans for complex tasks."""
import asyncio
import logging
from typing import Optional, Callable
from uuid import uuid4

from langchain_core.tools import tool

logger = logging.getLogger(__name__)

# Module-level SSE callback for plan events (same pattern as SecurityGate)
_sse_plan_callback: Optional[Callable] = None


def set_plan_sse_callback(callback: Optional[Callable]) -> None:
    """Set the SSE callback for plan events."""
    global _sse_plan_callback
    _sse_plan_callback = callback


def get_plan_sse_callback() -> Optional[Callable]:
    """Get the current plan SSE callback."""
    return _sse_plan_callback


def _send_plan_event(event_data: dict) -> None:
    """Send a plan event through the SSE callback (thread-safe)."""
    callback = get_plan_sse_callback()
    if callback is None:
        return
    try:
        # Tools run in thread pool, so we need thread-safe scheduling
        loop = _event_loop or asyncio.get_event_loop()
        loop.call_soon_threadsafe(asyncio.ensure_future, callback(event_data))
    except RuntimeError:
        # No event loop available — try direct approach
        try:
            asyncio.run(callback(event_data))
        except Exception:
            pass


# Store reference to the main event loop (set from app.py)
_event_loop: asyncio.AbstractEventLoop = None  # type: ignore


def set_plan_event_loop(loop: asyncio.AbstractEventLoop) -> None:
    """Store reference to the main async event loop for thread-safe callbacks."""
    global _event_loop
    _event_loop = loop


@tool
def plan_create(title: str, steps: list[str]) -> str:
    """为复杂的多步骤任务创建执行计划。当任务需要 3 个以上步骤或涉及多个工具协作时，必须首先调用此工具创建计划，然后再执行其他任何工具。

    Args:
        title: 计划的简短标题。
        steps: 按执行顺序排列的步骤描述列表，每个步骤约 10 字。
    """
    if not title or not title.strip():
        return "Error: Plan title cannot be empty."

    if not steps or len(steps) == 0:
        return "Error: Plan must have at least one step."

    plan_id = uuid4().hex[:8]
    plan = {
        "plan_id": plan_id,
        "title": title.strip(),
        "steps": [
            {"id": i + 1, "title": s.strip(), "status": "pending"}
            for i, s in enumerate(steps)
        ],
    }

    _send_plan_event({"type": "plan_created", "plan": plan})

    return f"Plan created: plan_id={plan_id}, {len(steps)} steps"


@tool
def plan_update(plan_id: str, step_id: int, status: str) -> str:
    """更新执行计划中某个步骤的状态。执行步骤前必须先标记为 running，完成后标记为 completed 或 failed。

    Args:
        plan_id: plan_create 返回的计划 ID。
        step_id: 要更新的步骤编号（从 1 开始）。
        status: 新状态，必须是 pending、running、completed、failed 之一。
    """
    valid_statuses = {"pending", "running", "completed", "failed"}
    if status not in valid_statuses:
        return f"Error: Invalid status '{status}'. Must be one of: {', '.join(valid_statuses)}"

    # Auto-complete previous steps when marking a new step as running
    if status == "running" and step_id > 1:
        for prev_id in range(1, step_id):
            _send_plan_event({
                "type": "plan_updated",
                "plan_id": plan_id,
                "step_id": prev_id,
                "status": "completed",
            })

    _send_plan_event({
        "type": "plan_updated",
        "plan_id": plan_id,
        "step_id": step_id,
        "status": status,
    })

    return f"Step {step_id} -> {status}"


def create_plan_create_tool():
    """Factory function to create the plan_create tool."""
    return plan_create


def create_plan_update_tool():
    """Factory function to create the plan_update tool."""
    return plan_update
