"""
Redis Client for Hot Tier Storage

Handles connection management, index creation, and TTL-based expiration.
"""

import logging
from typing import Optional, Any

import redis.asyncio as redis
from redis.commands.search.field import VectorField, TextField, NumericField, TagField
from redis.commands.search.indexDefinition import IndexDefinition, IndexType

from claude_recall.config import get_config, RedisConfig

logger = logging.getLogger(__name__)


class RedisClient:
    """Redis connection manager with RediSearch support."""

    def __init__(self, config: Optional[RedisConfig] = None):
        self.config = config or get_config().redis
        self.client: Optional[redis.Redis] = None
        self._initialized = False

    async def connect(self) -> None:
        """Create Redis connection."""
        if self.client is not None:
            return

        self.client = redis.Redis(
            host=self.config.host,
            port=self.config.port,
            db=self.config.db,
            password=self.config.password if self.config.password else None,
            decode_responses=False,  # We handle encoding ourselves for vectors
        )

        # Test connection
        await self.client.ping()
        logger.info(f"Redis connected at {self.config.host}:{self.config.port}")

    async def initialize(self) -> None:
        """Initialize RediSearch indexes."""
        if self._initialized:
            return

        await self.connect()
        assert self.client is not None

        # Create observation index
        try:
            await self._create_observation_index()
        except redis.ResponseError as e:
            if "Index already exists" in str(e):
                logger.debug("Observation index already exists")
            else:
                raise

        # Create summary index
        try:
            await self._create_summary_index()
        except redis.ResponseError as e:
            if "Index already exists" in str(e):
                logger.debug("Summary index already exists")
            else:
                raise

        self._initialized = True
        logger.info("Redis indexes initialized")

    async def _create_observation_index(self) -> None:
        """Create RediSearch index for observations."""
        assert self.client is not None

        schema = (
            VectorField(
                "embedding",
                "HNSW",
                {
                    "TYPE": "FLOAT32",
                    "DIM": 768,
                    "DISTANCE_METRIC": "COSINE",
                },
            ),
            TextField("title"),
            TextField("narrative"),
            TagField("project"),
            TagField("type"),
            NumericField("created_at_epoch", sortable=True),
            NumericField("prompt_number"),
        )

        definition = IndexDefinition(
            prefix=["observation:"],
            index_type=IndexType.HASH,
        )

        await self.client.ft("idx:observations").create_index(
            schema,
            definition=definition,
        )
        logger.info("Created RediSearch observation index")

    async def _create_summary_index(self) -> None:
        """Create RediSearch index for summaries."""
        assert self.client is not None

        schema = (
            VectorField(
                "embedding",
                "HNSW",
                {
                    "TYPE": "FLOAT32",
                    "DIM": 768,
                    "DISTANCE_METRIC": "COSINE",
                },
            ),
            TextField("request"),
            TextField("learned"),
            TextField("completed"),
            TagField("project"),
            NumericField("created_at_epoch", sortable=True),
        )

        definition = IndexDefinition(
            prefix=["summary:session:"],
            index_type=IndexType.HASH,
        )

        await self.client.ft("idx:summaries").create_index(
            schema,
            definition=definition,
        )
        logger.info("Created RediSearch summary index")

    async def hset(self, key: str, mapping: dict[str, Any], ttl: Optional[int] = None) -> None:
        """Set hash fields with optional TTL."""
        assert self.client is not None

        # Convert values to bytes/strings as needed
        processed = {}
        for k, v in mapping.items():
            if isinstance(v, (list, tuple)) and k == "embedding":
                # Pack embedding as binary float32
                import struct
                processed[k] = struct.pack(f"{len(v)}f", *v)
            elif isinstance(v, (dict, list)):
                import json
                processed[k] = json.dumps(v)
            elif v is None:
                processed[k] = ""
            else:
                processed[k] = str(v)

        await self.client.hset(key, mapping=processed)

        if ttl is not None:
            await self.client.expire(key, ttl)

    async def hgetall(self, key: str) -> Optional[dict[str, Any]]:
        """Get all hash fields."""
        assert self.client is not None

        data = await self.client.hgetall(key)
        if not data:
            return None

        # Decode bytes to strings
        result = {}
        for k, v in data.items():
            key_str = k.decode() if isinstance(k, bytes) else k
            if key_str == "embedding":
                # Unpack binary float32
                import struct
                float_count = len(v) // 4
                result[key_str] = list(struct.unpack(f"{float_count}f", v))
            elif isinstance(v, bytes):
                result[key_str] = v.decode()
            else:
                result[key_str] = v

        return result

    async def delete(self, *keys: str) -> int:
        """Delete keys."""
        assert self.client is not None
        return await self.client.delete(*keys)

    async def exists(self, key: str) -> bool:
        """Check if key exists."""
        assert self.client is not None
        return await self.client.exists(key) > 0

    async def zadd(self, key: str, mapping: dict[str, float]) -> int:
        """Add to sorted set."""
        assert self.client is not None
        return await self.client.zadd(key, mapping)

    async def zrangebyscore(
        self,
        key: str,
        min_score: float,
        max_score: float,
        start: int = 0,
        num: int = 100,
    ) -> list[str]:
        """Get range from sorted set by score."""
        assert self.client is not None
        result = await self.client.zrangebyscore(
            key, min_score, max_score, start=start, num=num
        )
        return [r.decode() if isinstance(r, bytes) else r for r in result]

    async def zrevrange(
        self,
        key: str,
        start: int = 0,
        end: int = -1,
    ) -> list[str]:
        """Get range from sorted set in reverse order."""
        assert self.client is not None
        result = await self.client.zrevrange(key, start, end)
        return [r.decode() if isinstance(r, bytes) else r for r in result]

    async def zrem(self, key: str, *members: str) -> int:
        """Remove from sorted set."""
        assert self.client is not None
        return await self.client.zrem(key, *members)

    async def scan_iter(self, match: str) -> list[str]:
        """Scan keys matching pattern."""
        assert self.client is not None
        keys = []
        async for key in self.client.scan_iter(match=match):
            keys.append(key.decode() if isinstance(key, bytes) else key)
        return keys

    async def is_available(self) -> bool:
        """Check if Redis is available."""
        try:
            await self.connect()
            assert self.client is not None
            await self.client.ping()
            return True
        except Exception as e:
            logger.warning(f"Redis not available: {e}")
            return False

    async def close(self) -> None:
        """Close the connection."""
        if self.client:
            await self.client.aclose()
            self.client = None
            self._initialized = False
            logger.info("Redis connection closed")


# Singleton instance
_client: Optional[RedisClient] = None


def get_redis_client() -> RedisClient:
    """Get the global Redis client."""
    global _client
    if _client is None:
        _client = RedisClient()
    return _client


async def initialize_redis() -> RedisClient:
    """Initialize and return the Redis client."""
    client = get_redis_client()
    await client.initialize()
    return client


async def close_redis() -> None:
    """Close the Redis client."""
    global _client
    if _client:
        await _client.close()
        _client = None
