"""RunContext — 每请求上下文，替代全局状态。

持有会话信息和审批通道。
计划状态现由 StateGraph 图状态管理，不再存储在 RunContext 中。
"""
import asyncio
import logging
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger(__name__)


@dataclass
class RunContext:
    session_id: str
    debug: bool = False
    stream: bool = True

    # 由 runner 在执行前设置
    message: str = ""
    session_history: list = field(default_factory=list)

    # 审批通道（security gate + plan approval 共用）
    approval_queue: asyncio.Queue = field(default_factory=asyncio.Queue)
    event_loop: Optional[asyncio.AbstractEventLoop] = None
