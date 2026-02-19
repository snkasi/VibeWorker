"""Runner — 顶层 Agent 编排器，带 Middleware 管线。

使用统一 StateGraph 替代旧的两阶段架构。
提供唯一入口 `run_agent()`：
1. 加载图配置 + 构建/缓存编译后的图
2. 构建初始状态 + 流式执行
3. 检查 interrupt → 等待审批 → resume 图
4. 所有事件经过 Middleware 链路由
"""
import asyncio
import logging
from typing import AsyncGenerator

from langchain_core.messages import HumanMessage
from langgraph.types import Command

from engine.config_loader import load_graph_config, get_node_config
from engine.context import RunContext
from engine import events
from engine.graph_builder import get_or_build_graph
from engine.messages import convert_history
from engine.stream_adapter import stream_graph_events
from engine.tool_resolver import resolve_tools, resolve_executor_tools

logger = logging.getLogger(__name__)


async def run_agent(
    message: str,
    session_history: list[dict],
    ctx: RunContext,
    middlewares: list = None,
) -> AsyncGenerator[dict, None]:
    """Agent 执行的唯一入口。

    编排 StateGraph 执行 + Middleware 管线。
    启用 LLM 缓存时自动走缓存路径。
    """
    from config import settings

    mws = middlewares or []

    # 通知中间件运行开始
    for mw in mws:
        await mw.on_run_start(ctx)

    try:
        if settings.enable_llm_cache:
            async for event in _cached_run(message, session_history, ctx, mws):
                yield event
        else:
            async for event in _run_uncached(message, session_history, ctx, mws):
                yield event
    finally:
        # 通知中间件运行结束
        for mw in mws:
            await mw.on_run_end(ctx)


async def _cached_run(message, session_history, ctx, mws):
    """带 LLM 缓存的执行路径。"""
    from prompt_builder import build_system_prompt
    from cache import llm_cache
    from config import settings

    system_prompt = build_system_prompt()
    recent_history = []
    for msg in session_history[-3:]:
        recent_history.append({
            "role": msg.get("role", ""),
            "content": msg.get("content", "")[:500],
        })

    cache_key_params = {
        "system_prompt": system_prompt,
        "recent_history": recent_history,
        "current_message": message,
        "model": settings.llm_model,
        "temperature": settings.llm_temperature,
    }

    async def generator():
        async for event in _run_uncached(message, session_history, ctx, mws):
            yield event

    async for event in llm_cache.get_or_generate(
        key_params=cache_key_params,
        generator_func=generator,
        stream=ctx.stream,
    ):
        yield event


async def _run_uncached(message, session_history, ctx, mws):
    """核心执行：统一 StateGraph 编排。"""
    from prompt_builder import build_system_prompt

    ctx.message = message
    ctx.session_history = session_history

    # 1. 加载图配置 + 构建/缓存编译后的图
    graph_config = load_graph_config()
    graph = get_or_build_graph(graph_config)

    # 2. 解析工具集（通过 config 注入到节点）
    agent_node_config = get_node_config(graph_config, "agent")
    executor_node_config = get_node_config(graph_config, "executor")

    agent_tools = resolve_tools(
        agent_node_config.get("tools", ["all"]),
        include_plan_create=True,
    )
    executor_tools = resolve_executor_tools(
        executor_node_config.get("tools", ["core", "mcp"]),
    )

    # 3. 构建初始状态
    system_prompt = build_system_prompt()
    messages = convert_history(session_history)
    messages.append(HumanMessage(content=message))

    input_state = {
        "messages": messages,
        "session_id": ctx.session_id,
        "system_prompt": system_prompt,
        "agent_iterations": 0,
        "current_step_index": 0,
    }

    # 4. 运行配置（thread_id 用于 checkpointer + interrupt/resume）
    run_config = {
        "configurable": {
            "thread_id": ctx.session_id,
            "graph_config": graph_config,
            "agent_tools": agent_tools,
            "executor_tools": executor_tools,
        },
        "recursion_limit": graph_config.get("graph", {}).get("settings", {}).get("recursion_limit", 100),
    }

    # 5. 流式执行 + 中间件管线
    async for event in _pipe(
        stream_graph_events(graph, input_state, run_config, system_prompt=system_prompt),
        mws, ctx,
    ):
        yield event

    # 6. 检查是否因 interrupt 暂停（审批）
    try:
        state_snapshot = graph.get_state(run_config)
        if state_snapshot and state_snapshot.next:
            # 图被中断 → 提取 interrupt payload
            interrupt_values = getattr(state_snapshot, "tasks", [])
            plan_info = _extract_interrupt_payload(interrupt_values)

            if plan_info:
                # 发送审批请求 SSE 事件
                yield events.build_plan_approval_request(plan_info)

                # 阻塞等待审批（保持 SSE 流不断开）
                approved = await _wait_for_approval(ctx, plan_info.get("plan_id", ""))

                # resume 图
                resume_cmd = Command(resume={"approved": approved})
                async for event in _pipe(
                    stream_graph_events(graph, resume_cmd, run_config, system_prompt=system_prompt),
                    mws, ctx,
                ):
                    yield event
    except Exception as e:
        logger.debug("检查 interrupt 状态失败（正常结束时可忽略）: %s", e)

    yield events.build_done()


def _extract_interrupt_payload(tasks) -> dict | None:
    """从 graph state tasks 中提取 interrupt payload。"""
    if not tasks:
        return None
    for task in tasks:
        interrupts = getattr(task, "interrupts", [])
        for intr in interrupts:
            value = getattr(intr, "value", None)
            if isinstance(value, dict) and "plan_id" in value:
                return value
    return None


async def _wait_for_approval(ctx: RunContext, plan_id: str) -> bool:
    """等待用户审批。通过 ctx.approval_queue 接收审批结果。"""
    try:
        result = await asyncio.wait_for(ctx.approval_queue.get(), timeout=300)
        if isinstance(result, dict):
            return result.get("approved", False)
        return bool(result)
    except asyncio.TimeoutError:
        logger.warning("计划审批超时 (300s): plan_id=%s", plan_id)
        return False


async def _pipe(events_gen, middlewares, ctx):
    """将事件流路由经过 Middleware 链。"""
    async for event in events_gen:
        processed = event
        for mw in middlewares:
            processed = await mw.on_event(processed, ctx)
            if processed is None:
                break
        if processed is not None:
            yield processed
