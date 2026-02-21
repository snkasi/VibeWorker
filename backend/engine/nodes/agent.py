"""Agent 节点 — 主 ReAct 循环。

手写 ReAct 循环（不使用 create_react_agent 黑盒），
支持流式 token、工具调用检测和 plan_create 识别。
"""
import asyncio
import json
import logging
import time
from typing import Any

from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.runnables import RunnableConfig

from engine.llm_factory import get_llm
from engine.state import AgentState

logger = logging.getLogger(__name__)


async def agent_node(state: AgentState, config: RunnableConfig) -> dict[str, Any]:
    """主 Agent 节点：手写 ReAct 循环。

    1. 绑定工具到 LLM
    2. 循环调用 LLM → 执行工具 → 反馈结果
    3. 检测 plan_create 工具调用时设置 plan_data 并退出
    4. 无工具调用时 agent_outcome="respond" 退出

    使用 ainvoke 而非 astream，流式 token 由 astream_events 在外层捕获。
    """
    # 从 state 中获取 session_id
    sid = state.get("session_id", "unknown")

    # 从 config 的 configurable 中获取图配置
    graph_config = config.get("configurable", {}).get("graph_config", {})
    node_config = graph_config.get("graph", {}).get("nodes", {}).get("agent", {})
    max_iterations = node_config.get("max_iterations", 50)

    # 从 config 的 configurable 中获取工具（由 graph_builder 注入）
    tools = config.get("configurable", {}).get("agent_tools", [])
    tool_map = {t.name: t for t in tools}

    messages = list(state["messages"])
    # 记录初始消息数量，用于计算新增消息（add_messages reducer 只需要新增部分）
    initial_message_count = len(messages)

    logger.info("[%s] Agent 节点开始, max_iter=%d, tools=%d, 初始消息=%d",
                sid, max_iterations, len(tools), initial_message_count)

    from config import settings as _settings
    llm_timeout = _settings.llm_request_timeout
    tool_timeout = _settings.tool_execution_timeout

    llm = get_llm(streaming=True)
    llm_with_tools = llm.bind_tools(tools) if tools else llm

    iterations = 0
    plan_data = None
    agent_outcome = "respond"
    pending_events = []

    while iterations < max_iterations:
        iterations += 1

        # 调用 LLM（ainvoke，外层 astream_events 会捕获流式 token）
        logger.info("[%s] Agent LLM 调用 #%d, 消息数=%d", sid, iterations, len(messages))
        t0 = time.time()
        try:
            response: AIMessage = await asyncio.wait_for(
                llm_with_tools.ainvoke(messages, config=config),
                timeout=llm_timeout,
            )
        except asyncio.TimeoutError:
            elapsed = time.time() - t0
            logger.error("[%s] Agent LLM 调用 #%d 超时 (%.1fs > %ds)，终止迭代",
                         sid, iterations, elapsed, llm_timeout)
            messages.append(AIMessage(content=f"[ERROR] LLM 请求超时 ({llm_timeout}s)，请稍后重试"))
            agent_outcome = "respond"
            break
        elapsed = time.time() - t0
        messages.append(response)

        # 无工具调用 → 直接回复
        if not response.tool_calls:
            logger.info("[%s] Agent LLM 响应: tool_calls=无, 耗时=%.1fs", sid, elapsed)
            agent_outcome = "respond"
            break

        logger.info("[%s] Agent LLM 响应: tool_calls=%s, 耗时=%.1fs", sid,
                    [tc["name"] for tc in response.tool_calls], elapsed)

        # 处理工具调用
        for tool_call in response.tool_calls:
            tool_name = tool_call["name"]
            tool_args = tool_call["args"]
            call_id = tool_call.get("id", "")

            if tool_name in tool_map:
                try:
                    result = await asyncio.wait_for(
                        tool_map[tool_name].ainvoke(tool_args, config=config),
                        timeout=tool_timeout,
                    )
                    result_str = str(result)
                except asyncio.TimeoutError:
                    result_str = f"[ERROR] 工具 {tool_name} 执行超时 ({tool_timeout}s)"
                    logger.error("[%s] 工具 %s 执行超时 (%ds)", sid, tool_name, tool_timeout)
                except Exception as e:
                    result_str = f"[ERROR] 工具执行失败: {e}"
                    logger.error("[%s] 工具 %s 执行失败: %s", sid, tool_name, e, exc_info=True)
            else:
                result_str = f"[ERROR] 未知工具: {tool_name}"
                logger.warning("[%s] Agent 调用了未知工具: %s", sid, tool_name)

            messages.append(ToolMessage(content=result_str, tool_call_id=call_id))
            logger.info("[%s] Agent 工具执行: %s, 成功=%s", sid, tool_name, "[ERROR]" not in result_str)

            # 检测 plan_create → 解析计划数据
            if tool_name == "plan_create" and "[ERROR]" not in result_str:
                plan_data = _parse_plan_from_tool_result(result_str, tool_args)
                if plan_data:
                    logger.info("[%s] Agent 检测到 plan_create, plan_id=%s", sid, plan_data.get("plan_id"))
                    agent_outcome = "plan_create"
                    break

        # plan_create 被触发，跳出主循环
        if agent_outcome == "plan_create":
            break

    if iterations >= max_iterations:
        logger.warning("[%s] Agent 达到最大迭代次数 (%d)，强制终止", sid, max_iterations)

    # 只返回新增的消息，避免 add_messages reducer 重复累积已有消息
    new_messages = messages[initial_message_count:]
    logger.info("[%s] Agent 节点结束: outcome=%s, iterations=%d, 新增消息=%d",
                sid, agent_outcome, iterations, len(new_messages))

    result: dict[str, Any] = {
        "messages": new_messages,
        "agent_outcome": agent_outcome,
        "agent_iterations": iterations,
    }

    if plan_data:
        result["plan_data"] = plan_data

    if pending_events:
        result["pending_events"] = pending_events

    return result


def _parse_plan_from_tool_result(result_str: str, tool_args: dict) -> dict | None:
    """从 plan_create 工具返回值和参数中解析 PlanData。

    plan_create 工具返回 "Plan created: plan_id=xxx, N steps. ..." 格式，
    同时工具参数中包含 title 和 steps。
    """
    try:
        # 从返回值中提取 plan_id
        plan_id = None
        if "plan_id=" in result_str:
            plan_id = result_str.split("plan_id=")[1].split(",")[0].strip()

        if not plan_id:
            return None

        title = tool_args.get("title", "")
        raw_steps = tool_args.get("steps", [])

        # 标准化步骤
        steps = []
        for i, s in enumerate(raw_steps):
            if isinstance(s, dict):
                text = s.get("step") or s.get("title") or s.get("description") or str(next(iter(s.values()), ""))
            else:
                text = str(s)
            steps.append({
                "id": i + 1,
                "title": text.strip(),
                "status": "pending",
            })

        return {
            "plan_id": plan_id,
            "title": title.strip(),
            "steps": steps,
        }
    except Exception as e:
        logger.warning("解析 plan_create 结果失败: %s", e)
        return None


