"""
Retention Worker

Cleans up data older than retention period.
"""

import asyncio
import logging
from datetime import datetime, timedelta

from claude_recall.storage.cold.postgres_client import get_postgres_client
from claude_recall.config import get_config

logger = logging.getLogger(__name__)


class RetentionWorker:
    """
    Background worker for data retention cleanup.

    Runs periodically to delete data older than retention period.
    Default: 20 days for observations and summaries.
    """

    def __init__(self):
        self.postgres = get_postgres_client()
        self.config = get_config()
        self._running = False

    async def start(self) -> None:
        """Start the background worker."""
        self._running = True
        logger.info("Retention worker started")

        while self._running:
            try:
                await self.run_cleanup()
            except Exception as e:
                logger.error(f"Retention cleanup failed: {e}")

            # Run once per day
            await asyncio.sleep(24 * 60 * 60)

    def stop(self) -> None:
        """Stop the background worker."""
        self._running = False
        logger.info("Retention worker stopped")

    async def run_cleanup(self) -> dict:
        """
        Run retention cleanup.

        Returns count of deleted items by type.
        """
        retention_days = self.config.postgres.retention_days
        cutoff = datetime.now() - timedelta(days=retention_days)

        logger.info(f"Running retention cleanup (cutoff: {cutoff})")

        results = {
            "observations": 0,
            "session_summaries": 0,
            "weekly_summaries": 0,
        }

        # Delete old observations
        result = await self.postgres.execute(
            f"DELETE FROM observations WHERE created_at < NOW() - INTERVAL '{retention_days} days'"
        )
        try:
            results["observations"] = int(result.split()[-1])
        except (IndexError, ValueError):
            pass

        # Delete old session summaries
        result = await self.postgres.execute(
            f"DELETE FROM session_summaries WHERE created_at < NOW() - INTERVAL '{retention_days} days'"
        )
        try:
            results["session_summaries"] = int(result.split()[-1])
        except (IndexError, ValueError):
            pass

        # Weekly summaries are kept longer (90 days)
        result = await self.postgres.execute(
            "DELETE FROM weekly_summaries WHERE created_at < NOW() - INTERVAL '90 days'"
        )
        try:
            results["weekly_summaries"] = int(result.split()[-1])
        except (IndexError, ValueError):
            pass

        total = sum(results.values())
        if total > 0:
            logger.info(f"Retention cleanup deleted: {results}")

        return results

    async def vacuum_analyze(self) -> None:
        """
        Run VACUUM ANALYZE on tables after cleanup.

        This reclaims space and updates statistics.
        """
        try:
            # Note: VACUUM requires autocommit mode
            await self.postgres.execute("VACUUM ANALYZE observations")
            await self.postgres.execute("VACUUM ANALYZE session_summaries")
            await self.postgres.execute("VACUUM ANALYZE weekly_summaries")
            logger.info("VACUUM ANALYZE complete")
        except Exception as e:
            logger.warning(f"VACUUM ANALYZE failed: {e}")

    async def get_storage_stats(self) -> dict:
        """Get storage statistics."""
        stats = {}

        # Count by table
        for table in ["observations", "session_summaries", "weekly_summaries", "project_facts"]:
            result = await self.postgres.fetchval(f"SELECT COUNT(*) FROM {table}")
            stats[f"{table}_count"] = result or 0

        # Get oldest records
        for table in ["observations", "session_summaries"]:
            result = await self.postgres.fetchval(
                f"SELECT MIN(created_at) FROM {table}"
            )
            stats[f"{table}_oldest"] = str(result) if result else None

        # Get disk usage (approximate)
        result = await self.postgres.fetchval(
            """
            SELECT pg_size_pretty(
                pg_total_relation_size('observations') +
                pg_total_relation_size('session_summaries') +
                pg_total_relation_size('weekly_summaries') +
                pg_total_relation_size('project_facts')
            )
            """
        )
        stats["total_size"] = result

        return stats
