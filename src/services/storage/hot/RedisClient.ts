/**
 * Redis Client for Hot Tier
 * Uses redis package with RediSearch for vector search
 */

import { createClient, type RedisClientType, SchemaFieldTypes, VectorAlgorithms } from 'redis';
import { getTieredStorageConfig, type RedisConfig } from '../config.js';

export type RedisClient = RedisClientType;

export class RedisClientWrapper {
  private client: RedisClient | null = null;
  private config: RedisConfig;
  private initialized: boolean = false;

  constructor(config?: Partial<RedisConfig>) {
    const defaultConfig = getTieredStorageConfig().redis;
    this.config = { ...defaultConfig, ...config };
  }

  /**
   * Get the Redis client
   */
  async getClient(): Promise<RedisClient> {
    if (this.client && this.client.isOpen) {
      return this.client;
    }

    const url = this.config.password
      ? `redis://:${this.config.password}@${this.config.host}:${this.config.port}/${this.config.db || 0}`
      : `redis://${this.config.host}:${this.config.port}/${this.config.db || 0}`;

    this.client = createClient({ url });

    this.client.on('error', (err) => {
      console.error('[RedisClient] Error:', err.message);
    });

    this.client.on('connect', () => {
      console.log('[RedisClient] Connected');
    });

    this.client.on('reconnecting', () => {
      console.log('[RedisClient] Reconnecting...');
    });

    await this.client.connect();
    return this.client;
  }

  /**
   * Initialize RediSearch indexes
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const client = await this.getClient();

    // Create observation vector index
    try {
      await client.ft.info(`${this.config.keyPrefix}idx:obs`);
      console.log('[RedisClient] Observation index already exists');
    } catch {
      // Index doesn't exist, create it
      await client.ft.create(
        `${this.config.keyPrefix}idx:obs`,
        {
          '$.embedding': {
            type: SchemaFieldTypes.VECTOR,
            ALGORITHM: VectorAlgorithms.HNSW,
            TYPE: 'FLOAT32',
            DIM: 768,
            DISTANCE_METRIC: 'COSINE',
            AS: 'embedding',
          },
          '$.project': {
            type: SchemaFieldTypes.TAG,
            AS: 'project',
          },
          '$.type': {
            type: SchemaFieldTypes.TAG,
            AS: 'type',
          },
          '$.created_at_epoch': {
            type: SchemaFieldTypes.NUMERIC,
            SORTABLE: true,
            AS: 'created_at_epoch',
          },
          '$.title': {
            type: SchemaFieldTypes.TEXT,
            AS: 'title',
          },
          '$.narrative': {
            type: SchemaFieldTypes.TEXT,
            AS: 'narrative',
          },
        } as any,
        {
          ON: 'HASH',
          PREFIX: `${this.config.keyPrefix}observation:`,
        }
      );
      console.log('[RedisClient] Created observation index');
    }

    // Create summary vector index
    try {
      await client.ft.info(`${this.config.keyPrefix}idx:summary`);
      console.log('[RedisClient] Summary index already exists');
    } catch {
      await client.ft.create(
        `${this.config.keyPrefix}idx:summary`,
        {
          '$.embedding': {
            type: SchemaFieldTypes.VECTOR,
            ALGORITHM: VectorAlgorithms.HNSW,
            TYPE: 'FLOAT32',
            DIM: 768,
            DISTANCE_METRIC: 'COSINE',
            AS: 'embedding',
          },
          '$.project': {
            type: SchemaFieldTypes.TAG,
            AS: 'project',
          },
          '$.created_at_epoch': {
            type: SchemaFieldTypes.NUMERIC,
            SORTABLE: true,
            AS: 'created_at_epoch',
          },
          '$.searchable_text': {
            type: SchemaFieldTypes.TEXT,
            AS: 'searchable_text',
          },
        } as any,
        {
          ON: 'HASH',
          PREFIX: `${this.config.keyPrefix}summary:`,
        }
      );
      console.log('[RedisClient] Created summary index');
    }

    // Create project facts index
    try {
      await client.ft.info(`${this.config.keyPrefix}idx:fact`);
      console.log('[RedisClient] Fact index already exists');
    } catch {
      await client.ft.create(
        `${this.config.keyPrefix}idx:fact`,
        {
          '$.embedding': {
            type: SchemaFieldTypes.VECTOR,
            ALGORITHM: VectorAlgorithms.HNSW,
            TYPE: 'FLOAT32',
            DIM: 768,
            DISTANCE_METRIC: 'COSINE',
            AS: 'embedding',
          },
          '$.project': {
            type: SchemaFieldTypes.TAG,
            AS: 'project',
          },
          '$.fact_text': {
            type: SchemaFieldTypes.TEXT,
            AS: 'fact_text',
          },
        } as any,
        {
          ON: 'HASH',
          PREFIX: `${this.config.keyPrefix}fact:`,
        }
      );
      console.log('[RedisClient] Created fact index');
    }

    this.initialized = true;
  }

  /**
   * Get key prefix
   */
  getKeyPrefix(): string {
    return this.config.keyPrefix;
  }

  /**
   * Get hot tier TTL
   */
  getHotTierTTL(): number {
    return this.config.hotTierTTL;
  }

  /**
   * Close the connection
   */
  async close(): Promise<void> {
    if (this.client && this.client.isOpen) {
      await this.client.quit();
      this.client = null;
      this.initialized = false;
    }
  }

  /**
   * Check if Redis is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      const client = await this.getClient();
      await client.ping();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Clear all data with prefix (for testing)
   */
  async clearAll(): Promise<void> {
    const client = await this.getClient();
    const keys = await client.keys(`${this.config.keyPrefix}*`);
    if (keys.length > 0) {
      await client.del(keys);
    }
  }
}

/**
 * Helper: Convert embedding array to buffer for Redis
 */
export function embeddingToBuffer(embedding: number[]): Buffer {
  const buffer = Buffer.alloc(embedding.length * 4);
  for (let i = 0; i < embedding.length; i++) {
    buffer.writeFloatLE(embedding[i], i * 4);
  }
  return buffer;
}

/**
 * Helper: Convert buffer back to embedding array
 */
export function bufferToEmbedding(buffer: Buffer): number[] {
  const embedding: number[] = [];
  for (let i = 0; i < buffer.length; i += 4) {
    embedding.push(buffer.readFloatLE(i));
  }
  return embedding;
}

/**
 * Singleton instance
 */
let redisClientInstance: RedisClientWrapper | null = null;

export function getRedisClient(): RedisClientWrapper {
  if (!redisClientInstance) {
    redisClientInstance = new RedisClientWrapper();
  }
  return redisClientInstance;
}

export async function initializeRedis(): Promise<RedisClientWrapper> {
  const client = getRedisClient();
  await client.initialize();
  return client;
}

export async function closeRedis(): Promise<void> {
  if (redisClientInstance) {
    await redisClientInstance.close();
    redisClientInstance = null;
  }
}
