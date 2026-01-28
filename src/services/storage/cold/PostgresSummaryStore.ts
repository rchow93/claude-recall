/**
 * PostgreSQL Summary Store Implementation
 * Cold tier storage for session summaries, weekly summaries, and project facts
 */

import { getPostgresClient, type PostgresClient } from './PostgresClient.js';
import type {
  ISummaryStore,
  IWeeklySummaryStore,
  IProjectFactStore,
  StoredSessionSummary,
  SessionSummaryInput,
  SummaryQueryOptions,
  StoredWeeklySummary,
  WeeklySummaryInput,
  StoredProjectFact,
  ProjectFactInput,
} from '../interfaces/ISummaryStore.js';
import {
  getOllamaEmbeddingService,
  createSummarySearchText,
} from '../embedding/OllamaEmbedding.js';

export class PostgresSummaryStore implements ISummaryStore {
  private client: PostgresClient;

  constructor(client?: PostgresClient) {
    this.client = client || getPostgresClient();
  }

  async store(summary: SessionSummaryInput): Promise<StoredSessionSummary> {
    const now = Date.now();
    const createdAtEpoch = summary.created_at_epoch || now;
    const createdAt = new Date(createdAtEpoch).toISOString();

    // Generate embedding if not provided
    let embedding = summary.embedding;
    if (!embedding) {
      try {
        const embeddingService = getOllamaEmbeddingService();
        if (await embeddingService.isAvailable()) {
          const searchText = createSummarySearchText(summary);
          if (searchText) {
            embedding = await embeddingService.generateEmbedding(searchText);
          }
        }
      } catch (err) {
        console.warn('[PostgresSummaryStore] Failed to generate embedding:', err);
      }
    }

    const result = await this.client.query<StoredSessionSummary>(
      `INSERT INTO session_summaries (
        memory_session_id, project, request, investigated, learned,
        completed, next_steps, notes, files_read, files_edited,
        prompt_number, discovery_tokens, embedding,
        created_at, created_at_epoch
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
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
      RETURNING *`,
      [
        summary.memory_session_id,
        summary.project,
        summary.request || null,
        summary.investigated || null,
        summary.learned || null,
        summary.completed || null,
        summary.next_steps || null,
        summary.notes || null,
        JSON.stringify(summary.files_read || []),
        JSON.stringify(summary.files_edited || []),
        summary.prompt_number || null,
        summary.discovery_tokens || 0,
        embedding ? `[${embedding.join(',')}]` : null,
        createdAt,
        createdAtEpoch,
      ]
    );

    return this.rowToSummary(result.rows[0]);
  }

  async getById(id: number): Promise<StoredSessionSummary | null> {
    const result = await this.client.query(
      'SELECT * FROM session_summaries WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.rowToSummary(result.rows[0]);
  }

  async getBySession(memorySessionId: string): Promise<StoredSessionSummary | null> {
    const result = await this.client.query(
      'SELECT * FROM session_summaries WHERE memory_session_id = $1',
      [memorySessionId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.rowToSummary(result.rows[0]);
  }

  async getRecent(options: SummaryQueryOptions = {}): Promise<StoredSessionSummary[]> {
    const {
      project,
      limit = 100,
      offset = 0,
      since_epoch,
      until_epoch,
      order = 'desc',
    } = options;

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (project) {
      conditions.push(`project = $${paramIndex++}`);
      params.push(project);
    }

    if (since_epoch) {
      conditions.push(`created_at_epoch >= $${paramIndex++}`);
      params.push(since_epoch);
    }

    if (until_epoch) {
      conditions.push(`created_at_epoch <= $${paramIndex++}`);
      params.push(until_epoch);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit, offset);

    const result = await this.client.query(
      `SELECT * FROM session_summaries
       ${whereClause}
       ORDER BY created_at_epoch ${order === 'asc' ? 'ASC' : 'DESC'}
       LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
      params
    );

    return result.rows.map((row) => this.rowToSummary(row));
  }

  async delete(id: number): Promise<boolean> {
    const result = await this.client.query(
      'DELETE FROM session_summaries WHERE id = $1',
      [id]
    );

    return (result.rowCount ?? 0) > 0;
  }

  async deleteOlderThan(epochMs: number): Promise<number> {
    const result = await this.client.query(
      'DELETE FROM session_summaries WHERE created_at_epoch < $1',
      [epochMs]
    );

    return result.rowCount ?? 0;
  }

  async existsForSession(memorySessionId: string): Promise<boolean> {
    const result = await this.client.query(
      'SELECT 1 FROM session_summaries WHERE memory_session_id = $1',
      [memorySessionId]
    );

    return result.rows.length > 0;
  }

  async count(options: SummaryQueryOptions = {}): Promise<number> {
    const { project, since_epoch, until_epoch } = options;

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (project) {
      conditions.push(`project = $${paramIndex++}`);
      params.push(project);
    }

    if (since_epoch) {
      conditions.push(`created_at_epoch >= $${paramIndex++}`);
      params.push(since_epoch);
    }

    if (until_epoch) {
      conditions.push(`created_at_epoch <= $${paramIndex++}`);
      params.push(until_epoch);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await this.client.query(
      `SELECT COUNT(*) as count FROM session_summaries ${whereClause}`,
      params
    );

    return parseInt(result.rows[0]?.count || '0', 10);
  }

  private rowToSummary(row: any): StoredSessionSummary {
    return {
      id: row.id,
      memory_session_id: row.memory_session_id,
      project: row.project,
      request: row.request,
      investigated: row.investigated,
      learned: row.learned,
      completed: row.completed,
      next_steps: row.next_steps,
      notes: row.notes,
      files_read: typeof row.files_read === 'string' ? JSON.parse(row.files_read) : row.files_read,
      files_edited: typeof row.files_edited === 'string' ? JSON.parse(row.files_edited) : row.files_edited,
      prompt_number: row.prompt_number,
      discovery_tokens: row.discovery_tokens || 0,
      embedding: row.embedding ? this.parseEmbedding(row.embedding) : undefined,
      created_at: row.created_at,
      created_at_epoch: parseInt(row.created_at_epoch, 10),
    };
  }

  private parseEmbedding(embedding: any): number[] | undefined {
    if (!embedding) return undefined;
    if (Array.isArray(embedding)) return embedding;
    if (typeof embedding === 'string') {
      try { return JSON.parse(embedding); } catch { return undefined; }
    }
    return undefined;
  }
}

export class PostgresWeeklySummaryStore implements IWeeklySummaryStore {
  private client: PostgresClient;

  constructor(client?: PostgresClient) {
    this.client = client || getPostgresClient();
  }

  async store(summary: WeeklySummaryInput): Promise<StoredWeeklySummary> {
    const now = Date.now();
    const createdAt = new Date(now).toISOString();

    let embedding = summary.embedding;
    if (!embedding) {
      try {
        const embeddingService = getOllamaEmbeddingService();
        if (await embeddingService.isAvailable()) {
          embedding = await embeddingService.generateEmbedding(summary.summary_text);
        }
      } catch (err) {
        console.warn('[PostgresWeeklySummaryStore] Failed to generate embedding:', err);
      }
    }

    const result = await this.client.query<StoredWeeklySummary>(
      `INSERT INTO weekly_summaries (
        project, week_start, summary_text, key_topics,
        embedding, source_session_ids, created_at, created_at_epoch
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (project, week_start) DO UPDATE SET
        summary_text = EXCLUDED.summary_text,
        key_topics = EXCLUDED.key_topics,
        embedding = EXCLUDED.embedding,
        source_session_ids = EXCLUDED.source_session_ids
      RETURNING *`,
      [
        summary.project,
        summary.week_start,
        summary.summary_text,
        JSON.stringify(summary.key_topics || []),
        embedding ? `[${embedding.join(',')}]` : null,
        summary.source_session_ids,
        createdAt,
        now,
      ]
    );

    return this.rowToWeeklySummary(result.rows[0]);
  }

  async getByWeek(project: string, weekStart: string): Promise<StoredWeeklySummary | null> {
    const result = await this.client.query(
      'SELECT * FROM weekly_summaries WHERE project = $1 AND week_start = $2',
      [project, weekStart]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.rowToWeeklySummary(result.rows[0]);
  }

  async getRecent(project: string, limit: number = 10): Promise<StoredWeeklySummary[]> {
    const result = await this.client.query(
      `SELECT * FROM weekly_summaries
       WHERE project = $1
       ORDER BY week_start DESC
       LIMIT $2`,
      [project, limit]
    );

    return result.rows.map((row) => this.rowToWeeklySummary(row));
  }

  async areSessionsSummarized(sessionIds: number[]): Promise<boolean> {
    if (sessionIds.length === 0) {
      return true;
    }

    const result = await this.client.query(
      `SELECT 1 FROM weekly_summaries
       WHERE source_session_ids && $1
       LIMIT 1`,
      [sessionIds]
    );

    return result.rows.length > 0;
  }

  private rowToWeeklySummary(row: any): StoredWeeklySummary {
    return {
      id: row.id,
      project: row.project,
      week_start: row.week_start,
      summary_text: row.summary_text,
      key_topics: typeof row.key_topics === 'string' ? JSON.parse(row.key_topics) : row.key_topics,
      embedding: row.embedding ? this.parseEmbedding(row.embedding) : undefined,
      source_session_ids: row.source_session_ids || [],
      created_at: row.created_at,
      created_at_epoch: parseInt(row.created_at_epoch, 10),
    };
  }

  private parseEmbedding(embedding: any): number[] | undefined {
    if (!embedding) return undefined;
    if (Array.isArray(embedding)) return embedding;
    if (typeof embedding === 'string') {
      try { return JSON.parse(embedding); } catch { return undefined; }
    }
    return undefined;
  }
}

export class PostgresProjectFactStore implements IProjectFactStore {
  private client: PostgresClient;

  constructor(client?: PostgresClient) {
    this.client = client || getPostgresClient();
  }

  async store(fact: ProjectFactInput): Promise<StoredProjectFact> {
    const now = Date.now();
    const createdAt = new Date(now).toISOString();

    let embedding = fact.embedding;
    if (!embedding) {
      try {
        const embeddingService = getOllamaEmbeddingService();
        if (await embeddingService.isAvailable()) {
          embedding = await embeddingService.generateEmbedding(fact.fact_text);
        }
      } catch (err) {
        console.warn('[PostgresProjectFactStore] Failed to generate embedding:', err);
      }
    }

    const result = await this.client.query<StoredProjectFact>(
      `INSERT INTO project_facts (
        project, fact_text, fact_type, confidence,
        embedding, created_at, created_at_epoch
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *`,
      [
        fact.project,
        fact.fact_text,
        fact.fact_type || 'general',
        fact.confidence ?? 1.0,
        embedding ? `[${embedding.join(',')}]` : null,
        createdAt,
        now,
      ]
    );

    return this.rowToFact(result.rows[0]);
  }

  async storeBatch(facts: ProjectFactInput[]): Promise<StoredProjectFact[]> {
    const results: StoredProjectFact[] = [];
    for (const fact of facts) {
      const stored = await this.store(fact);
      results.push(stored);
    }
    return results;
  }

  async getByProject(project: string, limit: number = 100): Promise<StoredProjectFact[]> {
    const result = await this.client.query(
      `SELECT * FROM project_facts
       WHERE project = $1
       ORDER BY confidence DESC, created_at_epoch DESC
       LIMIT $2`,
      [project, limit]
    );

    return result.rows.map((row) => this.rowToFact(row));
  }

  async delete(id: number): Promise<boolean> {
    const result = await this.client.query(
      'DELETE FROM project_facts WHERE id = $1',
      [id]
    );

    return (result.rowCount ?? 0) > 0;
  }

  async deleteByProject(project: string): Promise<number> {
    const result = await this.client.query(
      'DELETE FROM project_facts WHERE project = $1',
      [project]
    );

    return result.rowCount ?? 0;
  }

  private rowToFact(row: any): StoredProjectFact {
    return {
      id: row.id,
      project: row.project,
      fact_text: row.fact_text,
      fact_type: row.fact_type,
      confidence: parseFloat(row.confidence),
      embedding: row.embedding ? this.parseEmbedding(row.embedding) : undefined,
      created_at: row.created_at,
      created_at_epoch: parseInt(row.created_at_epoch, 10),
    };
  }

  private parseEmbedding(embedding: any): number[] | undefined {
    if (!embedding) return undefined;
    if (Array.isArray(embedding)) return embedding;
    if (typeof embedding === 'string') {
      try { return JSON.parse(embedding); } catch { return undefined; }
    }
    return undefined;
  }
}

// Singleton instances
let summaryStoreInstance: PostgresSummaryStore | null = null;
let weeklySummaryStoreInstance: PostgresWeeklySummaryStore | null = null;
let projectFactStoreInstance: PostgresProjectFactStore | null = null;

export function getPostgresSummaryStore(): PostgresSummaryStore {
  if (!summaryStoreInstance) {
    summaryStoreInstance = new PostgresSummaryStore();
  }
  return summaryStoreInstance;
}

export function getPostgresWeeklySummaryStore(): PostgresWeeklySummaryStore {
  if (!weeklySummaryStoreInstance) {
    weeklySummaryStoreInstance = new PostgresWeeklySummaryStore();
  }
  return weeklySummaryStoreInstance;
}

export function getPostgresProjectFactStore(): PostgresProjectFactStore {
  if (!projectFactStoreInstance) {
    projectFactStoreInstance = new PostgresProjectFactStore();
  }
  return projectFactStoreInstance;
}
