"""System Prompt Builder - Dynamically assembles the system prompt from workspace files."""
from pathlib import Path
from typing import Optional
import logging

from config import settings, PROJECT_ROOT

logger = logging.getLogger(__name__)


def _read_file_safe(path: Path, max_chars: Optional[int] = None) -> str:
    """Read a file safely, returning empty string if not found."""
    if not path.exists():
        return ""
    content = path.read_text(encoding="utf-8")
    if max_chars and len(content) > max_chars:
        content = content[:max_chars] + "\n\n...[truncated]"
    return content


def generate_skills_snapshot() -> str:
    """Scan skills directory and generate SKILLS_SNAPSHOT content."""
    skills_dirs = [settings.skills_dir]

    # Claude Code Skills compatibility
    claude_code_dir = _detect_claude_code_skills()
    if claude_code_dir:
        skills_dirs.append(claude_code_dir)

    skills_xml = "<available_skills>\n"
    for base_dir in skills_dirs:
        if not base_dir.exists():
            continue
        for skill_dir in sorted(base_dir.iterdir()):
            if not skill_dir.is_dir():
                continue
            skill_md = skill_dir / "SKILL.md"
            if not skill_md.exists():
                continue
            # Parse frontmatter for name and description
            name, description = _parse_skill_frontmatter(skill_md)
            if not name:
                name = skill_dir.name
            # Use relative path from project root
            try:
                rel_path = skill_md.relative_to(PROJECT_ROOT)
            except ValueError:
                rel_path = skill_md
            skills_xml += f"  <skill>\n"
            skills_xml += f"    <name>{name}</name>\n"
            skills_xml += f"    <description>{description}</description>\n"
            skills_xml += f"    <location>./{rel_path}</location>\n"
            skills_xml += f"  </skill>\n"

    skills_xml += "</available_skills>"
    return skills_xml


def _parse_skill_frontmatter(skill_md: Path) -> tuple[str, str]:
    """Parse YAML frontmatter from a SKILL.md file."""
    try:
        import frontmatter
        post = frontmatter.load(str(skill_md))
        name = post.get("name", "")
        description = post.get("description", "")
        return name, description
    except Exception:
        return "", ""


def _detect_claude_code_skills() -> Optional[Path]:
    """Detect Claude Code skills directory if installed."""
    # Common Claude Code skills locations
    home = Path.home()
    possible_paths = [
        home / ".claude" / "skills",
        home / ".config" / "claude" / "skills",
        home / "AppData" / "Roaming" / "claude" / "skills",  # Windows
    ]
    # Also check from settings
    if settings.claude_code_skills_dir:
        possible_paths.insert(0, settings.claude_code_skills_dir)

    for p in possible_paths:
        if p.exists() and p.is_dir():
            return p
    return None


def build_system_prompt() -> str:
    """
    Build the complete system prompt by assembling 6 components in order:
    1. SKILLS_SNAPSHOT (能力列表)
    2. SOUL.md (核心设定)
    3. IDENTITY.md (自我认知)
    4. USER.md (用户画像)
    5. AGENTS.md (行为准则 & 记忆操作指南)
    6. MEMORY.md (长期记忆)
    """
    # Check cache first
    try:
        from cache import prompt_cache
        cached = prompt_cache.get_cached_prompt()
        if cached is not None:
            logger.debug("✓ Using cached system prompt")
            return cached
    except Exception as e:
        logger.warning(f"Prompt cache error (falling back to build): {e}")

    max_chars = settings.max_prompt_chars
    workspace = settings.workspace_dir

    parts: list[str] = []

    # 1. Skills Snapshot
    skills = generate_skills_snapshot()
    parts.append(f"<!-- SKILLS_SNAPSHOT -->\n{skills}")

    # 2. SOUL.md
    soul = _read_file_safe(workspace / "SOUL.md", max_chars)
    if soul:
        parts.append(f"<!-- SOUL -->\n{soul}")

    # 3. IDENTITY.md
    identity = _read_file_safe(workspace / "IDENTITY.md", max_chars)
    if identity:
        parts.append(f"<!-- IDENTITY -->\n{identity}")

    # 4. USER.md
    user = _read_file_safe(workspace / "USER.md", max_chars)
    if user:
        parts.append(f"<!-- USER -->\n{user}")

    # 5. AGENTS.md
    agents = _read_file_safe(workspace / "AGENTS.md", max_chars)
    if agents:
        parts.append(f"<!-- AGENTS -->\n{agents}")

    # 6. MEMORY.md
    memory = _read_file_safe(settings.memory_dir / "MEMORY.md", max_chars)
    if memory:
        parts.append(f"<!-- MEMORY -->\n{memory}")

    full_prompt = "\n\n---\n\n".join(parts)

    # Cache the result
    try:
        from cache import prompt_cache
        prompt_cache.cache_prompt(full_prompt)
        logger.debug("✓ System prompt cached")
    except Exception as e:
        logger.warning(f"Failed to cache prompt: {e}")

    return full_prompt
