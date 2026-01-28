/**
 * Interface for session summary storage operations
 * Implemented by both hot (Redis) and cold (PostgreSQL) tiers
 */

export interface StoredSessionSummary {
  id: number;
  memory_session_id: string;
  project: string;
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  notes: string | null;
  files_read: string[] | null;
  files_edited: string[] | null;
  prompt_number: number | null;
  discovery_tokens: number;
  embedding?: number[];
  created_at: string;
  created_at_epoch: number;
}

export interface SessionSummaryInput {
  memory_session_id: string;
  project: string;
  request?: string | null;
  investigated?: string | null;
  learned?: string | null;
  completed?: string | null;
  next_steps?: string | null;
  notes?: string | null;
  files_read?: string[];
  files_edited?: string[];
  prompt_number?: number | null;
  discovery_tokens?: number;
  embedding?: number[];
  created_at_epoch?: number;
}

export interface SummaryQueryOptions {
  project?: string;
  limit?: number;
  offset?: number;
  since_epoch?: number;
  until_epoch?: number;
  order?: 'asc' | 'desc';
}

/**
 * Weekly summary for hierarchical consolidation
 */
export interface StoredWeeklySummary {
  id: number;
  project: string;
  week_start: string; // ISO date (YYYY-MM-DD)
  summary_text: string;
  key_topics: string[] | null;
  embedding?: number[];
  source_session_ids: number[];
  created_at: string;
  created_at_epoch: number;
}

export interface WeeklySummaryInput {
  project: string;
  week_start: string;
  summary_text: string;
  key_topics?: string[];
  embedding?: number[];
  source_session_ids: number[];
}

/**
 * Project-level facts extracted from summaries
 */
export interface StoredProjectFact {
  id: number;
  project: string;
  fact_text: string;
  fact_type: string;
  confidence: number;
  embedding?: number[];
  created_at: string;
  created_at_epoch: number;
}

export interface ProjectFactInput {
  project: string;
  fact_text: string;
  fact_type?: string;
  confidence?: number;
  embedding?: number[];
}

export interface ISummaryStore {
  /**
   * Store a session summary
   */
  store(summary: SessionSummaryInput): Promise<StoredSessionSummary>;

  /**
   * Get summary by ID
   */
  getById(id: number): Promise<StoredSessionSummary | null>;

  /**
   * Get summary for a session
   */
  getBySession(memorySessionId: string): Promise<StoredSessionSummary | null>;

  /**
   * Get recent summaries
   */
  getRecent(options: SummaryQueryOptions): Promise<StoredSessionSummary[]>;

  /**
   * Delete summary by ID
   */
  delete(id: number): Promise<boolean>;

  /**
   * Delete summaries older than epoch
   */
  deleteOlderThan(epochMs: number): Promise<number>;

  /**
   * Check if summary exists for session
   */
  existsForSession(memorySessionId: string): Promise<boolean>;

  /**
   * Count summaries matching criteria
   */
  count(options?: SummaryQueryOptions): Promise<number>;
}

export interface IWeeklySummaryStore {
  /**
   * Store a weekly summary (upserts based on project + week_start)
   */
  store(summary: WeeklySummaryInput): Promise<StoredWeeklySummary>;

  /**
   * Get weekly summary
   */
  getByWeek(project: string, weekStart: string): Promise<StoredWeeklySummary | null>;

  /**
   * Get recent weekly summaries for a project
   */
  getRecent(project: string, limit?: number): Promise<StoredWeeklySummary[]>;

  /**
   * Check if sessions are already summarized
   */
  areSessionsSummarized(sessionIds: number[]): Promise<boolean>;
}

export interface IProjectFactStore {
  /**
   * Store a project fact
   */
  store(fact: ProjectFactInput): Promise<StoredProjectFact>;

  /**
   * Store multiple facts in batch
   */
  storeBatch(facts: ProjectFactInput[]): Promise<StoredProjectFact[]>;

  /**
   * Get all facts for a project
   */
  getByProject(project: string, limit?: number): Promise<StoredProjectFact[]>;

  /**
   * Delete a fact
   */
  delete(id: number): Promise<boolean>;

  /**
   * Delete all facts for a project
   */
  deleteByProject(project: string): Promise<number>;
}
