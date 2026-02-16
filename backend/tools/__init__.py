"""Core Tools Package - 7 built-in tools + Plan tools for VibeWorker Agent."""
from tools.terminal_tool import create_terminal_tool
from tools.python_repl_tool import create_python_repl_tool
from tools.fetch_url_tool import create_fetch_url_tool
from tools.read_file_tool import create_read_file_tool
from tools.rag_tool import create_rag_tool
from tools.memory_write_tool import create_memory_write_tool
from tools.memory_search_tool import create_memory_search_tool
from tools.plan_tool import create_plan_create_tool, create_plan_update_tool

__all__ = [
    "create_terminal_tool",
    "create_python_repl_tool",
    "create_fetch_url_tool",
    "create_read_file_tool",
    "create_rag_tool",
    "create_memory_write_tool",
    "create_memory_search_tool",
    "create_plan_create_tool",
    "create_plan_update_tool",
]


def get_all_tools() -> list:
    """Create and return all core tools + Plan tools + MCP tools, wrapped with security."""
    from config import settings

    tools = [
        create_terminal_tool(),
        create_python_repl_tool(),
        create_fetch_url_tool(),
        create_read_file_tool(),
        create_rag_tool(),
        create_memory_write_tool(),
        create_memory_search_tool(),
    ]

    # Add Plan tools if enabled
    if getattr(settings, "plan_enabled", True):
        tools.append(create_plan_create_tool())
        tools.append(create_plan_update_tool())
    # Append MCP tools (dynamic, from connected MCP servers)
    try:
        from mcp_module import mcp_manager
        mcp_tools = mcp_manager.get_all_mcp_tools()
        if mcp_tools:
            tools.extend(mcp_tools)
    except Exception:
        pass  # MCP unavailable — does not affect core tools

    # Wrap all tools with security gate (only when security is enabled)
    try:
        if settings.security_enabled:
            from security import wrap_all_tools
            tools = wrap_all_tools(tools)
    except Exception:
        pass  # Security module unavailable — tools run unwrapped

    return tools
