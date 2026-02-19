"""流适配器 — 统一的 StateGraph 事件循环。

将 StateGraph astream_events 翻译为标准化的 AgentEvent dict。
同时从节点输出中提取 pending_events 侧通道事件。
"""
import logging
import time
from typing import AsyncGenerator, Optional, Union

from langgraph.types import Command

from engine import events

logger = logging.getLogger(__name__)


def _serialize_debug_messages(input_data) -> str:
    """序列化 LLM 输入消息，用于调试显示。"""
    messages = input_data.get("messages", [])
    if messages and isinstance(messages[0], list):
        messages = messages[0]
    parts = []
    for msg in messages:
        role = type(msg).__name__
        content = str(msg.content) if hasattr(msg, "content") else str(msg)
        parts.append(f"[{role}]\n{content}")
    return "\n---\n".join(parts)


def _format_debug_input(system_prompt: str, messages_str: str, instruction: str = None) -> str:
    """格式化调试输入，保持统一结构。"""
    parts = [f"[System Prompt]\n{system_prompt}"]
    if instruction:
        parts.append(f"[Instruction]\n{instruction}")
    parts.append(f"[Messages]\n{messages_str}")
    return "\n\n".join(parts)


# 节点到 motivation 的映射
_NODE_MOTIVATIONS = {
    "agent": "调用大模型进行推理",
    "executor": "执行计划步骤",
    "replanner": "评估是否需要调整计划",
    "summarizer": "生成计划执行总结",
}


async def stream_graph_events(
    graph,
    input_data: Union[dict, Command],
    config: dict,
    *,
    system_prompt: str = "",
) -> AsyncGenerator[dict, None]:
    """StateGraph astream_events → 标准化 AgentEvent dict 流。

    处理 5 类标准事件 + pending_events 侧通道：
    - on_chat_model_stream → TOKEN 事件
    - on_chat_model_start → LLM_START 事件
    - on_chat_model_end → LLM_END 事件
    - on_tool_start → TOOL_START 事件
    - on_tool_end → TOOL_END 事件
    - on_chain_end → 提取 pending_events（plan 侧通道事件）

    Args:
        graph: 编译后的 StateGraph
        input_data: 初始状态 dict 或 Command（resume 场景）
        config: 运行配置（含 thread_id 等）
        system_prompt: 用于调试输入格式化
    """
    from model_pool import resolve_model

    debug_tracking = {}
    seen_event_count = 0  # pending_events 消费计数器

    async for event in graph.astream_events(input_data, version="v2", config=config):
        kind = event.get("event", "")
        metadata = event.get("metadata", {})

        if kind == "on_chat_model_stream":
            chunk = (event.get("data") or {}).get("chunk", None)
            if chunk and hasattr(chunk, "content") and chunk.content:
                yield events.build_token(chunk.content)

        elif kind == "on_chat_model_start":
            run_id = event.get("run_id", "")
            node = metadata.get("langgraph_node", "")
            input_data_msg = (event.get("data") or {}).get("input", {})
            input_messages = _serialize_debug_messages(input_data_msg)
            full_input = _format_debug_input(system_prompt, input_messages)
            debug_tracking[run_id] = {
                "start_time": time.time(),
                "node": node,
                "input": full_input,
            }

            mot = _NODE_MOTIVATIONS.get(node, "调用大模型处理请求")
            model_name = resolve_model("llm").get("model", "unknown")
            yield events.build_llm_start(run_id[:12], node, model_name, full_input[:5000], mot)

        elif kind == "on_chat_model_end":
            run_id = event.get("run_id", "")
            tracked = debug_tracking.pop(run_id, None)
            if tracked:
                yield events.build_llm_end_from_raw(event, tracked)

        elif kind == "on_tool_start":
            run_id = event.get("run_id", "")
            debug_tracking[f"tool_{run_id}"] = {"start_time": time.time()}
            yield events.build_tool_start_from_raw(event)

        elif kind == "on_tool_end":
            run_id = event.get("run_id", "")
            tracked = debug_tracking.pop(f"tool_{run_id}", None)
            duration_ms = int((time.time() - tracked["start_time"]) * 1000) if tracked else None
            yield events.build_tool_end_from_raw(event, duration_ms)

        elif kind == "on_chain_end":
            # 从节点输出中提取 pending_events
            output = (event.get("data") or {}).get("output", {})
            if isinstance(output, dict):
                pending = output.get("pending_events", [])
                if isinstance(pending, list):
                    # 只 yield 新增的事件
                    new_events = pending[seen_event_count:]
                    for pe in new_events:
                        if isinstance(pe, dict) and "type" in pe:
                            yield pe
                    seen_event_count = len(pending)
