# Python Alternative for Tiered Memory

> **Note**: The primary implementation uses TypeScript and is integrated into the claude-recall plugin. See [TIERED_MEMORY.md](./TIERED_MEMORY.md) for the standard setup. This document describes an alternative Python implementation for users who prefer Python.

## Overview

While claude-recall is implemented in TypeScript/Bun, the tiered storage architecture uses **language-agnostic services**:

- **PostgreSQL** - Standard SQL database with REST/TCP protocol
- **Redis** - Standard Redis protocol
- **Ollama** - REST API for embeddings

This means you can absolutely implement the same system in Python with potentially **simpler code** and **better ML ecosystem support**.

## Why Python Might Be Better

| Aspect | Node.js | Python |
|--------|---------|--------|
| ML/Embedding libraries | Limited | Excellent (sentence-transformers, etc.) |
| Database ORMs | TypeORM, Prisma | SQLAlchemy, asyncpg |
| Redis clients | node-redis | redis-py, aioredis |
| Async support | Native | asyncio, excellent |
| Typing | TypeScript | Type hints + mypy |
| Packaging | npm | pip, poetry, uv |
| LLM integrations | anthropic-sdk | anthropic, langchain, llama-index |

## Python Implementation

### Dependencies

```bash
# Using uv (fast Python package manager)
uv pip install \
    asyncpg \
    pgvector \
    redis \
    httpx \
    pydantic \
    sentence-transformers \
    numpy
```

Or with `requirements.txt`:

```txt
asyncpg>=0.29.0
pgvector>=0.2.0
redis>=5.0.0
httpx>=0.27.0
pydantic>=2.0.0
sentence-transformers>=2.2.0
numpy>=1.24.0
```

### Project Structure

```
claude-recall-py/
├── src/
│   ├── storage/
│   │   ├── __init__.py
│   │   ├── config.py
│   │   ├── interfaces.py
│   │   ├── cold/
│   │   │   ├── __init__.py
│   │   │   ├── postgres_client.py
│   │   │   ├── observation_store.py
│   │   │   ├── summary_store.py
│   │   │   └── hybrid_search.py
│   │   ├── hot/
│   │   │   ├── __init__.py
│   │   │   ├── redis_client.py
│   │   │   └── observation_store.py
│   │   ├── tiered/
│   │   │   ├── __init__.py
│   │   │   ├── manager.py
│   │   │   ├── query_router.py
│   │   │   └── cache_warmer.py
│   │   └── workers/
│   │       ├── __init__.py
│   │       └── summarization.py
│   ├── embedding/
│   │   ├── __init__.py
│   │   └── service.py
│   └── api/
│       ├── __init__.py
│       └── routes.py
├── tests/
├── pyproject.toml
└── README.md
```

### Core Implementation

#### `src/storage/config.py`

```python
from pydantic import BaseSettings
from typing import Optional

class RedisConfig(BaseSettings):
    host: str = "localhost"
    port: int = 6379
    password: Optional[str] = None
    db: int = 0
    hot_tier_ttl: int = 48 * 60 * 60  # 48 hours

    class Config:
        env_prefix = "REDIS_"

class PostgresConfig(BaseSettings):
    connection_string: str = "postgres://localhost:5432/claude_recall"
    max_connections: int = 10
    retention_days: int = 20

    class Config:
        env_prefix = "PG_"

class OllamaConfig(BaseSettings):
    host: str = "http://localhost:11434"
    embedding_model: str = "nomic-embed-text"
    embedding_dim: int = 768
    timeout_ms: int = 30000

    class Config:
        env_prefix = "OLLAMA_"

class TieredStorageConfig(BaseSettings):
    redis: RedisConfig = RedisConfig()
    postgres: PostgresConfig = PostgresConfig()
    ollama: OllamaConfig = OllamaConfig()
```

#### `src/storage/interfaces.py`

```python
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Optional, List
from datetime import datetime
from enum import Enum

class ObservationType(str, Enum):
    DECISION = "decision"
    BUGFIX = "bugfix"
    FEATURE = "feature"
    REFACTOR = "refactor"
    DISCOVERY = "discovery"
    CHANGE = "change"

@dataclass
class StoredObservation:
    id: int
    memory_session_id: str
    project: str
    type: ObservationType
    title: Optional[str]
    subtitle: Optional[str]
    facts: Optional[List[str]]
    narrative: Optional[str]
    concepts: Optional[List[str]]
    files_read: Optional[List[str]]
    files_modified: Optional[List[str]]
    prompt_number: Optional[int]
    discovery_tokens: int
    embedding: Optional[List[float]]
    created_at: datetime
    created_at_epoch: int

@dataclass
class SearchResult:
    item: StoredObservation
    score: float
    source: str  # 'vector', 'bm25', 'hybrid'

class IObservationStore(ABC):
    @abstractmethod
    async def store(self, observation: dict) -> StoredObservation:
        pass

    @abstractmethod
    async def get_by_id(self, id: int) -> Optional[StoredObservation]:
        pass

    @abstractmethod
    async def get_recent(self, project: str, limit: int = 100) -> List[StoredObservation]:
        pass

class ISearchEngine(ABC):
    @abstractmethod
    async def vector_search(
        self, embedding: List[float], limit: int = 10, project: Optional[str] = None
    ) -> List[SearchResult]:
        pass

    @abstractmethod
    async def hybrid_search(
        self, query: str, embedding: List[float], limit: int = 10
    ) -> List[SearchResult]:
        pass
```

#### `src/storage/cold/postgres_client.py`

```python
import asyncpg
from pgvector.asyncpg import register_vector
from typing import Optional
from ..config import PostgresConfig

class PostgresClient:
    def __init__(self, config: Optional[PostgresConfig] = None):
        self.config = config or PostgresConfig()
        self.pool: Optional[asyncpg.Pool] = None

    async def connect(self):
        self.pool = await asyncpg.create_pool(
            self.config.connection_string,
            min_size=2,
            max_size=self.config.max_connections,
            setup=self._setup_connection
        )

    async def _setup_connection(self, conn):
        await register_vector(conn)

    async def initialize_schema(self):
        async with self.pool.acquire() as conn:
            await conn.execute("""
                CREATE EXTENSION IF NOT EXISTS vector;

                CREATE TABLE IF NOT EXISTS observations (
                    id BIGSERIAL PRIMARY KEY,
                    memory_session_id TEXT NOT NULL,
                    project TEXT NOT NULL,
                    type TEXT NOT NULL,
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

                CREATE INDEX IF NOT EXISTS idx_obs_embedding
                ON observations USING ivfflat (embedding vector_cosine_ops);

                CREATE INDEX IF NOT EXISTS idx_obs_tsv
                ON observations USING GIN (
                    to_tsvector('english', coalesce(title,'') || ' ' || coalesce(narrative,''))
                );

                CREATE INDEX IF NOT EXISTS idx_obs_project_time
                ON observations (project, created_at_epoch DESC);
            """)

    async def close(self):
        if self.pool:
            await self.pool.close()
```

#### `src/storage/cold/hybrid_search.py`

```python
import asyncpg
from typing import List, Optional
import numpy as np
from ..interfaces import StoredObservation, SearchResult

def reciprocal_rank_fusion(
    vector_results: List[SearchResult],
    text_results: List[SearchResult],
    k: int = 60
) -> List[SearchResult]:
    """Combine results using RRF."""
    scores = {}
    items = {}

    for rank, result in enumerate(vector_results):
        rrf_score = 1 / (k + rank + 1)
        scores[result.item.id] = scores.get(result.item.id, 0) + rrf_score
        items[result.item.id] = result.item

    for rank, result in enumerate(text_results):
        rrf_score = 1 / (k + rank + 1)
        scores[result.item.id] = scores.get(result.item.id, 0) + rrf_score
        items[result.item.id] = result.item

    sorted_ids = sorted(scores.keys(), key=lambda x: scores[x], reverse=True)

    return [
        SearchResult(item=items[id], score=scores[id], source='hybrid')
        for id in sorted_ids
    ]

class PostgresHybridSearch:
    def __init__(self, pool: asyncpg.Pool):
        self.pool = pool

    async def vector_search(
        self,
        embedding: List[float],
        limit: int = 10,
        project: Optional[str] = None
    ) -> List[SearchResult]:
        embedding_str = f"[{','.join(map(str, embedding))}]"

        query = """
            SELECT *, 1 - (embedding <=> $1::vector) as score
            FROM observations
            WHERE embedding IS NOT NULL
        """
        params = [embedding_str]

        if project:
            query += " AND project = $2"
            params.append(project)

        query += " ORDER BY embedding <=> $1::vector LIMIT $" + str(len(params) + 1)
        params.append(limit)

        async with self.pool.acquire() as conn:
            rows = await conn.fetch(query, *params)

        return [
            SearchResult(
                item=self._row_to_observation(row),
                score=row['score'],
                source='vector'
            )
            for row in rows
        ]

    async def text_search(
        self,
        query: str,
        limit: int = 10,
        project: Optional[str] = None
    ) -> List[SearchResult]:
        sql = """
            SELECT *,
                   ts_rank(
                       to_tsvector('english', coalesce(title,'') || ' ' || coalesce(narrative,'')),
                       plainto_tsquery('english', $1)
                   ) as score
            FROM observations
            WHERE to_tsvector('english', coalesce(title,'') || ' ' || coalesce(narrative,''))
                  @@ plainto_tsquery('english', $1)
        """
        params = [query]

        if project:
            sql += " AND project = $2"
            params.append(project)

        sql += " ORDER BY score DESC LIMIT $" + str(len(params) + 1)
        params.append(limit)

        async with self.pool.acquire() as conn:
            rows = await conn.fetch(sql, *params)

        max_score = max((r['score'] for r in rows), default=1)

        return [
            SearchResult(
                item=self._row_to_observation(row),
                score=row['score'] / max_score if max_score > 0 else 0,
                source='bm25'
            )
            for row in rows
        ]

    async def hybrid_search(
        self,
        query: str,
        embedding: List[float],
        limit: int = 10,
        project: Optional[str] = None
    ) -> List[SearchResult]:
        vector_results, text_results = await asyncio.gather(
            self.vector_search(embedding, limit * 2, project),
            self.text_search(query, limit * 2, project)
        )

        fused = reciprocal_rank_fusion(vector_results, text_results)
        return fused[:limit]

    def _row_to_observation(self, row) -> StoredObservation:
        return StoredObservation(
            id=row['id'],
            memory_session_id=row['memory_session_id'],
            project=row['project'],
            type=row['type'],
            title=row['title'],
            subtitle=row['subtitle'],
            facts=row['facts'],
            narrative=row['narrative'],
            concepts=row['concepts'],
            files_read=row['files_read'],
            files_modified=row['files_modified'],
            prompt_number=row['prompt_number'],
            discovery_tokens=row['discovery_tokens'],
            embedding=list(row['embedding']) if row['embedding'] else None,
            created_at=row['created_at'],
            created_at_epoch=row['created_at_epoch']
        )
```

#### `src/embedding/service.py`

```python
import httpx
from typing import List, Optional
from ..storage.config import OllamaConfig

class EmbeddingService:
    """Embedding service using Ollama or sentence-transformers."""

    def __init__(self, config: Optional[OllamaConfig] = None):
        self.config = config or OllamaConfig()
        self._model = None  # Lazy load sentence-transformers

    async def generate_embedding_ollama(self, text: str) -> List[float]:
        """Generate embedding using Ollama REST API."""
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{self.config.host}/api/embeddings",
                json={
                    "model": self.config.embedding_model,
                    "prompt": text.strip()
                },
                timeout=self.config.timeout_ms / 1000
            )
            response.raise_for_status()
            return response.json()["embedding"]

    def generate_embedding_local(self, text: str) -> List[float]:
        """Generate embedding using sentence-transformers (local, faster)."""
        if self._model is None:
            from sentence_transformers import SentenceTransformer
            self._model = SentenceTransformer('nomic-ai/nomic-embed-text-v1')

        embedding = self._model.encode(text.strip())
        return embedding.tolist()

    async def generate_embedding(self, text: str, use_local: bool = False) -> List[float]:
        """Generate embedding using configured method."""
        if use_local:
            return self.generate_embedding_local(text)
        return await self.generate_embedding_ollama(text)

    async def generate_embeddings(
        self, texts: List[str], use_local: bool = False
    ) -> List[List[float]]:
        """Batch embedding generation."""
        if use_local:
            if self._model is None:
                from sentence_transformers import SentenceTransformer
                self._model = SentenceTransformer('nomic-ai/nomic-embed-text-v1')

            embeddings = self._model.encode([t.strip() for t in texts])
            return embeddings.tolist()

        # Ollama doesn't support batch, parallelize
        import asyncio
        tasks = [self.generate_embedding_ollama(t) for t in texts]
        return await asyncio.gather(*tasks)
```

#### `src/api/routes.py` (FastAPI)

```python
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Optional, List

app = FastAPI()

class RAGQueryRequest(BaseModel):
    query: str
    project: str
    limit: int = 5
    token_budget: int = 2000

class RAGQueryResponse(BaseModel):
    context: str
    stats: dict

@app.post("/api/rag/query", response_model=RAGQueryResponse)
async def rag_query(request: RAGQueryRequest):
    from ..storage.tiered import get_query_router
    from ..embedding import get_embedding_service

    router = get_query_router()
    embedding_service = get_embedding_service()

    # Generate query embedding
    embedding = await embedding_service.generate_embedding(request.query)

    # Query with hot-first strategy
    results = await router.query_for_rag(
        query=request.query,
        embedding=embedding,
        project=request.project,
        limit=request.limit
    )

    # Format for injection
    context = router.format_for_injection(results, request.token_budget)

    return RAGQueryResponse(
        context=context,
        stats={
            "observation_count": len(results.observations),
            "summary_count": len(results.summaries),
            "query_time_ms": results.query_time_ms,
            "hot_tier_hit": results.hot_tier_hit
        }
    )

@app.post("/api/rag/warm")
async def cache_warm(project: str):
    from ..storage.tiered import get_cache_warmer
    warmer = get_cache_warmer()
    stats = await warmer.warm_for_project(project)
    return {"warmed": True, "stats": stats}
```

### Running the Python Version

```bash
# Install dependencies
uv pip install -r requirements.txt

# Run FastAPI server
uvicorn src.api.routes:app --host 0.0.0.0 --port 37777

# Or with auto-reload for development
uvicorn src.api.routes:app --reload
```

## Advantages of Python Version

1. **Better ML ecosystem**: Direct access to sentence-transformers for local embeddings
2. **Simpler async**: asyncio is more mature and simpler than Node.js promises
3. **Type safety**: Pydantic provides runtime validation + IDE support
4. **Database tools**: asyncpg is faster than node-postgres
5. **Testing**: pytest is more intuitive than Jest
6. **LangChain/LlamaIndex**: Easy integration for advanced RAG patterns

## Hybrid Approach

You can also run Python services alongside the Node.js claude-recall:

1. Keep claude-recall for Claude Code hooks (TypeScript)
2. Run Python microservice for RAG/search (FastAPI)
3. Communicate via REST API or message queue

```yaml
# docker-compose.yml
services:
  claude-recall:
    build: ./claude-recall
    ports:
      - "37777:37777"

  rag-service:
    build: ./rag-service-python
    ports:
      - "37778:37778"

  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_DB: claude_recall
    ports:
      - "5432:5432"

  redis:
    image: redis/redis-stack:latest
    ports:
      - "6379:6379"
```

## Conclusion

Python is an excellent choice for the tiered storage system because:

1. The underlying services (PostgreSQL, Redis, Ollama) are language-agnostic
2. Python has superior ML/embedding library support
3. asyncpg and redis-py are production-ready
4. FastAPI provides a clean, typed API layer
5. The sentence-transformers library allows local embeddings without Ollama

The Node.js implementation was chosen because claude-recall already uses TypeScript, but a Python rewrite would be cleaner and potentially more performant for the ML-heavy RAG workloads.
