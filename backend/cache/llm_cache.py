"""
LLM cache for Agent responses, including streaming support.
"""

import asyncio
import hashlib
import json
import logging
from typing import Optional, Dict, Any, AsyncGenerator, Callable

from .memory_cache import MemoryCache
from .disk_cache import DiskCache
from config import settings

logger = logging.getLogger(__name__)


class LLMCache:
    """
    Two-tier cache for LLM responses with streaming simulation.

    Cache key is based on:
    - System prompt hash
    - Recent conversation history (last 3 messages)
    - Current message
    - Model parameters (model, temperature)
    """

    def __init__(self):
        """Initialize LLM cache with L1 + L2."""
        self.l1 = MemoryCache(
            max_size=settings.cache_max_memory_items,
            default_ttl=settings.llm_cache_ttl,
        )
        self.l2 = DiskCache(
            cache_dir=settings.cache_dir,
            cache_type="llm",
            default_ttl=settings.llm_cache_ttl,
            max_size_mb=settings.cache_max_disk_size_mb,
        )

    def _compute_cache_key(self, key_params: Dict[str, Any]) -> str:
        """
        Compute cache key for LLM request.

        Args:
            key_params: Dict with:
                - system_prompt: System prompt text
                - recent_history: List of recent messages
                - current_message: Current user message
                - model: Model name
                - temperature: Temperature value

        Returns:
            SHA256 hash of all parameters
        """
        # Hash system prompt to reduce size
        system_prompt = key_params.get("system_prompt", "")
        system_prompt_hash = hashlib.sha256(
            system_prompt.encode("utf-8")
        ).hexdigest()[:16]

        # Create simplified key structure
        key_structure = {
            "system_prompt_hash": system_prompt_hash,
            "recent_history": key_params.get("recent_history", []),
            "current_message": key_params.get("current_message", ""),
            "model": key_params.get("model", ""),
            "temperature": key_params.get("temperature", 0.7),
        }

        key_str = json.dumps(key_structure, sort_keys=True)
        return hashlib.sha256(key_str.encode("utf-8")).hexdigest()

    async def get_or_generate(
        self,
        key_params: Dict[str, Any],
        generator_func: Callable[[], AsyncGenerator],
        stream: bool = True,
    ) -> AsyncGenerator:
        """
        Get cached response or generate new one.

        Args:
            key_params: Parameters for cache key computation
            generator_func: Async generator function to call if cache miss
            stream: Whether to simulate streaming output

        Yields:
            Event dicts from cache or generator
        """
        if not settings.enable_llm_cache:
            # Cache disabled, use generator directly
            async for event in generator_func():
                yield event
            return

        cache_key = self._compute_cache_key(key_params)

        # Try L1 first
        cached = self.l1.get(cache_key)
        if cached is not None:
            logger.info("✓ LLM cache L1 hit")
            if stream:
                async for event in self._simulate_stream(cached):
                    yield event
            else:
                yield cached
            return

        # Try L2
        cached = self.l2.get(cache_key)
        if cached is not None:
            logger.info("✓ LLM cache L2 hit")
            # Promote to L1
            self.l1.set(cache_key, cached)
            if stream:
                async for event in self._simulate_stream(cached):
                    yield event
            else:
                yield cached
            return

        # Cache miss - generate and cache
        logger.debug("LLM cache miss, generating...")
        collected_events = []

        try:
            async for event in generator_func():
                collected_events.append(event)
                yield event

            # Cache the collected events
            if collected_events:
                self._cache_response(cache_key, collected_events)

        except Exception as e:
            logger.error(f"Error during LLM generation: {e}")
            raise

    def _cache_response(self, cache_key: str, events: list) -> None:
        """
        Cache the collected response events.

        Args:
            cache_key: Cache key
            events: List of event dicts
        """
        try:
            # Store in both L1 and L2
            self.l1.set(cache_key, events)
            self.l2.set(cache_key, events)
            logger.debug("✓ LLM response cached")
        except Exception as e:
            logger.warning(f"Failed to cache LLM response: {e}")

    async def _simulate_stream(self, cached_events: list) -> AsyncGenerator:
        """
        Simulate streaming output from cached events.

        This replays the cached events with small delays to maintain
        the streaming experience.

        Args:
            cached_events: List of cached event dicts

        Yields:
            Event dicts with simulated streaming
        """
        for event in cached_events:
            event_type = event.get("type")

            # Add small delay for different event types
            if event_type == "token":
                # Very short delay for tokens (feels like streaming)
                await asyncio.sleep(0.01)
            elif event_type in ["tool_start", "tool_end"]:
                # Slightly longer delay for tool events
                await asyncio.sleep(0.05)
            elif event_type in ["thinking_start", "thinking_end"]:
                # Minimal delay for thinking boundaries
                await asyncio.sleep(0.02)
            else:
                # Default minimal delay
                await asyncio.sleep(0.01)

            # Mark as cached (optional, for debugging)
            event_copy = event.copy()
            event_copy["cached"] = True

            yield event_copy

    def clear(self) -> dict:
        """
        Clear all LLM cache.

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
        """Get LLM cache statistics."""
        return {
            "enabled": settings.enable_llm_cache,
            "ttl": settings.llm_cache_ttl,
            "l1": self.l1.get_stats(),
            "l2": self.l2.get_stats(),
        }
