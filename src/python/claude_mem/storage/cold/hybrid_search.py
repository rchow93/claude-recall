"""
PostgreSQL Hybrid Search

Combines pgvector semantic search with tsvector full-text (BM25-like) search
using Reciprocal Rank Fusion (RRF) for result merging.
"""

import logging
from typing import Optional

from claude_recall.models import (
    StoredObservation,
    StoredSessionSummary,
    SearchResult,
    HybridSearchOptions,
)
from claude_recall.storage.cold.postgres_client import PostgresClient, get_postgres_client

logger = logging.getLogger(__name__)


def _rrf_score(rank: int, k: int = 60) -> float:
    """Calculate Reciprocal Rank Fusion score."""
    return 1.0 / (k + rank)


def _merge_results_rrf(
    vector_results: list[dict],
    text_results: list[dict],
    k: int = 60,
) -> list[dict]:
    """
    Merge vector and text search results using Reciprocal Rank Fusion.

    RRF is robust to score distribution differences between retrieval methods.
    Formula: score = sum(1 / (k + rank)) for each method
    """
    scores: dict[int, float] = {}
    data: dict[int, dict] = {}

    # Score vector results
    for rank, result in enumerate(vector_results, 1):
        obs_id = result["id"]
        scores[obs_id] = scores.get(obs_id, 0) + _rrf_score(rank, k)
        data[obs_id] = result

    # Score text results
    for rank, result in enumerate(text_results, 1):
        obs_id = result["id"]
        scores[obs_id] = scores.get(obs_id, 0) + _rrf_score(rank, k)
        if obs_id not in data:
            data[obs_id] = result

    # Sort by combined RRF score
    sorted_ids = sorted(scores.keys(), key=lambda x: scores[x], reverse=True)

    return [
        {**data[obs_id], "rrf_score": scores[obs_id]}
        for obs_id in sorted_ids
    ]


class PostgresObservationSearch:
    """Hybrid search for observations using pgvector + tsvector + RRF."""

    def __init__(self, client: Optional[PostgresClient] = None):
        self.client = client or get_postgres_client()

    async def vector_search(
        self,
        embedding: list[float],
        options: Optional[HybridSearchOptions] = None,
    ) -> list[dict]:
        """Pure vector similarity search."""
        opts = options or HybridSearchOptions()

        # Build WHERE clause
        conditions = []
        params: list = []
        param_idx = 1

        # Embedding parameter
        embedding_str = f"[{','.join(map(str, embedding))}]"
        params.append(embedding_str)
        param_idx += 1

        if opts.project:
            conditions.append(f"project = ${param_idx}")
            params.append(opts.project)
            param_idx += 1

        if opts.since_epoch:
            conditions.append(f"created_at_epoch >= ${param_idx}")
            params.append(opts.since_epoch)
            param_idx += 1

        if opts.types:
            conditions.append(f"type = ANY(${param_idx})")
            params.append([t.value for t in opts.types])
            param_idx += 1

        where_clause = f"WHERE {' AND '.join(conditions)}" if conditions else ""

        # Limit parameter
        params.append(opts.limit)

        query = f"""
            SELECT id, memory_session_id, project, type, title, subtitle,
                   facts, narrative, concepts, files_read, files_modified,
                   prompt_number, discovery_tokens, created_at, created_at_epoch,
                   1 - (embedding <=> $1::vector) as vector_score
            FROM observations
            {where_clause}
            ORDER BY embedding <=> $1::vector
            LIMIT ${param_idx}
        """

        rows = await self.client.fetch(query, *params)
        return [dict(row) for row in rows]

    async def text_search(
        self,
        query_text: str,
        options: Optional[HybridSearchOptions] = None,
    ) -> list[dict]:
        """Full-text search using tsvector."""
        opts = options or HybridSearchOptions()

        conditions = ["to_tsvector('english', coalesce(title,'') || ' ' || coalesce(narrative,'')) @@ plainto_tsquery('english', $1)"]
        params: list = [query_text]
        param_idx = 2

        if opts.project:
            conditions.append(f"project = ${param_idx}")
            params.append(opts.project)
            param_idx += 1

        if opts.since_epoch:
            conditions.append(f"created_at_epoch >= ${param_idx}")
            params.append(opts.since_epoch)
            param_idx += 1

        if opts.types:
            conditions.append(f"type = ANY(${param_idx})")
            params.append([t.value for t in opts.types])
            param_idx += 1

        where_clause = f"WHERE {' AND '.join(conditions)}"
        params.append(opts.limit)

        query = f"""
            SELECT id, memory_session_id, project, type, title, subtitle,
                   facts, narrative, concepts, files_read, files_modified,
                   prompt_number, discovery_tokens, created_at, created_at_epoch,
                   ts_rank(
                       to_tsvector('english', coalesce(title,'') || ' ' || coalesce(narrative,'')),
                       plainto_tsquery('english', $1)
                   ) as text_score
            FROM observations
            {where_clause}
            ORDER BY text_score DESC
            LIMIT ${param_idx}
        """

        rows = await self.client.fetch(query, *params)
        return [dict(row) for row in rows]

    async def hybrid_search(
        self,
        query_text: str,
        embedding: list[float],
        options: Optional[HybridSearchOptions] = None,
    ) -> list[SearchResult]:
        """
        Hybrid search combining vector and text search with RRF.

        This is the primary search method for cold tier retrieval.
        """
        opts = options or HybridSearchOptions()

        # Fetch more results for RRF fusion
        fetch_limit = opts.limit * 3
        search_opts = HybridSearchOptions(
            limit=fetch_limit,
            project=opts.project,
            since_epoch=opts.since_epoch,
            types=opts.types,
        )

        # Run both searches in parallel conceptually (asyncio handles this)
        vector_results = await self.vector_search(embedding, search_opts)
        text_results = await self.text_search(query_text, search_opts)

        # Merge with RRF
        merged = _merge_results_rrf(vector_results, text_results)

        # Filter by minimum score if specified
        if opts.min_score:
            merged = [r for r in merged if r.get("rrf_score", 0) >= opts.min_score]

        # Convert to SearchResult
        results = []
        for i, row in enumerate(merged[:opts.limit]):
            results.append(SearchResult(
                id=row["id"],
                type="observation",
                title=row.get("title") or "",
                content=row.get("narrative") or "",
                score=row.get("rrf_score", 0),
                rank=i + 1,
                source="cold",
                metadata={
                    "project": row.get("project"),
                    "observation_type": row.get("type"),
                    "memory_session_id": row.get("memory_session_id"),
                    "vector_score": row.get("vector_score"),
                    "text_score": row.get("text_score"),
                },
            ))

        return results

    async def search_by_concepts(
        self,
        concepts: list[str],
        options: Optional[HybridSearchOptions] = None,
    ) -> list[SearchResult]:
        """Search observations by concept overlap."""
        opts = options or HybridSearchOptions()

        conditions = ["concepts ?| $1"]
        params: list = [concepts]
        param_idx = 2

        if opts.project:
            conditions.append(f"project = ${param_idx}")
            params.append(opts.project)
            param_idx += 1

        if opts.since_epoch:
            conditions.append(f"created_at_epoch >= ${param_idx}")
            params.append(opts.since_epoch)
            param_idx += 1

        where_clause = f"WHERE {' AND '.join(conditions)}"
        params.append(opts.limit)

        query = f"""
            SELECT id, memory_session_id, project, type, title, subtitle,
                   facts, narrative, concepts, files_read, files_modified,
                   prompt_number, discovery_tokens, created_at, created_at_epoch
            FROM observations
            {where_clause}
            ORDER BY created_at_epoch DESC
            LIMIT ${param_idx}
        """

        rows = await self.client.fetch(query, *params)

        results = []
        for i, row in enumerate(rows):
            results.append(SearchResult(
                id=row["id"],
                type="observation",
                title=row.get("title") or "",
                content=row.get("narrative") or "",
                score=1.0,
                rank=i + 1,
                source="cold",
                metadata={
                    "project": row.get("project"),
                    "observation_type": row.get("type"),
                    "concepts": row.get("concepts"),
                },
            ))

        return results

    async def search_by_files(
        self,
        files: list[str],
        options: Optional[HybridSearchOptions] = None,
    ) -> list[SearchResult]:
        """Search observations by file involvement."""
        opts = options or HybridSearchOptions()

        conditions = ["(files_read ?| $1 OR files_modified ?| $1)"]
        params: list = [files]
        param_idx = 2

        if opts.project:
            conditions.append(f"project = ${param_idx}")
            params.append(opts.project)
            param_idx += 1

        if opts.since_epoch:
            conditions.append(f"created_at_epoch >= ${param_idx}")
            params.append(opts.since_epoch)
            param_idx += 1

        where_clause = f"WHERE {' AND '.join(conditions)}"
        params.append(opts.limit)

        query = f"""
            SELECT id, memory_session_id, project, type, title, subtitle,
                   facts, narrative, concepts, files_read, files_modified,
                   prompt_number, discovery_tokens, created_at, created_at_epoch
            FROM observations
            {where_clause}
            ORDER BY created_at_epoch DESC
            LIMIT ${param_idx}
        """

        rows = await self.client.fetch(query, *params)

        results = []
        for i, row in enumerate(rows):
            results.append(SearchResult(
                id=row["id"],
                type="observation",
                title=row.get("title") or "",
                content=row.get("narrative") or "",
                score=1.0,
                rank=i + 1,
                source="cold",
                metadata={
                    "project": row.get("project"),
                    "files_read": row.get("files_read"),
                    "files_modified": row.get("files_modified"),
                },
            ))

        return results


class PostgresSummarySearch:
    """Hybrid search for session summaries."""

    def __init__(self, client: Optional[PostgresClient] = None):
        self.client = client or get_postgres_client()

    async def vector_search(
        self,
        embedding: list[float],
        options: Optional[HybridSearchOptions] = None,
    ) -> list[dict]:
        """Vector similarity search on summaries."""
        opts = options or HybridSearchOptions()

        conditions = []
        params: list = []
        param_idx = 1

        embedding_str = f"[{','.join(map(str, embedding))}]"
        params.append(embedding_str)
        param_idx += 1

        if opts.project:
            conditions.append(f"project = ${param_idx}")
            params.append(opts.project)
            param_idx += 1

        if opts.since_epoch:
            conditions.append(f"created_at_epoch >= ${param_idx}")
            params.append(opts.since_epoch)
            param_idx += 1

        where_clause = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        params.append(opts.limit)

        query = f"""
            SELECT id, memory_session_id, project, request, investigated,
                   learned, completed, next_steps, notes, files_read, files_edited,
                   prompt_number, discovery_tokens, created_at, created_at_epoch,
                   1 - (embedding <=> $1::vector) as vector_score
            FROM session_summaries
            {where_clause}
            ORDER BY embedding <=> $1::vector
            LIMIT ${param_idx}
        """

        rows = await self.client.fetch(query, *params)
        return [dict(row) for row in rows]

    async def text_search(
        self,
        query_text: str,
        options: Optional[HybridSearchOptions] = None,
    ) -> list[dict]:
        """Full-text search on summaries."""
        opts = options or HybridSearchOptions()

        conditions = [
            """to_tsvector('english',
                coalesce(request,'') || ' ' ||
                coalesce(investigated,'') || ' ' ||
                coalesce(learned,'') || ' ' ||
                coalesce(completed,'')
            ) @@ plainto_tsquery('english', $1)"""
        ]
        params: list = [query_text]
        param_idx = 2

        if opts.project:
            conditions.append(f"project = ${param_idx}")
            params.append(opts.project)
            param_idx += 1

        if opts.since_epoch:
            conditions.append(f"created_at_epoch >= ${param_idx}")
            params.append(opts.since_epoch)
            param_idx += 1

        where_clause = f"WHERE {' AND '.join(conditions)}"
        params.append(opts.limit)

        query = f"""
            SELECT id, memory_session_id, project, request, investigated,
                   learned, completed, next_steps, notes, files_read, files_edited,
                   prompt_number, discovery_tokens, created_at, created_at_epoch,
                   ts_rank(
                       to_tsvector('english',
                           coalesce(request,'') || ' ' ||
                           coalesce(investigated,'') || ' ' ||
                           coalesce(learned,'') || ' ' ||
                           coalesce(completed,'')
                       ),
                       plainto_tsquery('english', $1)
                   ) as text_score
            FROM session_summaries
            {where_clause}
            ORDER BY text_score DESC
            LIMIT ${param_idx}
        """

        rows = await self.client.fetch(query, *params)
        return [dict(row) for row in rows]

    async def hybrid_search(
        self,
        query_text: str,
        embedding: list[float],
        options: Optional[HybridSearchOptions] = None,
    ) -> list[SearchResult]:
        """Hybrid search on session summaries with RRF."""
        opts = options or HybridSearchOptions()

        fetch_limit = opts.limit * 3
        search_opts = HybridSearchOptions(
            limit=fetch_limit,
            project=opts.project,
            since_epoch=opts.since_epoch,
        )

        vector_results = await self.vector_search(embedding, search_opts)
        text_results = await self.text_search(query_text, search_opts)

        merged = _merge_results_rrf(vector_results, text_results)

        if opts.min_score:
            merged = [r for r in merged if r.get("rrf_score", 0) >= opts.min_score]

        results = []
        for i, row in enumerate(merged[:opts.limit]):
            # Combine summary fields for content
            content_parts = []
            if row.get("request"):
                content_parts.append(f"Request: {row['request']}")
            if row.get("learned"):
                content_parts.append(f"Learned: {row['learned']}")
            if row.get("completed"):
                content_parts.append(f"Completed: {row['completed']}")

            results.append(SearchResult(
                id=row["id"],
                type="summary",
                title=row.get("request", "Session Summary")[:100],
                content="\n".join(content_parts),
                score=row.get("rrf_score", 0),
                rank=i + 1,
                source="cold",
                metadata={
                    "project": row.get("project"),
                    "memory_session_id": row.get("memory_session_id"),
                    "files_read": row.get("files_read"),
                    "files_edited": row.get("files_edited"),
                },
            ))

        return results
