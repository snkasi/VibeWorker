"""Core Tools Package - 7 built-in tools + Plan tools for VibeWorker Agent."""
from tools.terminal_tool import create_terminal_tool
from tools.python_repl_tool import create_python_repl_tool
from tools.fetch_url_tool import create_fetch_url_tool
from tools.read_file_tool import create_read_file_tool
from tools.rag_tool import create_rag_tool
from tools.memory_write_tool import create_memory_write_tool
from tools.memory_search_tool import create_memory_search_tool
from tools.plan_tool import create_plan_create_tool

__all__ = [
    "create_terminal_tool",
    "create_python_repl_tool",
    "create_fetch_url_tool",
    "create_read_file_tool",
    "create_rag_tool",
    "create_memory_write_tool",
    "create_memory_search_tool",
    "create_plan_create_tool",
    "get_executor_tools",
]


def _get_core_tools() -> list:
    """Return the 7 core tools (no plan tools, no MCP)."""
    return [
        create_terminal_tool(),
        create_python_repl_tool(),
        create_fetch_url_tool(),
        create_read_file_tool(),
        create_rag_tool(),
        create_memory_write_tool(),
        create_memory_search_tool(),
    ]


def _append_mcp_tools(tools: list) -> list:
    """Append MCP tools if available."""
    try:
        from mcp_module import mcp_manager
        mcp_tools = mcp_manager.get_all_mcp_tools()
        if mcp_tools:
            tools.extend(mcp_tools)
    except Exception:
        pass  # MCP unavailable — does not affect core tools
    return tools


def _wrap_security(tools: list) -> list:
    """Wrap tools with security gate if enabled."""
    from config import settings
    try:
        if settings.security_enabled:
            from security import wrap_all_tools
            tools = wrap_all_tools(tools)
    except Exception:
        pass  # Security module unavailable — tools run unwrapped
    return tools


def get_all_tools() -> list:
    """Create and return all core tools + Plan tools + MCP tools, wrapped with security."""
    from config import settings

    tools = _get_core_tools()

    # 添加 plan_create 工具（plan_update 已移除：executor 通过 pending_events 自动管理步骤状态）
    if getattr(settings, "plan_enabled", True):
        tools.append(create_plan_create_tool())

    tools = _append_mcp_tools(tools)
    tools = _wrap_security(tools)
    return tools


def get_executor_tools() -> list:
    """返回 Executor 子 Agent 的工具集。

    包含 7 个 Core Tools + MCP 工具（不含 plan_create / plan_update）。
    步骤状态由 executor 节点通过 pending_events 自动管理，无需 plan_update 工具。
    """
    tools = _get_core_tools()
    tools = _append_mcp_tools(tools)
    tools = _wrap_security(tools)
    return tools
