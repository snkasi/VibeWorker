"""
通用工具缓存装饰器

这个装饰器可以为任何工具添加缓存功能，无需修改工具本身的代码。
"""

import hashlib
import json
import logging
from functools import wraps
from typing import Callable, Any

from .memory_cache import MemoryCache
from .disk_cache import DiskCache
from config import settings

logger = logging.getLogger(__name__)


class ToolCacheDecorator:
    """工具缓存装饰器，为任何工具添加缓存功能"""

    def __init__(
        self,
        tool_name: str,
        ttl: int = 3600,
        enabled: bool = True,
        add_marker: bool = True,
    ):
        """
        初始化工具缓存装饰器

        Args:
            tool_name: 工具名称（用于缓存目录）
            ttl: 缓存 TTL（秒）
            enabled: 是否启用缓存
            add_marker: 是否在输出中添加 [CACHE_HIT] 标记
        """
        self.tool_name = tool_name
        self.ttl = ttl
        self.enabled = enabled
        self.add_marker = add_marker

        # 创建 L1 + L2 缓存
        self.l1 = MemoryCache(
            max_size=settings.cache_max_memory_items,
            default_ttl=ttl,
        )
        self.l2 = DiskCache(
            cache_dir=settings.cache_dir,
            cache_type=f"tool_{tool_name}",
            default_ttl=ttl,
            max_size_mb=settings.cache_max_disk_size_mb,
        )

    def _compute_cache_key(self, args: tuple, kwargs: dict) -> str:
        """
        计算缓存键

        Args:
            args: 位置参数
            kwargs: 关键字参数

        Returns:
            SHA256 哈希值
        """
        # 将参数序列化为 JSON
        cache_input = {
            "args": args,
            "kwargs": kwargs,
        }
        cache_str = json.dumps(cache_input, sort_keys=True, default=str)
        return hashlib.sha256(cache_str.encode("utf-8")).hexdigest()

    def __call__(self, func: Callable) -> Callable:
        """
        装饰器实现

        Args:
            func: 要装饰的函数

        Returns:
            装饰后的函数
        """

        @wraps(func)
        def wrapper(*args, **kwargs) -> Any:
            """包装函数"""
            if not self.enabled:
                # 缓存未启用，直接调用原函数
                return func(*args, **kwargs)

            # 计算缓存键
            cache_key = self._compute_cache_key(args, kwargs)

            # 尝试从 L1 获取
            cached = self.l1.get(cache_key)
            if cached is not None:
                logger.info(f"✓ Cache L1 hit for {self.tool_name}")
                if self.add_marker:
                    return "[CACHE_HIT]" + cached
                return cached

            # 尝试从 L2 获取
            cached = self.l2.get(cache_key)
            if cached is not None:
                logger.info(f"✓ Cache L2 hit for {self.tool_name}")
                # 提升到 L1
                self.l1.set(cache_key, cached)
                if self.add_marker:
                    return "[CACHE_HIT]" + cached
                return cached

            # 缓存未命中，调用原函数
            logger.debug(f"Cache miss for {self.tool_name}")
            try:
                result = func(*args, **kwargs)

                # 缓存结果
                if result is not None:
                    self.l1.set(cache_key, result)
                    self.l2.set(cache_key, result)
                    logger.debug(f"✓ Cached result for {self.tool_name}")

                return result

            except Exception as e:
                logger.error(f"Error in {self.tool_name}: {e}")
                raise

        return wrapper


# 便捷函数：创建常用的缓存装饰器
def cached_tool(
    tool_name: str,
    ttl: int = 3600,
    enabled: bool = True,
    add_marker: bool = True,
):
    """
    便捷函数：创建工具缓存装饰器

    使用示例：

    ```python
    @cached_tool("my_tool", ttl=7200)
    def my_tool_function(url: str) -> str:
        # 工具逻辑
        return result
    ```

    Args:
        tool_name: 工具名称
        ttl: 缓存 TTL（秒）
        enabled: 是否启用缓存
        add_marker: 是否添加 [CACHE_HIT] 标记

    Returns:
        装饰器
    """
    return ToolCacheDecorator(
        tool_name=tool_name,
        ttl=ttl,
        enabled=enabled,
        add_marker=add_marker,
    )
