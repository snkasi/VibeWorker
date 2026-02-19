"""图构建器 — 根据配置组装 StateGraph。

根据 graph_config.yaml 配置控制哪些节点添加、边如何连接。
编译后的图通过内容指纹缓存，配置不变时复用。
"""
import hashlib
import json
import logging
from functools import lru_cache
from typing import Optional

from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, StateGraph

from engine.config_loader import get_node_config, get_settings, load_graph_config
from engine.edges import (
    route_after_agent,
    route_after_approval,
    route_after_plan_gate,
    route_after_replanner,
)
from engine.nodes import (
    agent_node,
    approval_node,
    executor_node,
    plan_gate_node,
    replanner_node,
    summarizer_node,
)
from engine.state import AgentState

logger = logging.getLogger(__name__)

# 图缓存：fingerprint → 编译后的图
_graph_cache: dict[str, tuple] = {}

# 全局 checkpointer（用于 interrupt/resume）
_checkpointer = MemorySaver()


def build_graph(graph_config: dict):
    """根据配置构建 StateGraph 并编译。

    Args:
        graph_config: 从 config_loader 加载的完整配置

    Returns:
        编译后的 CompiledGraph
    """
    nodes_cfg = graph_config.get("graph", {}).get("nodes", {})
    settings_cfg = get_settings(graph_config)

    planner_enabled = nodes_cfg.get("planner", {}).get("enabled", True)
    approval_enabled = nodes_cfg.get("approval", {}).get("enabled", False)
    replanner_enabled = nodes_cfg.get("replanner", {}).get("enabled", True)
    summarizer_enabled = nodes_cfg.get("summarizer", {}).get("enabled", True)

    graph = StateGraph(AgentState)

    # ========== 添加节点 ==========
    graph.add_node("agent", agent_node)

    if planner_enabled:
        graph.add_node("plan_gate", plan_gate_node)

        if approval_enabled:
            graph.add_node("approval", approval_node)

        graph.add_node("executor", executor_node)

        if replanner_enabled:
            graph.add_node("replanner", replanner_node)

        if summarizer_enabled:
            graph.add_node("summarizer", summarizer_node)

    # ========== 入口 ==========
    graph.set_entry_point("agent")

    # ========== 添加边 ==========

    if planner_enabled:
        # agent → plan_gate | END
        graph.add_conditional_edges("agent", route_after_agent, {
            "plan_gate": "plan_gate",
            END: END,
        })

        # plan_gate → approval | executor
        if approval_enabled:
            def _route_plan_gate(state):
                return route_after_plan_gate(state, approval_enabled=True)

            graph.add_conditional_edges("plan_gate", _route_plan_gate, {
                "approval": "approval",
                "executor": "executor",
            })

            # approval → executor | agent
            graph.add_conditional_edges("approval", route_after_approval, {
                "executor": "executor",
                "agent": "agent",
            })
        else:
            graph.add_edge("plan_gate", "executor")

        if replanner_enabled:
            # executor → replanner
            graph.add_edge("executor", "replanner")

            if summarizer_enabled:
                # replanner → executor | summarizer
                graph.add_conditional_edges("replanner", route_after_replanner, {
                    "executor": "executor",
                    "summarizer": "summarizer",
                })
                # summarizer → agent（回到主循环）
                graph.add_edge("summarizer", "agent")
            else:
                # replanner → executor | END
                graph.add_conditional_edges("replanner", route_after_replanner, {
                    "executor": "executor",
                    "summarizer": END,  # summarizer 禁用时直连 END
                })
        else:
            # 无 replanner：executor 自行判断是否完成
            if summarizer_enabled:
                def _route_executor_no_replanner(state: AgentState) -> str:
                    """无 replanner 时的 executor 路由。"""
                    plan_data = state.get("plan_data")
                    if not plan_data:
                        return "summarizer"
                    step_index = state.get("current_step_index", 0)
                    total_steps = len(plan_data.get("steps", []))
                    max_steps = nodes_cfg.get("executor", {}).get("max_steps", 8)
                    if step_index >= total_steps or step_index >= max_steps:
                        return "summarizer"
                    return "executor"

                graph.add_conditional_edges("executor", _route_executor_no_replanner, {
                    "executor": "executor",
                    "summarizer": "summarizer",
                })
                graph.add_edge("summarizer", "agent")
            else:
                def _route_executor_minimal(state: AgentState) -> str:
                    """最简模式的 executor 路由。"""
                    plan_data = state.get("plan_data")
                    if not plan_data:
                        return END
                    step_index = state.get("current_step_index", 0)
                    total_steps = len(plan_data.get("steps", []))
                    max_steps = nodes_cfg.get("executor", {}).get("max_steps", 8)
                    if step_index >= total_steps or step_index >= max_steps:
                        return END
                    return "executor"

                graph.add_conditional_edges("executor", _route_executor_minimal, {
                    "executor": "executor",
                    END: END,
                })
    else:
        # planner 禁用 → agent 直连 END
        graph.add_edge("agent", END)

    # ========== 编译 ==========
    recursion_limit = settings_cfg.get("recursion_limit", 100)
    compiled = graph.compile(
        checkpointer=_checkpointer,
    )

    logger.info("StateGraph 已构建: planner=%s, approval=%s, replanner=%s, summarizer=%s",
                planner_enabled, approval_enabled, replanner_enabled, summarizer_enabled)

    return compiled


def get_or_build_graph(graph_config: dict):
    """获取或构建编译后的图（带指纹缓存）。"""
    fp = _config_fingerprint(graph_config)
    if fp not in _graph_cache:
        compiled = build_graph(graph_config)
        _graph_cache[fp] = compiled
        logger.debug("图已缓存，指纹: %s", fp)
    return _graph_cache[fp]


def _config_fingerprint(graph_config: dict) -> str:
    """根据配置内容生成 SHA256 短指纹。"""
    raw = json.dumps(graph_config, sort_keys=True)
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def invalidate_graph_cache() -> None:
    """清除图缓存。配置变更后应调用此函数。"""
    _graph_cache.clear()
    logger.info("图缓存已清除")
