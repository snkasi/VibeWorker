"""Fetch URL Tool - Retrieve web content with HTML cleaning and SSRF protection."""
import requests
import html2text
import logging

from langchain_core.tools import tool
from security.classifier import classify_url, RiskLevel

logger = logging.getLogger(__name__)


@tool
def fetch_url(url: str) -> str:
    """Fetch the content of a web page and return it as clean Markdown text.

    This tool retrieves web content, strips HTML tags, and returns readable
    Markdown text. Use it to access web pages, APIs, or any HTTP resources.

    Args:
        url: The URL to fetch content from.

    Returns:
        Cleaned content in Markdown format, or error message.
    """
    # SSRF protection: validate URL before fetching (respects config toggle)
    try:
        from config import settings
        ssrf_on = settings.security_enabled and settings.security_ssrf_protection
    except Exception:
        ssrf_on = True
    if ssrf_on:
        risk = classify_url(url)
        if risk == RiskLevel.BLOCKED:
            return f"⛔ Blocked: URL '{url}' is not allowed (private network or self-referencing)."
        if risk == RiskLevel.DANGEROUS:
            return f"⛔ Blocked: URL '{url}' resolves to a private/internal IP address (SSRF protection)."

    # Check cache first
    try:
        from cache import url_cache
        cached = url_cache.get_cached_url(url)
        if cached is not None:
            logger.info(f"✓ Cache hit for URL: {url}")
            # Add cache marker prefix (will be detected by frontend)
            return "[CACHE_HIT]" + cached
    except Exception as e:
        logger.warning(f"Cache error (falling back to fetch): {e}")

    try:
        headers = {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/120.0.0.0 Safari/537.36"
            )
        }
        response = requests.get(url, headers=headers, timeout=15)
        response.raise_for_status()

        content_type = response.headers.get("content-type", "")

        # Determine the result based on content type
        result = None

        # If it's JSON, return raw text
        if "application/json" in content_type:
            result = response.text[:10000]  # Limit to 10k chars

        # If it's plain text, return directly
        elif "text/plain" in content_type:
            result = response.text[:10000]

        # For HTML, clean and convert to Markdown
        else:
            converter = html2text.HTML2Text()
            converter.ignore_links = False
            converter.ignore_images = True
            converter.ignore_emphasis = False
            converter.body_width = 0  # Don't wrap lines

            markdown_content = converter.handle(response.text)

            # Limit output size to save tokens
            if len(markdown_content) > 8000:
                result = markdown_content[:8000] + "\n\n...[content truncated]"
            else:
                result = markdown_content

        # Cache the result (for all content types)
        try:
            from cache import url_cache
            url_cache.cache_url(url, result)
        except Exception as e:
            logger.warning(f"Failed to cache URL result: {e}")

        return result

    except requests.exceptions.Timeout:
        return f"❌ Error: Request timed out for URL: {url}"
    except requests.exceptions.HTTPError as e:
        return f"❌ HTTP Error {e.response.status_code}: {e}"
    except requests.exceptions.ConnectionError:
        return f"❌ Error: Could not connect to {url}"
    except Exception as e:
        return f"❌ Error fetching URL: {str(e)}"


def create_fetch_url_tool():
    """Factory function to create the fetch_url tool."""
    return fetch_url
