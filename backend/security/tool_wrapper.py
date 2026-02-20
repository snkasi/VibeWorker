"""Tool Wrapper - Wraps LangChain tools with security gate checks.

采用统一的 session context 注入机制：
1. 从 RunnableConfig 中提取 session_id
2. 在调用工具前设置到 session_context
3. 工具内部通过 get_current_session_id() 获取

这样工具不需要声明 config 参数，简化工具开发。
"""
import logging
import time
from typing import Any

from langchain_core.tools import BaseTool, StructuredTool
from langchain_core.runnables import RunnableConfig

from security.gate import security_gate
from security.audit import audit_logger

logger = logging.getLogger(__name__)


def _extract_session_id(config: RunnableConfig) -> str:
    """从 RunnableConfig 中提取 session_id。

    Args:
        config: LangChain 传递的配置对象

    Returns:
        session_id，提取失败时返回空字符串
    """
    if not config:
        return ""
    try:
        if isinstance(config, dict):
            return config.get("configurable", {}).get("session_id", "")
        # 处理可能的其他类型
        configurable = getattr(config, "configurable", None)
        if configurable:
            return configurable.get("session_id", "")
    except Exception:
        pass
    return ""


def create_secured_tool(original_tool: BaseTool) -> BaseTool:
    """Wrap a LangChain tool with security gate checks.

    包装后的工具会：
    1. 从 config 中提取 session_id 并设置到 session_context
    2. 检查权限（SecurityGate）
    3. 如果被拒绝，返回拒绝消息
    4. 如果允许，执行原始工具
    5. 工具执行完毕后恢复 session_context

    工具内部可以通过 get_current_session_id() 获取 session_id，
    无需声明 config 参数。
    """
    tool_name = original_tool.name

    # 获取原始函数
    original_func = original_tool.func if hasattr(original_tool, 'func') else None
    original_coroutine = original_tool.coroutine if hasattr(original_tool, 'coroutine') else None

    async def secured_invoke(config: RunnableConfig, **kwargs: Any) -> str:
        """安全包装的异步工具调用。

        Args:
            config: RunnableConfig，由 LangChain 自动注入
            **kwargs: 工具参数
        """
        # 从 config 中提取 session_id 并设置到 session_context
        from session_context import set_current_session_id, reset_session_id

        session_id = _extract_session_id(config)
        token = set_current_session_id(session_id)

        try:
            start = time.time()

            # 检查权限（返回 allowed, reason, feedback）
            allowed, reason, feedback = await security_gate.check_permission(tool_name, kwargs)

            if not allowed:
                # 检查是否是用户指示（instruct action）
                if reason.startswith("[用户指示]"):
                    logger.info(f"Tool {tool_name} 收到用户指示: {reason}")
                    return f"⚠️ 用户要求你重新考虑：{reason}"
                logger.info(f"Tool {tool_name} blocked: {reason}")
                return f"⛔ Operation denied: {reason}"

            # 执行原始工具
            # 注意：工具内部通过 get_current_session_id() 获取 session_id
            # 不需要传递 config 参数
            try:
                if original_coroutine:
                    result = await original_coroutine(**kwargs)
                elif original_func:
                    result = original_func(**kwargs)
                else:
                    # 回退到 ainvoke（传递 config 以支持嵌套调用）
                    result = await original_tool.ainvoke(kwargs, config=config)

                elapsed = (time.time() - start) * 1000
                if security_gate._audit_enabled:
                    audit_logger.log(
                        tool_name=tool_name,
                        tool_input=kwargs,
                        risk_level="executed",
                        action="executed",
                        execution_time_ms=elapsed,
                    )

                # 如果用户提供了反馈/指示，注入到结果中让 LLM 看到
                if feedback:
                    result = f"[用户指示] {feedback}\n\n{result}"
                    logger.info(f"Tool {tool_name} 注入用户反馈: {feedback[:50]}...")

                return result

            except Exception as e:
                elapsed = (time.time() - start) * 1000
                if security_gate._audit_enabled:
                    audit_logger.log(
                        tool_name=tool_name,
                        tool_input=kwargs,
                        risk_level="error",
                        action="error",
                        execution_time_ms=elapsed,
                        error=str(e),
                    )
                raise

        finally:
            # 恢复 session_context
            reset_session_id(token)

    # 创建包装后的 StructuredTool
    secured = StructuredTool(
        name=original_tool.name,
        description=original_tool.description,
        args_schema=original_tool.args_schema,
        coroutine=secured_invoke,
        # 同步函数设为 None，统一使用异步
    )

    return secured


def wrap_all_tools(tools: list[BaseTool]) -> list[BaseTool]:
    """Wrap all tools in a list with security checks.

    在 RELAXED 模式下不包装（性能优化），
    但这意味着 RELAXED 模式下 session_id 需要其他方式传递。
    """
    from security.config import SecurityLevel

    # RELAXED 模式下不包装
    if security_gate.security_level == SecurityLevel.RELAXED:
        # 即使不包装安全检查，也需要注入 session_id
        # 创建轻量级的 session context wrapper
        return [_create_session_context_wrapper(tool) for tool in tools]

    wrapped = []
    for tool in tools:
        try:
            wrapped.append(create_secured_tool(tool))
        except Exception as e:
            logger.error(f"Failed to wrap tool {tool.name}: {e}")
            wrapped.append(tool)  # 回退到未包装
    return wrapped


def _create_session_context_wrapper(original_tool: BaseTool) -> BaseTool:
    """创建仅注入 session_context 的轻量级包装器（用于 RELAXED 模式）。

    不进行安全检查，只设置 session_id。
    """
    original_func = original_tool.func if hasattr(original_tool, 'func') else None
    original_coroutine = original_tool.coroutine if hasattr(original_tool, 'coroutine') else None

    async def context_inject_invoke(config: RunnableConfig, **kwargs: Any) -> str:
        """仅注入 session_context 的包装器。"""
        from session_context import set_current_session_id, reset_session_id

        session_id = _extract_session_id(config)
        token = set_current_session_id(session_id)

        try:
            if original_coroutine:
                return await original_coroutine(**kwargs)
            elif original_func:
                return original_func(**kwargs)
            else:
                return await original_tool.ainvoke(kwargs, config=config)
        finally:
            reset_session_id(token)

    return StructuredTool(
        name=original_tool.name,
        description=original_tool.description,
        args_schema=original_tool.args_schema,
        coroutine=context_inject_invoke,
    )
