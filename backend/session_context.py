"""会话上下文 — 为工具提供当前 session_id 和 RunContext。

采用双层架构：
1. contextvars：用于 asyncio 协程间的上下文传播（LangGraph 主流程）
2. 显式传递：用于 ThreadPoolExecutor 等跨线程场景（python_repl 超时执行）

使用方式：
- Security Wrapper 调用 set_current_session_id() 设置当前会话
- 工具调用 get_current_session_id() 获取会话 ID
- 跨线程执行时使用 run_in_session_context() 包装
"""
import contextvars
from contextlib import contextmanager
from pathlib import Path
from typing import Callable, TypeVar, Optional

from config import settings

# ============================================================
# contextvars 实现（主要方式，支持 asyncio）
# ============================================================

# 当前会话 ID（contextvars 在 asyncio 中自动传播）
_current_session_id: contextvars.ContextVar[str] = contextvars.ContextVar(
    'current_session_id', default=''
)

# 当前 RunContext（用于存储更多上下文信息）
_current_run_context: contextvars.ContextVar[Optional[object]] = contextvars.ContextVar(
    'current_run_context', default=None
)


def set_current_session_id(session_id: str) -> contextvars.Token[str]:
    """设置当前上下文的 session_id。

    由 Security Wrapper 在工具调用前设置。

    Args:
        session_id: 会话 ID

    Returns:
        Token，可用于 reset（通常不需要手动调用）
    """
    return _current_session_id.set(session_id or '')


def get_current_session_id() -> str:
    """获取当前上下文的 session_id。

    工具应使用此函数获取 session_id，无需声明 config 参数。

    Returns:
        session_id，未设置时返回空字符串
    """
    return _current_session_id.get()


def reset_session_id(token: contextvars.Token[str]) -> None:
    """重置 session_id 到之前的值。

    通常不需要手动调用，使用 session_context() 上下文管理器更安全。
    """
    _current_session_id.reset(token)


@contextmanager
def session_context(session_id: str):
    """会话上下文管理器。

    在 with 块内设置 session_id，退出时自动恢复。

    Example:
        with session_context("abc123"):
            # 这里 get_current_session_id() 返回 "abc123"
            do_something()
        # 这里恢复为之前的值
    """
    token = set_current_session_id(session_id)
    try:
        yield
    finally:
        reset_session_id(token)


# ============================================================
# 跨线程执行支持（用于 ThreadPoolExecutor）
# ============================================================

T = TypeVar('T')


def run_in_session_context(func: Callable[..., T], *args, **kwargs) -> T:
    """在调用时的会话上下文中执行函数。

    注意：此函数本身必须在目标线程中执行，所以它会使用传入的上下文，
    而不是捕获当前上下文。

    如果需要在线程池中传播上下文，请使用 create_context_carrier()。

    Args:
        func: 要执行的函数
        *args: 位置参数
        **kwargs: 关键字参数

    Returns:
        函数的返回值
    """
    # 直接执行，因为 contextvars 会在当前上下文中生效
    return func(*args, **kwargs)


def create_context_carrier(func: Callable[..., T]) -> Callable[..., T]:
    """创建一个携带当前上下文的函数包装器。

    在主线程中调用此函数，返回的包装器可以在其他线程中执行，
    同时保持主线程的 session context。

    用于 ThreadPoolExecutor 等跨线程场景：

    Example:
        # 在主线程中创建 carrier
        carrier = create_context_carrier(_execute_code)
        # 提交到线程池
        future = executor.submit(carrier, code)

    Args:
        func: 要包装的函数

    Returns:
        携带上下文的函数包装器
    """
    # 在主线程中捕获当前上下文
    ctx = contextvars.copy_context()

    def wrapper(*args, **kwargs) -> T:
        # 在工作线程中使用捕获的上下文执行
        return ctx.run(func, *args, **kwargs)

    return wrapper


def get_context_runner() -> Callable:
    """获取一个绑定了当前上下文的 runner。

    返回的 runner 可以在其他线程中执行函数，同时保持当前的 session context。

    Example:
        runner = get_context_runner()
        executor.submit(runner, some_func, arg1, arg2)

    Returns:
        绑定了当前上下文的执行函数
    """
    ctx = contextvars.copy_context()

    def runner(func: Callable[..., T], *args, **kwargs) -> T:
        return ctx.run(func, *args, **kwargs)

    return runner


# ============================================================
# RunContext 支持（向后兼容）
# ============================================================

def set_run_context(ctx) -> None:
    """设置当前的 RunContext。

    RunContext 包含更多上下文信息（debug 模式、事件队列等）。
    同时会设置 session_id。
    """
    _current_run_context.set(ctx)
    if ctx and hasattr(ctx, 'session_id'):
        set_current_session_id(ctx.session_id)


def get_run_context():
    """获取当前 RunContext（未设置时返回 None）。"""
    return _current_run_context.get()


# ============================================================
# 向后兼容的旧 API（基于 threading.local，逐步废弃）
# ============================================================

import threading
_thread_local = threading.local()


def set_session_id(session_id: str) -> None:
    """设置当前请求的 session_id。

    DEPRECATED: 请使用 set_current_session_id() 代替。
    保留此函数是为了向后兼容 app.py 等调用方。
    """
    _thread_local.session_id = session_id
    # 同时设置 contextvars 版本
    set_current_session_id(session_id)


def get_session_id() -> str:
    """获取当前 session_id。

    DEPRECATED: 请使用 get_current_session_id() 代替。
    保留此函数是为了向后兼容。

    优先级：contextvars > RunContext > threading.local
    """
    # 1. 优先使用 contextvars
    sid = get_current_session_id()
    if sid:
        return sid

    # 2. 尝试从 RunContext 获取
    ctx = get_run_context()
    if ctx and hasattr(ctx, 'session_id'):
        return ctx.session_id

    # 3. 回退到 threading.local
    return getattr(_thread_local, 'session_id', '')


# ============================================================
# 工具目录相关
# ============================================================

def get_session_tmp_dir() -> Path:
    """获取当前会话的临时目录。

    有 session_id 时返回 ~/.vibeworker/tmp/{session_id}/，
    否则返回 ~/.vibeworker/tmp/_default/。
    """
    session_id = get_current_session_id() or get_session_id() or "_default"
    return get_tmp_dir_for_session(session_id)


def get_tmp_dir_for_session(session_id: str) -> Path:
    """根据指定的 session_id 获取临时目录。

    Args:
        session_id: 会话 ID，空字符串或 None 时使用 "_default"

    Returns:
        临时目录路径 ~/.vibeworker/tmp/{safe_session_id}/
    """
    sid = session_id or "_default"
    # 清理 session_id 以生成安全的目录名
    safe_id = "".join(c for c in sid if c.isalnum() or c in "_-")
    tmp_dir = settings.get_data_path() / "tmp" / safe_id
    tmp_dir.mkdir(parents=True, exist_ok=True)
    return tmp_dir
