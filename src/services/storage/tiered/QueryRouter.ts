/**
 * Query Router
 * Routes search queries to appropriate tier(s) and merges results
 * Supports hot-first lookup with cold fallback for RAG retrieval
 */

import {
  getRedisObservationSearch,
  type RedisObservationSearch,
} from '../hot/RedisObservationStore.js';
import {
  getPostgresObservationSearch,
  getPostgresSummarySearch,
  type PostgresObservationSearch,
  type PostgresSummarySearch,
} from '../cold/PostgresHybridSearch.js';
import { getRedisClient } from '../hot/RedisClient.js';
import type { SearchResult, HybridSearchOptions } from '../interfaces/ISearchEngine.js';
import type { StoredObservation } from '../interfaces/IObservationStore.js';
import type { StoredSessionSummary } from '../interfaces/ISummaryStore.js';
import {
  getOllamaEmbeddingService,
  type OllamaEmbeddingService,
} from '../embedding/OllamaEmbedding.js';
import { getTieredStorageConfig } from '../config.js';

export interface RAGQueryOptions {
  query: string;
  project?: string;
  limit?: number;
  includeObservations?: boolean;
  includeSummaries?: boolean;
  minScore?: number;
  maxTokens?: number;
}

export interface RAGResult {
  observations: SearchResult<StoredObservation>[];
  summaries: SearchResult<StoredSessionSummary>[];
  queryTimeMs: number;
  hotTierHit: boolean;
}

export class QueryRouter {
  private hotObsSearch: RedisObservationSearch | null = null;
  private coldObsSearch: PostgresObservationSearch;
  private coldSummarySearch: PostgresSummarySearch;
  private embeddingService: OllamaEmbeddingService;
  private redisAvailable: boolean = false;

  constructor() {
    this.coldObsSearch = getPostgresObservationSearch();
    this.coldSummarySearch = getPostgresSummarySearch();
    this.embeddingService = getOllamaEmbeddingService();
  }

  /**
   * Initialize the query router
   */
  async initialize(): Promise<void> {
    try {
      const redisClient = getRedisClient();
      if (await redisClient.isAvailable()) {
        this.hotObsSearch = getRedisObservationSearch();
        this.redisAvailable = true;
        console.log('[QueryRouter] Redis hot tier search available');
      }
    } catch {
      this.redisAvailable = false;
    }
  }

  /**
   * Execute a RAG query with hot-first strategy
   *
   * Strategy:
   * 1. Generate embedding for query
   * 2. Try hot tier first (Redis) - fast ~1-5ms
   * 3. If insufficient results, query cold tier (PostgreSQL) - ~100-200ms
   * 4. Merge and deduplicate results
   */
  async queryForRAG(options: RAGQueryOptions): Promise<RAGResult> {
    const startTime = Date.now();
    const {
      query,
      project,
      limit = 10,
      includeObservations = true,
      includeSummaries = true,
      minScore = 0.3,
    } = options;

    const config = getTieredStorageConfig();
    const hotTierCutoff = Date.now() - (config.redis.hotTierTTL * 1000);

    // Generate embedding for query
    let embedding: number[] | null = null;
    try {
      if (await this.embeddingService.isAvailable()) {
        embedding = await this.embeddingService.generateEmbedding(query);
      }
    } catch (err) {
      console.warn('[QueryRouter] Failed to generate query embedding:', err);
    }

    const observations: SearchResult<StoredObservation>[] = [];
    const summaries: SearchResult<StoredSessionSummary>[] = [];
    let hotTierHit = false;

    // Query observations
    if (includeObservations) {
      // Try hot tier first
      if (this.redisAvailable && this.hotObsSearch && embedding) {
        try {
          const hotResults = await this.hotObsSearch.hybridSearch({
            query,
            embedding,
            limit,
            project,
            minScore,
          });

          if (hotResults.length >= limit * 0.7) {
            // Hot tier has enough results
            observations.push(...hotResults);
            hotTierHit = true;
          } else {
            // Need cold tier supplement
            const coldResults = await this.coldObsSearch.hybridSearch({
              query,
              embedding,
              limit: limit * 2,
              project,
              since_epoch: undefined, // Search all time in cold tier
            });

            // Merge and dedupe
            const hotIds = new Set(hotResults.map((r) => r.item.id));
            const deduped = coldResults.filter((r) => !hotIds.has(r.item.id));
            observations.push(...hotResults, ...deduped.slice(0, limit - hotResults.length));
          }
        } catch (err) {
          console.warn('[QueryRouter] Hot tier search failed:', err);
        }
      }

      // Fallback or supplement from cold tier
      if (observations.length < limit) {
        const needed = limit - observations.length;
        const existingIds = new Set(observations.map((r) => r.item.id));

        if (embedding) {
          const coldResults = await this.coldObsSearch.hybridSearch({
            query,
            embedding,
            limit: needed * 2,
            project,
            useReranker: config.search.useReranker,
          });

          const deduped = coldResults.filter((r) => !existingIds.has(r.item.id));
          observations.push(...deduped.slice(0, needed));
        } else {
          // Text-only fallback
          const textResults = await this.coldObsSearch.textSearch({
            query,
            limit: needed,
            project,
          });

          const deduped = textResults.filter((r) => !existingIds.has(r.item.id));
          observations.push(...deduped);
        }
      }
    }

    // Query summaries (cold tier only for now)
    if (includeSummaries && embedding) {
      const summaryResults = await this.coldSummarySearch.hybridSearch({
        query,
        embedding,
        limit: Math.ceil(limit / 2),
        project,
      });
      summaries.push(...summaryResults);
    }

    // Sort by score
    observations.sort((a, b) => b.score - a.score);
    summaries.sort((a, b) => b.score - a.score);

    return {
      observations: observations.slice(0, limit),
      summaries: summaries.slice(0, Math.ceil(limit / 2)),
      queryTimeMs: Date.now() - startTime,
      hotTierHit,
    };
  }

  /**
   * Quick search for recent relevant context (optimized for per-prompt RAG)
   */
  async quickSearch(
    query: string,
    project: string,
    limit: number = 5
  ): Promise<SearchResult<StoredObservation>[]> {
    // Generate embedding
    let embedding: number[] | null = null;
    try {
      if (await this.embeddingService.isAvailable()) {
        embedding = await this.embeddingService.generateEmbedding(query);
      }
    } catch {
      // Text-only fallback
    }

    // Hot tier only for quick search
    if (this.redisAvailable && this.hotObsSearch && embedding) {
      try {
        return await this.hotObsSearch.vectorSearch({
          embedding,
          limit,
          project,
        });
      } catch {
        // Fallback to cold
      }
    }

    // Cold tier fallback
    if (embedding) {
      return await this.coldObsSearch.vectorSearch({
        embedding,
        limit,
        project,
      });
    }

    // Text-only fallback
    return await this.coldObsSearch.textSearch({
      query,
      limit,
      project,
    });
  }

  /**
   * Format RAG results for context injection
   */
  formatForInjection(result: RAGResult, tokenBudget: number = 2000): string {
    const parts: string[] = [];
    const CHARS_PER_TOKEN = 4;
    let remainingChars = tokenBudget * CHARS_PER_TOKEN;

    // Add observations (higher priority)
    if (result.observations.length > 0) {
      parts.push('## Relevant Past Work\n');
      remainingChars -= 25;

      for (const { item, score } of result.observations) {
        if (remainingChars <= 0) break;

        const obsText = this.formatObservation(item, score);
        if (obsText.length <= remainingChars) {
          parts.push(obsText);
          remainingChars -= obsText.length;
        }
      }
    }

    // Add summaries
    if (result.summaries.length > 0 && remainingChars > 200) {
      parts.push('\n## Recent Session Summaries\n');
      remainingChars -= 30;

      for (const { item, score } of result.summaries) {
        if (remainingChars <= 0) break;

        const summaryText = this.formatSummary(item, score);
        if (summaryText.length <= remainingChars) {
          parts.push(summaryText);
          remainingChars -= summaryText.length;
        }
      }
    }

    return parts.join('\n');
  }

  private formatObservation(obs: StoredObservation, score: number): string {
    const parts: string[] = [];

    // Type and title
    parts.push(`### [${obs.type}] ${obs.title || 'Untitled'}`);

    // Subtitle if present
    if (obs.subtitle) {
      parts.push(`_${obs.subtitle}_`);
    }

    // Narrative or facts
    if (obs.narrative) {
      parts.push(obs.narrative);
    } else if (obs.facts && obs.facts.length > 0) {
      parts.push(obs.facts.map((f) => `- ${f}`).join('\n'));
    }

    // Files if present
    if (obs.files_modified && obs.files_modified.length > 0) {
      parts.push(`Files: ${obs.files_modified.slice(0, 3).join(', ')}`);
    }

    parts.push('');
    return parts.join('\n');
  }

  private formatSummary(summary: StoredSessionSummary, score: number): string {
    const parts: string[] = [];

    if (summary.request) {
      parts.push(`**Request:** ${summary.request}`);
    }
    if (summary.completed) {
      parts.push(`**Completed:** ${summary.completed}`);
    }
    if (summary.learned) {
      parts.push(`**Learned:** ${summary.learned}`);
    }

    parts.push('');
    return parts.join('\n');
  }
}

// Singleton instance
let queryRouterInstance: QueryRouter | null = null;

export function getQueryRouter(): QueryRouter {
  if (!queryRouterInstance) {
    queryRouterInstance = new QueryRouter();
  }
  return queryRouterInstance;
}

export async function initializeQueryRouter(): Promise<QueryRouter> {
  const router = getQueryRouter();
  await router.initialize();
  return router;
}
