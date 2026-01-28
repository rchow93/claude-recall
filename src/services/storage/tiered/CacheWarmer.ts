/**
 * Cache Warmer
 * Proactively populates hot tier cache on session start and access patterns
 */

import { getRedisObservationStore, type RedisObservationStore } from '../hot/RedisObservationStore.js';
import { getPostgresObservationStore, type PostgresObservationStore } from '../cold/PostgresObservationStore.js';
import { getPostgresProjectFactStore, type PostgresProjectFactStore } from '../cold/PostgresSummaryStore.js';
import { getRedisClient } from '../hot/RedisClient.js';
import { getTieredStorageConfig } from '../config.js';
import type { StoredObservation } from '../interfaces/IObservationStore.js';

export interface CacheWarmingStats {
  observationsWarmed: number;
  factsWarmed: number;
  durationMs: number;
}

export class CacheWarmer {
  private hotStore: RedisObservationStore | null = null;
  private coldStore: PostgresObservationStore;
  private factStore: PostgresProjectFactStore;
  private redisAvailable: boolean = false;
  private accessCounts: Map<number, number> = new Map();
  private accessPromotionThreshold: number = 3;

  constructor() {
    this.coldStore = getPostgresObservationStore();
    this.factStore = getPostgresProjectFactStore();
  }

  /**
   * Initialize the cache warmer
   */
  async initialize(): Promise<void> {
    try {
      const redisClient = getRedisClient();
      if (await redisClient.isAvailable()) {
        this.hotStore = getRedisObservationStore();
        this.redisAvailable = true;
      }
    } catch {
      this.redisAvailable = false;
    }
  }

  /**
   * Warm cache for a project on session start
   */
  async warmForProject(project: string): Promise<CacheWarmingStats> {
    const startTime = Date.now();
    const stats: CacheWarmingStats = {
      observationsWarmed: 0,
      factsWarmed: 0,
      durationMs: 0,
    };

    if (!this.redisAvailable || !this.hotStore) {
      stats.durationMs = Date.now() - startTime;
      return stats;
    }

    const config = getTieredStorageConfig();
    const hotTierCutoff = Date.now() - (config.redis.hotTierTTL * 1000);

    try {
      // Warm recent observations (last 48h)
      const recentObs = await this.coldStore.getRecent({
        project,
        since_epoch: hotTierCutoff,
        limit: 100,
      });

      for (const obs of recentObs) {
        try {
          await this.hotStore.cache(obs);
          stats.observationsWarmed++;
        } catch {
          // Ignore individual failures
        }
      }

      // Warm project facts (always hot - no TTL expiration for facts in hot tier)
      const facts = await this.factStore.getByProject(project, 50);
      for (const fact of facts) {
        try {
          const client = await getRedisClient().getClient();
          const key = `${getRedisClient().getKeyPrefix()}fact:${fact.id}`;
          await client.hSet(key, {
            id: fact.id.toString(),
            project: fact.project,
            fact_text: fact.fact_text,
            fact_type: fact.fact_type,
            confidence: fact.confidence.toString(),
          });
          // Facts don't expire - they're always relevant
          stats.factsWarmed++;
        } catch {
          // Ignore individual failures
        }
      }

      console.log(`[CacheWarmer] Warmed ${stats.observationsWarmed} observations, ${stats.factsWarmed} facts for ${project}`);
    } catch (err) {
      console.warn('[CacheWarmer] Error warming cache:', err);
    }

    stats.durationMs = Date.now() - startTime;
    return stats;
  }

  /**
   * Track access and promote frequently accessed observations
   */
  async onAccess(observationId: number): Promise<void> {
    if (!this.redisAvailable || !this.hotStore) {
      return;
    }

    // Increment access count
    const count = (this.accessCounts.get(observationId) || 0) + 1;
    this.accessCounts.set(observationId, count);

    // Check if should promote to hot tier
    if (count >= this.accessPromotionThreshold) {
      try {
        // Check if already in hot tier
        if (await this.hotStore.exists(observationId)) {
          return;
        }

        // Fetch from cold and cache
        const obs = await this.coldStore.getById(observationId);
        if (obs) {
          await this.hotStore.cache(obs);
          console.log(`[CacheWarmer] Promoted observation ${observationId} to hot tier after ${count} accesses`);
        }
      } catch {
        // Ignore promotion failures
      }
    }
  }

  /**
   * Batch warm multiple projects (e.g., for worktree support)
   */
  async warmForProjects(projects: string[]): Promise<CacheWarmingStats> {
    const combinedStats: CacheWarmingStats = {
      observationsWarmed: 0,
      factsWarmed: 0,
      durationMs: 0,
    };

    const startTime = Date.now();

    for (const project of projects) {
      const stats = await this.warmForProject(project);
      combinedStats.observationsWarmed += stats.observationsWarmed;
      combinedStats.factsWarmed += stats.factsWarmed;
    }

    combinedStats.durationMs = Date.now() - startTime;
    return combinedStats;
  }

  /**
   * Clear access tracking (e.g., on session end)
   */
  clearAccessTracking(): void {
    this.accessCounts.clear();
  }

  /**
   * Warm specific observations by IDs
   */
  async warmObservationsByIds(ids: number[]): Promise<number> {
    if (!this.redisAvailable || !this.hotStore || ids.length === 0) {
      return 0;
    }

    let warmed = 0;
    const observations = await this.coldStore.getByIds(ids);

    for (const obs of observations) {
      try {
        await this.hotStore.cache(obs);
        warmed++;
      } catch {
        // Ignore individual failures
      }
    }

    return warmed;
  }

  /**
   * Prefetch observations related to specific files
   */
  async warmForFiles(project: string, filePaths: string[]): Promise<number> {
    if (!this.redisAvailable || !this.hotStore || filePaths.length === 0) {
      return 0;
    }

    const config = getTieredStorageConfig();
    const hotTierCutoff = Date.now() - (config.redis.hotTierTTL * 1000);

    // Get observations that touched these files
    const observations = await this.coldStore.getRecent({
      project,
      files: filePaths,
      since_epoch: hotTierCutoff,
      limit: 50,
    });

    let warmed = 0;
    for (const obs of observations) {
      try {
        await this.hotStore.cache(obs);
        warmed++;
      } catch {
        // Ignore individual failures
      }
    }

    console.log(`[CacheWarmer] Warmed ${warmed} observations for files: ${filePaths.slice(0, 3).join(', ')}`);
    return warmed;
  }
}

// Singleton instance
let cacheWarmerInstance: CacheWarmer | null = null;

export function getCacheWarmer(): CacheWarmer {
  if (!cacheWarmerInstance) {
    cacheWarmerInstance = new CacheWarmer();
  }
  return cacheWarmerInstance;
}

export async function initializeCacheWarmer(): Promise<CacheWarmer> {
  const warmer = getCacheWarmer();
  await warmer.initialize();
  return warmer;
}
