"""VibeWorker Configuration Management"""
import os
from pathlib import Path
from typing import Optional

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict
from dotenv import load_dotenv

load_dotenv()

# Project root directory
PROJECT_ROOT = Path(__file__).parent.resolve()


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",  # Ignore extra env vars like OPENAI_API_KEY
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

    # Paths
    memory_dir: Path = PROJECT_ROOT / "memory"
    sessions_dir: Path = PROJECT_ROOT / "sessions"
    skills_dir: Path = PROJECT_ROOT / "skills"
    workspace_dir: Path = PROJECT_ROOT / "workspace"
    knowledge_dir: Path = PROJECT_ROOT / "knowledge"
    storage_dir: Path = PROJECT_ROOT / "storage"
    tools_dir: Path = PROJECT_ROOT / "tools"
    cache_dir: Path = PROJECT_ROOT / ".cache"

    # System Prompt constraints
    max_prompt_chars: int = 20000

    # Agent execution limits
    agent_recursion_limit: int = 100  # Max tool calls per request (default was 25)

    # Cache Configuration
    enable_url_cache: bool = Field(default=True)
    enable_llm_cache: bool = Field(default=False)  # 默认关闭，避免影响探索性
    enable_prompt_cache: bool = Field(default=True)
    enable_translate_cache: bool = Field(default=True)

    url_cache_ttl: int = Field(default=3600)  # 1 hour
    llm_cache_ttl: int = Field(default=86400)  # 24 hours
    prompt_cache_ttl: int = Field(default=600)  # 10 minutes
    translate_cache_ttl: int = Field(default=604800)  # 7 days

    cache_max_memory_items: int = Field(default=100)
    cache_max_disk_size_mb: int = Field(default=5120)  # 5GB

    # Claude Code Skills compatibility
    claude_code_skills_dir: Optional[Path] = None

    # Skills Store configuration
    store_registry_url: str = "https://raw.githubusercontent.com/anthropics/vibeworker-skills/main"
    store_cache_ttl: int = 3600  # Cache TTL in seconds (1 hour)

    def model_post_init(self, __context) -> None:
        """Load values from env vars after init (manual mapping)."""
        # Map OPENAI_API_KEY -> llm_api_key if not set via LLM_API_KEY
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

    def ensure_dirs(self) -> None:
        """Ensure all required directories exist."""
        for dir_path in [
            self.memory_dir,
            self.memory_dir / "logs",
            self.sessions_dir,
            self.skills_dir,
            self.workspace_dir,
            self.knowledge_dir,
            self.storage_dir,
            self.cache_dir,
            self.cache_dir / "url",
            self.cache_dir / "llm",
            self.cache_dir / "prompt",
            self.cache_dir / "translate",
        ]:
            dir_path.mkdir(parents=True, exist_ok=True)


settings = Settings()
