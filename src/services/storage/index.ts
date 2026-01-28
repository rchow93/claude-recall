/**
 * Tiered Storage System
 *
 * Two-tier architecture for claude-recall persistent memory:
 * - Hot Tier (Redis): Fast retrieval (~1-5ms), recent data, 48h TTL
 * - Cold Tier (PostgreSQL): 20-day retention, hybrid search (pgvector + BM25)
 *
 * Usage:
 * ```typescript
 * import {
 *   initializeTieredStorage,
 *   getTieredStorageManager,
 *   getQueryRouter,
 *   getCacheWarmer,
 * } from './services/storage';
 *
 * // On worker startup
 * await initializeTieredStorage();
 * await initializeQueryRouter();
 * await initializeCacheWarmer();
 *
 * // On session start - warm cache
 * const warmer = getCacheWarmer();
 * await warmer.warmForProject(project);
 *
 * // Store observations
 * const manager = getTieredStorageManager();
 * await manager.storeObservation(observation);
 *
 * // Query for RAG (per-prompt retrieval)
 * const router = getQueryRouter();
 * const results = await router.queryForRAG({
 *   query: userPrompt,
 *   project,
 *   limit: 5,
 * });
 * const context = router.formatForInjection(results, 2000);
 * ```
 */

// Configuration
export { getTieredStorageConfig, loadTieredStorageConfig, resetTieredStorageConfig } from './config.js';
export type { TieredStorageConfig, RedisConfig, PostgresConfig, OllamaConfig, SearchConfig, SummarizationConfig } from './config.js';

// Interfaces
export * from './interfaces/index.js';

// Embedding service
export {
  OllamaEmbeddingService,
  getOllamaEmbeddingService,
  resetOllamaEmbeddingService,
  createObservationSearchText,
  createSummarySearchText,
} from './embedding/OllamaEmbedding.js';

// Cold Tier (PostgreSQL)
export {
  PostgresClient,
  getPostgresClient,
  initializePostgres,
  closePostgres,
} from './cold/PostgresClient.js';
export {
  PostgresObservationStore,
  getPostgresObservationStore,
} from './cold/PostgresObservationStore.js';
export {
  PostgresSummaryStore,
  PostgresWeeklySummaryStore,
  PostgresProjectFactStore,
  getPostgresSummaryStore,
  getPostgresWeeklySummaryStore,
  getPostgresProjectFactStore,
} from './cold/PostgresSummaryStore.js';
export {
  PostgresObservationSearch,
  PostgresSummarySearch,
  getPostgresObservationSearch,
  getPostgresSummarySearch,
} from './cold/PostgresHybridSearch.js';

// Hot Tier (Redis)
export {
  RedisClientWrapper,
  getRedisClient,
  initializeRedis,
  closeRedis,
  embeddingToBuffer,
  bufferToEmbedding,
} from './hot/RedisClient.js';
export {
  RedisObservationStore,
  RedisObservationSearch,
  getRedisObservationStore,
  getRedisObservationSearch,
} from './hot/RedisObservationStore.js';

// Tiered Coordination
export {
  TieredStorageManager,
  getTieredStorageManager,
  initializeTieredStorage,
  closeTieredStorage,
} from './tiered/TieredStorageManager.js';
export {
  QueryRouter,
  getQueryRouter,
  initializeQueryRouter,
} from './tiered/QueryRouter.js';
export type { RAGQueryOptions, RAGResult } from './tiered/QueryRouter.js';
export {
  CacheWarmer,
  getCacheWarmer,
  initializeCacheWarmer,
} from './tiered/CacheWarmer.js';
export type { CacheWarmingStats } from './tiered/CacheWarmer.js';

// Background Workers
export {
  SummarizationWorker,
  RetentionWorker,
  getSummarizationWorker,
  getRetentionWorker,
  startBackgroundWorkers,
  stopBackgroundWorkers,
} from './workers/SummarizationWorker.js';
export type { SummarizationStats } from './workers/SummarizationWorker.js';
