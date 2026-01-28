/**
 * TieredSearchStrategy - pgvector hybrid search via QueryRouter
 *
 * Replaces ChromaSearchStrategy and HybridSearchStrategy.
 * Routes all semantic search through the tiered storage layer
 * (Redis hot tier + PostgreSQL cold tier with pgvector + BM25 + RRF).
 *
 * Used when: Query text is provided and QueryRouter is available
 */

import { BaseSearchStrategy, SearchStrategy } from './SearchStrategy.js';
import {
  StrategySearchOptions,
  StrategySearchResult,
  SEARCH_CONSTANTS,
  ObservationSearchResult,
  SessionSummarySearchResult
} from '../types.js';
import type { QueryRouter } from '../../../storage/tiered/QueryRouter.js';
import { SessionStore } from '../../../sqlite/SessionStore.js';
import { SessionSearch } from '../../../sqlite/SessionSearch.js';
import { logger } from '../../../../utils/logger.js';

export class TieredSearchStrategy extends BaseSearchStrategy implements SearchStrategy {
  readonly name = 'tiered';

  constructor(
    private queryRouter: QueryRouter,
    private sessionStore: SessionStore,
    private sessionSearch: SessionSearch
  ) {
    super();
  }

  canHandle(options: StrategySearchOptions): boolean {
    return !!options.query && !!this.queryRouter;
  }

  async search(options: StrategySearchOptions): Promise<StrategySearchResult> {
    const {
      query,
      searchType = 'all',
      obsType,
      concepts,
      files,
      limit = SEARCH_CONSTANTS.DEFAULT_LIMIT,
      project,
      orderBy = 'date_desc'
    } = options;

    if (!query) {
      return this.emptyResult('tiered');
    }

    const searchObservations = searchType === 'all' || searchType === 'observations';
    const searchSessions = searchType === 'all' || searchType === 'sessions';

    let observations: ObservationSearchResult[] = [];
    let sessions: SessionSummarySearchResult[] = [];

    try {
      logger.debug('SEARCH', 'TieredSearchStrategy: Querying via QueryRouter', { query, searchType });

      const ragResult = await this.queryRouter.queryForRAG({
        query,
        project,
        limit: limit * 2,
        includeObservations: searchObservations,
        includeSummaries: searchSessions,
        minScore: 0.3
      });

      logger.debug('SEARCH', 'TieredSearchStrategy: QueryRouter returned', {
        observations: ragResult.observations.length,
        summaries: ragResult.summaries.length,
        queryTimeMs: ragResult.queryTimeMs,
        hotTierHit: ragResult.hotTierHit
      });

      // Extract IDs from RAG results and hydrate from SQLite
      if (ragResult.observations.length > 0 && searchObservations) {
        const obsIds = ragResult.observations.map(r => r.item.id);
        const obsOptions = { type: obsType, concepts, files, orderBy, limit, project };
        observations = this.sessionStore.getObservationsByIds(obsIds, obsOptions);
        // Preserve QueryRouter relevance ranking
        const idOrder = new Map(obsIds.map((id, idx) => [id, idx]));
        observations.sort((a, b) => (idOrder.get(a.id) ?? Infinity) - (idOrder.get(b.id) ?? Infinity));
      }

      if (ragResult.summaries.length > 0 && searchSessions) {
        const summaryIds = ragResult.summaries.map(r => r.item.id);
        sessions = this.sessionStore.getSessionSummariesByIds(summaryIds, {
          orderBy,
          limit,
          project
        });
        const idOrder = new Map(summaryIds.map((id, idx) => [id, idx]));
        sessions.sort((a, b) => (idOrder.get(a.id) ?? Infinity) - (idOrder.get(b.id) ?? Infinity));
      }

      logger.debug('SEARCH', 'TieredSearchStrategy: Hydrated results', {
        observations: observations.length,
        sessions: sessions.length
      });

      return {
        results: { observations, sessions, prompts: [] },
        usedTiered: true,
        fellBack: false,
        strategy: 'tiered'
      };

    } catch (error) {
      logger.error('SEARCH', 'TieredSearchStrategy: Search failed', {}, error as Error);
      return {
        results: { observations: [], sessions: [], prompts: [] },
        usedTiered: false,
        fellBack: false,
        strategy: 'tiered'
      };
    }
  }

  /**
   * Find observations by concept with tiered search ranking
   */
  async findByConcept(
    concept: string,
    options: StrategySearchOptions
  ): Promise<StrategySearchResult> {
    const { limit = SEARCH_CONSTANTS.DEFAULT_LIMIT, project, dateRange, orderBy } = options;
    const filterOptions = { limit, project, dateRange, orderBy };

    try {
      logger.debug('SEARCH', 'TieredSearchStrategy: findByConcept', { concept });

      // Step 1: SQLite metadata filter
      const metadataResults = this.sessionSearch.findByConcept(concept, filterOptions);
      if (metadataResults.length === 0) {
        return this.emptyResult('tiered');
      }

      // Step 2: Re-rank via QueryRouter
      const ragResult = await this.queryRouter.queryForRAG({
        query: concept,
        project,
        limit: Math.min(metadataResults.length, SEARCH_CONSTANTS.TIERED_BATCH_SIZE),
        includeObservations: true,
        includeSummaries: false,
        minScore: 0.2
      });

      // Step 3: Intersect metadata IDs with tiered results
      const metadataIds = new Set(metadataResults.map(obs => obs.id));
      const rankedIds = ragResult.observations
        .map(r => r.item.id)
        .filter(id => metadataIds.has(id));

      if (rankedIds.length > 0) {
        const observations = this.sessionStore.getObservationsByIds(rankedIds, { limit });
        const idOrder = new Map(rankedIds.map((id, idx) => [id, idx]));
        observations.sort((a, b) => (idOrder.get(a.id) ?? Infinity) - (idOrder.get(b.id) ?? Infinity));

        return {
          results: { observations, sessions: [], prompts: [] },
          usedTiered: true,
          fellBack: false,
          strategy: 'tiered'
        };
      }

      // Tiered search didn't match metadata candidates - return metadata results directly
      return {
        results: { observations: metadataResults.slice(0, limit), sessions: [], prompts: [] },
        usedTiered: false,
        fellBack: true,
        strategy: 'tiered'
      };

    } catch (error) {
      logger.error('SEARCH', 'TieredSearchStrategy: findByConcept failed', {}, error as Error);
      const results = this.sessionSearch.findByConcept(concept, filterOptions);
      return {
        results: { observations: results, sessions: [], prompts: [] },
        usedTiered: false,
        fellBack: true,
        strategy: 'tiered'
      };
    }
  }

  /**
   * Find observations by type with tiered search ranking
   */
  async findByType(
    type: string | string[],
    options: StrategySearchOptions
  ): Promise<StrategySearchResult> {
    const { limit = SEARCH_CONSTANTS.DEFAULT_LIMIT, project, dateRange, orderBy } = options;
    const filterOptions = { limit, project, dateRange, orderBy };
    const typeStr = Array.isArray(type) ? type.join(', ') : type;

    try {
      logger.debug('SEARCH', 'TieredSearchStrategy: findByType', { type: typeStr });

      const metadataResults = this.sessionSearch.findByType(type as any, filterOptions);
      if (metadataResults.length === 0) {
        return this.emptyResult('tiered');
      }

      const ragResult = await this.queryRouter.queryForRAG({
        query: typeStr,
        project,
        limit: Math.min(metadataResults.length, SEARCH_CONSTANTS.TIERED_BATCH_SIZE),
        includeObservations: true,
        includeSummaries: false,
        minScore: 0.2
      });

      const metadataIds = new Set(metadataResults.map(obs => obs.id));
      const rankedIds = ragResult.observations
        .map(r => r.item.id)
        .filter(id => metadataIds.has(id));

      if (rankedIds.length > 0) {
        const observations = this.sessionStore.getObservationsByIds(rankedIds, { limit });
        const idOrder = new Map(rankedIds.map((id, idx) => [id, idx]));
        observations.sort((a, b) => (idOrder.get(a.id) ?? Infinity) - (idOrder.get(b.id) ?? Infinity));

        return {
          results: { observations, sessions: [], prompts: [] },
          usedTiered: true,
          fellBack: false,
          strategy: 'tiered'
        };
      }

      return {
        results: { observations: metadataResults.slice(0, limit), sessions: [], prompts: [] },
        usedTiered: false,
        fellBack: true,
        strategy: 'tiered'
      };

    } catch (error) {
      logger.error('SEARCH', 'TieredSearchStrategy: findByType failed', {}, error as Error);
      const results = this.sessionSearch.findByType(type as any, filterOptions);
      return {
        results: { observations: results, sessions: [], prompts: [] },
        usedTiered: false,
        fellBack: true,
        strategy: 'tiered'
      };
    }
  }

  /**
   * Find observations and sessions by file path with tiered search ranking
   */
  async findByFile(
    filePath: string,
    options: StrategySearchOptions
  ): Promise<{
    observations: ObservationSearchResult[];
    sessions: SessionSummarySearchResult[];
    usedTiered: boolean;
  }> {
    const { limit = SEARCH_CONSTANTS.DEFAULT_LIMIT, project, dateRange, orderBy } = options;
    const filterOptions = { limit, project, dateRange, orderBy };

    try {
      logger.debug('SEARCH', 'TieredSearchStrategy: findByFile', { filePath });

      const metadataResults = this.sessionSearch.findByFile(filePath, filterOptions);
      const sessions = metadataResults.sessions;

      if (metadataResults.observations.length === 0) {
        return { observations: [], sessions, usedTiered: false };
      }

      const ragResult = await this.queryRouter.queryForRAG({
        query: filePath,
        project,
        limit: Math.min(metadataResults.observations.length, SEARCH_CONSTANTS.TIERED_BATCH_SIZE),
        includeObservations: true,
        includeSummaries: false,
        minScore: 0.2
      });

      const metadataIds = new Set(metadataResults.observations.map(obs => obs.id));
      const rankedIds = ragResult.observations
        .map(r => r.item.id)
        .filter(id => metadataIds.has(id));

      if (rankedIds.length > 0) {
        const observations = this.sessionStore.getObservationsByIds(rankedIds, { limit });
        const idOrder = new Map(rankedIds.map((id, idx) => [id, idx]));
        observations.sort((a, b) => (idOrder.get(a.id) ?? Infinity) - (idOrder.get(b.id) ?? Infinity));

        return { observations, sessions, usedTiered: true };
      }

      return { observations: metadataResults.observations.slice(0, limit), sessions, usedTiered: false };

    } catch (error) {
      logger.error('SEARCH', 'TieredSearchStrategy: findByFile failed', {}, error as Error);
      const results = this.sessionSearch.findByFile(filePath, filterOptions);
      return {
        observations: results.observations,
        sessions: results.sessions,
        usedTiered: false
      };
    }
  }
}
