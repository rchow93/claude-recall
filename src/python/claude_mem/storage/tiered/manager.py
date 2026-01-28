"""
Tiered Storage Manager

Coordinates hot (Redis) and cold (PostgreSQL) storage tiers.
Implements write-through caching and hot-first reads.
"""

import logging
from typing import Optional

from claude_recall.models import (
    StoredObservation,
    ObservationInput,
    StoredSessionSummary,
    SessionSummaryInput,
    QueryOptions,
)
from claude_recall.storage.cold.postgres_client import PostgresClient, get_postgres_client
from claude_recall.storage.cold.observation_store import PostgresObservationStore
from claude_recall.storage.cold.summary_store import PostgresSummaryStore
from claude_recall.storage.hot.redis_client import RedisClient, get_redis_client
from claude_recall.storage.hot.observation_store import RedisObservationStore
from claude_recall.config import get_config

logger = logging.getLogger(__name__)


class TieredStorageManager:
    """
    Manages tiered storage with write-through caching.

    Write path: Write to cold tier (source of truth), then cache in hot tier
    Read path: Check hot tier first, fall back to cold tier
    """

    def __init__(
        self,
        postgres: Optional[PostgresClient] = None,
        redis: Optional[RedisClient] = None,
    ):
        self.postgres = postgres or get_postgres_client()
        self.redis = redis or get_redis_client()

        # Cold tier stores
        self.cold_observations = PostgresObservationStore(self.postgres)
        self.cold_summaries = PostgresSummaryStore(self.postgres)

        # Hot tier stores
        self.hot_observations = RedisObservationStore(self.redis)

        self.config = get_config()
        self._initialized = False

    async def initialize(self) -> None:
        """Initialize both storage tiers."""
        if self._initialized:
            return

        # Initialize cold tier (always required)
        await self.postgres.initialize()

        # Initialize hot tier (optional, degrades gracefully)
        try:
            await self.redis.initialize()
            self._hot_available = True
        except Exception as e:
            logger.warning(f"Hot tier unavailable, running in cold-only mode: {e}")
            self._hot_available = False

        self._initialized = True
        logger.info(f"Tiered storage initialized (hot tier: {self._hot_available})")

    async def store_observation(
        self,
        observation: ObservationInput,
    ) -> StoredObservation:
        """
        Store an observation using write-through caching.

        1. Write to cold tier (PostgreSQL) - source of truth
        2. Cache in hot tier (Redis) with TTL
        """
        # Write to cold tier first
        stored = await self.cold_observations.store(observation)

        # Cache in hot tier if available
        if self._hot_available:
            try:
                await self.hot_observations.cache(stored)
            except Exception as e:
                logger.warning(f"Failed to cache observation in hot tier: {e}")

        return stored

    async def store_observations_batch(
        self,
        observations: list[ObservationInput],
    ) -> list[StoredObservation]:
        """Store multiple observations."""
        results = []
        for obs in observations:
            stored = await self.store_observation(obs)
            results.append(stored)
        return results

    async def get_observation(self, obs_id: int) -> Optional[StoredObservation]:
        """
        Get an observation with hot-first lookup.

        1. Check hot tier (Redis) - fast path
        2. Fall back to cold tier (PostgreSQL)
        3. Optionally promote to hot tier on access
        """
        # Try hot tier first
        if self._hot_available:
            try:
                obs = await self.hot_observations.get_by_id(obs_id)
                if obs:
                    return obs
            except Exception as e:
                logger.debug(f"Hot tier lookup failed: {e}")

        # Fall back to cold tier
        obs = await self.cold_observations.get_by_id(obs_id)

        # Promote to hot tier on access (if enabled)
        if obs and self._hot_available:
            try:
                await self.hot_observations.cache(obs)
            except Exception:
                pass  # Silent fail for cache promotion

        return obs

    async def get_observations(self, ids: list[int]) -> list[StoredObservation]:
        """Get multiple observations."""
        results = []
        for obs_id in ids:
            obs = await self.get_observation(obs_id)
            if obs:
                results.append(obs)
        return results

    async def get_recent_observations(
        self,
        options: Optional[QueryOptions] = None,
    ) -> list[StoredObservation]:
        """
        Get recent observations.

        For recency queries, always go to cold tier to ensure consistency.
        """
        return await self.cold_observations.get_recent(options)

    async def store_summary(
        self,
        summary: SessionSummaryInput,
    ) -> StoredSessionSummary:
        """Store a session summary."""
        return await self.cold_summaries.store(summary)

    async def get_summary(self, summary_id: int) -> Optional[StoredSessionSummary]:
        """Get a session summary by ID."""
        return await self.cold_summaries.get_by_id(summary_id)

    async def get_summary_by_session(
        self,
        memory_session_id: str,
    ) -> Optional[StoredSessionSummary]:
        """Get the summary for a session."""
        return await self.cold_summaries.get_by_session(memory_session_id)

    async def delete_observation(self, obs_id: int) -> bool:
        """Delete an observation from both tiers."""
        # Delete from hot tier
        if self._hot_available:
            try:
                await self.hot_observations.delete(obs_id)
            except Exception:
                pass

        # Delete from cold tier
        return await self.cold_observations.delete(obs_id)

    async def is_hot_tier_available(self) -> bool:
        """Check if hot tier is available."""
        if not self._hot_available:
            return False
        return await self.redis.is_available()

    async def close(self) -> None:
        """Close all connections."""
        await self.postgres.close()
        if self._hot_available:
            await self.redis.close()
        self._initialized = False


# Singleton instance
_manager: Optional[TieredStorageManager] = None


def get_tiered_storage() -> TieredStorageManager:
    """Get the global tiered storage manager."""
    global _manager
    if _manager is None:
        _manager = TieredStorageManager()
    return _manager


async def initialize_tiered_storage() -> TieredStorageManager:
    """Initialize and return the tiered storage manager."""
    manager = get_tiered_storage()
    await manager.initialize()
    return manager


async def close_tiered_storage() -> None:
    """Close the tiered storage manager."""
    global _manager
    if _manager:
        await _manager.close()
        _manager = None
