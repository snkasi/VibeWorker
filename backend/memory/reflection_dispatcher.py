"""反思分发器 — 管理策略注册、事件分发和异步执行

ReflectionDispatcher 是单例，负责：
1. 注册反思策略
2. 维护每会话的工具调用历史
3. 接收 Hook 事件并分发给匹配的策略
4. 异步执行策略的 reflect()，不阻塞主流程
5. 被动 TTL 清理超时会话数据
"""
import asyncio
import logging
import time
from typing import Optional

from memory.reflection_strategies import (
    HookEvent,
    HookContext,
    ToolCallRecord,
    ReflectionStrategy,
    ToolFailureStrategy,
    RepeatedToolStrategy,
)

logger = logging.getLogger(__name__)

# 会话数据过期时间（秒）：1 小时无活动自动清理
_SESSION_TTL = 3600
# 清理检查间隔（秒）
_CLEANUP_INTERVAL = 300


class ReflectionDispatcher:
    """反思事件分发器

    在 agent/executor 的 Hook 埋点处调用 emit()，
    自动匹配并调度注册的反思策略。
    """

    def __init__(self):
        self._strategies: list[ReflectionStrategy] = []
        # 每会话工具调用历史: session_id → list[ToolCallRecord]
        self._session_tracks: dict[str, list[ToolCallRecord]] = {}
        # 每会话最后活动时间: session_id → timestamp
        self._session_last_active: dict[str, float] = {}
        # 去重记录: (session_id, strategy_name)
        self._triggered: set[tuple[str, str]] = set()
        # 上次清理时间
        self._last_cleanup: float = time.time()

    def register(self, strategy: ReflectionStrategy) -> None:
        """注册一个反思策略"""
        self._strategies.append(strategy)
        logger.info("已注册反思策略: %s (监听事件: %s)",
                     strategy.strategy_name,
                     [e.value for e in strategy.trigger_on])

    def emit(
        self,
        event: str,
        session_id: str,
        *,
        tool_name: Optional[str] = None,
        tool_args: Optional[dict] = None,
        result_str: Optional[str] = None,
    ) -> None:
        """发射 Hook 事件，评估并调度匹配的策略

        Args:
            event: 事件类型字符串（对应 HookEvent 的值）
            session_id: 当前会话 ID
            tool_name: 工具名称（TOOL_END 时提供）
            tool_args: 工具参数（TOOL_END 时提供）
            result_str: 工具结果（TOOL_END 时提供）
        """
        try:
            hook_event = HookEvent(event)
        except ValueError:
            logger.warning("未知的 Hook 事件类型: %s", event)
            return

        # 被动 TTL 清理
        now = time.time()
        if now - self._last_cleanup > _CLEANUP_INTERVAL:
            self._passive_cleanup(now)

        # 更新会话活动时间
        self._session_last_active[session_id] = now

        # 如果是 TOOL_END，记录工具调用到会话历史
        current_tool_call: Optional[ToolCallRecord] = None
        if hook_event == HookEvent.TOOL_END and tool_name is not None:
            current_tool_call = ToolCallRecord(
                tool_name=tool_name,
                tool_args=tool_args or {},
                result_str=result_str or "",
                timestamp=now,
                is_error="[ERROR]" in (result_str or ""),
            )
            if session_id not in self._session_tracks:
                self._session_tracks[session_id] = []
            self._session_tracks[session_id].append(current_tool_call)

        # 构建 HookContext
        ctx = HookContext(
            event=hook_event,
            session_id=session_id,
            current_tool_call=current_tool_call,
            tool_history=list(self._session_tracks.get(session_id, [])),
        )

        # 遍历策略，检查匹配
        for strategy in self._strategies:
            if hook_event not in strategy.trigger_on:
                continue

            # 去重检查：allow_multiple=False 且本会话已触发则跳过
            dedup_key = (session_id, strategy.strategy_name)
            if not strategy.allow_multiple and dedup_key in self._triggered:
                continue

            try:
                if not strategy.should_trigger(ctx):
                    continue
            except Exception as e:
                logger.debug("策略 %s should_trigger 异常: %s",
                             strategy.strategy_name, e)
                continue

            # 记录触发（在调度前标记，避免重复）
            if not strategy.allow_multiple:
                self._triggered.add(dedup_key)

            logger.info("反思策略触发: %s (event=%s, session=%s)",
                        strategy.strategy_name, event, session_id)

            # 异步执行反思
            self._schedule_reflection(strategy, ctx)

    def _schedule_reflection(
        self, strategy: ReflectionStrategy, ctx: HookContext
    ) -> None:
        """异步执行反思（create_task，不阻塞主流程）"""

        async def _do_reflect():
            try:
                result = await strategy.reflect(ctx)

                # 如果策略返回了 {content, salience}，存储为程序性记忆
                if result and isinstance(result, dict) and result.get("content"):
                    from memory.manager import memory_manager

                    tool = result.get("tool")
                    content = result["content"]
                    salience = result.get("salience", 0.8)

                    # 存储程序性记忆
                    if tool:
                        memory_manager.add_procedural_memory(
                            content=content,
                            tool=tool,
                            session_id=ctx.session_id,
                            salience=salience,
                        )
                    else:
                        memory_manager.add_entry(
                            content=content,
                            category="reflections",
                            salience=salience,
                            source=strategy.strategy_name,
                        )

                    # 写入每日日志
                    memory_manager.append_daily_log(
                        content=f"[{strategy.strategy_name}] {content}",
                        log_type="reflection",
                        tool=tool,
                    )

                    logger.info("反思策略 %s 已存储记忆: %s",
                                strategy.strategy_name, content[:80])

            except Exception as e:
                logger.debug("反思策略 %s 执行失败（非致命）: %s",
                             strategy.strategy_name, e)

        try:
            loop = asyncio.get_running_loop()
            loop.create_task(_do_reflect())
        except RuntimeError:
            pass  # 无运行中的事件循环，跳过

    def cleanup_session(self, session_id: str) -> None:
        """手动清理指定会话的跟踪数据"""
        self._session_tracks.pop(session_id, None)
        self._session_last_active.pop(session_id, None)
        # 清理该会话的去重记录
        self._triggered = {
            (sid, name) for sid, name in self._triggered
            if sid != session_id
        }

    def _passive_cleanup(self, now: float) -> None:
        """被动 TTL 清理：移除超时无活动的会话数据"""
        self._last_cleanup = now
        expired = [
            sid for sid, last in self._session_last_active.items()
            if now - last > _SESSION_TTL
        ]
        for sid in expired:
            self.cleanup_session(sid)
        if expired:
            logger.debug("被动清理了 %d 个过期会话的反思跟踪数据", len(expired))


# ── 单例初始化 ──────────────────────────────────────────────

reflection_dispatcher = ReflectionDispatcher()

# 注册内置策略
reflection_dispatcher.register(ToolFailureStrategy())
reflection_dispatcher.register(RepeatedToolStrategy())

logger.info("已注册反思策略: %s",
            ", ".join(s.strategy_name for s in reflection_dispatcher._strategies))
