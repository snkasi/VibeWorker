"""Plan Gate 节点 — 计划门控。

轻量节点：发出 plan_created 侧通道事件，重置步骤索引，
并从 Agent 阶段的消息中提取上下文摘要供 Executor 使用。
"""
import logging
from typing import Any

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.runnables import RunnableConfig

from engine.state import AgentState

logger = logging.getLogger(__name__)


async def plan_gate_node(state: AgentState, config: RunnableConfig) -> dict[str, Any]:
    """计划门控节点。

    - 从 Agent 阶段消息中提取上下文摘要（用户请求 + 工具调用结果）
    - 发出 plan_created 侧通道事件
    - 初始化步骤执行索引
    """
    sid = state.get("session_id", "unknown")
    plan_data = state.get("plan_data")
    if not plan_data:
        logger.warning("[%s] plan_gate 被调用但 plan_data 为空", sid)
        return {}

    # 构建 plan_context：提取 Agent 阶段的关键信息
    plan_context = _build_plan_context(state.get("messages", []))

    logger.info("[%s] 计划门控: plan_id=%s, title=%s, steps=%d, context_len=%d",
                sid, plan_data.get("plan_id"), plan_data.get("title"),
                len(plan_data.get("steps", [])), len(plan_context))

    return {
        "current_step_index": 0,
        "plan_context": plan_context,
        "pending_events": [{
            "type": "plan_created",
            "plan": plan_data,
        }],
    }


def _build_plan_context(messages: list) -> str:
    """从 Agent 阶段的消息中提取上下文摘要。

    提取内容：
    1. 用户原始请求（HumanMessage）
    2. Agent 的工具调用结果摘要（ToolMessage，截断到 500 字）
    3. Agent 的文本回复（AIMessage 中的非工具调用内容）

    这些信息帮助 Executor 理解完整的任务背景，而不仅仅是单个步骤标题。
    """
    context_parts = []

    for msg in messages:
        if isinstance(msg, HumanMessage):
            context_parts.append(f"[用户请求] {msg.content}")
        elif isinstance(msg, ToolMessage):
            # 工具调用结果可能很长，截断保留关键信息
            content = str(msg.content)[:500]
            tool_name = getattr(msg, "name", "unknown")
            context_parts.append(f"[工具结果: {tool_name}] {content}")
        elif isinstance(msg, AIMessage):
            # 只提取文本内容（跳过纯工具调用的 AIMessage）
            content = msg.content
            if isinstance(content, list):
                content = " ".join(
                    item.get("text", "") if isinstance(item, dict) else str(item)
                    for item in content
                )
            content = str(content).strip()
            if content and not content.startswith("[步骤"):
                context_parts.append(f"[Agent 分析] {content[:300]}")

    # 限制总长度，避免上下文过大
    result = "\n".join(context_parts)
    if len(result) > 3000:
        result = result[:3000] + "\n...[已截断]"

    return result
