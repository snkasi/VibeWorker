"""图配置加载器 — 从用户数据目录读取 YAML 配置。

加载 {data_dir}/graph_config.yaml，缺失字段自动用硬编码默认值补全。
"""
import logging
from pathlib import Path
from typing import Any

import yaml

logger = logging.getLogger(__name__)

# 硬编码默认值（YAML 文件缺失或字段不完整时兜底）
_DEFAULTS: dict[str, Any] = {
    "graph": {
        "nodes": {
            "agent": {
                "enabled": True,
                "max_iterations": 50,
                "tools": ["all"],
            },
            "planner": {
                "enabled": True,
            },
            "approval": {
                "enabled": False,
            },
            "executor": {
                "enabled": True,
                "max_iterations": 30,
                "max_steps": 8,
                "tools": ["core", "mcp"],
            },
            "replanner": {
                "enabled": True,
                "skip_on_success": True,
            },
            "summarizer": {
                "enabled": True,
            },
        },
        "settings": {
            "recursion_limit": 100,
        },
    }
}


def _deep_merge(base: dict, override: dict) -> dict:
    """深度合并两个字典，override 覆盖 base 中对应的值。"""
    result = dict(base)
    for key, value in override.items():
        if key in result and isinstance(result[key], dict) and isinstance(value, dict):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def _get_config_path() -> Path:
    """获取用户数据目录下的图配置路径。"""
    from config import settings
    return settings.get_data_path() / "graph_config.yaml"


def load_graph_config(config_path: Path = None) -> dict:
    """加载图配置。

    1. 从用户数据目录读取 YAML 文件
    2. 与硬编码默认值深度合并
    3. 缺失字段自动补全

    Args:
        config_path: 配置文件路径，默认为 {data_dir}/graph_config.yaml

    Returns:
        合并后的完整配置字典
    """
    path = config_path or _get_config_path()
    user_config: dict = {}

    if path.exists():
        try:
            with open(path, "r", encoding="utf-8") as f:
                raw = yaml.safe_load(f)
            if isinstance(raw, dict):
                user_config = raw
            logger.debug("已加载图配置: %s", path)
        except Exception as e:
            logger.warning("加载图配置失败，使用默认值: %s", e)
    else:
        logger.info("图配置文件不存在 (%s)，使用默认值", path)

    return _deep_merge(_DEFAULTS, user_config)


def save_graph_config(config: dict, config_path: Path = None) -> None:
    """保存图配置到 YAML 文件。

    Args:
        config: 要保存的配置字典
        config_path: 配置文件路径，默认为 {data_dir}/graph_config.yaml
    """
    path = config_path or _get_config_path()
    path.parent.mkdir(parents=True, exist_ok=True)

    with open(path, "w", encoding="utf-8") as f:
        yaml.dump(config, f, default_flow_style=False, allow_unicode=True, sort_keys=False)
    logger.info("图配置已保存: %s", path)


def get_node_config(config: dict, node_name: str) -> dict:
    """获取指定节点的配置。"""
    return config.get("graph", {}).get("nodes", {}).get(node_name, {})


def get_settings(config: dict) -> dict:
    """获取全局设置。"""
    return config.get("graph", {}).get("settings", {})


def get_defaults() -> dict:
    """获取硬编码默认值（用于初始化）。"""
    return _DEFAULTS.copy()
