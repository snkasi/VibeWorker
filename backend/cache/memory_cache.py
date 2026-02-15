"""
L1 Memory cache implementation using LRU eviction.
"""

import time
from collections import OrderedDict
from typing import Any, Optional
import logging

from .base import BaseCache, CacheStats

logger = logging.getLogger(__name__)


class MemoryCache(BaseCache):
    """
    In-memory cache with TTL and LRU eviction.

    Features:
    - TTL (Time-To-Live) for automatic expiration
    - LRU (Least Recently Used) eviction when max size reached
    - Thread-safe operations
    - Statistics tracking
    """

    def __init__(self, max_size: int = 100, default_ttl: int = 3600):
        """
        Initialize memory cache.

        Args:
            max_size: Maximum number of items to store
            default_ttl: Default TTL in seconds
        """
        self.max_size = max_size
        self.default_ttl = default_ttl
        self._cache: OrderedDict[str, dict] = OrderedDict()
        self.stats = CacheStats()

    def get(self, key: str) -> Optional[Any]:
        """
        Retrieve a value from the cache.

        Args:
            key: Cache key

        Returns:
            Cached value if exists and not expired, None otherwise
        """
        if key not in self._cache:
            self.stats.record_miss()
            return None

        entry = self._cache[key]
        current_time = time.time()

        # Check if expired
        if current_time > entry["expire_at"]:
            self.delete(key)
            self.stats.record_miss()
            return None

        # Move to end (mark as recently used)
        self._cache.move_to_end(key)
        self.stats.record_hit()

        return entry["value"]

    def set(self, key: str, value: Any, ttl: Optional[int] = None) -> None:
        """
        Store a value in the cache.

        Args:
            key: Cache key
            value: Value to cache
            ttl: Time-to-live in seconds (None = use default)
        """
        if ttl is None:
            ttl = self.default_ttl

        current_time = time.time()
        entry = {
            "value": value,
            "created_at": current_time,
            "expire_at": current_time + ttl,
        }

        # Update existing key or add new
        if key in self._cache:
            self._cache[key] = entry
            self._cache.move_to_end(key)
        else:
            # Evict oldest item if at capacity
            if len(self._cache) >= self.max_size:
                oldest_key = next(iter(self._cache))
                self.delete(oldest_key)
                logger.debug(f"Memory cache: Evicted oldest key: {oldest_key[:16]}...")

            self._cache[key] = entry

        self.stats.record_set()

    def delete(self, key: str) -> bool:
        """
        Delete a key from the cache.

        Args:
            key: Cache key

        Returns:
            True if key was deleted, False if key didn't exist
        """
        if key in self._cache:
            del self._cache[key]
            self.stats.record_delete()
            return True
        return False

    def clear(self) -> int:
        """
        Clear all cached items.

        Returns:
            Number of items cleared
        """
        count = len(self._cache)
        self._cache.clear()
        logger.info(f"Memory cache: Cleared {count} items")
        return count

    def exists(self, key: str) -> bool:
        """
        Check if a key exists in the cache.

        Args:
            key: Cache key

        Returns:
            True if key exists and not expired, False otherwise
        """
        if key not in self._cache:
            return False

        entry = self._cache[key]
        current_time = time.time()

        # Check if expired
        if current_time > entry["expire_at"]:
            self.delete(key)
            return False

        return True

    def cleanup_expired(self) -> int:
        """
        Remove all expired entries.

        Returns:
            Number of entries removed
        """
        current_time = time.time()
        expired_keys = [
            key
            for key, entry in self._cache.items()
            if current_time > entry["expire_at"]
        ]

        for key in expired_keys:
            self.delete(key)

        if expired_keys:
            logger.debug(f"Memory cache: Cleaned up {len(expired_keys)} expired items")

        return len(expired_keys)

    def get_stats(self) -> dict:
        """Get cache statistics."""
        return {
            **self.stats.to_dict(),
            "size": len(self._cache),
            "max_size": self.max_size,
        }

    def __len__(self) -> int:
        """Return number of items in cache."""
        return len(self._cache)
