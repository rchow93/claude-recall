"""
Redis Vector Search

Fast vector similarity search using RediSearch.
"""

import struct
import logging
from typing import Optional

from redis.commands.search.query import Query

from claude_recall.models import (
    SearchResult,
    HybridSearchOptions,
)
from claude_recall.storage.hot.redis_client import RedisClient, get_redis_client

logger = logging.getLogger(__name__)


class RedisObservationSearch:
    """Vector search for observations using RediSearch."""

    def __init__(self, client: Optional[RedisClient] = None):
        self.client = client or get_redis_client()

    async def vector_search(
        self,
        embedding: list[float],
        options: Optional[HybridSearchOptions] = None,
    ) -> list[SearchResult]:
        """
        Search observations by vector similarity.

        Uses RediSearch KNN query for fast approximate nearest neighbor search.
        """
        opts = options or HybridSearchOptions()

        # Build filter expression
        filters = []
        if opts.project:
            filters.append(f"@project:{{{opts.project}}}")
        if opts.types:
            type_filter = "|".join(t.value for t in opts.types)
            filters.append(f"@type:{{{type_filter}}}")
        if opts.since_epoch:
            filters.append(f"@created_at_epoch:[{opts.since_epoch} +inf]")

        filter_expr = " ".join(filters) if filters else "*"

        # Pack embedding as binary
        embedding_bytes = struct.pack(f"{len(embedding)}f", *embedding)

        # Build KNN query
        # RediSearch vector query format: *=>[KNN K @field $param]
        query_str = f"({filter_expr})=>[KNN {opts.limit} @embedding $embedding AS score]"

        query = (
            Query(query_str)
            .return_fields("title", "narrative", "project", "type", "memory_session_id", "created_at_epoch", "score")
            .sort_by("score")
            .dialect(2)
        )

        assert self.client.client is not None
        try:
            result = await self.client.client.ft("idx:observations").search(
                query,
                query_params={"embedding": embedding_bytes},
            )
        except Exception as e:
            logger.warning(f"Redis vector search failed: {e}")
            return []

        # Convert results
        results = []
        for i, doc in enumerate(result.docs):
            obs_id = int(doc.id.split(":")[1]) if ":" in doc.id else int(doc.id)

            # RediSearch returns distance, convert to similarity
            distance = float(getattr(doc, "score", 0))
            similarity = 1 - distance  # Cosine distance to similarity

            if opts.min_score and similarity < opts.min_score:
                continue

            results.append(SearchResult(
                id=obs_id,
                type="observation",
                title=getattr(doc, "title", "") or "",
                content=getattr(doc, "narrative", "") or "",
                score=similarity,
                rank=i + 1,
                source="hot",
                metadata={
                    "project": getattr(doc, "project", None),
                    "observation_type": getattr(doc, "type", None),
                    "memory_session_id": getattr(doc, "memory_session_id", None),
                },
            ))

        return results

    async def text_search(
        self,
        query_text: str,
        options: Optional[HybridSearchOptions] = None,
    ) -> list[SearchResult]:
        """
        Full-text search on observations.

        Uses RediSearch text indexing for fast keyword search.
        """
        opts = options or HybridSearchOptions()

        # Build query with filters
        filters = []
        if opts.project:
            filters.append(f"@project:{{{opts.project}}}")
        if opts.types:
            type_filter = "|".join(t.value for t in opts.types)
            filters.append(f"@type:{{{type_filter}}}")
        if opts.since_epoch:
            filters.append(f"@created_at_epoch:[{opts.since_epoch} +inf]")

        # Escape special characters in query text
        escaped_query = query_text.replace("-", "\\-").replace(":", "\\:")

        # Combine text query with filters
        if filters:
            query_str = f"({escaped_query}) {' '.join(filters)}"
        else:
            query_str = escaped_query

        query = (
            Query(query_str)
            .return_fields("title", "narrative", "project", "type", "memory_session_id", "created_at_epoch")
            .paging(0, opts.limit)
        )

        assert self.client.client is not None
        try:
            result = await self.client.client.ft("idx:observations").search(query)
        except Exception as e:
            logger.warning(f"Redis text search failed: {e}")
            return []

        # Convert results
        results = []
        for i, doc in enumerate(result.docs):
            obs_id = int(doc.id.split(":")[1]) if ":" in doc.id else int(doc.id)

            results.append(SearchResult(
                id=obs_id,
                type="observation",
                title=getattr(doc, "title", "") or "",
                content=getattr(doc, "narrative", "") or "",
                score=1.0,  # RediSearch doesn't provide scores for text search
                rank=i + 1,
                source="hot",
                metadata={
                    "project": getattr(doc, "project", None),
                    "observation_type": getattr(doc, "type", None),
                    "memory_session_id": getattr(doc, "memory_session_id", None),
                },
            ))

        return results

    async def search(
        self,
        query_text: str,
        embedding: list[float],
        options: Optional[HybridSearchOptions] = None,
    ) -> list[SearchResult]:
        """
        Combined search using vector similarity.

        For hot tier, we primarily use vector search since it's fast enough.
        Text search is available as a fallback.
        """
        # Primary: vector search
        results = await self.vector_search(embedding, options)

        if not results:
            # Fallback: text search
            results = await self.text_search(query_text, options)

        return results


class RedisSummarySearch:
    """Vector search for session summaries using RediSearch."""

    def __init__(self, client: Optional[RedisClient] = None):
        self.client = client or get_redis_client()

    async def vector_search(
        self,
        embedding: list[float],
        options: Optional[HybridSearchOptions] = None,
    ) -> list[SearchResult]:
        """Search summaries by vector similarity."""
        opts = options or HybridSearchOptions()

        filters = []
        if opts.project:
            filters.append(f"@project:{{{opts.project}}}")
        if opts.since_epoch:
            filters.append(f"@created_at_epoch:[{opts.since_epoch} +inf]")

        filter_expr = " ".join(filters) if filters else "*"
        embedding_bytes = struct.pack(f"{len(embedding)}f", *embedding)

        query_str = f"({filter_expr})=>[KNN {opts.limit} @embedding $embedding AS score]"

        query = (
            Query(query_str)
            .return_fields("request", "learned", "completed", "project", "memory_session_id", "score")
            .sort_by("score")
            .dialect(2)
        )

        assert self.client.client is not None
        try:
            result = await self.client.client.ft("idx:summaries").search(
                query,
                query_params={"embedding": embedding_bytes},
            )
        except Exception as e:
            logger.warning(f"Redis summary search failed: {e}")
            return []

        results = []
        for i, doc in enumerate(result.docs):
            summary_id = doc.id.split(":")[-1] if ":" in doc.id else doc.id

            distance = float(getattr(doc, "score", 0))
            similarity = 1 - distance

            if opts.min_score and similarity < opts.min_score:
                continue

            # Build content from summary fields
            content_parts = []
            if getattr(doc, "request", None):
                content_parts.append(f"Request: {doc.request}")
            if getattr(doc, "learned", None):
                content_parts.append(f"Learned: {doc.learned}")
            if getattr(doc, "completed", None):
                content_parts.append(f"Completed: {doc.completed}")

            results.append(SearchResult(
                id=int(summary_id) if summary_id.isdigit() else 0,
                type="summary",
                title=getattr(doc, "request", "Session Summary")[:100] if getattr(doc, "request", None) else "Session Summary",
                content="\n".join(content_parts),
                score=similarity,
                rank=i + 1,
                source="hot",
                metadata={
                    "project": getattr(doc, "project", None),
                    "memory_session_id": getattr(doc, "memory_session_id", None),
                },
            ))

        return results
