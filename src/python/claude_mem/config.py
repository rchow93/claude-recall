"""
Configuration for Tiered Storage System

Uses Pydantic Settings for environment variable loading with validation.
Automatically loads from .env file if present.
"""

from typing import Optional
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class RedisConfig(BaseSettings):
    """Redis hot tier configuration."""

    model_config = SettingsConfigDict(env_prefix="REDIS_")

    host: str = "localhost"
    port: int = 6379
    password: Optional[str] = None
    db: int = 0
    hot_tier_ttl: int = Field(default=48 * 60 * 60, description="TTL in seconds (48h)")
    key_prefix: str = "cr:"


class PostgresConfig(BaseSettings):
    """PostgreSQL cold tier configuration."""

    model_config = SettingsConfigDict(env_prefix="PG_")

    connection_string: str = Field(
        default="postgres://localhost:5432/claude_recall",
        alias="DATABASE_URL"
    )
    max_connections: int = 10
    idle_timeout_ms: int = 30000
    retention_days: int = 20


class OllamaConfig(BaseSettings):
    """Ollama embedding service configuration."""

    model_config = SettingsConfigDict(env_prefix="OLLAMA_")

    host: str = "http://localhost:11434"
    embedding_model: str = "nomic-embed-text"
    embedding_dimension: int = 768  # nomic-embed-text dimension
    timeout_ms: int = 30000


class SearchConfig(BaseSettings):
    """Search configuration."""

    model_config = SettingsConfigDict(env_prefix="SEARCH_")

    use_reranker: bool = False
    reranker_url: Optional[str] = None
    token_budget: int = 2000
    default_limit: int = 10
    hybrid_vector_weight: float = Field(default=0.5, ge=0.0, le=1.0)
    min_hot_results: int = 3  # Minimum hot tier results before querying cold


class SummarizationConfig(BaseSettings):
    """Background summarization configuration."""

    model_config = SettingsConfigDict(env_prefix="SUMMARIZATION_")

    session_consolidation_delay_hours: int = 24
    weekly_consolidation_delay_days: int = 7
    consolidation_interval_ms: int = 6 * 60 * 60 * 1000  # 6 hours in ms
    max_observations_per_summary: int = 50


class TieredStorageConfig(BaseSettings):
    """Main configuration container."""

    model_config = SettingsConfigDict(
        env_prefix="CLAUDE_RECALL_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    redis: RedisConfig = Field(default_factory=RedisConfig)
    postgres: PostgresConfig = Field(default_factory=PostgresConfig)
    ollama: OllamaConfig = Field(default_factory=OllamaConfig)
    search: SearchConfig = Field(default_factory=SearchConfig)
    summarization: SummarizationConfig = Field(default_factory=SummarizationConfig)

    # Server config
    server_host: str = "127.0.0.1"
    server_port: int = 37778  # Different from Node.js to allow running alongside

    # Feature flags
    use_local_embeddings: bool = Field(
        default=False,
        description="Use sentence-transformers instead of Ollama"
    )


# Global config singleton
_config: Optional[TieredStorageConfig] = None


def get_config() -> TieredStorageConfig:
    """Get the global configuration instance."""
    global _config
    if _config is None:
        _config = TieredStorageConfig()
    return _config


def reset_config() -> None:
    """Reset config (for testing)."""
    global _config
    _config = None
