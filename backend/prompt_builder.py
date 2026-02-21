"""System Prompt Builder - Dynamically assembles the system prompt from workspace files."""
from pathlib import Path
from typing import Optional
import logging
import platform

from config import settings, PROJECT_ROOT, read_text_smart

logger = logging.getLogger(__name__)


def _read_file_safe(path: Path, max_chars: Optional[int] = None) -> str:
    """安全读取文件，自动处理编码，找不到时返回空字符串。"""
    if not path.exists():
        return ""
    content = read_text_smart(path)
    if max_chars and len(content) > max_chars:
        content = content[:max_chars] + "\n\n...[truncated]"
    return content


def _detect_os_description() -> str:
    """检测当前操作系统，返回人类可读的描述字符串。

    例如：'Windows 10 (10.0.19045)'、'macOS 14.2 (arm64)'、'Linux Ubuntu 22.04 (x86_64)'
    帮助 Agent 在生成命令和脚本时使用正确的语法（如路径分隔符、Shell 命令等）。
    """
    system = platform.system()  # 'Windows' / 'Darwin' / 'Linux'
    machine = platform.machine()  # 'AMD64' / 'arm64' / 'x86_64'

    if system == "Windows":
        # platform.version() 返回如 '10.0.19045'
        version = platform.version()
        release = platform.release()  # '10' / '11'
        return f"Windows {release} ({version}, {machine})"

    elif system == "Darwin":
        # macOS 版本
        mac_ver = platform.mac_ver()[0]  # 如 '14.2.1'
        return f"macOS {mac_ver} ({machine})" if mac_ver else f"macOS ({machine})"

    elif system == "Linux":
        # 尝试读取发行版信息
        try:
            import distro
            distro_name = distro.name(pretty=True)  # 如 'Ubuntu 22.04.3 LTS'
        except ImportError:
            # 回退：尝试读取 /etc/os-release
            distro_name = ""
            try:
                with open("/etc/os-release") as f:
                    for line in f:
                        if line.startswith("PRETTY_NAME="):
                            distro_name = line.split("=", 1)[1].strip().strip('"')
                            break
            except Exception:
                pass
        kernel = platform.release()  # 内核版本
        if distro_name:
            return f"Linux {distro_name} (kernel {kernel}, {machine})"
        return f"Linux (kernel {kernel}, {machine})"

    else:
        return f"{system} {platform.release()} ({machine})"


def generate_skills_snapshot() -> str:
    """Scan skills directory and generate SKILLS_SNAPSHOT content."""
    skills_dirs = [settings.skills_dir]

    # Claude Code Skills compatibility
    claude_code_dir = _detect_claude_code_skills()
    if claude_code_dir:
        skills_dirs.append(claude_code_dir)

    data_path = settings.get_data_path()
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
            # Use relative path from data_dir first, fallback to PROJECT_ROOT
            try:
                rel_path = skill_md.relative_to(data_path)
            except ValueError:
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
    """解析 SKILL.md 的 YAML frontmatter，自动处理文件编码。"""
    try:
        import frontmatter
        # 用 read_text_smart 处理编码后，再解析 frontmatter
        content = read_text_smart(skill_md)
        post = frontmatter.loads(content)
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
    6. memory.json (长期记忆) + Daily Logs
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

    # 5.5 Workspace Info（包含动态占位符 {{SESSION_ID}} 和 {{WORKING_DIR}}，由 runner 替换）
    data_path = settings.get_data_path()
    os_desc = _detect_os_description()
    parts.append(
        f"<!-- WORKSPACE_INFO -->\n"
        f"## 环境信息\n"
        f"- **操作系统**: {os_desc}\n"
        f"  - 请根据操作系统使用正确的命令语法、路径格式和 Shell 特性\n"
        f"- **当前会话 ID**: `{{{{SESSION_ID}}}}`\n"
        f"- **工作目录**: `{{{{WORKING_DIR}}}}`\n"
        f"  - 所有工具（terminal、python_repl）的当前工作目录\n"
        f"  - 下载的文件、生成的文件都保存在这里\n"
        f"  - 向用户提供文件时，请给出完整路径\n"
        f"- **用户数据目录**: `{data_path}`\n"
        f"- **项目源码**（只读）: `{PROJECT_ROOT}`"
    )

    # 6. Memory — 统一记忆区块（memory.json + Daily Logs）
    # 所有记忆内容合并在一个 <!-- MEMORY --> 标签下，
    # 隐式召回在 runner.py 中按需追加到此区块末尾
    memory_budget = settings.memory_max_prompt_tokens * 4  # ~4 chars per token estimate
    memory_sections: list[str] = []

    # 长期记忆（memory.json：含用户偏好、事实、程序经验等所有分类）
    try:
        from memory.manager import memory_manager
        memory_content = memory_manager.read_memory()
        if memory_content:
            memory_sections.append(memory_content)
    except Exception as e:
        logger.warning(f"加载 memory.json 失败: {e}")

    # 每日日志
    try:
        from memory.manager import memory_manager
        daily_context = memory_manager.get_daily_context()
        if daily_context:
            memory_sections.append(f"## 每日日志\n{daily_context}")
    except Exception as e:
        logger.warning(f"加载每日日志失败: {e}")

    # 合并并应用 token 预算
    if memory_sections:
        memory_combined = "<!-- MEMORY -->\n" + "\n\n".join(memory_sections)
        if len(memory_combined) > memory_budget:
            memory_combined = memory_combined[:memory_budget] + "\n\n...[memory truncated]"
        parts.append(memory_combined)

    full_prompt = "\n\n---\n\n".join(parts)

    # Cache the result
    try:
        from cache import prompt_cache
        prompt_cache.cache_prompt(full_prompt)
        logger.debug("✓ System prompt cached")
    except Exception as e:
        logger.warning(f"Failed to cache prompt: {e}")

    return full_prompt


def build_implicit_recall_context(user_message: str) -> str:
    """基于用户首条消息构建隐式召回上下文

    在对话开始时自动检索相关记忆，注入到 <!-- MEMORY --> 区块末尾。
    不包含 procedural 记忆（程序经验已在 read_memory() 中输出，避免重复）。

    Args:
        user_message: 用户的首条消息

    Returns:
        隐式召回的 ## 子区块字符串，由 runner.py 追加到 MEMORY 区块内
    """
    if not user_message or not user_message.strip():
        return ""

    try:
        from memory.search import get_implicit_recall

        top_k = settings.memory_implicit_recall_top_k
        # 不包含 procedural，因为程序经验已在 read_memory() 的 "## 程序经验" 中展示
        results = get_implicit_recall(
            query=user_message,
            top_k=top_k,
            include_procedural=False,
        )

        if not results:
            return ""

        # 过滤掉可能从语义搜索路径进来的 procedural 条目
        results = [r for r in results if r.get("category") != "procedural"]
        if not results:
            return ""

        parts = ["## 相关记忆（自动召回）\n"]
        for r in results[:top_k]:
            content = r.get("content", "")[:200]
            cat = r.get("category", "")
            salience = r.get("salience", 0.5)
            star = "⭐ " if salience >= 0.8 else ""
            parts.append(f"- {star}[{cat}] {content}")

        return "\n".join(parts)

    except Exception as e:
        logger.warning(f"Failed to build implicit recall context: {e}")
        return ""
