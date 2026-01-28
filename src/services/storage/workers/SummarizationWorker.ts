/**
 * Summarization Worker
 * Background job that runs hierarchical summarization:
 * - Session consolidation (observations > 24h → session summaries)
 * - Weekly consolidation (session summaries > 7d → weekly summaries)
 * - Fact extraction (extract stable knowledge from summaries)
 */

import { getPostgresClient } from '../cold/PostgresClient.js';
import {
  getPostgresObservationStore,
  type PostgresObservationStore,
} from '../cold/PostgresObservationStore.js';
import {
  getPostgresSummaryStore,
  getPostgresWeeklySummaryStore,
  getPostgresProjectFactStore,
  type PostgresSummaryStore,
  type PostgresWeeklySummaryStore,
  type PostgresProjectFactStore,
} from '../cold/PostgresSummaryStore.js';
import {
  getOllamaEmbeddingService,
} from '../embedding/OllamaEmbedding.js';
import { getTieredStorageConfig } from '../config.js';
import type { StoredObservation } from '../interfaces/IObservationStore.js';
import type { StoredSessionSummary, WeeklySummaryInput, ProjectFactInput } from '../interfaces/ISummaryStore.js';

export interface SummarizationStats {
  sessionsConsolidated: number;
  weeklyConsolidated: number;
  factsExtracted: number;
  durationMs: number;
}

export class SummarizationWorker {
  private observationStore: PostgresObservationStore;
  private summaryStore: PostgresSummaryStore;
  private weeklySummaryStore: PostgresWeeklySummaryStore;
  private factStore: PostgresProjectFactStore;
  private running: boolean = false;
  private intervalHandle: NodeJS.Timeout | null = null;

  constructor() {
    this.observationStore = getPostgresObservationStore();
    this.summaryStore = getPostgresSummaryStore();
    this.weeklySummaryStore = getPostgresWeeklySummaryStore();
    this.factStore = getPostgresProjectFactStore();
  }

  /**
   * Start the background worker
   */
  start(): void {
    if (this.running) {
      return;
    }

    const config = getTieredStorageConfig();
    this.running = true;

    // Run immediately
    this.run().catch((err) => {
      console.error('[SummarizationWorker] Initial run failed:', err);
    });

    // Schedule periodic runs
    this.intervalHandle = setInterval(() => {
      if (this.running) {
        this.run().catch((err) => {
          console.error('[SummarizationWorker] Periodic run failed:', err);
        });
      }
    }, config.summarization.consolidationIntervalMs);

    console.log(`[SummarizationWorker] Started with interval ${config.summarization.consolidationIntervalMs}ms`);
  }

  /**
   * Stop the background worker
   */
  stop(): void {
    this.running = false;
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    console.log('[SummarizationWorker] Stopped');
  }

  /**
   * Run a single summarization cycle
   */
  async run(): Promise<SummarizationStats> {
    const startTime = Date.now();
    const stats: SummarizationStats = {
      sessionsConsolidated: 0,
      weeklyConsolidated: 0,
      factsExtracted: 0,
      durationMs: 0,
    };

    try {
      // Step 1: Session consolidation
      stats.sessionsConsolidated = await this.consolidateSessions();

      // Step 2: Weekly consolidation
      stats.weeklyConsolidated = await this.consolidateWeekly();

      // Step 3: Fact extraction
      stats.factsExtracted = await this.extractFacts();
    } catch (err) {
      console.error('[SummarizationWorker] Run failed:', err);
    }

    stats.durationMs = Date.now() - startTime;

    if (stats.sessionsConsolidated > 0 || stats.weeklyConsolidated > 0 || stats.factsExtracted > 0) {
      console.log(`[SummarizationWorker] Completed: ${stats.sessionsConsolidated} sessions, ${stats.weeklyConsolidated} weeks, ${stats.factsExtracted} facts in ${stats.durationMs}ms`);
    }

    return stats;
  }

  /**
   * Consolidate sessions with stale observations into summaries
   */
  private async consolidateSessions(): Promise<number> {
    const config = getTieredStorageConfig();
    const cutoffEpoch = Date.now() - (config.summarization.sessionConsolidationDelayHours * 60 * 60 * 1000);
    const client = getPostgresClient();

    // Find sessions with observations older than cutoff that don't have summaries
    const result = await client.query(`
      SELECT DISTINCT o.memory_session_id, o.project
      FROM observations o
      WHERE o.created_at_epoch < $1
        AND NOT EXISTS (
          SELECT 1 FROM session_summaries s
          WHERE s.memory_session_id = o.memory_session_id
        )
      LIMIT 50
    `, [cutoffEpoch]);

    let consolidated = 0;

    for (const row of result.rows) {
      try {
        await this.consolidateSession(row.memory_session_id, row.project);
        consolidated++;
      } catch (err) {
        console.warn(`[SummarizationWorker] Failed to consolidate session ${row.memory_session_id}:`, err);
      }
    }

    return consolidated;
  }

  /**
   * Consolidate a single session's observations into a summary
   */
  private async consolidateSession(memorySessionId: string, project: string): Promise<void> {
    const config = getTieredStorageConfig();

    // Get observations for this session
    const observations = await this.observationStore.getBySession(memorySessionId, {
      limit: config.summarization.maxObservationsPerSummary,
      order: 'asc',
    });

    if (observations.length === 0) {
      return;
    }

    // Generate summary using LLM (simplified - in production would use Claude SDK)
    const summary = this.generateSessionSummaryFromObservations(observations);

    // Store summary
    await this.summaryStore.store({
      memory_session_id: memorySessionId,
      project,
      request: summary.request,
      investigated: summary.investigated,
      learned: summary.learned,
      completed: summary.completed,
      next_steps: summary.next_steps,
      files_read: this.collectFiles(observations, 'read'),
      files_edited: this.collectFiles(observations, 'modified'),
      discovery_tokens: observations.reduce((sum, o) => sum + (o.discovery_tokens || 0), 0),
    });
  }

  /**
   * Generate a summary from observations (simplified extraction)
   * In production, this would use Claude SDK for intelligent summarization
   */
  private generateSessionSummaryFromObservations(observations: StoredObservation[]): {
    request: string | null;
    investigated: string | null;
    learned: string | null;
    completed: string | null;
    next_steps: string | null;
  } {
    const decisions = observations.filter((o) => o.type === 'decision');
    const bugfixes = observations.filter((o) => o.type === 'bugfix');
    const features = observations.filter((o) => o.type === 'feature');
    const discoveries = observations.filter((o) => o.type === 'discovery');

    // Build request from first observation
    const firstObs = observations[0];
    const request = firstObs?.title || null;

    // Build investigated from discoveries
    const investigated = discoveries.length > 0
      ? discoveries.map((d) => d.title).filter(Boolean).join('; ')
      : null;

    // Build learned from observations with narrative
    const learnedItems = observations
      .filter((o) => o.narrative)
      .map((o) => o.narrative)
      .slice(0, 3);
    const learned = learnedItems.length > 0 ? learnedItems.join(' ') : null;

    // Build completed from features, bugfixes, and decisions
    const completedItems = [...features, ...bugfixes, ...decisions]
      .map((o) => o.title)
      .filter(Boolean)
      .slice(0, 5);
    const completed = completedItems.length > 0 ? completedItems.join('; ') : null;

    return {
      request,
      investigated,
      learned,
      completed,
      next_steps: null, // Would require LLM inference
    };
  }

  /**
   * Consolidate session summaries older than a week into weekly summaries
   */
  private async consolidateWeekly(): Promise<number> {
    const config = getTieredStorageConfig();
    const cutoffEpoch = Date.now() - (config.summarization.weeklyConsolidationDelayDays * 24 * 60 * 60 * 1000);
    const client = getPostgresClient();

    // Find projects with session summaries older than cutoff
    const result = await client.query(`
      SELECT DISTINCT project,
             date_trunc('week', created_at)::date as week_start
      FROM session_summaries
      WHERE created_at_epoch < $1
      GROUP BY project, date_trunc('week', created_at)
      HAVING COUNT(*) >= 2
      LIMIT 20
    `, [cutoffEpoch]);

    let consolidated = 0;

    for (const row of result.rows) {
      const weekStart = row.week_start.toISOString().split('T')[0];

      // Check if already consolidated
      const existing = await this.weeklySummaryStore.getByWeek(row.project, weekStart);
      if (existing) {
        continue;
      }

      try {
        await this.consolidateWeek(row.project, weekStart);
        consolidated++;
      } catch (err) {
        console.warn(`[SummarizationWorker] Failed to consolidate week ${weekStart} for ${row.project}:`, err);
      }
    }

    return consolidated;
  }

  /**
   * Consolidate a week's summaries into a single weekly summary
   */
  private async consolidateWeek(project: string, weekStart: string): Promise<void> {
    const client = getPostgresClient();

    // Get session summaries for this week
    const result = await client.query(`
      SELECT id, request, investigated, learned, completed, next_steps
      FROM session_summaries
      WHERE project = $1
        AND created_at >= $2::date
        AND created_at < $2::date + interval '7 days'
      ORDER BY created_at_epoch ASC
    `, [project, weekStart]);

    if (result.rows.length === 0) {
      return;
    }

    // Generate weekly summary (simplified)
    const summaryText = this.generateWeeklySummaryText(result.rows);
    const keyTopics = this.extractKeyTopics(result.rows);

    // Store weekly summary
    await this.weeklySummaryStore.store({
      project,
      week_start: weekStart,
      summary_text: summaryText,
      key_topics: keyTopics,
      source_session_ids: result.rows.map((r) => r.id),
    });
  }

  /**
   * Generate weekly summary text from session summaries
   */
  private generateWeeklySummaryText(summaries: any[]): string {
    const parts: string[] = [];

    // Combine completed items
    const allCompleted = summaries
      .map((s) => s.completed)
      .filter(Boolean)
      .join('; ');

    if (allCompleted) {
      parts.push(`Completed: ${allCompleted}`);
    }

    // Combine learned items
    const allLearned = summaries
      .map((s) => s.learned)
      .filter(Boolean)
      .slice(0, 3)
      .join(' ');

    if (allLearned) {
      parts.push(`Learned: ${allLearned}`);
    }

    return parts.join('\n\n');
  }

  /**
   * Extract key topics from summaries
   */
  private extractKeyTopics(summaries: any[]): string[] {
    const topics = new Set<string>();

    for (const summary of summaries) {
      // Extract topics from requests
      if (summary.request) {
        const words = summary.request.split(/\s+/).slice(0, 3);
        topics.add(words.join(' '));
      }
    }

    return Array.from(topics).slice(0, 10);
  }

  /**
   * Extract stable facts from weekly summaries
   */
  private async extractFacts(): Promise<number> {
    const client = getPostgresClient();

    // Find weekly summaries that haven't had facts extracted
    const result = await client.query(`
      SELECT ws.id, ws.project, ws.summary_text, ws.key_topics
      FROM weekly_summaries ws
      WHERE NOT EXISTS (
        SELECT 1 FROM project_facts pf
        WHERE pf.project = ws.project
          AND pf.created_at_epoch >= ws.created_at_epoch
      )
      ORDER BY ws.created_at DESC
      LIMIT 10
    `);

    let extracted = 0;

    for (const row of result.rows) {
      try {
        const facts = this.extractFactsFromWeeklySummary(row);
        for (const fact of facts) {
          await this.factStore.store(fact);
          extracted++;
        }
      } catch (err) {
        console.warn(`[SummarizationWorker] Failed to extract facts from weekly summary ${row.id}:`, err);
      }
    }

    return extracted;
  }

  /**
   * Extract facts from a weekly summary
   */
  private extractFactsFromWeeklySummary(summary: any): ProjectFactInput[] {
    const facts: ProjectFactInput[] = [];
    const topics = summary.key_topics || [];

    // Convert key topics to facts
    for (const topic of topics.slice(0, 5)) {
      facts.push({
        project: summary.project,
        fact_text: topic,
        fact_type: 'topic',
        confidence: 0.8,
      });
    }

    // Extract patterns from summary text (simplified)
    const summaryText = summary.summary_text || '';
    const completedMatch = summaryText.match(/Completed: (.+?)(?:\n|$)/);
    if (completedMatch) {
      const items = completedMatch[1].split(';').map((s: string) => s.trim()).filter(Boolean);
      for (const item of items.slice(0, 3)) {
        facts.push({
          project: summary.project,
          fact_text: item,
          fact_type: 'completed',
          confidence: 0.9,
        });
      }
    }

    return facts;
  }

  /**
   * Collect file paths from observations
   */
  private collectFiles(observations: StoredObservation[], type: 'read' | 'modified'): string[] {
    const files = new Set<string>();

    for (const obs of observations) {
      const fileList = type === 'read' ? obs.files_read : obs.files_modified;
      if (fileList) {
        for (const file of fileList) {
          files.add(file);
        }
      }
    }

    return Array.from(files);
  }
}

/**
 * Retention Worker
 * Handles cleanup of expired data
 */
export class RetentionWorker {
  private running: boolean = false;
  private intervalHandle: NodeJS.Timeout | null = null;

  /**
   * Start the retention worker (runs once per day)
   */
  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    const oneDayMs = 24 * 60 * 60 * 1000;

    // Run immediately
    this.run().catch((err) => {
      console.error('[RetentionWorker] Initial run failed:', err);
    });

    // Schedule daily
    this.intervalHandle = setInterval(() => {
      if (this.running) {
        this.run().catch((err) => {
          console.error('[RetentionWorker] Periodic run failed:', err);
        });
      }
    }, oneDayMs);

    console.log('[RetentionWorker] Started with 24h interval');
  }

  /**
   * Stop the retention worker
   */
  stop(): void {
    this.running = false;
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    console.log('[RetentionWorker] Stopped');
  }

  /**
   * Run retention cleanup
   */
  async run(): Promise<void> {
    const config = getTieredStorageConfig();
    const cutoffEpoch = Date.now() - (config.postgres.retentionDays * 24 * 60 * 60 * 1000);
    const client = getPostgresClient();

    try {
      // Delete old observations
      const obsResult = await client.query(
        'DELETE FROM observations WHERE created_at_epoch < $1 RETURNING id',
        [cutoffEpoch]
      );

      // Delete old session summaries
      const summaryResult = await client.query(
        'DELETE FROM session_summaries WHERE created_at_epoch < $1 RETURNING id',
        [cutoffEpoch]
      );

      const obsCount = obsResult.rowCount ?? 0;
      const summaryCount = summaryResult.rowCount ?? 0;

      if (obsCount > 0 || summaryCount > 0) {
        console.log(`[RetentionWorker] Cleaned up ${obsCount} observations, ${summaryCount} summaries older than ${config.postgres.retentionDays} days`);
      }
    } catch (err) {
      console.error('[RetentionWorker] Cleanup failed:', err);
    }
  }
}

// Singleton instances
let summarizationWorkerInstance: SummarizationWorker | null = null;
let retentionWorkerInstance: RetentionWorker | null = null;

export function getSummarizationWorker(): SummarizationWorker {
  if (!summarizationWorkerInstance) {
    summarizationWorkerInstance = new SummarizationWorker();
  }
  return summarizationWorkerInstance;
}

export function getRetentionWorker(): RetentionWorker {
  if (!retentionWorkerInstance) {
    retentionWorkerInstance = new RetentionWorker();
  }
  return retentionWorkerInstance;
}

export function startBackgroundWorkers(): void {
  getSummarizationWorker().start();
  getRetentionWorker().start();
}

export function stopBackgroundWorkers(): void {
  if (summarizationWorkerInstance) {
    summarizationWorkerInstance.stop();
  }
  if (retentionWorkerInstance) {
    retentionWorkerInstance.stop();
  }
}
