"""Executor 节点 — 步骤执行器。

为当前步骤运行独立 ReAct 循环，使用受限工具集。
执行器的消息列表与主 messages 分离，仅追加摘要到图状态。
"""
import logging
from typing import Any

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.runnables import RunnableConfig

from engine.llm_factory import get_llm
from engine.state import AgentState

logger = logging.getLogger(__name__)


async def executor_node(state: AgentState, config: RunnableConfig) -> dict[str, Any]:
    """步骤执行器节点。

    1. 获取当前步骤信息
    2. 构建步骤级 prompt（system_prompt + 计划上下文 + past_steps）
    3. 运行独立 ReAct 循环（与主 messages 分离）
    4. 返回步骤响应 + pending_events（plan_updated）
    """
    # 从配置获取参数
    graph_config = config.get("configurable", {}).get("graph_config", {})
    node_config = graph_config.get("graph", {}).get("nodes", {}).get("executor", {})
    max_iterations = node_config.get("max_iterations", 30)

    # 获取工具（由 graph_builder 注入）
    tools = config.get("configurable", {}).get("executor_tools", [])
    tool_map = {t.name: t for t in tools}

    plan_data = state.get("plan_data")
    if not plan_data:
        logger.warning("executor 被调用但 plan_data 为空")
        return {"step_response": "[ERROR] 无计划数据"}

    steps = plan_data.get("steps", [])
    step_index = state.get("current_step_index", 0)
    system_prompt = state.get("system_prompt", "")
    past_steps = state.get("past_steps", [])

    if step_index >= len(steps):
        logger.warning("step_index (%d) 超出步骤范围 (%d)", step_index, len(steps))
        return {"step_response": "[DONE] 所有步骤已完成"}

    step = steps[step_index]
    step_title = step["title"] if isinstance(step, dict) else str(step)
    step_id = step["id"] if isinstance(step, dict) else step_index + 1
    plan_id = plan_data.get("plan_id", "")
    plan_title = plan_data.get("title", "")

    pending_events = []

    # 标记步骤为运行中
    pending_events.append({
        "type": "plan_updated",
        "plan_id": plan_id,
        "step_id": step_id,
        "status": "running",
    })

    # 构建步骤级 prompt
    executor_prompt = _build_executor_prompt(
        system_prompt, plan_title, step_title, step_index, len(steps), past_steps
    )

    # 构建独立消息列表（不污染主 messages）
    # 从主消息中提取原始用户消息作为上下文
    original_user_messages = []
    for msg in state.get("messages", []):
        if isinstance(msg, HumanMessage):
            original_user_messages.append(msg)
        if len(original_user_messages) >= 3:
            break

    exec_messages = [SystemMessage(content=executor_prompt)]
    exec_messages.extend(original_user_messages)
    exec_messages.append(HumanMessage(content=f"执行步骤 {step_index + 1}: {step_title}"))

    # 运行 ReAct 循环
    llm = get_llm(streaming=True)
    llm_with_tools = llm.bind_tools(tools) if tools else llm

    step_response = ""
    step_status = "completed"

    try:
        iterations = 0
        while iterations < max_iterations:
            iterations += 1

            response: AIMessage = await llm_with_tools.ainvoke(exec_messages)
            exec_messages.append(response)

            # 收集文本输出
            if response.content:
                content = response.content
                if isinstance(content, list):
                    content = " ".join(
                        item.get("text", str(item)) if isinstance(item, dict) else str(item)
                        for item in content
                    )
                step_response += str(content)

            # 无工具调用 → 步骤完成
            if not response.tool_calls:
                break

            # 执行工具
            for tool_call in response.tool_calls:
                tool_name = tool_call["name"]
                tool_args = tool_call["args"]
                call_id = tool_call.get("id", "")

                if tool_name in tool_map:
                    try:
                        result = await tool_map[tool_name].ainvoke(tool_args)
                        result_str = str(result)
                    except Exception as e:
                        result_str = f"[ERROR] 工具执行失败: {e}"
                        logger.error("Executor 工具 %s 执行失败: %s", tool_name, e)
                else:
                    result_str = f"[ERROR] 未知工具: {tool_name}"

                exec_messages.append(ToolMessage(content=result_str, tool_call_id=call_id))

        if iterations >= max_iterations:
            logger.warning("Executor 达到最大迭代次数 (%d)", max_iterations)

    except Exception as e:
        step_status = "failed"
        step_response = f"[ERROR] {e}"
        logger.error("步骤 %d 执行失败: %s", step_index + 1, e, exc_info=True)

    # 标记步骤最终状态
    pending_events.append({
        "type": "plan_updated",
        "plan_id": plan_id,
        "step_id": step_id,
        "status": step_status,
    })

    # 将步骤摘要追加到主消息中（保持上下文简洁）
    summary_msg = AIMessage(
        content=f"[步骤 {step_index + 1}/{len(steps)} - {step_title}] {step_response[:500]}"
    )

    # 构建完整的 past_steps（追加当前步骤）
    updated_past_steps = list(past_steps) + [(step_title, step_response[:1000])]

    return {
        "messages": [summary_msg],
        "step_response": step_response[:1000],
        "current_step_index": step_index + 1,
        "past_steps": updated_past_steps,
        "pending_events": pending_events,
    }


def _build_executor_prompt(
    system_prompt: str, plan_title: str, step_title: str,
    step_index: int, total_steps: int, past_steps: list[tuple[str, str]]
) -> str:
    """构建步骤级 prompt。"""
    past_context = ""
    if past_steps:
        past_context = "\n".join(
            f"步骤 {i+1} [{s}]: {r[:300]}" for i, (s, r) in enumerate(past_steps)
        )

    past_section = f"已完成的步骤：\n{past_context}" if past_context else ""

    return f"""{system_prompt}

计划标题：{plan_title}
当前步骤（{step_index + 1}/{total_steps}）：{step_title}

{past_section}

请专注完成当前步骤。完成后简要总结结果。"""
