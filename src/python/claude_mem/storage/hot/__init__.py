"""Hot tier storage (Redis with RediSearch)."""

from claude_recall.storage.hot.redis_client import (
    RedisClient,
    get_redis_client,
    initialize_redis,
    close_redis,
)
from claude_recall.storage.hot.observation_store import RedisObservationStore
from claude_recall.storage.hot.vector_search import RedisObservationSearch

__all__ = [
    "RedisClient",
    "get_redis_client",
    "initialize_redis",
    "close_redis",
    "RedisObservationStore",
    "RedisObservationSearch",
]
