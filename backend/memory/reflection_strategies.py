"""反思策略框架 — 通用 Hook 事件 + 可扩展策略基类

定义反思 Hook 事件类型、工具调用记录、Hook 上下文，
以及两个内置策略：
1. ToolFailureStrategy — 工具失败时委托 reflector 记录经验
2. RepeatedToolStrategy — 同一工具 ≥3 次调用时 LLM 分析提取操作经验

扩展新策略只需继承 ReflectionStrategy，无需修改 agent.py / executor.py。
"""
import json
import logging
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional

logger = logging.getLogger(__name__)


class HookEvent(str, Enum):
    """反思 Hook 事件类型

    在 agent/executor 的关键生命周期点发射，
    策略通过 trigger_on 声明监听的事件类型。
    """
    TOOL_END = "tool_end"    # 每次工具执行后
    TURN_END = "turn_end"    # 一轮 ReAct 循环结束后


@dataclass
class ToolCallRecord:
    """单次工具调用记录"""
    tool_name: str
    tool_args: dict
    result_str: str          # 截断到 2000 字符
    timestamp: float
    is_error: bool           # "[ERROR]" in result_str

    def __post_init__(self):
        # 截断过长的结果字符串
        if len(self.result_str) > 2000:
            self.result_str = self.result_str[:2000] + "...[truncated]"


@dataclass
class HookContext:
    """Hook 事件上下文，传递给策略的 should_trigger / reflect"""
    event: HookEvent
    session_id: str
    # TOOL_END 时有值：
    current_tool_call: Optional[ToolCallRecord] = None
    # 始终可用（本会话全部工具调用历史）：
    tool_history: list[ToolCallRecord] = field(default_factory=list)


class ReflectionStrategy(ABC):
    """反思策略基类

    子类需实现：
    - strategy_name: 唯一标识（用于去重日志）
    - trigger_on: 监听的 HookEvent 列表
    - should_trigger(ctx): 是否满足触发条件
    - reflect(ctx): 执行反思，返回 {content, salience} 或 None
    """

    @property
    @abstractmethod
    def strategy_name(self) -> str:
        """策略唯一标识"""
        ...

    @property
    @abstractmethod
    def trigger_on(self) -> list[HookEvent]:
        """监听的事件列表"""
        ...

    @property
    def allow_multiple(self) -> bool:
        """是否允许同会话多次触发，默认 True"""
        return True

    @abstractmethod
    def should_trigger(self, ctx: HookContext) -> bool:
        """判断是否满足触发条件"""
        ...

    @abstractmethod
    async def reflect(self, ctx: HookContext) -> Optional[dict]:
        """执行反思逻辑

        Returns:
            {content, salience} 字典（由 dispatcher 存储），
            或 None（策略内部已处理存储，如 ToolFailureStrategy）
        """
        ...


class ToolFailureStrategy(ReflectionStrategy):
    """工具失败反思策略 — 委托 reflector.record_tool_failure()

    每次工具执行返回 [ERROR] 时触发，与原有行为完全一致。
    allow_multiple=True，因为每次失败都应独立分析。
    """

    @property
    def strategy_name(self) -> str:
        return "tool_failure"

    @property
    def trigger_on(self) -> list[HookEvent]:
        return [HookEvent.TOOL_END]

    @property
    def allow_multiple(self) -> bool:
        return True

    def should_trigger(self, ctx: HookContext) -> bool:
        return (
            ctx.current_tool_call is not None
            and ctx.current_tool_call.is_error
        )

    async def reflect(self, ctx: HookContext) -> Optional[dict]:
        """委托 reflector 处理，存储在 reflector 内部完成，返回 None"""
        tc = ctx.current_tool_call
        if tc is None:
            return None
        try:
            from memory.reflector import record_tool_failure
            await record_tool_failure(
                tool_name=tc.tool_name,
                tool_input=tc.tool_args,
                error_message=tc.result_str,
                session_id=ctx.session_id,
            )
        except Exception as e:
            logger.debug("ToolFailureStrategy 反思失败（非致命）: %s", e)
        return None


class RepeatedToolStrategy(ReflectionStrategy):
    """重复工具使用反思策略 — 同一工具 ≥3 次调用时 LLM 分析

    在一轮 ReAct 循环结束时检查工具调用历史，
    如果同一工具被调用 3 次及以上，用 LLM 分析是否有可复用的操作经验。
    allow_multiple=False，每会话最多触发一次。
    """

    # 触发阈值：同一工具至少调用 N 次
    REPEAT_THRESHOLD = 3

    @property
    def strategy_name(self) -> str:
        return "repeated_tool"

    @property
    def trigger_on(self) -> list[HookEvent]:
        return [HookEvent.TURN_END]

    @property
    def allow_multiple(self) -> bool:
        return False

    def should_trigger(self, ctx: HookContext) -> bool:
        """检查是否有工具被调用 ≥ REPEAT_THRESHOLD 次"""
        return self._find_repeated_tool(ctx.tool_history) is not None

    async def reflect(self, ctx: HookContext) -> Optional[dict]:
        """LLM 分析重复工具调用，提取可复用经验"""
        tool_name = self._find_repeated_tool(ctx.tool_history)
        if not tool_name:
            return None

        # 提取该工具的全部调用记录
        records = [r for r in ctx.tool_history if r.tool_name == tool_name]
        call_count = len(records)

        # 构建调用时间线
        timeline_lines = []
        for i, r in enumerate(records, 1):
            # 参数摘要（截断）
            args_str = str(r.tool_args)[:200]
            # 结果摘要
            status = "失败" if r.is_error else "成功"
            result_brief = r.result_str[:150]
            timeline_lines.append(
                f"  第{i}次 → 参数: {args_str} → 结果({status}): {result_brief}"
            )
        timeline = "\n".join(timeline_lines)

        prompt = f"""你在本次对话中对工具 {tool_name} 进行了 {call_count} 次调用。

调用时间线：
{timeline}

请分析是否存在可复用的操作经验：
- 如果多次尝试后找到了有效方法，总结最佳方案
- 如果参数调整带来了更好的结果，记录最佳参数策略
- 评估重要性（0.7-1.0）
- 如果没有可复用价值（如纯粹重复调用同样参数且都成功），返回 null

返回 JSON: {{"content": "经验描述", "salience": 0.85}} 或 null"""

        try:
            from engine.llm_factory import create_llm
            llm = create_llm()
            response = await llm.ainvoke(prompt)
            result = response.content.strip()

            # 清理 markdown 代码块
            if result.startswith("```"):
                lines = result.split("\n")
                result = "\n".join(
                    lines[1:-1] if lines[-1].strip() == "```" else lines[1:]
                )

            if result.lower() == "null" or not result:
                return None

            data = json.loads(result)
            if not data or not isinstance(data, dict):
                return None

            content = data.get("content", "")
            if not content:
                return None

            return {
                "content": content,
                "tool": tool_name,
                "salience": max(0.7, min(1.0, float(data.get("salience", 0.85)))),
            }

        except json.JSONDecodeError:
            logger.warning("RepeatedToolStrategy: 无法解析 LLM 返回的 JSON")
            return None
        except Exception as e:
            logger.debug("RepeatedToolStrategy 反思失败（非致命）: %s", e)
            return None

    def _find_repeated_tool(self, history: list[ToolCallRecord]) -> Optional[str]:
        """找出第一个调用次数 ≥ 阈值的工具名，找不到返回 None"""
        counts: dict[str, int] = {}
        for r in history:
            counts[r.tool_name] = counts.get(r.tool_name, 0) + 1
        for name, cnt in counts.items():
            if cnt >= self.REPEAT_THRESHOLD:
                return name
        return None
