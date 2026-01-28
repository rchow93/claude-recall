/**
 * PostgreSQL Observation Store Implementation
 * Cold tier storage with pgvector embeddings
 */

import { getPostgresClient, type PostgresClient } from './PostgresClient.js';
import type {
  IObservationStore,
  StoredObservation,
  ObservationInput,
  ObservationQueryOptions,
} from '../interfaces/IObservationStore.js';
import {
  getOllamaEmbeddingService,
  createObservationSearchText,
} from '../embedding/OllamaEmbedding.js';

export class PostgresObservationStore implements IObservationStore {
  private client: PostgresClient;

  constructor(client?: PostgresClient) {
    this.client = client || getPostgresClient();
  }

  async store(observation: ObservationInput): Promise<StoredObservation> {
    const now = Date.now();
    const createdAtEpoch = observation.created_at_epoch || now;
    const createdAt = new Date(createdAtEpoch).toISOString();

    // Generate embedding if not provided
    let embedding = observation.embedding;
    if (!embedding) {
      try {
        const embeddingService = getOllamaEmbeddingService();
        if (await embeddingService.isAvailable()) {
          const searchText = createObservationSearchText(observation);
          if (searchText) {
            embedding = await embeddingService.generateEmbedding(searchText);
          }
        }
      } catch (err) {
        console.warn('[PostgresObservationStore] Failed to generate embedding:', err);
      }
    }

    const result = await this.client.query<StoredObservation>(
      `INSERT INTO observations (
        memory_session_id, project, type, title, subtitle,
        facts, narrative, concepts, files_read, files_modified,
        prompt_number, discovery_tokens, embedding,
        created_at, created_at_epoch
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING *`,
      [
        observation.memory_session_id,
        observation.project,
        observation.type,
        observation.title || null,
        observation.subtitle || null,
        JSON.stringify(observation.facts || []),
        observation.narrative || null,
        JSON.stringify(observation.concepts || []),
        JSON.stringify(observation.files_read || []),
        JSON.stringify(observation.files_modified || []),
        observation.prompt_number || null,
        observation.discovery_tokens || 0,
        embedding ? `[${embedding.join(',')}]` : null,
        createdAt,
        createdAtEpoch,
      ]
    );

    return this.rowToObservation(result.rows[0]);
  }

  async storeBatch(observations: ObservationInput[]): Promise<StoredObservation[]> {
    if (observations.length === 0) {
      return [];
    }

    // Generate embeddings in batch
    const embeddingService = getOllamaEmbeddingService();
    const hasEmbeddings = await embeddingService.isAvailable();

    const observationsWithEmbeddings = await Promise.all(
      observations.map(async (obs) => {
        if (obs.embedding) {
          return obs;
        }
        if (hasEmbeddings) {
          try {
            const searchText = createObservationSearchText(obs);
            if (searchText) {
              const embedding = await embeddingService.generateEmbedding(searchText);
              return { ...obs, embedding };
            }
          } catch (err) {
            console.warn('[PostgresObservationStore] Failed to generate embedding:', err);
          }
        }
        return obs;
      })
    );

    const results: StoredObservation[] = [];
    for (const obs of observationsWithEmbeddings) {
      const stored = await this.store(obs);
      results.push(stored);
    }

    return results;
  }

  async getById(id: number): Promise<StoredObservation | null> {
    const result = await this.client.query(
      'SELECT * FROM observations WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.rowToObservation(result.rows[0]);
  }

  async getByIds(ids: number[]): Promise<StoredObservation[]> {
    if (ids.length === 0) {
      return [];
    }

    const result = await this.client.query(
      'SELECT * FROM observations WHERE id = ANY($1) ORDER BY created_at_epoch DESC',
      [ids]
    );

    return result.rows.map((row) => this.rowToObservation(row));
  }

  async getBySession(
    memorySessionId: string,
    options: ObservationQueryOptions = {}
  ): Promise<StoredObservation[]> {
    const { limit = 100, offset = 0, order = 'desc' } = options;

    const result = await this.client.query(
      `SELECT * FROM observations
       WHERE memory_session_id = $1
       ORDER BY created_at_epoch ${order === 'asc' ? 'ASC' : 'DESC'}
       LIMIT $2 OFFSET $3`,
      [memorySessionId, limit, offset]
    );

    return result.rows.map((row) => this.rowToObservation(row));
  }

  async getRecent(options: ObservationQueryOptions = {}): Promise<StoredObservation[]> {
    const {
      project,
      types,
      concepts,
      files,
      limit = 100,
      offset = 0,
      since_epoch,
      until_epoch,
      order = 'desc',
    } = options;

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (project) {
      conditions.push(`project = $${paramIndex++}`);
      params.push(project);
    }

    if (types && types.length > 0) {
      conditions.push(`type = ANY($${paramIndex++})`);
      params.push(types);
    }

    if (concepts && concepts.length > 0) {
      conditions.push(`concepts ?| $${paramIndex++}`);
      params.push(concepts);
    }

    if (files && files.length > 0) {
      conditions.push(`(files_read ?| $${paramIndex} OR files_modified ?| $${paramIndex++})`);
      params.push(files);
    }

    if (since_epoch) {
      conditions.push(`created_at_epoch >= $${paramIndex++}`);
      params.push(since_epoch);
    }

    if (until_epoch) {
      conditions.push(`created_at_epoch <= $${paramIndex++}`);
      params.push(until_epoch);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    params.push(limit, offset);

    const result = await this.client.query(
      `SELECT * FROM observations
       ${whereClause}
       ORDER BY created_at_epoch ${order === 'asc' ? 'ASC' : 'DESC'}
       LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
      params
    );

    return result.rows.map((row) => this.rowToObservation(row));
  }

  async delete(id: number): Promise<boolean> {
    const result = await this.client.query(
      'DELETE FROM observations WHERE id = $1',
      [id]
    );

    return (result.rowCount ?? 0) > 0;
  }

  async deleteOlderThan(epochMs: number): Promise<number> {
    const result = await this.client.query(
      'DELETE FROM observations WHERE created_at_epoch < $1',
      [epochMs]
    );

    return result.rowCount ?? 0;
  }

  async exists(id: number): Promise<boolean> {
    const result = await this.client.query(
      'SELECT 1 FROM observations WHERE id = $1',
      [id]
    );

    return result.rows.length > 0;
  }

  async count(options: ObservationQueryOptions = {}): Promise<number> {
    const { project, types, since_epoch, until_epoch } = options;

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (project) {
      conditions.push(`project = $${paramIndex++}`);
      params.push(project);
    }

    if (types && types.length > 0) {
      conditions.push(`type = ANY($${paramIndex++})`);
      params.push(types);
    }

    if (since_epoch) {
      conditions.push(`created_at_epoch >= $${paramIndex++}`);
      params.push(since_epoch);
    }

    if (until_epoch) {
      conditions.push(`created_at_epoch <= $${paramIndex++}`);
      params.push(until_epoch);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await this.client.query(
      `SELECT COUNT(*) as count FROM observations ${whereClause}`,
      params
    );

    return parseInt(result.rows[0]?.count || '0', 10);
  }

  /**
   * Convert database row to StoredObservation
   */
  private rowToObservation(row: any): StoredObservation {
    return {
      id: row.id,
      memory_session_id: row.memory_session_id,
      project: row.project,
      type: row.type,
      title: row.title,
      subtitle: row.subtitle,
      facts: typeof row.facts === 'string' ? JSON.parse(row.facts) : row.facts,
      narrative: row.narrative,
      concepts: typeof row.concepts === 'string' ? JSON.parse(row.concepts) : row.concepts,
      files_read: typeof row.files_read === 'string' ? JSON.parse(row.files_read) : row.files_read,
      files_modified: typeof row.files_modified === 'string' ? JSON.parse(row.files_modified) : row.files_modified,
      prompt_number: row.prompt_number,
      discovery_tokens: row.discovery_tokens || 0,
      embedding: row.embedding ? this.parseEmbedding(row.embedding) : undefined,
      created_at: row.created_at,
      created_at_epoch: parseInt(row.created_at_epoch, 10),
    };
  }

  /**
   * Parse embedding from PostgreSQL vector format
   */
  private parseEmbedding(embedding: any): number[] | undefined {
    if (!embedding) {
      return undefined;
    }
    if (Array.isArray(embedding)) {
      return embedding;
    }
    if (typeof embedding === 'string') {
      // pgvector returns as string like "[0.1,0.2,...]"
      try {
        return JSON.parse(embedding);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

/**
 * Singleton instance
 */
let observationStoreInstance: PostgresObservationStore | null = null;

export function getPostgresObservationStore(): PostgresObservationStore {
  if (!observationStoreInstance) {
    observationStoreInstance = new PostgresObservationStore();
  }
  return observationStoreInstance;
}
