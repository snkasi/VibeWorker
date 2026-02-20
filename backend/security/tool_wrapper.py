"""Tool Wrapper - Wraps LangChain tools with security gate checks.

Uses a decorator pattern to intercept tool calls, check permissions
via SecurityGate, and block/approve execution.
"""
import logging
import time
from typing import Any

from langchain_core.tools import BaseTool, StructuredTool

from security.gate import security_gate
from security.audit import audit_logger

logger = logging.getLogger(__name__)


def create_secured_tool(original_tool: BaseTool) -> BaseTool:
    """Wrap a LangChain tool with security gate checks.

    The wrapped tool will:
    1. Parse the tool input
    2. Check permission via SecurityGate
    3. If denied, return a denial message (not raise an exception)
    4. If allowed, execute the original tool
    """
    tool_name = original_tool.name

    # Get the original function
    original_func = original_tool.func if hasattr(original_tool, 'func') else None
    original_coroutine = original_tool.coroutine if hasattr(original_tool, 'coroutine') else None

    async def secured_invoke(**kwargs: Any) -> str:
        """Secured async wrapper around the tool."""
        start = time.time()

        # Check permission（返回 allowed, reason, feedback）
        allowed, reason, feedback = await security_gate.check_permission(tool_name, kwargs)

        if not allowed:
            logger.info(f"Tool {tool_name} blocked: {reason}")
            return f"⛔ Operation denied: {reason}"

        # Execute original tool
        try:
            if original_coroutine:
                result = await original_coroutine(**kwargs)
            elif original_func:
                result = original_func(**kwargs)
            else:
                result = await original_tool.ainvoke(kwargs)

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

    # Create a new StructuredTool with the secured function
    secured = StructuredTool(
        name=original_tool.name,
        description=original_tool.description,
        args_schema=original_tool.args_schema,
        coroutine=secured_invoke,
        # Keep sync func as None - we always use async
    )

    return secured


def wrap_all_tools(tools: list[BaseTool]) -> list[BaseTool]:
    """Wrap all tools in a list with security checks.

    Tools that are already secured (or safe by default like memory tools)
    are wrapped to maintain consistent behavior.
    """
    from security.config import SecurityLevel

    # In relaxed mode, don't wrap at all for performance
    if security_gate.security_level == SecurityLevel.RELAXED:
        return tools

    wrapped = []
    for tool in tools:
        try:
            wrapped.append(create_secured_tool(tool))
        except Exception as e:
            logger.error(f"Failed to wrap tool {tool.name}: {e}")
            wrapped.append(tool)  # Fallback to unwrapped
    return wrapped
