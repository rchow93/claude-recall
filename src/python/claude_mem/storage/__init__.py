"""
Tiered Storage System

Provides hot (Redis) and cold (PostgreSQL) storage tiers with automatic
tiering, caching, and search capabilities.
"""

from claude_recall.storage.cold import (
    PostgresClient,
    get_postgres_client,
    initialize_postgres,
    close_postgres,
    PostgresObservationStore,
    PostgresSummaryStore,
    PostgresWeeklySummaryStore,
    PostgresProjectFactStore,
    PostgresObservationSearch,
    PostgresSummarySearch,
)
from claude_recall.storage.hot import (
    RedisClient,
    get_redis_client,
    initialize_redis,
    close_redis,
    RedisObservationStore,
    RedisObservationSearch,
)
from claude_recall.storage.tiered import (
    TieredStorageManager,
    get_tiered_storage,
    QueryRouter,
    get_query_router,
    CacheWarmer,
    get_cache_warmer,
)

__all__ = [
    # Cold tier
    "PostgresClient",
    "get_postgres_client",
    "initialize_postgres",
    "close_postgres",
    "PostgresObservationStore",
    "PostgresSummaryStore",
    "PostgresWeeklySummaryStore",
    "PostgresProjectFactStore",
    "PostgresObservationSearch",
    "PostgresSummarySearch",
    # Hot tier
    "RedisClient",
    "get_redis_client",
    "initialize_redis",
    "close_redis",
    "RedisObservationStore",
    "RedisObservationSearch",
    # Tiered
    "TieredStorageManager",
    "get_tiered_storage",
    "QueryRouter",
    "get_query_router",
    "CacheWarmer",
    "get_cache_warmer",
]
