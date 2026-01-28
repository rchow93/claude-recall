"""
PostgreSQL Client for Cold Tier Storage

Handles connection pooling, schema initialization, and retention cleanup.
"""

import asyncio
import logging
from typing import Optional, Any

import asyncpg
from pgvector.asyncpg import register_vector

from claude_recall.config import get_config, PostgresConfig

logger = logging.getLogger(__name__)

# SQL schema
SCHEMA_SQL = """
-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Observations with vector embeddings
CREATE TABLE IF NOT EXISTS observations (
    id BIGSERIAL PRIMARY KEY,
    memory_session_id TEXT NOT NULL,
    project TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('decision','bugfix','feature','refactor','discovery','change')),
    title TEXT,
    subtitle TEXT,
    facts JSONB DEFAULT '[]',
    narrative TEXT,
    concepts JSONB DEFAULT '[]',
    files_read JSONB DEFAULT '[]',
    files_modified JSONB DEFAULT '[]',
    prompt_number INTEGER,
    discovery_tokens INTEGER DEFAULT 0,
    embedding vector(768),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at_epoch BIGINT NOT NULL
);

-- Session summaries
CREATE TABLE IF NOT EXISTS session_summaries (
    id BIGSERIAL PRIMARY KEY,
    memory_session_id TEXT NOT NULL UNIQUE,
    project TEXT NOT NULL,
    request TEXT,
    investigated TEXT,
    learned TEXT,
    completed TEXT,
    next_steps TEXT,
    notes TEXT,
    files_read JSONB DEFAULT '[]',
    files_edited JSONB DEFAULT '[]',
    prompt_number INTEGER,
    discovery_tokens INTEGER DEFAULT 0,
    embedding vector(768),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at_epoch BIGINT NOT NULL
);

-- Weekly summaries (hierarchical consolidation)
CREATE TABLE IF NOT EXISTS weekly_summaries (
    id BIGSERIAL PRIMARY KEY,
    project TEXT NOT NULL,
    week_start DATE NOT NULL,
    summary_text TEXT NOT NULL,
    key_topics JSONB,
    embedding vector(768),
    source_session_ids BIGINT[],
    created_at TIMESTAMPTZ DEFAULT NOW(),
    created_at_epoch BIGINT NOT NULL,
    UNIQUE(project, week_start)
);

-- Project facts (stable knowledge)
CREATE TABLE IF NOT EXISTS project_facts (
    id BIGSERIAL PRIMARY KEY,
    project TEXT NOT NULL,
    fact_text TEXT NOT NULL,
    fact_type TEXT DEFAULT 'general',
    confidence FLOAT DEFAULT 1.0,
    embedding vector(768),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    created_at_epoch BIGINT NOT NULL
);

-- SDK Sessions
CREATE TABLE IF NOT EXISTS sdk_sessions (
    id BIGSERIAL PRIMARY KEY,
    content_session_id TEXT NOT NULL UNIQUE,
    memory_session_id TEXT,
    project TEXT NOT NULL,
    user_prompt TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at_epoch BIGINT NOT NULL,
    completed_at TIMESTAMPTZ,
    completed_at_epoch BIGINT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'failed')),
    worker_port INTEGER,
    prompt_counter INTEGER DEFAULT 1
);

-- User prompts
CREATE TABLE IF NOT EXISTS user_prompts (
    id BIGSERIAL PRIMARY KEY,
    content_session_id TEXT NOT NULL,
    prompt_number INTEGER NOT NULL,
    prompt_text TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at_epoch BIGINT NOT NULL,
    UNIQUE(content_session_id, prompt_number)
);
"""

INDEXES_SQL = """
-- Vector indexes using IVFFlat
CREATE INDEX IF NOT EXISTS idx_obs_embedding ON observations
    USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE INDEX IF NOT EXISTS idx_summary_embedding ON session_summaries
    USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50);

CREATE INDEX IF NOT EXISTS idx_weekly_embedding ON weekly_summaries
    USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50);

CREATE INDEX IF NOT EXISTS idx_fact_embedding ON project_facts
    USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50);

-- Full-text search indexes
CREATE INDEX IF NOT EXISTS idx_obs_tsv ON observations
    USING GIN (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(narrative,'')));

CREATE INDEX IF NOT EXISTS idx_summary_tsv ON session_summaries
    USING GIN (to_tsvector('english',
        coalesce(request,'') || ' ' ||
        coalesce(investigated,'') || ' ' ||
        coalesce(learned,'') || ' ' ||
        coalesce(completed,'')
    ));

-- Time-based indexes
CREATE INDEX IF NOT EXISTS idx_obs_project_time ON observations (project, created_at_epoch DESC);
CREATE INDEX IF NOT EXISTS idx_obs_session ON observations (memory_session_id);
CREATE INDEX IF NOT EXISTS idx_obs_created ON observations (created_at);
CREATE INDEX IF NOT EXISTS idx_obs_type ON observations (type);

CREATE INDEX IF NOT EXISTS idx_summary_project_time ON session_summaries (project, created_at_epoch DESC);
CREATE INDEX IF NOT EXISTS idx_summary_created ON session_summaries (created_at);

CREATE INDEX IF NOT EXISTS idx_weekly_project ON weekly_summaries (project, week_start DESC);
CREATE INDEX IF NOT EXISTS idx_facts_project ON project_facts (project);

-- JSONB indexes
CREATE INDEX IF NOT EXISTS idx_obs_concepts ON observations USING GIN (concepts);
CREATE INDEX IF NOT EXISTS idx_obs_files_read ON observations USING GIN (files_read);
CREATE INDEX IF NOT EXISTS idx_obs_files_modified ON observations USING GIN (files_modified);
"""


class PostgresClient:
    """PostgreSQL connection pool and schema manager."""

    def __init__(self, config: Optional[PostgresConfig] = None):
        self.config = config or get_config().postgres
        self.pool: Optional[asyncpg.Pool] = None
        self._initialized = False

    async def connect(self) -> None:
        """Create connection pool."""
        if self.pool is not None:
            return

        self.pool = await asyncpg.create_pool(
            self.config.connection_string,
            min_size=2,
            max_size=self.config.max_connections,
            command_timeout=60,
            setup=self._setup_connection,
        )
        logger.info("PostgreSQL connection pool created")

    async def _setup_connection(self, conn: asyncpg.Connection) -> None:
        """Set up each connection with pgvector support."""
        await register_vector(conn)

    async def initialize(self) -> None:
        """Initialize schema and indexes."""
        if self._initialized:
            return

        await self.connect()
        assert self.pool is not None

        async with self.pool.acquire() as conn:
            await conn.execute(SCHEMA_SQL)
            await conn.execute(INDEXES_SQL)

        self._initialized = True
        logger.info("PostgreSQL schema initialized")

    async def execute(self, query: str, *args: Any) -> str:
        """Execute a query."""
        assert self.pool is not None
        async with self.pool.acquire() as conn:
            return await conn.execute(query, *args)

    async def fetch(self, query: str, *args: Any) -> list[asyncpg.Record]:
        """Fetch multiple rows."""
        assert self.pool is not None
        async with self.pool.acquire() as conn:
            return await conn.fetch(query, *args)

    async def fetchrow(self, query: str, *args: Any) -> Optional[asyncpg.Record]:
        """Fetch a single row."""
        assert self.pool is not None
        async with self.pool.acquire() as conn:
            return await conn.fetchrow(query, *args)

    async def fetchval(self, query: str, *args: Any) -> Any:
        """Fetch a single value."""
        assert self.pool is not None
        async with self.pool.acquire() as conn:
            return await conn.fetchval(query, *args)

    async def run_retention_cleanup(self) -> int:
        """Delete data older than retention period. Returns count of deleted rows."""
        assert self.pool is not None

        deleted_total = 0

        async with self.pool.acquire() as conn:
            # Delete old observations
            result = await conn.execute(
                f"DELETE FROM observations WHERE created_at < NOW() - INTERVAL '{self.config.retention_days} days'"
            )
            deleted_total += int(result.split()[-1]) if result else 0

            # Delete old summaries
            result = await conn.execute(
                f"DELETE FROM session_summaries WHERE created_at < NOW() - INTERVAL '{self.config.retention_days} days'"
            )
            deleted_total += int(result.split()[-1]) if result else 0

        if deleted_total > 0:
            logger.info(f"Retention cleanup: deleted {deleted_total} rows")

        return deleted_total

    async def is_available(self) -> bool:
        """Check if database is available."""
        try:
            await self.connect()
            assert self.pool is not None
            async with self.pool.acquire() as conn:
                await conn.fetchval("SELECT 1")
            return True
        except Exception as e:
            logger.warning(f"PostgreSQL not available: {e}")
            return False

    async def close(self) -> None:
        """Close the connection pool."""
        if self.pool:
            await self.pool.close()
            self.pool = None
            self._initialized = False
            logger.info("PostgreSQL connection pool closed")


# Singleton instance
_client: Optional[PostgresClient] = None


def get_postgres_client() -> PostgresClient:
    """Get the global PostgreSQL client."""
    global _client
    if _client is None:
        _client = PostgresClient()
    return _client


async def initialize_postgres() -> PostgresClient:
    """Initialize and return the PostgreSQL client."""
    client = get_postgres_client()
    await client.initialize()
    return client


async def close_postgres() -> None:
    """Close the PostgreSQL client."""
    global _client
    if _client:
        await _client.close()
        _client = None
