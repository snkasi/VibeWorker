"""Plan Tool — 创建和更新执行计划的纯函数工具。

plan_create 返回包含 plan_data 的 JSON 字符串，不再有副作用。
agent_node 检测到 plan_create 调用后，解析返回值填充 state["plan_data"]。
plan_update 保留给 executor 内的 LLM 调用。
"""
import logging
from uuid import uuid4

from langchain_core.tools import tool

logger = logging.getLogger(__name__)


@tool
def plan_create(title: str, steps: list) -> str:
    """仅当任务确实需要 3 个以上步骤且涉及多个不同工具协作时，才调用此工具创建执行计划。简单问答、闲聊、单步工具调用等绝对不要使用此工具。

    Args:
        title: 计划的简短标题。
        steps: 按执行顺序排列的步骤描述列表（字符串数组），每个步骤约 10 字。例如 ["读取文件", "分析内容", "保存结果"]
    """
    if not title or not title.strip():
        return "Error: Plan title cannot be empty."

    if not steps or len(steps) == 0:
        return "Error: Plan must have at least one step."

    # 标准化步骤：LLM 可能发送 dict 如 {"step": "..."} 而非纯字符串
    normalized = []
    for s in steps:
        if isinstance(s, dict):
            text = s.get("step") or s.get("title") or s.get("description") or str(next(iter(s.values()), ""))
        else:
            text = str(s)
        normalized.append(text.strip())

    plan_id = uuid4().hex[:8]

    return f"Plan created: plan_id={plan_id}, {len(normalized)} steps. System will now auto-execute each step."


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

    return f"Step {step_id} -> {status}"


def create_plan_create_tool():
    """工厂函数：创建 plan_create 工具。"""
    return plan_create


def create_plan_update_tool():
    """工厂函数：创建 plan_update 工具。"""
    return plan_update
