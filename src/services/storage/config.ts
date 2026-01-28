/**
 * Tiered Storage Configuration
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// Load settings from ~/.claude-recall/settings.json
function loadSettings(): Record<string, string> {
  const settingsPath = join(homedir(), '.claude-recall', 'settings.json');
  if (existsSync(settingsPath)) {
    try {
      return JSON.parse(readFileSync(settingsPath, 'utf-8'));
    } catch {
      return {};
    }
  }
  return {};
}

const settings = loadSettings();

// Helper to get config value from env or settings
function getConfig(key: string, defaultValue: string): string {
  return process.env[key] || settings[key] || defaultValue;
}

export interface RedisConfig {
  host: string;
  port: number;
  password?: string;
  db?: number;
  hotTierTTL: number; // seconds
  keyPrefix: string;
}

export interface PostgresConfig {
  connectionString: string;
  maxConnections: number;
  idleTimeoutMs: number;
  retentionDays: number;
}

export interface OllamaConfig {
  host: string;
  embeddingModel: string;
  embeddingDimension: number;
  timeoutMs: number;
}

export interface SearchConfig {
  useReranker: boolean;
  rerankerUrl?: string;
  tokenBudget: number;
  defaultLimit: number;
  hybridVectorWeight: number; // 0-1, weight for vector vs text in hybrid search
}

export interface SummarizationConfig {
  sessionConsolidationDelayHours: number;
  weeklyConsolidationDelayDays: number;
  consolidationIntervalMs: number;
  maxObservationsPerSummary: number;
}

/**
 * Storage mode determines write priority:
 * - 'sqlite-primary': SQLite first (atomic), then sync to tiered (fire-and-forget). Default.
 * - 'tiered-primary': Tiered storage first (PostgreSQL + Redis), SQLite as fallback if tiered fails.
 */
export type StorageMode = 'sqlite-primary' | 'tiered-primary';

export interface TieredStorageConfig {
  redis: RedisConfig;
  postgres: PostgresConfig;
  ollama: OllamaConfig;
  search: SearchConfig;
  summarization: SummarizationConfig;
  storageMode: StorageMode;
}

/**
 * Load configuration from environment variables with defaults
 */
export function loadTieredStorageConfig(): TieredStorageConfig {
  return {
    redis: {
      host: getConfig('REDIS_HOST', 'localhost'),
      port: parseInt(getConfig('REDIS_PORT', '6379'), 10),
      password: process.env.REDIS_PASSWORD || settings.REDIS_PASSWORD,
      db: parseInt(getConfig('REDIS_DB', '0'), 10),
      hotTierTTL: parseInt(getConfig('REDIS_HOT_TIER_TTL', String(48 * 60 * 60)), 10), // 48 hours
      keyPrefix: getConfig('REDIS_KEY_PREFIX', 'cr:'),
    },
    postgres: {
      connectionString: getConfig('DATABASE_URL', 'postgres://localhost:5432/claude_recall'),
      maxConnections: parseInt(getConfig('PG_MAX_CONNECTIONS', '10'), 10),
      idleTimeoutMs: parseInt(getConfig('PG_IDLE_TIMEOUT_MS', '30000'), 10),
      retentionDays: parseInt(getConfig('PG_RETENTION_DAYS', '20'), 10),
    },
    ollama: {
      host: getConfig('OLLAMA_HOST', 'http://localhost:11434'),
      embeddingModel: getConfig('OLLAMA_EMBEDDING_MODEL', 'nomic-embed-text'),
      embeddingDimension: parseInt(getConfig('OLLAMA_EMBEDDING_DIM', '768'), 10),
      timeoutMs: parseInt(getConfig('OLLAMA_TIMEOUT_MS', '30000'), 10),
    },
    search: {
      useReranker: getConfig('SEARCH_USE_RERANKER', 'false') === 'true',
      rerankerUrl: process.env.RERANKER_URL || settings.RERANKER_URL,
      tokenBudget: parseInt(getConfig('SEARCH_TOKEN_BUDGET', '2000'), 10),
      defaultLimit: parseInt(getConfig('SEARCH_DEFAULT_LIMIT', '10'), 10),
      hybridVectorWeight: parseFloat(getConfig('SEARCH_HYBRID_VECTOR_WEIGHT', '0.5')),
    },
    summarization: {
      sessionConsolidationDelayHours: parseInt(getConfig('SUMMARIZATION_SESSION_DELAY_HOURS', '24'), 10),
      weeklyConsolidationDelayDays: parseInt(getConfig('SUMMARIZATION_WEEKLY_DELAY_DAYS', '7'), 10),
      consolidationIntervalMs: parseInt(getConfig('SUMMARIZATION_INTERVAL_MS', String(6 * 60 * 60 * 1000)), 10), // 6 hours
      maxObservationsPerSummary: parseInt(getConfig('SUMMARIZATION_MAX_OBS', '50'), 10),
    },
    storageMode: getConfig('CLAUDE_RECALL_STORAGE_MODE', 'sqlite-primary') as StorageMode,
  };
}

/**
 * Singleton config instance
 */
let configInstance: TieredStorageConfig | null = null;

export function getTieredStorageConfig(): TieredStorageConfig {
  if (!configInstance) {
    configInstance = loadTieredStorageConfig();
  }
  return configInstance;
}

/**
 * Reset config (for testing)
 */
export function resetTieredStorageConfig(): void {
  configInstance = null;
}
