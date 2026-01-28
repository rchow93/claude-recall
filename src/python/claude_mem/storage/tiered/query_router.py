"""
Query Router

Routes search queries to appropriate storage tier based on query characteristics.
Implements hot-first search with cold tier fallback.
"""

import logging
from typing import Optional

from claude_recall.models import (
    SearchResult,
    RAGQueryResult,
    HybridSearchOptions,
)
from claude_recall.storage.cold.hybrid_search import (
    PostgresObservationSearch,
    PostgresSummarySearch,
)
from claude_recall.storage.hot.vector_search import (
    RedisObservationSearch,
    RedisSummarySearch,
)
from claude_recall.storage.cold.postgres_client import get_postgres_client
from claude_recall.storage.hot.redis_client import get_redis_client
from claude_recall.config import get_config

logger = logging.getLogger(__name__)


class QueryRouter:
    """
    Routes queries to the appropriate storage tier.

    Strategy:
    1. Try hot tier first (Redis) - ~1-5ms
    2. If insufficient results, query cold tier (PostgreSQL) - ~100-200ms
    3. Merge and deduplicate results
    """

    def __init__(self):
        postgres = get_postgres_client()
        redis = get_redis_client()

        # Search engines
        self.cold_observations = PostgresObservationSearch(postgres)
        self.cold_summaries = PostgresSummarySearch(postgres)
        self.hot_observations = RedisObservationSearch(redis)
        self.hot_summaries = RedisSummarySearch(redis)

        self.config = get_config()
        self._hot_available = True

    async def check_hot_tier(self) -> bool:
        """Check if hot tier is available."""
        try:
            redis = get_redis_client()
            self._hot_available = await redis.is_available()
        except Exception:
            self._hot_available = False
        return self._hot_available

    async def query(
        self,
        query_text: str,
        embedding: list[float],
        options: Optional[HybridSearchOptions] = None,
    ) -> RAGQueryResult:
        """
        Execute a tiered query for RAG context retrieval.

        Returns both observations and summaries relevant to the query.
        """
        opts = options or HybridSearchOptions()
        all_results: list[SearchResult] = []
        sources_used: list[str] = []
        hot_hits = 0
        cold_hits = 0

        # Hot tier search (if available)
        if self._hot_available:
            try:
                hot_results = await self.hot_observations.vector_search(embedding, opts)
                hot_hits = len(hot_results)
                all_results.extend(hot_results)
                if hot_hits > 0:
                    sources_used.append("hot")
                logger.debug(f"Hot tier returned {hot_hits} results")
            except Exception as e:
                logger.warning(f"Hot tier search failed: {e}")
                self._hot_available = False

        # Cold tier search (always, for completeness)
        min_hot_results = self.config.search.min_hot_results
        if not self._hot_available or hot_hits < min_hot_results:
            try:
                cold_opts = HybridSearchOptions(
                    limit=opts.limit,
                    project=opts.project,
                    since_epoch=opts.since_epoch,
                    types=opts.types,
                    min_score=opts.min_score,
                )
                cold_results = await self.cold_observations.hybrid_search(
                    query_text, embedding, cold_opts
                )
                cold_hits = len(cold_results)
                all_results.extend(cold_results)
                if cold_hits > 0:
                    sources_used.append("cold")
                logger.debug(f"Cold tier returned {cold_hits} results")
            except Exception as e:
                logger.error(f"Cold tier search failed: {e}")

        # Also search summaries for broader context
        summary_results = await self._search_summaries(query_text, embedding, opts)
        all_results.extend(summary_results)

        # Deduplicate and rank
        deduplicated = self._deduplicate_results(all_results)
        ranked = sorted(deduplicated, key=lambda x: x.score, reverse=True)

        # Apply final limit
        final_results = ranked[:opts.limit]

        # Update ranks
        for i, result in enumerate(final_results):
            result.rank = i + 1

        return RAGQueryResult(
            query=query_text,
            results=final_results,
            total_results=len(deduplicated),
            hot_tier_hits=hot_hits,
            cold_tier_hits=cold_hits,
            sources_used=sources_used,
        )

    async def _search_summaries(
        self,
        query_text: str,
        embedding: list[float],
        options: HybridSearchOptions,
    ) -> list[SearchResult]:
        """Search session summaries for context."""
        results: list[SearchResult] = []

        # Limit summary results to not overwhelm observations
        summary_limit = max(3, options.limit // 3)
        summary_opts = HybridSearchOptions(
            limit=summary_limit,
            project=options.project,
            since_epoch=options.since_epoch,
        )

        # Hot tier summaries
        if self._hot_available:
            try:
                hot_summaries = await self.hot_summaries.vector_search(
                    embedding, summary_opts
                )
                results.extend(hot_summaries)
            except Exception:
                pass

        # Cold tier summaries (hybrid search)
        try:
            cold_summaries = await self.cold_summaries.hybrid_search(
                query_text, embedding, summary_opts
            )
            results.extend(cold_summaries)
        except Exception as e:
            logger.warning(f"Summary search failed: {e}")

        return results

    def _deduplicate_results(
        self,
        results: list[SearchResult],
    ) -> list[SearchResult]:
        """Deduplicate results by ID and type, keeping highest score."""
        seen: dict[tuple[int, str], SearchResult] = {}

        for result in results:
            key = (result.id, result.type)
            if key not in seen or result.score > seen[key].score:
                seen[key] = result

        return list(seen.values())

    async def search_by_concepts(
        self,
        concepts: list[str],
        options: Optional[HybridSearchOptions] = None,
    ) -> list[SearchResult]:
        """Search by concept overlap (cold tier only)."""
        return await self.cold_observations.search_by_concepts(concepts, options)

    async def search_by_files(
        self,
        files: list[str],
        options: Optional[HybridSearchOptions] = None,
    ) -> list[SearchResult]:
        """Search by file involvement (cold tier only)."""
        return await self.cold_observations.search_by_files(files, options)


# Singleton instance
_router: Optional[QueryRouter] = None


def get_query_router() -> QueryRouter:
    """Get the global query router."""
    global _router
    if _router is None:
        _router = QueryRouter()
    return _router
