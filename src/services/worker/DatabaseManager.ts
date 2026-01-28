/**
 * DatabaseManager: Single long-lived database connection
 *
 * Responsibility:
 * - Manage single database connection for worker lifetime
 * - Provide centralized access to SessionStore and SessionSearch
 * - High-level database operations
 * - QueryRouter integration for tiered search
 */

import { SessionStore } from '../sqlite/SessionStore.js';
import { SessionSearch } from '../sqlite/SessionSearch.js';
import { logger } from '../../utils/logger.js';
import type { DBSession } from '../worker-types.js';
import type { TieredStorageManager } from '../storage/tiered/TieredStorageManager.js';
import { initializeTieredStorage, closeTieredStorage } from '../storage/tiered/TieredStorageManager.js';
import type { QueryRouter } from '../storage/tiered/QueryRouter.js';
import { initializeQueryRouter } from '../storage/tiered/QueryRouter.js';

export class DatabaseManager {
  private sessionStore: SessionStore | null = null;
  private sessionSearch: SessionSearch | null = null;
  private tieredStorage: TieredStorageManager | null = null;
  private queryRouter: QueryRouter | null = null;

  /**
   * Initialize database connection (once, stays open)
   */
  async initialize(): Promise<void> {
    // Open database connection (ONCE)
    this.sessionStore = new SessionStore();
    this.sessionSearch = new SessionSearch();

    // Initialize TieredStorage (Redis + PostgreSQL) - graceful degradation if unavailable
    try {
      this.tieredStorage = await initializeTieredStorage();
      logger.info('DB', 'TieredStorageManager initialized');
    } catch (err) {
      logger.warn('DB', 'Tiered storage not available, continuing with SQLite only', {
        error: err instanceof Error ? err.message : String(err)
      });
      this.tieredStorage = null;
    }

    // Initialize QueryRouter for tiered search - graceful degradation
    try {
      this.queryRouter = await initializeQueryRouter();
      logger.info('DB', 'QueryRouter initialized');
    } catch (err) {
      logger.warn('DB', 'QueryRouter not available, search will use SQLite only', {
        error: err instanceof Error ? err.message : String(err)
      });
      this.queryRouter = null;
    }

    logger.info('DB', 'Database initialized');
  }

  /**
   * Close database connection and cleanup all resources
   */
  async close(): Promise<void> {
    // Close TieredStorage first (Redis + PostgreSQL connections)
    if (this.tieredStorage) {
      try {
        await closeTieredStorage();
      } catch (err) {
        logger.warn('DB', 'Error closing tiered storage', {
          error: err instanceof Error ? err.message : String(err)
        });
      }
      this.tieredStorage = null;
    }

    this.queryRouter = null;

    if (this.sessionStore) {
      this.sessionStore.close();
      this.sessionStore = null;
    }
    if (this.sessionSearch) {
      this.sessionSearch.close();
      this.sessionSearch = null;
    }
    logger.info('DB', 'Database closed');
  }

  /**
   * Get SessionStore instance (throws if not initialized)
   */
  getSessionStore(): SessionStore {
    if (!this.sessionStore) {
      throw new Error('Database not initialized');
    }
    return this.sessionStore;
  }

  /**
   * Get SessionSearch instance (throws if not initialized)
   */
  getSessionSearch(): SessionSearch {
    if (!this.sessionSearch) {
      throw new Error('Database not initialized');
    }
    return this.sessionSearch;
  }

  /**
   * Get QueryRouter instance (returns null if unavailable)
   * Returns null for graceful degradation when PostgreSQL/Redis/Ollama
   * are not configured or reachable.
   */
  getQueryRouter(): QueryRouter | null {
    return this.queryRouter;
  }

  /**
   * Get TieredStorageManager instance (returns null if unavailable)
   * Unlike other getters, this returns null for graceful degradation
   * when PostgreSQL/Redis are not configured or reachable.
   */
  getTieredStorage(): TieredStorageManager | null {
    return this.tieredStorage;
  }

  // REMOVED: cleanupOrphanedSessions - violates "EVERYTHING SHOULD SAVE ALWAYS"
  // Worker restarts don't make sessions orphaned. Sessions are managed by hooks
  // and exist independently of worker state.

  /**
   * Get session by ID (throws if not found)
   */
  getSessionById(sessionDbId: number): {
    id: number;
    content_session_id: string;
    memory_session_id: string | null;
    project: string;
    user_prompt: string;
  } {
    const session = this.getSessionStore().getSessionById(sessionDbId);
    if (!session) {
      throw new Error(`Session ${sessionDbId} not found`);
    }
    return session;
  }

}
