/**
 * Tiered Storage Manager
 * Coordinates between hot (Redis) and cold (PostgreSQL) tiers
 *
 * Write path: Write to both tiers (write-through)
 * Read path: Hot first, cold fallback (read-through caching)
 */

import {
  getRedisObservationStore,
  type RedisObservationStore,
} from '../hot/RedisObservationStore.js';
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
import { getRedisClient, initializeRedis } from '../hot/RedisClient.js';
import { getPostgresClient, initializePostgres } from '../cold/PostgresClient.js';
import type {
  StoredObservation,
  ObservationInput,
  ObservationQueryOptions,
} from '../interfaces/IObservationStore.js';
import type {
  StoredSessionSummary,
  SessionSummaryInput,
  SummaryQueryOptions,
  StoredProjectFact,
  ProjectFactInput,
} from '../interfaces/ISummaryStore.js';
import { getTieredStorageConfig } from '../config.js';

export class TieredStorageManager {
  private hotObservations: RedisObservationStore | null = null;
  private coldObservations: PostgresObservationStore | null = null;
  private coldSummaries: PostgresSummaryStore | null = null;
  private weeklySummaries: PostgresWeeklySummaryStore | null = null;
  private projectFacts: PostgresProjectFactStore | null = null;
  private initialized: boolean = false;
  private redisAvailable: boolean = false;

  /**
   * Initialize both storage tiers
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Initialize PostgreSQL (required)
    await initializePostgres();
    this.coldObservations = getPostgresObservationStore();
    this.coldSummaries = getPostgresSummaryStore();
    this.weeklySummaries = getPostgresWeeklySummaryStore();
    this.projectFacts = getPostgresProjectFactStore();

    // Initialize Redis (optional - degrades gracefully)
    try {
      await initializeRedis();
      this.hotObservations = getRedisObservationStore();
      this.redisAvailable = true;
      console.log('[TieredStorageManager] Redis hot tier available');
    } catch (err) {
      console.warn('[TieredStorageManager] Redis unavailable, using cold tier only:', err);
      this.redisAvailable = false;
    }

    this.initialized = true;
    console.log('[TieredStorageManager] Initialized');
  }

  /**
   * Check if Redis is available
   */
  isHotTierAvailable(): boolean {
    return this.redisAvailable;
  }

  // ============================================================================
  // Observation Operations
  // ============================================================================

  /**
   * Store an observation (write-through)
   * Returns the stored observation with cache status
   */
  async storeObservation(observation: ObservationInput): Promise<StoredObservation & { _cached?: boolean }> {
    this.ensureInitialized();

    // Write to cold tier (source of truth)
    const stored = await this.coldObservations!.store(observation);

    // Cache in hot tier if available
    let cached = false;
    if (this.redisAvailable && this.hotObservations) {
      try {
        await this.hotObservations.cache(stored);
        cached = true;
      } catch (err) {
        console.warn('[TieredStorageManager] Failed to cache observation in hot tier:', err);
        // Mark Redis as potentially unavailable if we get repeated failures
        // This prevents slow requests due to repeated Redis timeouts
      }
    }

    return { ...stored, _cached: cached };
  }

  /**
   * Store multiple observations
   */
  async storeObservations(observations: ObservationInput[]): Promise<StoredObservation[]> {
    const results: StoredObservation[] = [];
    for (const obs of observations) {
      const stored = await this.storeObservation(obs);
      results.push(stored);
    }
    return results;
  }

  /**
   * Get observation by ID (hot-first read)
   */
  async getObservationById(id: number): Promise<StoredObservation | null> {
    this.ensureInitialized();

    // Try hot tier first
    if (this.redisAvailable && this.hotObservations) {
      try {
        const cached = await this.hotObservations.getById(id);
        if (cached) {
          return cached;
        }
      } catch (err) {
        console.warn('[TieredStorageManager] Hot tier read failed:', err);
      }
    }

    // Fallback to cold tier
    const stored = await this.coldObservations!.getById(id);

    // Cache miss - populate hot tier
    if (stored && this.redisAvailable && this.hotObservations) {
      try {
        await this.hotObservations.cache(stored);
      } catch (err) {
        console.warn('[TieredStorageManager] Failed to cache on read:', err);
      }
    }

    return stored;
  }

  /**
   * Get recent observations (hot-first, cold fallback)
   */
  async getRecentObservations(options: ObservationQueryOptions = {}): Promise<StoredObservation[]> {
    this.ensureInitialized();

    const config = getTieredStorageConfig();
    const hotTierCutoff = Date.now() - (config.redis.hotTierTTL * 1000);

    // If query is within hot tier range, try hot first
    if (
      this.redisAvailable &&
      this.hotObservations &&
      (!options.since_epoch || options.since_epoch >= hotTierCutoff)
    ) {
      try {
        const hotResults = await this.hotObservations.getRecent(options);
        if (hotResults.length >= (options.limit || 100)) {
          return hotResults;
        }
        // Partial results from hot tier - supplement from cold
        const hotIds = new Set(hotResults.map((r) => r.id));
        const coldOptions = {
          ...options,
          limit: (options.limit || 100) - hotResults.length,
        };
        const coldResults = await this.coldObservations!.getRecent(coldOptions);
        const deduped = coldResults.filter((r) => !hotIds.has(r.id));

        // Cache cold results in hot tier
        for (const obs of deduped) {
          if (obs.created_at_epoch >= hotTierCutoff) {
            try {
              await this.hotObservations.cache(obs);
            } catch {
              // Ignore cache failures
            }
          }
        }

        return [...hotResults, ...deduped].slice(0, options.limit || 100);
      } catch (err) {
        console.warn('[TieredStorageManager] Hot tier query failed:', err);
      }
    }

    // Cold tier query
    return this.coldObservations!.getRecent(options);
  }

  /**
   * Get observations for a session
   */
  async getObservationsBySession(
    memorySessionId: string,
    options: ObservationQueryOptions = {}
  ): Promise<StoredObservation[]> {
    this.ensureInitialized();

    // Try hot tier first
    if (this.redisAvailable && this.hotObservations) {
      try {
        const hotResults = await this.hotObservations.getBySession(memorySessionId, options);
        if (hotResults.length > 0) {
          return hotResults;
        }
      } catch (err) {
        console.warn('[TieredStorageManager] Hot tier session query failed:', err);
      }
    }

    // Fallback to cold tier
    return this.coldObservations!.getBySession(memorySessionId, options);
  }

  // ============================================================================
  // Summary Operations
  // ============================================================================

  /**
   * Store a session summary
   */
  async storeSummary(summary: SessionSummaryInput): Promise<StoredSessionSummary> {
    this.ensureInitialized();
    return this.coldSummaries!.store(summary);
  }

  /**
   * Get session summary
   */
  async getSummaryBySession(memorySessionId: string): Promise<StoredSessionSummary | null> {
    this.ensureInitialized();
    return this.coldSummaries!.getBySession(memorySessionId);
  }

  /**
   * Get recent summaries
   */
  async getRecentSummaries(options: SummaryQueryOptions = {}): Promise<StoredSessionSummary[]> {
    this.ensureInitialized();
    return this.coldSummaries!.getRecent(options);
  }

  // ============================================================================
  // Project Facts Operations
  // ============================================================================

  /**
   * Store a project fact
   */
  async storeProjectFact(fact: ProjectFactInput): Promise<StoredProjectFact> {
    this.ensureInitialized();
    return this.projectFacts!.store(fact);
  }

  /**
   * Get project facts
   */
  async getProjectFacts(project: string, limit?: number): Promise<StoredProjectFact[]> {
    this.ensureInitialized();
    return this.projectFacts!.getByProject(project, limit);
  }

  // ============================================================================
  // Cache Management
  // ============================================================================

  /**
   * Warm cache for a project (call on session start)
   */
  async warmCacheForProject(project: string): Promise<void> {
    if (!this.redisAvailable || !this.hotObservations) {
      return;
    }

    this.ensureInitialized();
    const config = getTieredStorageConfig();
    const hotTierCutoff = Date.now() - (config.redis.hotTierTTL * 1000);

    // Get recent observations from cold tier
    const recentObs = await this.coldObservations!.getRecent({
      project,
      since_epoch: hotTierCutoff,
      limit: 100,
    });

    // Cache them in hot tier
    for (const obs of recentObs) {
      try {
        await this.hotObservations.cache(obs);
      } catch {
        // Ignore individual cache failures
      }
    }

    console.log(`[TieredStorageManager] Warmed cache for ${project}: ${recentObs.length} observations`);
  }

  /**
   * Run retention cleanup
   */
  async runRetentionCleanup(): Promise<void> {
    this.ensureInitialized();

    const config = getTieredStorageConfig();
    const cutoffEpoch = Date.now() - (config.postgres.retentionDays * 24 * 60 * 60 * 1000);

    // Clean cold tier
    const obsDeleted = await this.coldObservations!.deleteOlderThan(cutoffEpoch);
    const summariesDeleted = await this.coldSummaries!.deleteOlderThan(cutoffEpoch);

    if (obsDeleted > 0 || summariesDeleted > 0) {
      console.log(`[TieredStorageManager] Retention cleanup: ${obsDeleted} observations, ${summariesDeleted} summaries`);
    }

    // Hot tier handles its own TTL expiration
  }

  // ============================================================================
  // Utilities
  // ============================================================================

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('TieredStorageManager not initialized. Call initialize() first.');
    }
  }

  /**
   * Close connections
   */
  async close(): Promise<void> {
    const { closeRedis } = await import('../hot/RedisClient.js');
    const { closePostgres } = await import('../cold/PostgresClient.js');

    await closeRedis();
    await closePostgres();

    this.initialized = false;
    this.redisAvailable = false;
    this.hotObservations = null;
    this.coldObservations = null;
    this.coldSummaries = null;
    this.weeklySummaries = null;
    this.projectFacts = null;
  }
}

// Singleton instance
let tieredStorageInstance: TieredStorageManager | null = null;

export function getTieredStorageManager(): TieredStorageManager {
  if (!tieredStorageInstance) {
    tieredStorageInstance = new TieredStorageManager();
  }
  return tieredStorageInstance;
}

export async function initializeTieredStorage(): Promise<TieredStorageManager> {
  const manager = getTieredStorageManager();
  await manager.initialize();
  return manager;
}

export async function closeTieredStorage(): Promise<void> {
  if (tieredStorageInstance) {
    await tieredStorageInstance.close();
    tieredStorageInstance = null;
  }
}
