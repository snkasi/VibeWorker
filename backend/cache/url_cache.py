"""
URL cache for web page fetch results.
"""

import hashlib
import logging
from typing import Optional

from .memory_cache import MemoryCache
from .disk_cache import DiskCache
from config import settings

logger = logging.getLogger(__name__)


class URLCache:
    """
    Two-tier cache for URL fetch results.

    L1: Memory cache (fast access)
    L2: Disk cache (persistent)
    """

    def __init__(self):
        """Initialize URL cache with L1 + L2."""
        self.l1 = MemoryCache(
            max_size=settings.cache_max_memory_items,
            default_ttl=settings.url_cache_ttl,
        )
        self.l2 = DiskCache(
            cache_dir=settings.cache_dir,
            cache_type="url",
            default_ttl=settings.url_cache_ttl,
            max_size_mb=settings.cache_max_disk_size_mb,
        )

    def _compute_cache_key(self, url: str) -> str:
        """
        Compute cache key for URL.

        Args:
            url: URL to fetch

        Returns:
            SHA256 hash of URL
        """
        return hashlib.sha256(url.encode("utf-8")).hexdigest()

    def get_cached_url(self, url: str) -> Optional[str]:
        """
        Get cached URL content.

        Args:
            url: URL to fetch

        Returns:
            Cached content if exists, None otherwise
        """
        if not settings.enable_url_cache:
            return None

        cache_key = self._compute_cache_key(url)

        # Try L1 first
        cached = self.l1.get(cache_key)
        if cached is not None:
            logger.debug(f"URL cache L1 hit: {url}")
            return cached

        # Try L2
        cached = self.l2.get(cache_key)
        if cached is not None:
            logger.debug(f"URL cache L2 hit: {url}")
            # Promote to L1
            self.l1.set(cache_key, cached)
            return cached

        logger.debug(f"URL cache miss: {url}")
        return None

    def cache_url(self, url: str, content: str) -> None:
        """
        Cache URL content.

        Args:
            url: URL that was fetched
            content: Content to cache
        """
        if not settings.enable_url_cache:
            return

        cache_key = self._compute_cache_key(url)

        # Store in both L1 and L2
        self.l1.set(cache_key, content)
        self.l2.set(cache_key, content)

        logger.debug(f"URL cached: {url}")

    def clear(self) -> dict:
        """
        Clear all URL cache.

        Returns:
            Dict with clear counts
        """
        l1_count = self.l1.clear()
        l2_count = self.l2.clear()

        return {
            "l1_cleared": l1_count,
            "l2_cleared": l2_count,
        }

    def get_stats(self) -> dict:
        """Get URL cache statistics."""
        return {
            "enabled": settings.enable_url_cache,
            "ttl": settings.url_cache_ttl,
            "l1": self.l1.get_stats(),
            "l2": self.l2.get_stats(),
        }
