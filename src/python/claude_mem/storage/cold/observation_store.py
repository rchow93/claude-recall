"""
PostgreSQL Observation Store

Handles CRUD operations for observations with embedding support.
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
from claude_recall.storage.cold.postgres_client import PostgresClient, get_postgres_client

logger = logging.getLogger(__name__)


def _row_to_observation(row: dict) -> StoredObservation:
    """Convert a database row to a StoredObservation."""
    return StoredObservation(
        id=row["id"],
        memory_session_id=row["memory_session_id"],
        project=row["project"],
        type=ObservationType(row["type"]),
        title=row["title"],
        subtitle=row["subtitle"],
        facts=row["facts"] if row["facts"] else None,
        narrative=row["narrative"],
        concepts=row["concepts"] if row["concepts"] else None,
        files_read=row["files_read"] if row["files_read"] else None,
        files_modified=row["files_modified"] if row["files_modified"] else None,
        prompt_number=row["prompt_number"],
        discovery_tokens=row["discovery_tokens"] or 0,
        embedding=list(row["embedding"]) if row["embedding"] else None,
        created_at=row["created_at"],
        created_at_epoch=row["created_at_epoch"],
    )


class PostgresObservationStore:
    """Observation store using PostgreSQL."""

    def __init__(self, client: Optional[PostgresClient] = None):
        self.client = client or get_postgres_client()

    async def store(self, observation: ObservationInput) -> StoredObservation:
        """Store a new observation."""
        now = int(datetime.now().timestamp() * 1000)
        created_at_epoch = observation.created_at_epoch or now

        embedding_str = None
        if observation.embedding:
            embedding_str = f"[{','.join(map(str, observation.embedding))}]"

        row = await self.client.fetchrow(
            """
            INSERT INTO observations (
                memory_session_id, project, type, title, subtitle,
                facts, narrative, concepts, files_read, files_modified,
                prompt_number, discovery_tokens, embedding,
                created_at, created_at_epoch
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::vector, $14, $15)
            RETURNING *
            """,
            observation.memory_session_id,
            observation.project,
            observation.type.value,
            observation.title,
            observation.subtitle,
            json.dumps(observation.facts or []),
            observation.narrative,
            json.dumps(observation.concepts or []),
            json.dumps(observation.files_read or []),
            json.dumps(observation.files_modified or []),
            observation.prompt_number,
            observation.discovery_tokens,
            embedding_str,
            datetime.fromtimestamp(created_at_epoch / 1000),
            created_at_epoch,
        )

        return _row_to_observation(dict(row))

    async def store_batch(
        self, observations: list[ObservationInput]
    ) -> list[StoredObservation]:
        """Store multiple observations."""
        results = []
        for obs in observations:
            stored = await self.store(obs)
            results.append(stored)
        return results

    async def get_by_id(self, id: int) -> Optional[StoredObservation]:
        """Get an observation by ID."""
        row = await self.client.fetchrow(
            "SELECT * FROM observations WHERE id = $1", id
        )
        if not row:
            return None
        return _row_to_observation(dict(row))

    async def get_by_ids(self, ids: list[int]) -> list[StoredObservation]:
        """Get observations by IDs."""
        if not ids:
            return []

        rows = await self.client.fetch(
            "SELECT * FROM observations WHERE id = ANY($1) ORDER BY created_at_epoch DESC",
            ids,
        )
        return [_row_to_observation(dict(row)) for row in rows]

    async def get_by_session(
        self, memory_session_id: str, options: Optional[QueryOptions] = None
    ) -> list[StoredObservation]:
        """Get observations for a session."""
        opts = options or QueryOptions()

        rows = await self.client.fetch(
            f"""
            SELECT * FROM observations
            WHERE memory_session_id = $1
            ORDER BY created_at_epoch {'ASC' if opts.order == 'asc' else 'DESC'}
            LIMIT $2 OFFSET $3
            """,
            memory_session_id,
            opts.limit,
            opts.offset,
        )
        return [_row_to_observation(dict(row)) for row in rows]

    async def get_recent(
        self, options: Optional[QueryOptions] = None
    ) -> list[StoredObservation]:
        """Get recent observations with optional filtering."""
        opts = options or QueryOptions()

        # Build query dynamically
        conditions = []
        params: list = []
        param_idx = 1

        if opts.project:
            conditions.append(f"project = ${param_idx}")
            params.append(opts.project)
            param_idx += 1

        if opts.types:
            conditions.append(f"type = ANY(${param_idx})")
            params.append([t.value for t in opts.types])
            param_idx += 1

        if opts.concepts:
            conditions.append(f"concepts ?| ${param_idx}")
            params.append(opts.concepts)
            param_idx += 1

        if opts.files:
            conditions.append(
                f"(files_read ?| ${param_idx} OR files_modified ?| ${param_idx})"
            )
            params.append(opts.files)
            param_idx += 1

        if opts.since_epoch:
            conditions.append(f"created_at_epoch >= ${param_idx}")
            params.append(opts.since_epoch)
            param_idx += 1

        if opts.until_epoch:
            conditions.append(f"created_at_epoch <= ${param_idx}")
            params.append(opts.until_epoch)
            param_idx += 1

        where_clause = f"WHERE {' AND '.join(conditions)}" if conditions else ""

        params.extend([opts.limit, opts.offset])

        query = f"""
            SELECT * FROM observations
            {where_clause}
            ORDER BY created_at_epoch {'ASC' if opts.order == 'asc' else 'DESC'}
            LIMIT ${param_idx} OFFSET ${param_idx + 1}
        """

        rows = await self.client.fetch(query, *params)
        return [_row_to_observation(dict(row)) for row in rows]

    async def delete(self, id: int) -> bool:
        """Delete an observation by ID."""
        result = await self.client.execute(
            "DELETE FROM observations WHERE id = $1", id
        )
        return result.endswith("1")

    async def delete_older_than(self, epoch_ms: int) -> int:
        """Delete observations older than the given epoch. Returns count."""
        result = await self.client.execute(
            "DELETE FROM observations WHERE created_at_epoch < $1", epoch_ms
        )
        try:
            return int(result.split()[-1])
        except (IndexError, ValueError):
            return 0

    async def exists(self, id: int) -> bool:
        """Check if an observation exists."""
        result = await self.client.fetchval(
            "SELECT 1 FROM observations WHERE id = $1", id
        )
        return result is not None

    async def count(self, options: Optional[QueryOptions] = None) -> int:
        """Count observations matching criteria."""
        opts = options or QueryOptions()

        conditions = []
        params: list = []
        param_idx = 1

        if opts.project:
            conditions.append(f"project = ${param_idx}")
            params.append(opts.project)
            param_idx += 1

        if opts.types:
            conditions.append(f"type = ANY(${param_idx})")
            params.append([t.value for t in opts.types])
            param_idx += 1

        if opts.since_epoch:
            conditions.append(f"created_at_epoch >= ${param_idx}")
            params.append(opts.since_epoch)
            param_idx += 1

        if opts.until_epoch:
            conditions.append(f"created_at_epoch <= ${param_idx}")
            params.append(opts.until_epoch)
            param_idx += 1

        where_clause = f"WHERE {' AND '.join(conditions)}" if conditions else ""

        result = await self.client.fetchval(
            f"SELECT COUNT(*) FROM observations {where_clause}", *params
        )
        return result or 0
