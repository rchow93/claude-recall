/**
 * PostgreSQL Client for Cold Tier
 * Uses pg library with pgvector extension
 */

import pg from 'pg';
import { getTieredStorageConfig, type PostgresConfig } from '../config.js';

const { Pool } = pg;

export class PostgresClient {
  private pool: pg.Pool | null = null;
  private poolPromise: Promise<pg.Pool> | null = null;  // Lock for concurrent initialization
  private config: PostgresConfig;
  private initialized: boolean = false;

  constructor(config?: Partial<PostgresConfig>) {
    const defaultConfig = getTieredStorageConfig().postgres;
    this.config = { ...defaultConfig, ...config };
  }

  /**
   * Get the connection pool (thread-safe initialization)
   * Uses promise-based lock to prevent race condition where multiple callers
   * could create separate pool instances before the first one completes
   */
  async getPool(): Promise<pg.Pool> {
    // Fast path: pool already initialized
    if (this.pool) {
      return this.pool;
    }

    // Concurrent initialization guard: if another caller is initializing, wait for them
    if (this.poolPromise) {
      return this.poolPromise;
    }

    // We're the first caller - create and store the promise immediately (synchronous)
    // This prevents other callers from starting their own initialization
    this.poolPromise = this.initializePool();

    try {
      const pool = await this.poolPromise;
      return pool;
    } catch (error) {
      // Reset on failure so future calls can retry
      this.poolPromise = null;
      throw error;
    }
  }

  /**
   * Internal pool initialization - only called once due to poolPromise guard
   */
  private async initializePool(): Promise<pg.Pool> {
    const pool = new Pool({
      connectionString: this.config.connectionString,
      max: this.config.maxConnections,
      idleTimeoutMillis: this.config.idleTimeoutMs,
    });

    // Test connection
    try {
      const client = await pool.connect();
      client.release();
    } catch (error) {
      // Clean up the pool we created
      await pool.end().catch(() => {}); // Ignore cleanup errors
      throw new Error(`PostgreSQL connection failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }

    // Only store pool after successful connection test
    this.pool = pool;
    return pool;
  }

  /**
   * Initialize schema (run migrations)
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const pool = await this.getPool();

    // Enable required extensions
    await pool.query(`CREATE EXTENSION IF NOT EXISTS vector;`);

    // Run schema creation
    await pool.query(SCHEMA_SQL);

    // Create indexes
    await pool.query(INDEXES_SQL);

    this.initialized = true;
    console.log('[PostgresClient] Schema initialized');
  }

  /**
   * Execute a query
   */
  async query<T extends pg.QueryResultRow = any>(
    text: string,
    params?: any[]
  ): Promise<pg.QueryResult<T>> {
    const pool = await this.getPool();
    return pool.query<T>(text, params);
  }

  /**
   * Execute a transaction
   */
  async transaction<T>(
    fn: (client: pg.PoolClient) => Promise<T>
  ): Promise<T> {
    const pool = await this.getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Close the connection pool
   */
  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      this.initialized = false;
    }
  }

  /**
   * Run retention cleanup
   */
  async runRetentionCleanup(): Promise<number> {
    const pool = await this.getPool();

    const result = await pool.query(`
      WITH deleted_obs AS (
        DELETE FROM observations
        WHERE created_at < NOW() - INTERVAL '${this.config.retentionDays} days'
        RETURNING id
      ),
      deleted_summaries AS (
        DELETE FROM session_summaries
        WHERE created_at < NOW() - INTERVAL '${this.config.retentionDays} days'
        RETURNING id
      )
      SELECT
        (SELECT COUNT(*) FROM deleted_obs) as obs_count,
        (SELECT COUNT(*) FROM deleted_summaries) as summary_count
    `);

    const obsCount = parseInt(result.rows[0]?.obs_count || '0', 10);
    const summaryCount = parseInt(result.rows[0]?.summary_count || '0', 10);

    if (obsCount > 0 || summaryCount > 0) {
      console.log(`[PostgresClient] Retention cleanup: deleted ${obsCount} observations, ${summaryCount} summaries`);
    }

    return obsCount + summaryCount;
  }

  /**
   * Check if database is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      const pool = await this.getPool();
      await pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Schema SQL
 */
const SCHEMA_SQL = `
-- Observations table with vector embeddings
CREATE TABLE IF NOT EXISTS observations (
  id BIGSERIAL PRIMARY KEY,
  memory_session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('decision','bugfix','feature','refactor','discovery','change')),
  title TEXT,
  subtitle TEXT,
  facts JSONB DEFAULT '[]',
  narrative TEXT,
  concepts JSONB DEFAULT '[]',
  files_read JSONB DEFAULT '[]',
  files_modified JSONB DEFAULT '[]',
  prompt_number INTEGER,
  discovery_tokens INTEGER DEFAULT 0,
  embedding vector(768),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at_epoch BIGINT NOT NULL
);

-- Session summaries
CREATE TABLE IF NOT EXISTS session_summaries (
  id BIGSERIAL PRIMARY KEY,
  memory_session_id TEXT NOT NULL UNIQUE,
  project TEXT NOT NULL,
  request TEXT,
  investigated TEXT,
  learned TEXT,
  completed TEXT,
  next_steps TEXT,
  notes TEXT,
  files_read JSONB DEFAULT '[]',
  files_edited JSONB DEFAULT '[]',
  prompt_number INTEGER,
  discovery_tokens INTEGER DEFAULT 0,
  embedding vector(768),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at_epoch BIGINT NOT NULL
);

-- Weekly summaries (hierarchical consolidation)
CREATE TABLE IF NOT EXISTS weekly_summaries (
  id BIGSERIAL PRIMARY KEY,
  project TEXT NOT NULL,
  week_start DATE NOT NULL,
  summary_text TEXT NOT NULL,
  key_topics JSONB,
  embedding vector(768),
  source_session_ids BIGINT[],
  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_at_epoch BIGINT NOT NULL,
  UNIQUE(project, week_start)
);

-- Project facts (stable knowledge extracted from summaries)
CREATE TABLE IF NOT EXISTS project_facts (
  id BIGSERIAL PRIMARY KEY,
  project TEXT NOT NULL,
  fact_text TEXT NOT NULL,
  fact_type TEXT DEFAULT 'general',
  confidence FLOAT DEFAULT 1.0,
  embedding vector(768),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_at_epoch BIGINT NOT NULL
);

-- SDK Sessions (migrated from SQLite)
CREATE TABLE IF NOT EXISTS sdk_sessions (
  id BIGSERIAL PRIMARY KEY,
  content_session_id TEXT NOT NULL UNIQUE,
  memory_session_id TEXT,
  project TEXT NOT NULL,
  user_prompt TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at_epoch BIGINT NOT NULL,
  completed_at TIMESTAMPTZ,
  completed_at_epoch BIGINT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'failed')),
  worker_port INTEGER,
  prompt_counter INTEGER DEFAULT 1
);

-- User prompts
CREATE TABLE IF NOT EXISTS user_prompts (
  id BIGSERIAL PRIMARY KEY,
  content_session_id TEXT NOT NULL,
  prompt_number INTEGER NOT NULL,
  prompt_text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at_epoch BIGINT NOT NULL,
  UNIQUE(content_session_id, prompt_number)
);
`;

/**
 * Indexes SQL
 */
const INDEXES_SQL = `
-- Vector indexes using IVFFlat (good balance of speed and recall)
CREATE INDEX IF NOT EXISTS idx_obs_embedding ON observations
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE INDEX IF NOT EXISTS idx_summary_embedding ON session_summaries
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50);

CREATE INDEX IF NOT EXISTS idx_weekly_embedding ON weekly_summaries
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50);

CREATE INDEX IF NOT EXISTS idx_fact_embedding ON project_facts
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50);

-- Full-text search indexes
CREATE INDEX IF NOT EXISTS idx_obs_tsv ON observations
  USING GIN (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(narrative,'')));

CREATE INDEX IF NOT EXISTS idx_summary_tsv ON session_summaries
  USING GIN (to_tsvector('english',
    coalesce(request,'') || ' ' ||
    coalesce(investigated,'') || ' ' ||
    coalesce(learned,'') || ' ' ||
    coalesce(completed,'')
  ));

-- Time-based indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_obs_project_time ON observations (project, created_at_epoch DESC);
CREATE INDEX IF NOT EXISTS idx_obs_session ON observations (memory_session_id);
CREATE INDEX IF NOT EXISTS idx_obs_created ON observations (created_at);
CREATE INDEX IF NOT EXISTS idx_obs_type ON observations (type);

CREATE INDEX IF NOT EXISTS idx_summary_project_time ON session_summaries (project, created_at_epoch DESC);
CREATE INDEX IF NOT EXISTS idx_summary_created ON session_summaries (created_at);

CREATE INDEX IF NOT EXISTS idx_weekly_project ON weekly_summaries (project, week_start DESC);
CREATE INDEX IF NOT EXISTS idx_facts_project ON project_facts (project);

CREATE INDEX IF NOT EXISTS idx_session_content ON sdk_sessions (content_session_id);
CREATE INDEX IF NOT EXISTS idx_session_memory ON sdk_sessions (memory_session_id);
CREATE INDEX IF NOT EXISTS idx_session_project ON sdk_sessions (project);

CREATE INDEX IF NOT EXISTS idx_prompt_session ON user_prompts (content_session_id);

-- Concept search (GIN index on JSONB array)
CREATE INDEX IF NOT EXISTS idx_obs_concepts ON observations USING GIN (concepts);
CREATE INDEX IF NOT EXISTS idx_obs_files_read ON observations USING GIN (files_read);
CREATE INDEX IF NOT EXISTS idx_obs_files_modified ON observations USING GIN (files_modified);
`;

/**
 * Singleton instance
 */
let postgresClientInstance: PostgresClient | null = null;

export function getPostgresClient(): PostgresClient {
  if (!postgresClientInstance) {
    postgresClientInstance = new PostgresClient();
  }
  return postgresClientInstance;
}

export async function initializePostgres(): Promise<PostgresClient> {
  const client = getPostgresClient();
  await client.initialize();
  return client;
}

export async function closePostgres(): Promise<void> {
  if (postgresClientInstance) {
    await postgresClientInstance.close();
    postgresClientInstance = null;
  }
}
