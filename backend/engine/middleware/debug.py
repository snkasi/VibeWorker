"""调试中间件 — 可插拔的分级调试追踪。

将所有调试/追踪逻辑从 agent.py 和 app.py 抽取到统一位置。
支持不同级别的详细程度配置。
"""
import logging
from datetime import datetime
from enum import Enum
from typing import Optional

from engine.context import RunContext

logger = logging.getLogger(__name__)


class DebugLevel(str, Enum):
    OFF = "off"
    BASIC = "basic"         # 仅工具计时
    STANDARD = "standard"   # + LLM 调用开始/结束 + Token 统计
    FULL = "full"           # + 完整输入/输出内容


class InMemoryCollector:
    """默认收集器：在内存中累积调试事件，运行结束后批量持久化。"""

    def __init__(self):
        self._calls: list[dict] = []

    def record_tool_start(self, event: dict) -> None:
        self._calls.append({
            "tool": event.get("tool", ""),
            "input": event.get("input", ""),
            "output": "",
            "duration_ms": None,
            "cached": False,
            "timestamp": datetime.now().isoformat(),
            "_inProgress": True,
            "motivation": event.get("motivation", ""),
        })

    def record_tool_end(self, event: dict) -> None:
        tool_name = event.get("tool", "")
        for i in range(len(self._calls) - 1, -1, -1):
            call = self._calls[i]
            if call.get("tool") == tool_name and call.get("_inProgress"):
                self._calls[i] = {
                    **call,
                    "output": event.get("output", "")[:1000],
                    "duration_ms": event.get("duration_ms"),
                    "cached": event.get("cached", False),
                    "_inProgress": False,
                }
                break

    def record_llm_start(self, event: dict) -> None:
        self._calls.append({
            "call_id": event.get("call_id", ""),
            "node": event.get("node", ""),
            "model": event.get("model", ""),
            "duration_ms": None,
            "input_tokens": None,
            "output_tokens": None,
            "total_tokens": None,
            "tokens_estimated": None,
            "input": event.get("input", ""),
            "output": "",
            # 成本相关字段（在 llm_end 时填充）
            "input_cost": None,
            "output_cost": None,
            "total_cost": None,
            "cost_estimated": None,
            "model_info": None,
            "timestamp": datetime.now().isoformat(),
            "_inProgress": True,
            "motivation": event.get("motivation", ""),
        })

    def record_llm_end(self, event: dict) -> None:
        call_id = event.get("call_id", "")
        for i in range(len(self._calls) - 1, -1, -1):
            call = self._calls[i]
            if call.get("call_id") == call_id and call.get("_inProgress"):
                self._calls[i] = {
                    **call,
                    "duration_ms": event.get("duration_ms"),
                    "input_tokens": event.get("input_tokens"),
                    "output_tokens": event.get("output_tokens"),
                    "total_tokens": event.get("total_tokens"),
                    "tokens_estimated": event.get("tokens_estimated"),
                    "output": event.get("output", ""),
                    # 成本相关字段（基于 OpenRouter 定价）
                    "input_cost": event.get("input_cost"),
                    "output_cost": event.get("output_cost"),
                    "total_cost": event.get("total_cost"),
                    "cost_estimated": event.get("cost_estimated"),
                    "model_info": event.get("model_info"),
                    "_inProgress": False,
                }
                break

    def get_all(self) -> list[dict]:
        return self._calls


class DebugMiddleware:
    """可插拔的分级调试追踪中间件。"""

    def __init__(self, level: DebugLevel = DebugLevel.STANDARD, collector: Optional[InMemoryCollector] = None):
        self.level = level
        self.collector = collector or InMemoryCollector()

    async def on_run_start(self, ctx: RunContext) -> None:
        pass

    async def on_event(self, event: dict, ctx: RunContext) -> Optional[dict]:
        if self.level == DebugLevel.OFF:
            return event

        event_type = event.get("type", "")

        # BASIC 及以上：追踪工具调用
        if event_type == "tool_start":
            self.collector.record_tool_start(event)
        elif event_type == "tool_end":
            self.collector.record_tool_end(event)

        # STANDARD 及以上：追踪 LLM 调用
        if self.level.value >= DebugLevel.STANDARD.value:
            if event_type == "llm_start":
                self.collector.record_llm_start(event)
            elif event_type == "llm_end":
                self.collector.record_llm_end(event)

        # STANDARD 级别：截断大 payload 以节省带宽
        if self.level == DebugLevel.STANDARD:
            if event_type == "llm_start" and len(event.get("input", "")) > 2000:
                event = {**event, "input": event["input"][:2000] + "...[truncated]"}
            if event_type == "llm_end" and len(event.get("output", "")) > 1000:
                event = {**event, "output": event["output"][:1000] + "...[truncated]"}

        return event

    async def on_run_end(self, ctx: RunContext) -> None:
        """运行结束时持久化收集的调试数据。"""
        if self.level == DebugLevel.OFF:
            return
        calls = self.collector.get_all()
        if calls:
            from sessions_manager import session_manager
            session_manager.save_debug_calls(ctx.session_id, calls)
