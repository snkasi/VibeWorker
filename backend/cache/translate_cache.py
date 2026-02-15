"""
Translation cache for translation API results.
"""

import hashlib
import logging
from typing import Optional, Dict, Any

from .memory_cache import MemoryCache
from .disk_cache import DiskCache
from config import settings

logger = logging.getLogger(__name__)


class TranslateCache:
    """
    Two-tier cache for translation results.

    Cache key is based on content + target language.
    """

    def __init__(self):
        """Initialize Translate cache with L1 + L2."""
        self.l1 = MemoryCache(
            max_size=settings.cache_max_memory_items,
            default_ttl=settings.translate_cache_ttl,
        )
        self.l2 = DiskCache(
            cache_dir=settings.cache_dir,
            cache_type="translate",
            default_ttl=settings.translate_cache_ttl,
            max_size_mb=settings.cache_max_disk_size_mb,
        )

    def _compute_cache_key(self, content: str, target_language: str) -> str:
        """
        Compute cache key for translation.

        Args:
            content: Content to translate
            target_language: Target language

        Returns:
            SHA256 hash of content + language
        """
        key_str = f"{content}|{target_language}"
        return hashlib.sha256(key_str.encode("utf-8")).hexdigest()

    def get_translation(
        self, content: str, target_language: str
    ) -> Optional[Dict[str, Any]]:
        """
        Get cached translation.

        Args:
            content: Content to translate
            target_language: Target language

        Returns:
            Cached translation result if exists, None otherwise
        """
        if not settings.enable_translate_cache:
            return None

        cache_key = self._compute_cache_key(content, target_language)

        # Try L1 first
        cached = self.l1.get(cache_key)
        if cached is not None:
            logger.debug(f"Translation cache L1 hit: {target_language}")
            return cached

        # Try L2
        cached = self.l2.get(cache_key)
        if cached is not None:
            logger.debug(f"Translation cache L2 hit: {target_language}")
            # Promote to L1
            self.l1.set(cache_key, cached)
            return cached

        logger.debug(f"Translation cache miss: {target_language}")
        return None

    def cache_translation(
        self, content: str, target_language: str, result: Dict[str, Any]
    ) -> None:
        """
        Cache translation result.

        Args:
            content: Content that was translated
            target_language: Target language
            result: Translation result to cache
        """
        if not settings.enable_translate_cache:
            return

        cache_key = self._compute_cache_key(content, target_language)

        # Store in both L1 and L2
        self.l1.set(cache_key, result)
        self.l2.set(cache_key, result)

        logger.debug(f"Translation cached: {target_language}")

    def clear(self) -> dict:
        """
        Clear all Translation cache.

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
        """Get Translation cache statistics."""
        return {
            "enabled": settings.enable_translate_cache,
            "ttl": settings.translate_cache_ttl,
            "l1": self.l1.get_stats(),
            "l2": self.l2.get_stats(),
        }
