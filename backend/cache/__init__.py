"""
Cache module for VibeWorker.

Provides a two-tier caching system (L1 memory + L2 disk) for various components:
- URL cache: Web page fetch results
- LLM cache: Agent responses
- Prompt cache: System prompt concatenation results
- Translate cache: Translation API results
- Tool cache decorator: Generic caching for any tool
"""

from .url_cache import URLCache
from .llm_cache import LLMCache
from .prompt_cache import PromptCache
from .translate_cache import TranslateCache
from .tool_cache_decorator import ToolCacheDecorator, cached_tool

# Global cache instances (lazy initialized)
_url_cache = None
_llm_cache = None
_prompt_cache = None
_translate_cache = None


def get_url_cache() -> URLCache:
    """Get the global URL cache instance."""
    global _url_cache
    if _url_cache is None:
        _url_cache = URLCache()
    return _url_cache


def get_llm_cache() -> LLMCache:
    """Get the global LLM cache instance."""
    global _llm_cache
    if _llm_cache is None:
        _llm_cache = LLMCache()
    return _llm_cache


def get_prompt_cache() -> PromptCache:
    """Get the global Prompt cache instance."""
    global _prompt_cache
    if _prompt_cache is None:
        _prompt_cache = PromptCache()
    return _prompt_cache


def get_translate_cache() -> TranslateCache:
    """Get the global Translate cache instance."""
    global _translate_cache
    if _translate_cache is None:
        _translate_cache = TranslateCache()
    return _translate_cache


# Convenience exports
url_cache = get_url_cache()
llm_cache = get_llm_cache()
prompt_cache = get_prompt_cache()
translate_cache = get_translate_cache()

__all__ = [
    "URLCache",
    "LLMCache",
    "PromptCache",
    "TranslateCache",
    "ToolCacheDecorator",
    "cached_tool",
    "url_cache",
    "llm_cache",
    "prompt_cache",
    "translate_cache",
    "get_url_cache",
    "get_llm_cache",
    "get_prompt_cache",
    "get_translate_cache",
]
