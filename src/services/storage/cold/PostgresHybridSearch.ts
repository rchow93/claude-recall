/**
 * PostgreSQL Hybrid Search Implementation
 * Combines pgvector similarity search with BM25 text search using RRF
 */

import { getPostgresClient, type PostgresClient } from './PostgresClient.js';
import type {
  IObservationSearchEngine,
  ISummarySearchEngine,
  SearchResult,
  VectorSearchOptions,
  TextSearchOptions,
  HybridSearchOptions,
} from '../interfaces/ISearchEngine.js';
import { reciprocalRankFusion } from '../interfaces/ISearchEngine.js';
import type { StoredObservation } from '../interfaces/IObservationStore.js';
import type { StoredSessionSummary } from '../interfaces/ISummaryStore.js';
import {
  getOllamaEmbeddingService,
  createObservationSearchText,
  createSummarySearchText,
} from '../embedding/OllamaEmbedding.js';
import { getTieredStorageConfig } from '../config.js';

export class PostgresObservationSearch implements IObservationSearchEngine {
  private client: PostgresClient;

  constructor(client?: PostgresClient) {
    this.client = client || getPostgresClient();
  }

  async vectorSearch(options: VectorSearchOptions): Promise<SearchResult<StoredObservation>[]> {
    const {
      embedding,
      limit = 10,
      project,
      types,
      since_epoch,
      until_epoch,
      minScore = 0,
    } = options;

    const conditions: string[] = ['embedding IS NOT NULL'];
    const params: any[] = [`[${embedding.join(',')}]`];
    let paramIndex = 2;

    if (project) {
      conditions.push(`project = $${paramIndex++}`);
      params.push(project);
    }

    if (types && types.length > 0) {
      conditions.push(`type = ANY($${paramIndex++})`);
      params.push(types);
    }

    if (since_epoch) {
      conditions.push(`created_at_epoch >= $${paramIndex++}`);
      params.push(since_epoch);
    }

    if (until_epoch) {
      conditions.push(`created_at_epoch <= $${paramIndex++}`);
      params.push(until_epoch);
    }

    const whereClause = conditions.join(' AND ');
    params.push(limit * 2); // Fetch extra for filtering

    const result = await this.client.query(
      `SELECT *,
              1 - (embedding <=> $1::vector) as similarity_score
       FROM observations
       WHERE ${whereClause}
       ORDER BY embedding <=> $1::vector
       LIMIT $${paramIndex}`,
      params
    );

    return result.rows
      .filter((row) => row.similarity_score >= minScore)
      .slice(0, limit)
      .map((row) => ({
        item: this.rowToObservation(row),
        score: row.similarity_score,
        source: 'vector' as const,
      }));
  }

  async textSearch(options: TextSearchOptions): Promise<SearchResult<StoredObservation>[]> {
    const {
      query,
      limit = 10,
      project,
      types,
      since_epoch,
      until_epoch,
    } = options;

    const conditions: string[] = [
      `to_tsvector('english', coalesce(title,'') || ' ' || coalesce(narrative,'')) @@ plainto_tsquery('english', $1)`,
    ];
    const params: any[] = [query];
    let paramIndex = 2;

    if (project) {
      conditions.push(`project = $${paramIndex++}`);
      params.push(project);
    }

    if (types && types.length > 0) {
      conditions.push(`type = ANY($${paramIndex++})`);
      params.push(types);
    }

    if (since_epoch) {
      conditions.push(`created_at_epoch >= $${paramIndex++}`);
      params.push(since_epoch);
    }

    if (until_epoch) {
      conditions.push(`created_at_epoch <= $${paramIndex++}`);
      params.push(until_epoch);
    }

    const whereClause = conditions.join(' AND ');
    params.push(limit);

    const result = await this.client.query(
      `SELECT *,
              ts_rank(
                to_tsvector('english', coalesce(title,'') || ' ' || coalesce(narrative,'')),
                plainto_tsquery('english', $1)
              ) as bm25_score
       FROM observations
       WHERE ${whereClause}
       ORDER BY bm25_score DESC
       LIMIT $${paramIndex}`,
      params
    );

    // Normalize BM25 scores to 0-1 range
    const maxScore = result.rows.length > 0 ? Math.max(...result.rows.map(r => r.bm25_score)) : 1;

    return result.rows.map((row) => ({
      item: this.rowToObservation(row),
      score: maxScore > 0 ? row.bm25_score / maxScore : 0,
      source: 'bm25' as const,
    }));
  }

  async hybridSearch(options: HybridSearchOptions): Promise<SearchResult<StoredObservation>[]> {
    const {
      query,
      embedding,
      limit = 10,
      project,
      types,
      since_epoch,
      until_epoch,
      vectorWeight = 0.5,
      useReranker = false,
    } = options;

    // Execute both searches in parallel
    const [vectorResults, textResults] = await Promise.all([
      this.vectorSearch({
        embedding,
        limit: limit * 2,
        project,
        types,
        since_epoch,
        until_epoch,
      }),
      this.textSearch({
        query,
        limit: limit * 2,
        project,
        types,
        since_epoch,
        until_epoch,
      }),
    ]);

    // Apply RRF fusion
    let fused = reciprocalRankFusion(vectorResults, textResults, { k: 60 });

    // Optionally apply reranker
    if (useReranker && fused.length > 0) {
      const config = getTieredStorageConfig();
      if (config.search.rerankerUrl) {
        try {
          fused = await this.applyReranker(query, fused, config.search.rerankerUrl);
        } catch (err) {
          console.warn('[PostgresObservationSearch] Reranker failed, using RRF results:', err);
        }
      }
    }

    return fused.slice(0, limit);
  }

  async index(observation: StoredObservation): Promise<void> {
    if (observation.embedding) {
      return; // Already has embedding
    }

    const embeddingService = getOllamaEmbeddingService();
    if (!(await embeddingService.isAvailable())) {
      return;
    }

    const searchText = createObservationSearchText(observation);
    if (!searchText) {
      return;
    }

    try {
      const embedding = await embeddingService.generateEmbedding(searchText);
      await this.client.query(
        'UPDATE observations SET embedding = $1 WHERE id = $2',
        [`[${embedding.join(',')}]`, observation.id]
      );
    } catch (err) {
      console.warn('[PostgresObservationSearch] Failed to index observation:', err);
    }
  }

  async indexBatch(observations: StoredObservation[]): Promise<void> {
    const toIndex = observations.filter((o) => !o.embedding);
    if (toIndex.length === 0) {
      return;
    }

    const embeddingService = getOllamaEmbeddingService();
    if (!(await embeddingService.isAvailable())) {
      return;
    }

    for (const observation of toIndex) {
      await this.index(observation);
    }
  }

  async removeFromIndex(id: number): Promise<void> {
    await this.client.query(
      'UPDATE observations SET embedding = NULL WHERE id = $1',
      [id]
    );
  }

  /**
   * Apply reranker to results
   */
  private async applyReranker(
    query: string,
    results: SearchResult<StoredObservation>[],
    rerankerUrl: string
  ): Promise<SearchResult<StoredObservation>[]> {
    const documents = results.map((r) =>
      createObservationSearchText(r.item)
    );

    const response = await fetch(`${rerankerUrl}/rerank`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        documents,
        top_k: results.length,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`Reranker request failed: ${response.statusText}`);
    }

    const data = await response.json() as {
      results: Array<{ index: number; score: number }>;
    };

    // Reorder based on reranker scores
    return data.results.map(({ index, score }) => ({
      item: results[index].item,
      score,
      source: 'hybrid' as const,
    }));
  }

  private rowToObservation(row: any): StoredObservation {
    return {
      id: row.id,
      memory_session_id: row.memory_session_id,
      project: row.project,
      type: row.type,
      title: row.title,
      subtitle: row.subtitle,
      facts: typeof row.facts === 'string' ? JSON.parse(row.facts) : row.facts,
      narrative: row.narrative,
      concepts: typeof row.concepts === 'string' ? JSON.parse(row.concepts) : row.concepts,
      files_read: typeof row.files_read === 'string' ? JSON.parse(row.files_read) : row.files_read,
      files_modified: typeof row.files_modified === 'string' ? JSON.parse(row.files_modified) : row.files_modified,
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
      try {
        return JSON.parse(embedding);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

export class PostgresSummarySearch implements ISummarySearchEngine {
  private client: PostgresClient;

  constructor(client?: PostgresClient) {
    this.client = client || getPostgresClient();
  }

  async vectorSearch(options: VectorSearchOptions): Promise<SearchResult<StoredSessionSummary>[]> {
    const {
      embedding,
      limit = 10,
      project,
      since_epoch,
      until_epoch,
      minScore = 0,
    } = options;

    const conditions: string[] = ['embedding IS NOT NULL'];
    const params: any[] = [`[${embedding.join(',')}]`];
    let paramIndex = 2;

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

    const whereClause = conditions.join(' AND ');
    params.push(limit * 2);

    const result = await this.client.query(
      `SELECT *,
              1 - (embedding <=> $1::vector) as similarity_score
       FROM session_summaries
       WHERE ${whereClause}
       ORDER BY embedding <=> $1::vector
       LIMIT $${paramIndex}`,
      params
    );

    return result.rows
      .filter((row) => row.similarity_score >= minScore)
      .slice(0, limit)
      .map((row) => ({
        item: this.rowToSummary(row),
        score: row.similarity_score,
        source: 'vector' as const,
      }));
  }

  async textSearch(options: TextSearchOptions): Promise<SearchResult<StoredSessionSummary>[]> {
    const {
      query,
      limit = 10,
      project,
      since_epoch,
      until_epoch,
    } = options;

    const conditions: string[] = [
      `to_tsvector('english',
        coalesce(request,'') || ' ' ||
        coalesce(investigated,'') || ' ' ||
        coalesce(learned,'') || ' ' ||
        coalesce(completed,'')
      ) @@ plainto_tsquery('english', $1)`,
    ];
    const params: any[] = [query];
    let paramIndex = 2;

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

    const whereClause = conditions.join(' AND ');
    params.push(limit);

    const result = await this.client.query(
      `SELECT *,
              ts_rank(
                to_tsvector('english',
                  coalesce(request,'') || ' ' ||
                  coalesce(investigated,'') || ' ' ||
                  coalesce(learned,'') || ' ' ||
                  coalesce(completed,'')
                ),
                plainto_tsquery('english', $1)
              ) as bm25_score
       FROM session_summaries
       WHERE ${whereClause}
       ORDER BY bm25_score DESC
       LIMIT $${paramIndex}`,
      params
    );

    const maxScore = result.rows.length > 0 ? Math.max(...result.rows.map(r => r.bm25_score)) : 1;

    return result.rows.map((row) => ({
      item: this.rowToSummary(row),
      score: maxScore > 0 ? row.bm25_score / maxScore : 0,
      source: 'bm25' as const,
    }));
  }

  async hybridSearch(options: HybridSearchOptions): Promise<SearchResult<StoredSessionSummary>[]> {
    const {
      query,
      embedding,
      limit = 10,
      project,
      since_epoch,
      until_epoch,
    } = options;

    const [vectorResults, textResults] = await Promise.all([
      this.vectorSearch({
        embedding,
        limit: limit * 2,
        project,
        since_epoch,
        until_epoch,
      }),
      this.textSearch({
        query,
        limit: limit * 2,
        project,
        since_epoch,
        until_epoch,
      }),
    ]);

    const fused = reciprocalRankFusion(vectorResults, textResults, { k: 60 });
    return fused.slice(0, limit);
  }

  async index(summary: StoredSessionSummary): Promise<void> {
    if (summary.embedding) {
      return;
    }

    const embeddingService = getOllamaEmbeddingService();
    if (!(await embeddingService.isAvailable())) {
      return;
    }

    const searchText = createSummarySearchText(summary);
    if (!searchText) {
      return;
    }

    try {
      const embedding = await embeddingService.generateEmbedding(searchText);
      await this.client.query(
        'UPDATE session_summaries SET embedding = $1 WHERE id = $2',
        [`[${embedding.join(',')}]`, summary.id]
      );
    } catch (err) {
      console.warn('[PostgresSummarySearch] Failed to index summary:', err);
    }
  }

  async removeFromIndex(id: number): Promise<void> {
    await this.client.query(
      'UPDATE session_summaries SET embedding = NULL WHERE id = $1',
      [id]
    );
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
      try {
        return JSON.parse(embedding);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

/**
 * Singleton instances
 */
let obsSearchInstance: PostgresObservationSearch | null = null;
let summarySearchInstance: PostgresSummarySearch | null = null;

export function getPostgresObservationSearch(): PostgresObservationSearch {
  if (!obsSearchInstance) {
    obsSearchInstance = new PostgresObservationSearch();
  }
  return obsSearchInstance;
}

export function getPostgresSummarySearch(): PostgresSummarySearch {
  if (!summarySearchInstance) {
    summarySearchInstance = new PostgresSummarySearch();
  }
  return summarySearchInstance;
}
