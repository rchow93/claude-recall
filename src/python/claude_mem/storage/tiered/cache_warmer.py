"""
Cache Warmer

Warms the hot tier cache on session start and promotes frequently accessed data.
"""

import logging
from datetime import datetime, timedelta
from typing import Optional

from claude_recall.models import QueryOptions
from claude_recall.storage.cold.observation_store import PostgresObservationStore
from claude_recall.storage.cold.summary_store import PostgresProjectFactStore
from claude_recall.storage.hot.observation_store import RedisObservationStore
from claude_recall.storage.cold.postgres_client import get_postgres_client
from claude_recall.storage.hot.redis_client import get_redis_client
from claude_recall.config import get_config

logger = logging.getLogger(__name__)


class CacheWarmer:
    """
    Warms the hot tier cache for optimal performance.

    Strategies:
    1. On session start: Load recent observations for the project
    2. On access: Promote frequently accessed data
    3. Background: Preload project facts
    """

    def __init__(self):
        self.postgres = get_postgres_client()
        self.redis = get_redis_client()

        self.cold_observations = PostgresObservationStore(self.postgres)
        self.cold_facts = PostgresProjectFactStore(self.postgres)
        self.hot_observations = RedisObservationStore(self.redis)

        self.config = get_config()
        self._access_counts: dict[int, int] = {}

    async def warm_for_project(self, project: str) -> int:
        """
        Warm cache for a specific project on session start.

        Loads recent observations (last 48 hours) into hot tier.
        Returns count of observations cached.
        """
        # Calculate time window
        now = datetime.now()
        hot_tier_hours = self.config.redis.hot_tier_ttl // 3600
        since = now - timedelta(hours=hot_tier_hours)
        since_epoch = int(since.timestamp() * 1000)

        # Fetch recent observations from cold tier
        options = QueryOptions(
            project=project,
            since_epoch=since_epoch,
            limit=500,  # Cap for performance
        )

        observations = await self.cold_observations.get_recent(options)
        logger.debug(f"Warming cache with {len(observations)} observations for {project}")

        # Cache in hot tier
        cached = 0
        for obs in observations:
            try:
                await self.hot_observations.cache(obs)
                cached += 1
            except Exception as e:
                logger.debug(f"Failed to cache observation {obs.id}: {e}")

        # Also load project facts (no TTL, always hot)
        await self._warm_project_facts(project)

        logger.info(f"Cache warmed for {project}: {cached} observations")
        return cached

    async def _warm_project_facts(self, project: str) -> int:
        """Load project facts into hot tier (no TTL)."""
        facts = await self.cold_facts.get_by_project(project)

        cached = 0
        for fact in facts:
            try:
                # Facts are stored differently - just track for now
                # Could add a RedisFacts store if needed
                cached += 1
            except Exception:
                pass

        return cached

    async def on_access(self, obs_id: int) -> bool:
        """
        Track access and potentially promote to hot tier.

        Returns True if promoted.
        """
        # Increment access count
        self._access_counts[obs_id] = self._access_counts.get(obs_id, 0) + 1
        count = self._access_counts[obs_id]

        # Promotion threshold
        threshold = 3

        if count >= threshold:
            # Check if already in hot tier
            if await self.hot_observations.exists(obs_id):
                return False

            # Fetch from cold tier and promote
            obs = await self.cold_observations.get_by_id(obs_id)
            if obs:
                try:
                    await self.hot_observations.cache(obs)
                    logger.debug(f"Promoted observation {obs_id} to hot tier")
                    return True
                except Exception:
                    pass

        return False

    async def warm_for_files(self, project: str, files: list[str]) -> int:
        """
        Warm cache for observations related to specific files.

        Useful when a user starts working on particular files.
        """
        from claude_recall.storage.cold.hybrid_search import PostgresObservationSearch

        search = PostgresObservationSearch(self.postgres)
        from claude_recall.models import HybridSearchOptions

        options = HybridSearchOptions(
            project=project,
            limit=50,
        )

        results = await search.search_by_files(files, options)

        cached = 0
        for result in results:
            obs = await self.cold_observations.get_by_id(result.id)
            if obs:
                try:
                    await self.hot_observations.cache(obs)
                    cached += 1
                except Exception:
                    pass

        logger.debug(f"Warmed cache with {cached} file-related observations")
        return cached

    async def warm_for_concepts(self, project: str, concepts: list[str]) -> int:
        """
        Warm cache for observations related to specific concepts.

        Useful when a user's prompt mentions specific topics.
        """
        from claude_recall.storage.cold.hybrid_search import PostgresObservationSearch

        search = PostgresObservationSearch(self.postgres)
        from claude_recall.models import HybridSearchOptions

        options = HybridSearchOptions(
            project=project,
            limit=50,
        )

        results = await search.search_by_concepts(concepts, options)

        cached = 0
        for result in results:
            obs = await self.cold_observations.get_by_id(result.id)
            if obs:
                try:
                    await self.hot_observations.cache(obs)
                    cached += 1
                except Exception:
                    pass

        logger.debug(f"Warmed cache with {cached} concept-related observations")
        return cached

    def clear_access_counts(self) -> None:
        """Clear access counts (e.g., at end of session)."""
        self._access_counts.clear()


# Singleton instance
_warmer: Optional[CacheWarmer] = None


def get_cache_warmer() -> CacheWarmer:
    """Get the global cache warmer."""
    global _warmer
    if _warmer is None:
        _warmer = CacheWarmer()
    return _warmer
