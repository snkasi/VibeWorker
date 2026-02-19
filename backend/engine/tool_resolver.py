"""工具解析器 — 从配置规格解析工具列表。

支持三种写法：
- ["all"] — 全部工具（7 core + plan + MCP）
- ["core", "mcp"] — 按类别组合
- ["terminal", "read_file", "fetch_url"] — 按名称指定
"""
import logging
from typing import Optional

logger = logging.getLogger(__name__)


def resolve_tools(tool_spec: list[str], include_plan_create: bool = True) -> list:
    """根据配置规格解析工具列表。

    Args:
        tool_spec: 工具规格列表，如 ["all"], ["core", "mcp"], ["terminal", "read_file"]
        include_plan_create: 是否包含 plan_create 工具

    Returns:
        LangChain 工具对象列表
    """
    from tools import (
        _get_core_tools, _append_mcp_tools, _wrap_security,
        create_plan_create_tool, create_plan_update_tool,
    )

    if not tool_spec:
        tool_spec = ["all"]

    # 标准化为小写
    spec_lower = [s.lower() for s in tool_spec]

    # "all" = 全部工具
    if "all" in spec_lower:
        tools = _get_core_tools()
        if include_plan_create:
            tools.append(create_plan_create_tool())
        tools.append(create_plan_update_tool())
        tools = _append_mcp_tools(tools)
        return _wrap_security(tools)

    # 按类别或名称组合
    tools = []
    tool_names_added = set()

    if "core" in spec_lower:
        core = _get_core_tools()
        tools.extend(core)
        tool_names_added.update(t.name for t in core)

    if "mcp" in spec_lower:
        tools = _append_mcp_tools(tools)

    if "plan" in spec_lower:
        if include_plan_create:
            tools.append(create_plan_create_tool())
        tools.append(create_plan_update_tool())
        tool_names_added.update(["plan_create", "plan_update"])

    # 按具体工具名指定
    specific_names = [s for s in spec_lower if s not in ("core", "mcp", "plan", "all")]
    if specific_names:
        all_available = _get_core_tools()
        if include_plan_create:
            all_available.append(create_plan_create_tool())
        all_available.append(create_plan_update_tool())
        all_available = _append_mcp_tools(all_available)

        name_map = {t.name: t for t in all_available}
        for name in specific_names:
            if name in name_map and name not in tool_names_added:
                tools.append(name_map[name])
                tool_names_added.add(name)
            else:
                if name not in name_map:
                    logger.warning("配置中指定的工具不存在: %s", name)

    return _wrap_security(tools)


def resolve_executor_tools(tool_spec: Optional[list[str]] = None) -> list:
    """解析 Executor 节点的工具集（默认不含 plan_create）。"""
    if tool_spec is None:
        tool_spec = ["core", "mcp"]
    return resolve_tools(tool_spec, include_plan_create=False)
