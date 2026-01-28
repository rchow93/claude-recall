"""
PostgreSQL Summary Stores

Handles session summaries, weekly summaries, and project facts.
"""

import json
import logging
from datetime import datetime
from typing import Optional

from claude_recall.models import (
    StoredSessionSummary,
    SessionSummaryInput,
    StoredWeeklySummary,
    WeeklySummaryInput,
    StoredProjectFact,
    ProjectFactInput,
    QueryOptions,
)
from claude_recall.storage.cold.postgres_client import PostgresClient, get_postgres_client

logger = logging.getLogger(__name__)


def _row_to_summary(row: dict) -> StoredSessionSummary:
    """Convert a database row to a StoredSessionSummary."""
    return StoredSessionSummary(
        id=row["id"],
        memory_session_id=row["memory_session_id"],
        project=row["project"],
        request=row["request"],
        investigated=row["investigated"],
        learned=row["learned"],
        completed=row["completed"],
        next_steps=row["next_steps"],
        notes=row["notes"],
        files_read=row["files_read"] if row["files_read"] else None,
        files_edited=row["files_edited"] if row["files_edited"] else None,
        prompt_number=row["prompt_number"],
        discovery_tokens=row["discovery_tokens"] or 0,
        embedding=list(row["embedding"]) if row["embedding"] else None,
        created_at=row["created_at"],
        created_at_epoch=row["created_at_epoch"],
    )


def _row_to_weekly(row: dict) -> StoredWeeklySummary:
    """Convert a database row to a StoredWeeklySummary."""
    return StoredWeeklySummary(
        id=row["id"],
        project=row["project"],
        week_start=str(row["week_start"]),
        summary_text=row["summary_text"],
        key_topics=row["key_topics"] if row["key_topics"] else None,
        embedding=list(row["embedding"]) if row["embedding"] else None,
        source_session_ids=list(row["source_session_ids"]) if row["source_session_ids"] else [],
        created_at=row["created_at"],
        created_at_epoch=row["created_at_epoch"],
    )


def _row_to_fact(row: dict) -> StoredProjectFact:
    """Convert a database row to a StoredProjectFact."""
    return StoredProjectFact(
        id=row["id"],
        project=row["project"],
        fact_text=row["fact_text"],
        fact_type=row["fact_type"],
        confidence=row["confidence"],
        embedding=list(row["embedding"]) if row["embedding"] else None,
        created_at=row["created_at"],
        created_at_epoch=row["created_at_epoch"],
    )


class PostgresSummaryStore:
    """Session summary store using PostgreSQL."""

    def __init__(self, client: Optional[PostgresClient] = None):
        self.client = client or get_postgres_client()

    async def store(self, summary: SessionSummaryInput) -> StoredSessionSummary:
        """Store a session summary (upserts on memory_session_id)."""
        now = int(datetime.now().timestamp() * 1000)
        created_at_epoch = summary.created_at_epoch or now

        embedding_str = None
        if summary.embedding:
            embedding_str = f"[{','.join(map(str, summary.embedding))}]"

        row = await self.client.fetchrow(
            """
            INSERT INTO session_summaries (
                memory_session_id, project, request, investigated, learned,
                completed, next_steps, notes, files_read, files_edited,
                prompt_number, discovery_tokens, embedding,
                created_at, created_at_epoch
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::vector, $14, $15)
            ON CONFLICT (memory_session_id) DO UPDATE SET
                request = EXCLUDED.request,
                investigated = EXCLUDED.investigated,
                learned = EXCLUDED.learned,
                completed = EXCLUDED.completed,
                next_steps = EXCLUDED.next_steps,
                notes = EXCLUDED.notes,
                files_read = EXCLUDED.files_read,
                files_edited = EXCLUDED.files_edited,
                prompt_number = EXCLUDED.prompt_number,
                discovery_tokens = EXCLUDED.discovery_tokens,
                embedding = EXCLUDED.embedding
            RETURNING *
            """,
            summary.memory_session_id,
            summary.project,
            summary.request,
            summary.investigated,
            summary.learned,
            summary.completed,
            summary.next_steps,
            summary.notes,
            json.dumps(summary.files_read or []),
            json.dumps(summary.files_edited or []),
            summary.prompt_number,
            summary.discovery_tokens,
            embedding_str,
            datetime.fromtimestamp(created_at_epoch / 1000),
            created_at_epoch,
        )

        return _row_to_summary(dict(row))

    async def get_by_id(self, id: int) -> Optional[StoredSessionSummary]:
        """Get a summary by ID."""
        row = await self.client.fetchrow(
            "SELECT * FROM session_summaries WHERE id = $1", id
        )
        if not row:
            return None
        return _row_to_summary(dict(row))

    async def get_by_session(self, memory_session_id: str) -> Optional[StoredSessionSummary]:
        """Get the summary for a session."""
        row = await self.client.fetchrow(
            "SELECT * FROM session_summaries WHERE memory_session_id = $1",
            memory_session_id,
        )
        if not row:
            return None
        return _row_to_summary(dict(row))

    async def get_recent(
        self, options: Optional[QueryOptions] = None
    ) -> list[StoredSessionSummary]:
        """Get recent summaries."""
        opts = options or QueryOptions()

        conditions = []
        params: list = []
        param_idx = 1

        if opts.project:
            conditions.append(f"project = ${param_idx}")
            params.append(opts.project)
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

        rows = await self.client.fetch(
            f"""
            SELECT * FROM session_summaries
            {where_clause}
            ORDER BY created_at_epoch {'ASC' if opts.order == 'asc' else 'DESC'}
            LIMIT ${param_idx} OFFSET ${param_idx + 1}
            """,
            *params,
        )
        return [_row_to_summary(dict(row)) for row in rows]

    async def delete(self, id: int) -> bool:
        """Delete a summary by ID."""
        result = await self.client.execute(
            "DELETE FROM session_summaries WHERE id = $1", id
        )
        return result.endswith("1")

    async def delete_older_than(self, epoch_ms: int) -> int:
        """Delete summaries older than the given epoch."""
        result = await self.client.execute(
            "DELETE FROM session_summaries WHERE created_at_epoch < $1", epoch_ms
        )
        try:
            return int(result.split()[-1])
        except (IndexError, ValueError):
            return 0

    async def exists_for_session(self, memory_session_id: str) -> bool:
        """Check if a summary exists for a session."""
        result = await self.client.fetchval(
            "SELECT 1 FROM session_summaries WHERE memory_session_id = $1",
            memory_session_id,
        )
        return result is not None

    async def count(self, options: Optional[QueryOptions] = None) -> int:
        """Count summaries matching criteria."""
        opts = options or QueryOptions()

        conditions = []
        params: list = []
        param_idx = 1

        if opts.project:
            conditions.append(f"project = ${param_idx}")
            params.append(opts.project)
            param_idx += 1

        where_clause = f"WHERE {' AND '.join(conditions)}" if conditions else ""

        result = await self.client.fetchval(
            f"SELECT COUNT(*) FROM session_summaries {where_clause}", *params
        )
        return result or 0


class PostgresWeeklySummaryStore:
    """Weekly summary store using PostgreSQL."""

    def __init__(self, client: Optional[PostgresClient] = None):
        self.client = client or get_postgres_client()

    async def store(self, summary: WeeklySummaryInput) -> StoredWeeklySummary:
        """Store a weekly summary (upserts on project + week_start)."""
        now = int(datetime.now().timestamp() * 1000)

        embedding_str = None
        if summary.embedding:
            embedding_str = f"[{','.join(map(str, summary.embedding))}]"

        row = await self.client.fetchrow(
            """
            INSERT INTO weekly_summaries (
                project, week_start, summary_text, key_topics,
                embedding, source_session_ids, created_at, created_at_epoch
            ) VALUES ($1, $2::date, $3, $4, $5::vector, $6, NOW(), $7)
            ON CONFLICT (project, week_start) DO UPDATE SET
                summary_text = EXCLUDED.summary_text,
                key_topics = EXCLUDED.key_topics,
                embedding = EXCLUDED.embedding,
                source_session_ids = EXCLUDED.source_session_ids
            RETURNING *
            """,
            summary.project,
            summary.week_start,
            summary.summary_text,
            json.dumps(summary.key_topics or []),
            embedding_str,
            summary.source_session_ids,
            now,
        )

        return _row_to_weekly(dict(row))

    async def get_by_week(
        self, project: str, week_start: str
    ) -> Optional[StoredWeeklySummary]:
        """Get a weekly summary."""
        row = await self.client.fetchrow(
            "SELECT * FROM weekly_summaries WHERE project = $1 AND week_start = $2::date",
            project,
            week_start,
        )
        if not row:
            return None
        return _row_to_weekly(dict(row))

    async def get_recent(self, project: str, limit: int = 10) -> list[StoredWeeklySummary]:
        """Get recent weekly summaries for a project."""
        rows = await self.client.fetch(
            """
            SELECT * FROM weekly_summaries
            WHERE project = $1
            ORDER BY week_start DESC
            LIMIT $2
            """,
            project,
            limit,
        )
        return [_row_to_weekly(dict(row)) for row in rows]

    async def are_sessions_summarized(self, session_ids: list[int]) -> bool:
        """Check if any of the sessions are already in a weekly summary."""
        if not session_ids:
            return True

        result = await self.client.fetchval(
            "SELECT 1 FROM weekly_summaries WHERE source_session_ids && $1 LIMIT 1",
            session_ids,
        )
        return result is not None


class PostgresProjectFactStore:
    """Project facts store using PostgreSQL."""

    def __init__(self, client: Optional[PostgresClient] = None):
        self.client = client or get_postgres_client()

    async def store(self, fact: ProjectFactInput) -> StoredProjectFact:
        """Store a project fact."""
        now = int(datetime.now().timestamp() * 1000)

        embedding_str = None
        if fact.embedding:
            embedding_str = f"[{','.join(map(str, fact.embedding))}]"

        row = await self.client.fetchrow(
            """
            INSERT INTO project_facts (
                project, fact_text, fact_type, confidence,
                embedding, created_at, created_at_epoch
            ) VALUES ($1, $2, $3, $4, $5::vector, NOW(), $6)
            RETURNING *
            """,
            fact.project,
            fact.fact_text,
            fact.fact_type,
            fact.confidence,
            embedding_str,
            now,
        )

        return _row_to_fact(dict(row))

    async def store_batch(self, facts: list[ProjectFactInput]) -> list[StoredProjectFact]:
        """Store multiple facts."""
        results = []
        for fact in facts:
            stored = await self.store(fact)
            results.append(stored)
        return results

    async def get_by_project(self, project: str, limit: int = 100) -> list[StoredProjectFact]:
        """Get all facts for a project."""
        rows = await self.client.fetch(
            """
            SELECT * FROM project_facts
            WHERE project = $1
            ORDER BY confidence DESC, created_at_epoch DESC
            LIMIT $2
            """,
            project,
            limit,
        )
        return [_row_to_fact(dict(row)) for row in rows]

    async def delete(self, id: int) -> bool:
        """Delete a fact by ID."""
        result = await self.client.execute(
            "DELETE FROM project_facts WHERE id = $1", id
        )
        return result.endswith("1")

    async def delete_by_project(self, project: str) -> int:
        """Delete all facts for a project."""
        result = await self.client.execute(
            "DELETE FROM project_facts WHERE project = $1", project
        )
        try:
            return int(result.split()[-1])
        except (IndexError, ValueError):
            return 0
