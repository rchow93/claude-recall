/**
 * Interface for search operations
 * Supports vector similarity, full-text, and hybrid search
 */

import type { StoredObservation } from './IObservationStore.js';
import type { StoredSessionSummary, StoredWeeklySummary, StoredProjectFact } from './ISummaryStore.js';

export interface SearchResult<T> {
  item: T;
  score: number; // 0-1, higher is better
  source: 'vector' | 'bm25' | 'hybrid';
}

export interface VectorSearchOptions {
  embedding: number[];
  limit?: number;
  project?: string;
  types?: string[];
  since_epoch?: number;
  until_epoch?: number;
  minScore?: number;
}

export interface TextSearchOptions {
  query: string;
  limit?: number;
  project?: string;
  types?: string[];
  since_epoch?: number;
  until_epoch?: number;
}

export interface HybridSearchOptions {
  query: string;
  embedding: number[];
  limit?: number;
  project?: string;
  types?: string[];
  since_epoch?: number;
  until_epoch?: number;
  vectorWeight?: number; // 0-1, default 0.5
  useReranker?: boolean;
  minScore?: number; // Minimum score threshold (0-1)
}

export interface IObservationSearchEngine {
  /**
   * Vector similarity search
   */
  vectorSearch(options: VectorSearchOptions): Promise<SearchResult<StoredObservation>[]>;

  /**
   * Full-text search (BM25 on PostgreSQL, basic on Redis)
   */
  textSearch(options: TextSearchOptions): Promise<SearchResult<StoredObservation>[]>;

  /**
   * Hybrid search combining vector and text with RRF fusion
   */
  hybridSearch(options: HybridSearchOptions): Promise<SearchResult<StoredObservation>[]>;

  /**
   * Index an observation (generate embedding if needed)
   */
  index(observation: StoredObservation): Promise<void>;

  /**
   * Index multiple observations
   */
  indexBatch(observations: StoredObservation[]): Promise<void>;

  /**
   * Remove observation from index
   */
  removeFromIndex(id: number): Promise<void>;
}

export interface ISummarySearchEngine {
  /**
   * Vector similarity search for summaries
   */
  vectorSearch(options: VectorSearchOptions): Promise<SearchResult<StoredSessionSummary>[]>;

  /**
   * Full-text search for summaries
   */
  textSearch(options: TextSearchOptions): Promise<SearchResult<StoredSessionSummary>[]>;

  /**
   * Hybrid search for summaries
   */
  hybridSearch(options: HybridSearchOptions): Promise<SearchResult<StoredSessionSummary>[]>;

  /**
   * Index a summary
   */
  index(summary: StoredSessionSummary): Promise<void>;

  /**
   * Remove summary from index
   */
  removeFromIndex(id: number): Promise<void>;
}

export interface IWeeklySummarySearchEngine {
  /**
   * Vector similarity search for weekly summaries
   */
  vectorSearch(options: VectorSearchOptions): Promise<SearchResult<StoredWeeklySummary>[]>;

  /**
   * Index a weekly summary
   */
  index(summary: StoredWeeklySummary): Promise<void>;
}

export interface IProjectFactSearchEngine {
  /**
   * Vector similarity search for project facts
   */
  vectorSearch(options: VectorSearchOptions): Promise<SearchResult<StoredProjectFact>[]>;

  /**
   * Index a project fact
   */
  index(fact: StoredProjectFact): Promise<void>;
}

/**
 * Reciprocal Rank Fusion helper
 * Combines results from multiple search methods
 */
export function reciprocalRankFusion<T extends { id: number }>(
  vectorResults: SearchResult<T>[],
  textResults: SearchResult<T>[],
  options: { k?: number } = {}
): SearchResult<T>[] {
  const k = options.k ?? 60;
  const scoreMap = new Map<number, { item: T; score: number }>();

  // Process vector results
  vectorResults.forEach((result, rank) => {
    const rrfScore = 1 / (k + rank + 1);
    const existing = scoreMap.get(result.item.id);
    if (existing) {
      existing.score += rrfScore;
    } else {
      scoreMap.set(result.item.id, { item: result.item, score: rrfScore });
    }
  });

  // Process text results
  textResults.forEach((result, rank) => {
    const rrfScore = 1 / (k + rank + 1);
    const existing = scoreMap.get(result.item.id);
    if (existing) {
      existing.score += rrfScore;
    } else {
      scoreMap.set(result.item.id, { item: result.item, score: rrfScore });
    }
  });

  // Sort by combined score and return
  return Array.from(scoreMap.values())
    .sort((a, b) => b.score - a.score)
    .map(({ item, score }) => ({
      item,
      score,
      source: 'hybrid' as const
    }));
}
