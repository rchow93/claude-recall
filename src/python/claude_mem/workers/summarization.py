"""
Summarization Worker

Consolidates observations into session summaries and weekly summaries.
"""

import asyncio
import logging
from datetime import datetime, timedelta
from typing import Optional

import httpx

from claude_recall.models import (
    SessionSummaryInput,
    WeeklySummaryInput,
    ProjectFactInput,
    QueryOptions,
)
from claude_recall.storage.cold.observation_store import PostgresObservationStore
from claude_recall.storage.cold.summary_store import (
    PostgresSummaryStore,
    PostgresWeeklySummaryStore,
    PostgresProjectFactStore,
)
from claude_recall.storage.cold.postgres_client import get_postgres_client
from claude_recall.embedding import generate_embedding
from claude_recall.config import get_config

logger = logging.getLogger(__name__)


class SummarizationWorker:
    """
    Background worker for hierarchical summarization.

    Pipeline:
    1. Raw observations (24h) -> Session summaries
    2. Session summaries (7d) -> Weekly summaries
    3. Weekly summaries -> Project facts
    """

    def __init__(self):
        self.postgres = get_postgres_client()
        self.observation_store = PostgresObservationStore(self.postgres)
        self.summary_store = PostgresSummaryStore(self.postgres)
        self.weekly_store = PostgresWeeklySummaryStore(self.postgres)
        self.fact_store = PostgresProjectFactStore(self.postgres)
        self.config = get_config()
        self._running = False

    async def start(self) -> None:
        """Start the background worker."""
        self._running = True
        logger.info("Summarization worker started")

        while self._running:
            try:
                await self.run_cycle()
            except Exception as e:
                logger.error(f"Summarization cycle failed: {e}")

            # Wait for next cycle
            await asyncio.sleep(self.config.summarization.consolidation_interval_ms / 1000)

    def stop(self) -> None:
        """Stop the background worker."""
        self._running = False
        logger.info("Summarization worker stopped")

    async def run_cycle(self) -> None:
        """Run one summarization cycle."""
        logger.debug("Starting summarization cycle")

        # 1. Session consolidation (observations > 24h old)
        await self._consolidate_sessions()

        # 2. Weekly consolidation (session summaries > 7d old)
        await self._consolidate_weekly()

        # 3. Fact extraction
        await self._extract_facts()

        logger.debug("Summarization cycle complete")

    async def _consolidate_sessions(self) -> int:
        """Consolidate observations into session summaries."""
        delay_hours = self.config.summarization.session_consolidation_delay_hours
        cutoff = datetime.now() - timedelta(hours=delay_hours)
        cutoff_epoch = int(cutoff.timestamp() * 1000)

        # Get sessions with observations older than cutoff that don't have summaries
        rows = await self.postgres.fetch(
            """
            SELECT DISTINCT memory_session_id, project
            FROM observations
            WHERE created_at_epoch < $1
              AND NOT EXISTS (
                SELECT 1 FROM session_summaries
                WHERE session_summaries.memory_session_id = observations.memory_session_id
              )
            """,
            cutoff_epoch,
        )

        consolidated = 0
        for row in rows:
            session_id = row["memory_session_id"]
            project = row["project"]

            try:
                await self._summarize_session(session_id, project)
                consolidated += 1
            except Exception as e:
                logger.error(f"Failed to summarize session {session_id}: {e}")

        if consolidated > 0:
            logger.info(f"Consolidated {consolidated} sessions")

        return consolidated

    async def _summarize_session(self, session_id: str, project: str) -> None:
        """Generate summary for a single session."""
        # Get all observations for this session
        observations = await self.observation_store.get_by_session(session_id)

        if not observations:
            return

        # Build prompt for LLM summarization
        obs_text = "\n\n".join([
            f"[{obs.type.value}] {obs.title or 'Untitled'}\n{obs.narrative or ''}"
            for obs in observations
        ])

        prompt = f"""Summarize this coding session. Extract:
1. What was requested/worked on
2. What was investigated
3. Key learnings
4. What was completed
5. Suggested next steps

Observations:
{obs_text[:4000]}  # Truncate for token limits

Respond in JSON format with fields: request, investigated, learned, completed, next_steps"""

        # Call LLM for summarization
        summary_data = await self._call_llm(prompt)

        if not summary_data:
            # Fallback: simple concatenation
            summary_data = {
                "request": observations[0].title or "Session work",
                "investigated": "",
                "learned": "",
                "completed": ", ".join([o.title or "" for o in observations if o.title]),
                "next_steps": "",
            }

        # Collect files from observations
        files_read = set()
        files_edited = set()
        for obs in observations:
            if obs.files_read:
                files_read.update(obs.files_read)
            if obs.files_modified:
                files_edited.update(obs.files_modified)

        # Generate embedding
        embed_text = f"{summary_data.get('request', '')} {summary_data.get('learned', '')}"
        embedding = await generate_embedding(embed_text)

        # Store summary
        summary = SessionSummaryInput(
            memory_session_id=session_id,
            project=project,
            request=summary_data.get("request"),
            investigated=summary_data.get("investigated"),
            learned=summary_data.get("learned"),
            completed=summary_data.get("completed"),
            next_steps=summary_data.get("next_steps"),
            files_read=list(files_read),
            files_edited=list(files_edited),
            prompt_number=max(o.prompt_number or 0 for o in observations),
            discovery_tokens=sum(o.discovery_tokens for o in observations),
            embedding=embedding,
        )

        await self.summary_store.store(summary)
        logger.debug(f"Created summary for session {session_id}")

    async def _consolidate_weekly(self) -> int:
        """Consolidate session summaries into weekly summaries."""
        delay_days = self.config.summarization.weekly_consolidation_delay_days
        cutoff = datetime.now() - timedelta(days=delay_days)
        cutoff_epoch = int(cutoff.timestamp() * 1000)

        # Get distinct projects with old summaries
        rows = await self.postgres.fetch(
            """
            SELECT DISTINCT project
            FROM session_summaries
            WHERE created_at_epoch < $1
            """,
            cutoff_epoch,
        )

        consolidated = 0
        for row in rows:
            project = row["project"]

            try:
                count = await self._summarize_weeks(project, cutoff_epoch)
                consolidated += count
            except Exception as e:
                logger.error(f"Failed to consolidate weekly for {project}: {e}")

        if consolidated > 0:
            logger.info(f"Created {consolidated} weekly summaries")

        return consolidated

    async def _summarize_weeks(self, project: str, cutoff_epoch: int) -> int:
        """Generate weekly summaries for a project."""
        # Get session summaries not yet in weekly summaries
        summaries = await self.summary_store.get_recent(
            QueryOptions(project=project, until_epoch=cutoff_epoch, limit=100)
        )

        if not summaries:
            return 0

        # Group by week
        weeks: dict[str, list] = {}
        for summary in summaries:
            if not summary.created_at:
                continue
            week_start = summary.created_at - timedelta(days=summary.created_at.weekday())
            week_key = week_start.strftime("%Y-%m-%d")

            if week_key not in weeks:
                weeks[week_key] = []
            weeks[week_key].append(summary)

        created = 0
        for week_start, week_summaries in weeks.items():
            # Check if already summarized
            existing = await self.weekly_store.get_by_week(project, week_start)
            if existing:
                continue

            # Check if all sessions are already in a weekly summary
            session_ids = [s.id for s in week_summaries]
            if await self.weekly_store.are_sessions_summarized(session_ids):
                continue

            # Build summary text
            summary_parts = []
            key_topics = set()

            for s in week_summaries:
                if s.request:
                    summary_parts.append(f"- {s.request}")
                if s.learned:
                    summary_parts.append(f"  Learned: {s.learned}")

            summary_text = "\n".join(summary_parts)

            # Generate embedding
            embedding = await generate_embedding(summary_text)

            # Store weekly summary
            weekly = WeeklySummaryInput(
                project=project,
                week_start=week_start,
                summary_text=summary_text,
                key_topics=list(key_topics),
                embedding=embedding,
                source_session_ids=session_ids,
            )

            await self.weekly_store.store(weekly)
            created += 1

        return created

    async def _extract_facts(self) -> int:
        """Extract stable project facts from weekly summaries."""
        # TODO: Implement fact extraction using LLM
        # This would analyze weekly summaries to extract:
        # - Project architecture patterns
        # - Common conventions
        # - Key decisions
        return 0

    async def _call_llm(self, prompt: str) -> Optional[dict]:
        """Call Ollama LLM for summarization."""
        try:
            async with httpx.AsyncClient(timeout=60.0) as client:
                response = await client.post(
                    f"{self.config.ollama.host}/api/generate",
                    json={
                        "model": "llama3.2",  # Or configured model
                        "prompt": prompt,
                        "format": "json",
                        "stream": False,
                    },
                )
                response.raise_for_status()
                data = response.json()

                import json
                return json.loads(data.get("response", "{}"))
        except Exception as e:
            logger.warning(f"LLM call failed: {e}")
            return None
