/**
 * Interface for observation storage operations
 * Implemented by both hot (Redis) and cold (PostgreSQL) tiers
 */

export interface ObservationType {
  type: 'decision' | 'bugfix' | 'feature' | 'refactor' | 'discovery' | 'change';
}

export interface StoredObservation {
  id: number;
  memory_session_id: string;
  project: string;
  type: ObservationType['type'];
  title: string | null;
  subtitle: string | null;
  facts: string[] | null;
  narrative: string | null;
  concepts: string[] | null;
  files_read: string[] | null;
  files_modified: string[] | null;
  prompt_number: number | null;
  discovery_tokens: number;
  embedding?: number[];
  created_at: string;
  created_at_epoch: number;
}

export interface ObservationInput {
  memory_session_id: string;
  project: string;
  type: ObservationType['type'];
  title?: string | null;
  subtitle?: string | null;
  facts?: string[];
  narrative?: string | null;
  concepts?: string[];
  files_read?: string[];
  files_modified?: string[];
  prompt_number?: number | null;
  discovery_tokens?: number;
  embedding?: number[];
  created_at_epoch?: number;
}

export interface ObservationQueryOptions {
  project?: string;
  types?: ObservationType['type'][];
  concepts?: string[];
  files?: string[];
  limit?: number;
  offset?: number;
  since_epoch?: number;
  until_epoch?: number;
  order?: 'asc' | 'desc';
}

export interface IObservationStore {
  /**
   * Store a new observation
   */
  store(observation: ObservationInput): Promise<StoredObservation>;

  /**
   * Store multiple observations in a batch
   */
  storeBatch(observations: ObservationInput[]): Promise<StoredObservation[]>;

  /**
   * Get observation by ID
   */
  getById(id: number): Promise<StoredObservation | null>;

  /**
   * Get observations by IDs
   */
  getByIds(ids: number[]): Promise<StoredObservation[]>;

  /**
   * Get observations for a session
   */
  getBySession(memorySessionId: string, options?: ObservationQueryOptions): Promise<StoredObservation[]>;

  /**
   * Get recent observations for a project
   */
  getRecent(options: ObservationQueryOptions): Promise<StoredObservation[]>;

  /**
   * Delete observation by ID
   */
  delete(id: number): Promise<boolean>;

  /**
   * Delete observations older than epoch
   */
  deleteOlderThan(epochMs: number): Promise<number>;

  /**
   * Check if observation exists
   */
  exists(id: number): Promise<boolean>;

  /**
   * Count observations matching criteria
   */
  count(options?: ObservationQueryOptions): Promise<number>;
}
