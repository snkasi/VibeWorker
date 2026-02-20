"""事件类型与构建函数 — Agent SSE 流式输出。

标准化 Agent 执行引擎发出的所有事件。
每个构建函数返回与前端 SSEEvent 类型兼容的 dict。
"""
import json
import logging
import time
from typing import Optional

logger = logging.getLogger(__name__)

# 事件类型常量
TOKEN = "token"
TOOL_START = "tool_start"
TOOL_END = "tool_end"
LLM_START = "llm_start"
LLM_END = "llm_end"
DONE = "done"
ERROR = "error"
PLAN_CREATED = "plan_created"
PLAN_UPDATED = "plan_updated"
PLAN_REVISED = "plan_revised"
PLAN_APPROVAL_REQUEST = "plan_approval_request"

# 工具动机映射（中文显示名）
TOOL_MOTIVATIONS = {
    "read_file": "读取文件内容",
    "write_file": "写入文件",
    "terminal": "执行终端命令",
    "python_repl": "执行 Python 代码",
    "search_knowledge_base": "搜索知识库",
    "memory_search": "搜索记忆",
    "memory_write": "写入记忆",
    "fetch_url": "获取网页内容",
    "plan_create": "创建任务计划",
    "plan_update": "更新任务计划",
}


def build_token(content: str) -> dict:
    return {"type": TOKEN, "content": content}


def build_tool_start(tool_name: str, tool_input, motivation: str = None) -> dict:
    if motivation is None:
        motivation = TOOL_MOTIVATIONS.get(tool_name, f"调用工具：{tool_name}")
    return {
        "type": TOOL_START,
        "tool": tool_name,
        "input": str(tool_input),
        "motivation": motivation,
    }


def build_tool_end(tool_name: str, output: str, cached: bool, duration_ms: int = None) -> dict:
    return {
        "type": TOOL_END,
        "tool": tool_name,
        "output": output,
        "cached": cached,
        "duration_ms": duration_ms,
    }


def build_llm_start(call_id: str, node: str, model: str, input_text: str, motivation: str) -> dict:
    return {
        "type": LLM_START,
        "call_id": call_id,
        "node": node,
        "model": model,
        "input": input_text[:5000],
        "motivation": motivation,
    }


def build_llm_end(call_id: str, node: str, model: str, duration_ms: int,
                   tokens: dict, input_text: str, output_text: str) -> dict:
    return {
        "type": LLM_END,
        "call_id": call_id,
        "node": node,
        "model": model,
        "duration_ms": duration_ms,
        "input_tokens": tokens.get("input_tokens"),
        "output_tokens": tokens.get("output_tokens"),
        "total_tokens": tokens.get("total_tokens"),
        "input": input_text[:5000],
        "output": output_text[:3000],
    }


def build_done() -> dict:
    return {"type": DONE}


def build_error(message: str) -> dict:
    return {"type": ERROR, "content": message}


def build_plan_approval_request(plan_info: dict) -> dict:
    """构建计划审批请求事件。"""
    return {
        "type": PLAN_APPROVAL_REQUEST,
        "plan_id": plan_info.get("plan_id", ""),
        "title": plan_info.get("title", ""),
        "steps": plan_info.get("steps", []),
    }


# --- 原始事件辅助函数（从 LangGraph astream_events 提取数据） ---

def build_tool_start_from_raw(event: dict) -> dict:
    """从 LangGraph on_tool_start 事件构建 tool_start。"""
    tool_name = event.get("name", "")
    tool_input = (event.get("data") or {}).get("input", {})
    return build_tool_start(tool_name, tool_input)


def build_tool_end_from_raw(event: dict, duration_ms: Optional[int] = None) -> dict:
    """从 LangGraph on_tool_end 事件构建 tool_end。"""
    tool_name = event.get("name", "")
    tool_output = (event.get("data") or {}).get("output", "")

    if hasattr(tool_output, 'content'):
        output_str = str(tool_output.content)
    else:
        output_str = str(tool_output)

    output_str = output_str[:2000]
    is_cached = output_str.startswith('[CACHE_HIT]')
    if is_cached:
        logger.info(f"✓ 工具缓存命中: {tool_name}")

    return build_tool_end(tool_name, output_str, is_cached, duration_ms)


def build_llm_end_from_raw(event: dict, tracked: dict) -> dict:
    """从 LangGraph on_chat_model_end 事件 + 追踪数据构建 llm_end。"""
    run_id = event.get("run_id", "")
    output_msg = (event.get("data") or {}).get("output", None)
    duration_ms = int((time.time() - tracked["start_time"]) * 1000)

    # 提取 Token 用量
    tokens = {}
    if output_msg and hasattr(output_msg, "usage_metadata") and output_msg.usage_metadata:
        um = output_msg.usage_metadata
        tokens = {
            "input_tokens": getattr(um, "input_tokens", None) or (um.get("input_tokens") if isinstance(um, dict) else None),
            "output_tokens": getattr(um, "output_tokens", None) or (um.get("output_tokens") if isinstance(um, dict) else None),
            "total_tokens": getattr(um, "total_tokens", None) or (um.get("total_tokens") if isinstance(um, dict) else None),
        }

    # 提取输出文本
    output_parts = []
    if output_msg:
        if hasattr(output_msg, "content"):
            content = output_msg.content
            if isinstance(content, list):
                content_str = " ".join(
                    item.get("text", str(item)) if isinstance(item, dict) else str(item)
                    for item in content
                )
            else:
                content_str = str(content) if content else ""
            if content_str.strip():
                output_parts.append(content_str)

        tool_calls = []
        if hasattr(output_msg, "tool_calls") and output_msg.tool_calls:
            for tc in output_msg.tool_calls:
                # 支持字典和对象两种格式（不同 LLM 返回格式可能不同）
                if isinstance(tc, dict):
                    name = tc.get("name", "unknown")
                    args = tc.get("args", tc.get("arguments", ""))
                else:
                    # 对象格式：优先取 name/args，其次取 function.name/function.arguments
                    name = getattr(tc, "name", None)
                    if name is None and hasattr(tc, "function"):
                        func = tc.function
                        name = func.get("name") if isinstance(func, dict) else getattr(func, "name", "unknown")
                    name = name or "unknown"

                    args = getattr(tc, "args", None) or getattr(tc, "arguments", None)
                    if args is None and hasattr(tc, "function"):
                        func = tc.function
                        args = func.get("arguments") if isinstance(func, dict) else getattr(func, "arguments", "")
                    args = args or ""

                tc_info = {
                    "name": name,
                    "arguments": json.dumps(args, ensure_ascii=False) if isinstance(args, dict) else str(args),
                }
                tool_calls.append(tc_info)

        if tool_calls:
            output_parts.append("[TOOL_CALLS]: " + json.dumps(tool_calls, ensure_ascii=False, indent=2))

        if not output_parts and hasattr(output_msg, "additional_kwargs") and output_msg.additional_kwargs:
            output_parts.append(str(output_msg.additional_kwargs))

        if not output_parts:
            output_parts.append(str(output_msg))

    output_text = "\n\n".join(output_parts) if output_parts else "(无内容)"

    from model_pool import resolve_model
    model_name = resolve_model("llm").get("model", "unknown")

    return build_llm_end(
        call_id=run_id[:12],
        node=tracked["node"],
        model=model_name,
        duration_ms=duration_ms,
        tokens=tokens,
        input_text=tracked["input"],
        output_text=output_text,
    )


def serialize_sse(event: dict) -> str:
    """将事件 dict 序列化为 SSE 格式。所有 SSE 输出的唯一入口。"""
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
