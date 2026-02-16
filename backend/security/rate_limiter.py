"""Rate Limiter - Sliding window rate limiting for tool calls."""
import time
import logging
from collections import defaultdict

logger = logging.getLogger(__name__)

# Default rate limits: (max_calls, window_seconds)
DEFAULT_LIMITS: dict[str, tuple[int, int]] = {
    "terminal": (20, 300),      # 20 calls per 5 minutes
    "python_repl": (20, 300),   # 20 calls per 5 minutes
    "fetch_url": (30, 300),     # 30 calls per 5 minutes
}


class ToolRateLimiter:
    """Sliding window rate limiter for tool calls."""

    def __init__(self, limits: dict[str, tuple[int, int]] | None = None):
        self._limits = limits or DEFAULT_LIMITS
        self._calls: dict[str, list[float]] = defaultdict(list)

    def check(self, tool_name: str) -> tuple[bool, str]:
        """Check if a tool call is within rate limits.

        Returns:
            (allowed, reason)
        """
        limit_key = tool_name
        # MCP tools share a generic limit
        if tool_name.startswith("mcp_"):
            limit_key = "mcp"

        if limit_key not in self._limits:
            return True, "no_limit"

        max_calls, window = self._limits[limit_key]
        now = time.time()
        cutoff = now - window

        # Clean old entries
        self._calls[limit_key] = [t for t in self._calls[limit_key] if t > cutoff]

        if len(self._calls[limit_key]) >= max_calls:
            remaining = int(self._calls[limit_key][0] + window - now)
            return False, f"Rate limited: {tool_name} exceeded {max_calls} calls per {window}s. Retry in {remaining}s."

        # Record this call
        self._calls[limit_key].append(now)
        return True, "ok"

    def get_stats(self) -> dict[str, dict]:
        """Get current rate limit stats."""
        now = time.time()
        stats = {}
        for tool, (max_calls, window) in self._limits.items():
            cutoff = now - window
            recent = [t for t in self._calls.get(tool, []) if t > cutoff]
            stats[tool] = {
                "used": len(recent),
                "limit": max_calls,
                "window_seconds": window,
            }
        return stats


# Singleton
rate_limiter = ToolRateLimiter()
