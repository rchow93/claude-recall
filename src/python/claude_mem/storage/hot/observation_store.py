"""
Redis Observation Store

Hot tier storage for recent observations with TTL-based expiration.
"""

import json
import logging
from datetime import datetime
from typing import Optional

from claude_recall.models import (
    StoredObservation,
    ObservationInput,
    ObservationType,
    QueryOptions,
)
from claude_recall.storage.hot.redis_client import RedisClient, get_redis_client
from claude_recall.config import get_config

logger = logging.getLogger(__name__)


def _hash_to_observation(obs_id: int, data: dict) -> StoredObservation:
    """Convert Redis hash data to StoredObservation."""
    return StoredObservation(
        id=obs_id,
        memory_session_id=data.get("memory_session_id", ""),
        project=data.get("project", ""),
        type=ObservationType(data.get("type", "discovery")),
        title=data.get("title"),
        subtitle=data.get("subtitle"),
        facts=json.loads(data.get("facts", "[]")) if data.get("facts") else None,
        narrative=data.get("narrative"),
        concepts=json.loads(data.get("concepts", "[]")) if data.get("concepts") else None,
        files_read=json.loads(data.get("files_read", "[]")) if data.get("files_read") else None,
        files_modified=json.loads(data.get("files_modified", "[]")) if data.get("files_modified") else None,
        prompt_number=int(data.get("prompt_number", 0)) if data.get("prompt_number") else None,
        discovery_tokens=int(data.get("discovery_tokens", 0)) if data.get("discovery_tokens") else 0,
        embedding=data.get("embedding"),
        created_at=datetime.fromisoformat(data["created_at"]) if data.get("created_at") else datetime.now(),
        created_at_epoch=int(data.get("created_at_epoch", 0)),
    )


class RedisObservationStore:
    """Hot tier observation store using Redis."""

    def __init__(self, client: Optional[RedisClient] = None):
        self.client = client or get_redis_client()
        self.config = get_config()

    def _key(self, obs_id: int) -> str:
        """Generate Redis key for observation."""
        return f"observation:{obs_id}"

    def _timeline_key(self, project: str) -> str:
        """Generate Redis key for project timeline."""
        return f"project:{project}:timeline"

    async def cache(
        self,
        observation: StoredObservation,
        ttl: Optional[int] = None,
    ) -> None:
        """Cache an observation in the hot tier."""
        if ttl is None:
            ttl = self.config.redis.hot_tier_ttl

        mapping = {
            "memory_session_id": observation.memory_session_id,
            "project": observation.project,
            "type": observation.type.value,
            "title": observation.title or "",
            "subtitle": observation.subtitle or "",
            "facts": observation.facts or [],
            "narrative": observation.narrative or "",
            "concepts": observation.concepts or [],
            "files_read": observation.files_read or [],
            "files_modified": observation.files_modified or [],
            "prompt_number": observation.prompt_number or 0,
            "discovery_tokens": observation.discovery_tokens,
            "created_at": observation.created_at.isoformat() if observation.created_at else "",
            "created_at_epoch": observation.created_at_epoch,
        }

        if observation.embedding:
            mapping["embedding"] = observation.embedding

        await self.client.hset(self._key(observation.id), mapping, ttl=ttl)

        # Add to project timeline
        await self.client.zadd(
            self._timeline_key(observation.project),
            {str(observation.id): float(observation.created_at_epoch)},
        )

    async def cache_batch(
        self,
        observations: list[StoredObservation],
        ttl: Optional[int] = None,
    ) -> None:
        """Cache multiple observations."""
        for obs in observations:
            await self.cache(obs, ttl)

    async def get_by_id(self, obs_id: int) -> Optional[StoredObservation]:
        """Get an observation from cache."""
        data = await self.client.hgetall(self._key(obs_id))
        if not data:
            return None
        return _hash_to_observation(obs_id, data)

    async def get_by_ids(self, ids: list[int]) -> list[StoredObservation]:
        """Get multiple observations from cache."""
        results = []
        for obs_id in ids:
            obs = await self.get_by_id(obs_id)
            if obs:
                results.append(obs)
        return results

    async def get_recent(
        self,
        options: Optional[QueryOptions] = None,
    ) -> list[StoredObservation]:
        """Get recent observations from hot tier."""
        opts = options or QueryOptions()

        if not opts.project:
            # Without project, scan all observation keys
            keys = await self.client.scan_iter("observation:*")
            results = []
            for key in keys[:opts.limit + opts.offset]:
                obs_id = int(key.split(":")[1])
                obs = await self.get_by_id(obs_id)
                if obs:
                    results.append(obs)

            # Sort by created_at_epoch
            results.sort(
                key=lambda x: x.created_at_epoch,
                reverse=(opts.order != "asc"),
            )
            return results[opts.offset : opts.offset + opts.limit]

        # With project, use timeline sorted set
        timeline_key = self._timeline_key(opts.project)

        # Get IDs from timeline
        if opts.order == "asc":
            if opts.since_epoch and opts.until_epoch:
                ids = await self.client.zrangebyscore(
                    timeline_key,
                    opts.since_epoch,
                    opts.until_epoch,
                    start=opts.offset,
                    num=opts.limit,
                )
            else:
                ids = await self.client.zrangebyscore(
                    timeline_key,
                    opts.since_epoch or 0,
                    opts.until_epoch or float("inf"),
                    start=opts.offset,
                    num=opts.limit,
                )
        else:
            # Descending order
            all_ids = await self.client.zrevrange(
                timeline_key,
                start=opts.offset,
                end=opts.offset + opts.limit - 1,
            )
            ids = all_ids

        # Fetch observations
        results = []
        for id_str in ids:
            obs = await self.get_by_id(int(id_str))
            if obs:
                # Filter by type if specified
                if opts.types and obs.type not in opts.types:
                    continue
                results.append(obs)

        return results

    async def delete(self, obs_id: int) -> bool:
        """Delete an observation from cache."""
        # Get observation first to remove from timeline
        obs = await self.get_by_id(obs_id)
        if obs:
            await self.client.zrem(
                self._timeline_key(obs.project),
                str(obs_id),
            )

        return await self.client.delete(self._key(obs_id)) > 0

    async def exists(self, obs_id: int) -> bool:
        """Check if observation exists in cache."""
        return await self.client.exists(self._key(obs_id))

    async def count(self, project: Optional[str] = None) -> int:
        """Count cached observations."""
        if project:
            timeline_key = self._timeline_key(project)
            ids = await self.client.zrevrange(timeline_key, 0, -1)
            return len(ids)

        keys = await self.client.scan_iter("observation:*")
        return len(keys)

    async def evict_old(self, project: str, keep_count: int = 100) -> int:
        """Evict old observations from a project, keeping the most recent."""
        timeline_key = self._timeline_key(project)

        # Get all IDs in timeline
        all_ids = await self.client.zrevrange(timeline_key, 0, -1)

        if len(all_ids) <= keep_count:
            return 0

        # IDs to evict (oldest ones)
        to_evict = all_ids[keep_count:]
        evicted = 0

        for id_str in to_evict:
            obs_id = int(id_str)
            if await self.delete(obs_id):
                evicted += 1

        return evicted
