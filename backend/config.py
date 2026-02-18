"""VibeWorker Configuration Management"""
import os

from pathlib import Path
from typing import Optional

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict
from dotenv import load_dotenv

# Project root directory (read-only source code)
PROJECT_ROOT = Path(__file__).parent.resolve()


def _resolve_data_dir() -> Path:
    """Resolve data_dir from env var or default, before full config loads."""
    raw = os.getenv("DATA_DIR", "~/.vibeworker/")
    resolved = Path(raw).expanduser().resolve()
    # Safety: data_dir must NOT be inside project source directory
    try:
        resolved.relative_to(PROJECT_ROOT)
        import warnings
        warnings.warn(
            f"DATA_DIR={raw} resolves inside project root ({PROJECT_ROOT}). "
            f"Falling back to ~/.vibeworker/"
        )
        resolved = Path("~/.vibeworker/").expanduser().resolve()
    except ValueError:
        pass  # Good: outside project root
    return resolved


def _bootstrap_env():
    """Two-stage .env loading:
    1. Resolve data_dir from env/default
    2. Generate default .env on first run
    3. Load data_dir/.env (user config)
    """
    from user_default.init_user_config import init_env_file

    data_dir = _resolve_data_dir()
    data_dir.mkdir(parents=True, exist_ok=True)

    # First-run: generate default .env from template
    init_env_file(data_dir)

    # Load user .env (overrides system env vars)
    user_env = data_dir / ".env"
    if user_env.exists():
        load_dotenv(user_env, override=True)


_bootstrap_env()


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    model_config = SettingsConfigDict(
        env_file=str(_resolve_data_dir() / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Server
    host: str = "0.0.0.0"
    port: int = 8088

    # LLM Configuration
    llm_api_key: str = Field(default="")
    llm_api_base: str = Field(default="https://api.openai.com/v1")
    llm_model: str = Field(default="gpt-4o")
    llm_temperature: float = Field(default=0.7)
    llm_max_tokens: int = Field(default=4096)

    # Embedding Configuration
    embedding_api_key: Optional[str] = Field(default=None)
    embedding_api_base: Optional[str] = Field(default=None)
    embedding_model: str = Field(default="text-embedding-3-small")

    # Translation Model Configuration (uses main LLM config if not set)
    translate_api_key: Optional[str] = Field(default=None)
    translate_api_base: Optional[str] = Field(default=None)
    translate_model: Optional[str] = Field(default=None)

    # Data directory — all writable user data lives here
    data_dir: str = Field(
        default="~/.vibeworker/",
        description="All writable data (sessions, memory, skills, etc.) stored here"
    )

    # Derived paths (set in model_post_init based on data_dir)
    memory_dir: Path = Field(default=Path(""))
    sessions_dir: Path = Field(default=Path(""))
    skills_dir: Path = Field(default=Path(""))
    workspace_dir: Path = Field(default=Path(""))
    knowledge_dir: Path = Field(default=Path(""))
    storage_dir: Path = Field(default=Path(""))
    cache_dir: Path = Field(default=Path(""))

    # tools_dir stays in PROJECT_ROOT (read-only source)
    tools_dir: Path = PROJECT_ROOT / "tools"

    # System Prompt constraints
    max_prompt_chars: int = 20000

    # Agent execution limits
    agent_recursion_limit: int = 100

    # Cache Configuration
    enable_url_cache: bool = Field(default=True)
    enable_llm_cache: bool = Field(default=False)
    enable_prompt_cache: bool = Field(default=True)
    enable_translate_cache: bool = Field(default=True)

    url_cache_ttl: int = Field(default=3600)
    llm_cache_ttl: int = Field(default=86400)
    prompt_cache_ttl: int = Field(default=600)
    translate_cache_ttl: int = Field(default=604800)

    cache_max_memory_items: int = Field(default=100)
    cache_max_disk_size_mb: int = Field(default=5120)

    # Memory Configuration
    memory_auto_extract: bool = Field(default=False)
    memory_daily_log_days: int = Field(default=2)
    memory_max_prompt_tokens: int = Field(default=4000)
    memory_index_enabled: bool = Field(default=True)

    # MCP Configuration
    mcp_enabled: bool = Field(default=True)
    mcp_tool_cache_ttl: int = Field(default=3600)

    # Security Configuration
    security_enabled: bool = Field(default=True)
    security_level: str = Field(default="standard")
    security_approval_timeout: float = Field(default=60.0)
    security_audit_enabled: bool = Field(default=True)
    security_ssrf_protection: bool = Field(default=True)
    security_sensitive_file_protection: bool = Field(default=True)
    security_python_sandbox: bool = Field(default=True)
    security_rate_limit_enabled: bool = Field(default=True)
    security_docker_enabled: bool = Field(default=False)
    security_docker_network: str = Field(default="none")

    # Agent Mode Configuration
    agent_mode: str = Field(default="task")  # Deprecated: no longer affects runtime. Kept for backward compat.
    plan_enabled: bool = Field(default=True)  # Whether plan_create tool is available
    plan_revision_enabled: bool = Field(default=True)
    plan_require_approval: bool = Field(default=False)
    plan_max_steps: int = Field(default=8)

    # Claude Code Skills compatibility
    claude_code_skills_dir: Optional[Path] = None

    # Skills Store configuration
    store_registry_url: str = "https://raw.githubusercontent.com/anthropics/vibeworker-skills/main"
    store_cache_ttl: int = 3600

    def model_post_init(self, __context) -> None:
        """Load values from env vars after init (manual mapping)."""
        if not self.llm_api_key:
            self.llm_api_key = os.getenv("OPENAI_API_KEY", "")
        if self.llm_api_base == "https://api.openai.com/v1":
            env_base = os.getenv("OPENAI_API_BASE", "")
            if env_base:
                self.llm_api_base = env_base
        if not self.embedding_api_key:
            self.embedding_api_key = os.getenv("EMBEDDING_API_KEY", None)
        if not self.embedding_api_base:
            self.embedding_api_base = os.getenv("EMBEDDING_API_BASE", None)
        if self.embedding_model == "text-embedding-3-small":
            env_embed = os.getenv("EMBEDDING_MODEL", "")
            if env_embed:
                self.embedding_model = env_embed

        # Migrate old PLAN_ENABLED → agent_mode (backward compatibility)
        if self.agent_mode == "task":  # still default — check for old config
            raw = os.getenv("AGENT_MODE", "")
            if not raw:
                old = os.getenv("PLAN_ENABLED", "")
                if old.lower() == "false":
                    self.agent_mode = "simple"

        # Compute derived paths from data_dir
        data = self.get_data_path()
        self.memory_dir = data / "memory"
        self.sessions_dir = data / "sessions"
        self.skills_dir = data / "skills"
        self.workspace_dir = data / "workspace"
        self.knowledge_dir = data / "knowledge"
        self.storage_dir = data / "storage"
        self.cache_dir = data / ".cache"

    def get_data_path(self) -> Path:
        """Get resolved data directory path."""
        resolved = Path(self.data_dir).expanduser().resolve()
        # Safety: never allow data inside project source directory
        try:
            resolved.relative_to(PROJECT_ROOT)
            resolved = Path("~/.vibeworker/").expanduser().resolve()
        except ValueError:
            pass  # Good: outside project root
        return resolved

    def get_env_path(self) -> Path:
        """Get path to user .env file."""
        return self.get_data_path() / ".env"

    def ensure_dirs(self) -> None:
        """Ensure all required directories and default files exist.

        Delegates to init_user_config which checks each file independently:
        missing files are restored without affecting existing ones.
        """
        from user_default.init_user_config import init_user_config

        init_user_config(self.get_data_path())


settings = Settings()


def reload_settings() -> None:
    """Reload settings from .env file into the existing settings singleton.

    Re-reads the .env file, creates a fresh Settings instance, and copies
    all field values in-place onto the module-level `settings` object so
    every module that imported it sees the updated values immediately.
    """
    global settings
    env_path = settings.get_env_path()
    if env_path.exists():
        load_dotenv(env_path, override=True)
    new = Settings()
    for field_name in new.model_fields:
        setattr(settings, field_name, getattr(new, field_name))
