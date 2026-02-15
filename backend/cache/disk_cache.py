"""
L2 Disk cache implementation with JSON storage.
"""

import json
import time
import hashlib
import shutil
from pathlib import Path
from typing import Any, List, Optional
import logging

from .base import BaseCache, CacheStats

logger = logging.getLogger(__name__)


class DiskCache(BaseCache):
    """
    Disk-based cache using JSON file storage.

    Features:
    - Two-level directory structure (key[:2]/key.json)
    - TTL (Time-To-Live) for automatic expiration
    - LRU cleanup when size limit reached
    - Transparent file-based storage
    """

    def __init__(
        self,
        cache_dir: Path,
        cache_type: str,
        default_ttl: int = 3600,
        max_size_mb: int = 5120,
    ):
        """
        Initialize disk cache.

        Args:
            cache_dir: Base cache directory
            cache_type: Cache type (url, llm, prompt, translate)
            default_ttl: Default TTL in seconds
            max_size_mb: Maximum disk size in MB
        """
        self.cache_dir = Path(cache_dir) / cache_type
        self.cache_type = cache_type
        self.default_ttl = default_ttl
        self.max_size_mb = max_size_mb
        self.stats = CacheStats()

        # Create cache directory
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    def _get_file_path(self, key: str) -> Path:
        """
        Get file path for a cache key.

        Uses two-level directory structure: {key[:2]}/{key}.json

        Args:
            key: Cache key (should be a hash)

        Returns:
            Path to cache file
        """
        # Create subdirectory based on first 2 chars
        subdir = self.cache_dir / key[:2]
        subdir.mkdir(exist_ok=True)
        return subdir / f"{key}.json"

    def get(self, key: str) -> Optional[Any]:
        """
        Retrieve a value from the cache.

        Args:
            key: Cache key

        Returns:
            Cached value if exists and not expired, None otherwise
        """
        file_path = self._get_file_path(key)

        if not file_path.exists():
            self.stats.record_miss()
            return None

        try:
            with open(file_path, "r", encoding="utf-8") as f:
                entry = json.load(f)

            current_time = time.time()

            # Check if expired
            if current_time > entry["expire_at"]:
                self.delete(key)
                self.stats.record_miss()
                return None

            # Update access time for LRU
            file_path.touch()

            self.stats.record_hit()
            return entry["value"]

        except (json.JSONDecodeError, KeyError, Exception) as e:
            logger.warning(f"Disk cache: Corrupted file {file_path}, deleting: {e}")
            self.delete(key)
            self.stats.record_miss()
            return None

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
            "key": key,
            "value": value,
            "created_at": current_time,
            "expire_at": current_time + ttl,
        }

        file_path = self._get_file_path(key)

        try:
            with open(file_path, "w", encoding="utf-8") as f:
                json.dump(entry, f, ensure_ascii=False, indent=2)

            self.stats.record_set()

            # Check if we need to cleanup
            if self.get_size_mb() > self.max_size_mb:
                self.cleanup_lru()

        except Exception as e:
            logger.error(f"Disk cache: Failed to write {file_path}: {e}")

    def delete(self, key: str) -> bool:
        """
        Delete a key from the cache.

        Args:
            key: Cache key

        Returns:
            True if key was deleted, False if key didn't exist
        """
        file_path = self._get_file_path(key)

        if file_path.exists():
            try:
                file_path.unlink()
                self.stats.record_delete()
                return True
            except Exception as e:
                logger.error(f"Disk cache: Failed to delete {file_path}: {e}")
                return False

        return False

    def clear(self) -> int:
        """
        Clear all cached items.

        Returns:
            Number of items cleared
        """
        count = 0

        try:
            # Count files before deletion
            for file_path in self.cache_dir.rglob("*.json"):
                count += 1

            # Remove entire cache directory
            if self.cache_dir.exists():
                shutil.rmtree(self.cache_dir)
                self.cache_dir.mkdir(parents=True, exist_ok=True)

            logger.info(f"Disk cache ({self.cache_type}): Cleared {count} items")

        except Exception as e:
            logger.error(f"Disk cache: Failed to clear: {e}")

        return count

    def exists(self, key: str) -> bool:
        """
        Check if a key exists in the cache.

        Args:
            key: Cache key

        Returns:
            True if key exists and not expired, False otherwise
        """
        file_path = self._get_file_path(key)

        if not file_path.exists():
            return False

        try:
            with open(file_path, "r", encoding="utf-8") as f:
                entry = json.load(f)

            current_time = time.time()

            # Check if expired
            if current_time > entry["expire_at"]:
                self.delete(key)
                return False

            return True

        except Exception:
            return False

    def cleanup_expired(self) -> int:
        """
        Remove all expired entries.

        Returns:
            Number of entries removed
        """
        current_time = time.time()
        removed_count = 0

        try:
            for file_path in self.cache_dir.rglob("*.json"):
                try:
                    with open(file_path, "r", encoding="utf-8") as f:
                        entry = json.load(f)

                    if current_time > entry["expire_at"]:
                        file_path.unlink()
                        removed_count += 1

                except Exception as e:
                    logger.warning(f"Disk cache: Failed to check {file_path}: {e}")
                    # Delete corrupted files
                    try:
                        file_path.unlink()
                        removed_count += 1
                    except Exception:
                        pass

            if removed_count > 0:
                logger.info(
                    f"Disk cache ({self.cache_type}): Cleaned up {removed_count} expired items"
                )

        except Exception as e:
            logger.error(f"Disk cache: Failed to cleanup expired: {e}")

        return removed_count

    def cleanup_lru(self, target_percent: float = 0.8) -> int:
        """
        LRU cleanup: Remove oldest 20% of files to reach 80% capacity.

        Args:
            target_percent: Target size as percentage of max (default 0.8)

        Returns:
            Number of files removed
        """
        try:
            # Get all cache files sorted by access time (oldest first)
            files = [
                (f, f.stat().st_atime) for f in self.cache_dir.rglob("*.json")
            ]
            files.sort(key=lambda x: x[1])

            current_size_mb = self.get_size_mb()
            target_size_mb = self.max_size_mb * target_percent

            if current_size_mb <= target_size_mb:
                return 0

            # Remove oldest files until we reach target size
            removed_count = 0
            for file_path, _ in files:
                if current_size_mb <= target_size_mb:
                    break

                try:
                    file_size_mb = file_path.stat().st_size / (1024 * 1024)
                    file_path.unlink()
                    current_size_mb -= file_size_mb
                    removed_count += 1
                except Exception as e:
                    logger.warning(f"Disk cache: Failed to remove {file_path}: {e}")

            logger.info(
                f"Disk cache ({self.cache_type}): LRU cleanup removed {removed_count} files"
            )
            return removed_count

        except Exception as e:
            logger.error(f"Disk cache: Failed to perform LRU cleanup: {e}")
            return 0

    def get_size_mb(self) -> float:
        """
        Get total cache size in MB.

        Returns:
            Cache size in megabytes
        """
        try:
            total_size = 0
            for file_path in self.cache_dir.rglob("*.json"):
                try:
                    total_size += file_path.stat().st_size
                except Exception:
                    pass

            return total_size / (1024 * 1024)

        except Exception as e:
            logger.error(f"Disk cache: Failed to calculate size: {e}")
            return 0.0

    def get_file_count(self, valid_only: bool = True) -> int:
        """
        Get number of cache files.

        Args:
            valid_only: If True, only count non-expired entries

        Returns:
            Number of files
        """
        try:
            if not valid_only:
                return sum(1 for _ in self.cache_dir.rglob("*.json"))

            current_time = time.time()
            count = 0
            for file_path in self.cache_dir.rglob("*.json"):
                try:
                    with open(file_path, "r", encoding="utf-8") as f:
                        entry = json.load(f)
                    if current_time <= entry.get("expire_at", 0):
                        count += 1
                except Exception:
                    pass
            return count
        except Exception:
            return 0

    def list_entries(self, page: int = 1, page_size: int = 50) -> dict:
        """
        List cache entries with pagination.

        Args:
            page: Page number (1-based)
            page_size: Items per page

        Returns:
            Dict with entries list, total count, page info
        """
        current_time = time.time()
        entries = []

        try:
            for file_path in self.cache_dir.rglob("*.json"):
                try:
                    with open(file_path, "r", encoding="utf-8") as f:
                        entry = json.load(f)

                    # Skip expired entries
                    if current_time > entry.get("expire_at", 0):
                        continue

                    # Build preview from value
                    value = entry.get("value", "")
                    if isinstance(value, str):
                        preview = value[:200]
                    elif isinstance(value, dict):
                        preview = json.dumps(value, ensure_ascii=False)[:200]
                    else:
                        preview = str(value)[:200]

                    entries.append({
                        "key": entry.get("key", file_path.stem),
                        "created_at": entry.get("created_at", 0),
                        "expire_at": entry.get("expire_at", 0),
                        "size_bytes": file_path.stat().st_size,
                        "preview": preview,
                    })
                except Exception:
                    continue

        except Exception as e:
            logger.error(f"Disk cache: Failed to list entries: {e}")
            return {"entries": [], "total": 0, "page": page, "page_size": page_size}

        # Sort by created_at descending
        entries.sort(key=lambda x: x["created_at"], reverse=True)

        total = len(entries)
        start = (page - 1) * page_size
        end = start + page_size
        paged = entries[start:end]

        return {
            "entries": paged,
            "total": total,
            "page": page,
            "page_size": page_size,
        }

    def get_stats(self) -> dict:
        """Get cache statistics."""
        return {
            **self.stats.to_dict(),
            "size_mb": round(self.get_size_mb(), 2),
            "max_size_mb": self.max_size_mb,
            "file_count": self.get_file_count(),
        }
