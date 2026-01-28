/**
 * Redis Observation Store Implementation
 * Hot tier storage with RediSearch vector indexing
 */

import {
  getRedisClient,
  type RedisClientWrapper,
  embeddingToBuffer,
  bufferToEmbedding,
} from './RedisClient.js';
import type {
  IObservationStore,
  StoredObservation,
  ObservationInput,
  ObservationQueryOptions,
} from '../interfaces/IObservationStore.js';
import type {
  IObservationSearchEngine,
  SearchResult,
  VectorSearchOptions,
  TextSearchOptions,
  HybridSearchOptions,
} from '../interfaces/ISearchEngine.js';
import { reciprocalRankFusion } from '../interfaces/ISearchEngine.js';
import {
  getOllamaEmbeddingService,
  createObservationSearchText,
} from '../embedding/OllamaEmbedding.js';

export class RedisObservationStore implements IObservationStore {
  private redisClient: RedisClientWrapper;

  constructor(client?: RedisClientWrapper) {
    this.redisClient = client || getRedisClient();
  }

  private getKey(id: number): string {
    return `${this.redisClient.getKeyPrefix()}observation:${id}`;
  }

  private getTimelineKey(project: string): string {
    return `${this.redisClient.getKeyPrefix()}timeline:${project}`;
  }

  async store(observation: ObservationInput): Promise<StoredObservation> {
    const client = await this.redisClient.getClient();
    const now = Date.now();
    const createdAtEpoch = observation.created_at_epoch || now;
    const createdAt = new Date(createdAtEpoch).toISOString();

    // Generate ID (use timestamp + random for uniqueness)
    const id = parseInt(`${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(-10), 10);

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
        console.warn('[RedisObservationStore] Failed to generate embedding:', err);
      }
    }

    const stored: StoredObservation = {
      id,
      memory_session_id: observation.memory_session_id,
      project: observation.project,
      type: observation.type,
      title: observation.title || null,
      subtitle: observation.subtitle || null,
      facts: observation.facts || null,
      narrative: observation.narrative || null,
      concepts: observation.concepts || null,
      files_read: observation.files_read || null,
      files_modified: observation.files_modified || null,
      prompt_number: observation.prompt_number || null,
      discovery_tokens: observation.discovery_tokens || 0,
      embedding,
      created_at: createdAt,
      created_at_epoch: createdAtEpoch,
    };

    // Store as hash
    const hashData: Record<string, string | Buffer> = {
      id: id.toString(),
      memory_session_id: stored.memory_session_id,
      project: stored.project,
      type: stored.type,
      title: stored.title || '',
      subtitle: stored.subtitle || '',
      facts: JSON.stringify(stored.facts || []),
      narrative: stored.narrative || '',
      concepts: JSON.stringify(stored.concepts || []),
      files_read: JSON.stringify(stored.files_read || []),
      files_modified: JSON.stringify(stored.files_modified || []),
      prompt_number: (stored.prompt_number || 0).toString(),
      discovery_tokens: stored.discovery_tokens.toString(),
      created_at: stored.created_at,
      created_at_epoch: stored.created_at_epoch.toString(),
    };

    if (embedding) {
      hashData.embedding = embeddingToBuffer(embedding);
    }

    const key = this.getKey(id);
    await client.hSet(key, hashData);

    // Set TTL
    await client.expire(key, this.redisClient.getHotTierTTL());

    // Add to project timeline (sorted set)
    await client.zAdd(this.getTimelineKey(stored.project), {
      score: createdAtEpoch,
      value: id.toString(),
    });

    return stored;
  }

  async storeBatch(observations: ObservationInput[]): Promise<StoredObservation[]> {
    const results: StoredObservation[] = [];
    for (const obs of observations) {
      const stored = await this.store(obs);
      results.push(stored);
    }
    return results;
  }

  async getById(id: number): Promise<StoredObservation | null> {
    const client = await this.redisClient.getClient();
    const data = await client.hGetAll(this.getKey(id));

    if (!data || Object.keys(data).length === 0) {
      return null;
    }

    return this.hashToObservation(data);
  }

  async getByIds(ids: number[]): Promise<StoredObservation[]> {
    const results: StoredObservation[] = [];
    for (const id of ids) {
      const obs = await this.getById(id);
      if (obs) {
        results.push(obs);
      }
    }
    return results;
  }

  async getBySession(
    memorySessionId: string,
    options: ObservationQueryOptions = {}
  ): Promise<StoredObservation[]> {
    const client = await this.redisClient.getClient();
    const { limit = 100, order = 'desc' } = options;

    // Search using RediSearch
    const query = `@memory_session_id:{${this.escapeTag(memorySessionId)}}`;
    const results = await client.ft.search(
      `${this.redisClient.getKeyPrefix()}idx:obs`,
      query,
      {
        LIMIT: { from: 0, size: limit },
        SORTBY: { BY: 'created_at_epoch', DIRECTION: order === 'asc' ? 'ASC' : 'DESC' },
      }
    );

    return results.documents.map((doc) => this.documentToObservation(doc));
  }

  async getRecent(options: ObservationQueryOptions = {}): Promise<StoredObservation[]> {
    const client = await this.redisClient.getClient();
    const {
      project,
      types,
      limit = 100,
      offset = 0,
      since_epoch,
      until_epoch,
      order = 'desc',
    } = options;

    // Build query
    const queryParts: string[] = ['*'];

    if (project) {
      queryParts[0] = `@project:{${this.escapeTag(project)}}`;
    }

    if (types && types.length > 0) {
      const typeQuery = types.map((t) => this.escapeTag(t)).join('|');
      queryParts.push(`@type:{${typeQuery}}`);
    }

    if (since_epoch) {
      queryParts.push(`@created_at_epoch:[${since_epoch} +inf]`);
    }

    if (until_epoch) {
      queryParts.push(`@created_at_epoch:[-inf ${until_epoch}]`);
    }

    const query = queryParts.join(' ');

    const results = await client.ft.search(
      `${this.redisClient.getKeyPrefix()}idx:obs`,
      query,
      {
        LIMIT: { from: offset, size: limit },
        SORTBY: { BY: 'created_at_epoch', DIRECTION: order === 'asc' ? 'ASC' : 'DESC' },
      }
    );

    return results.documents.map((doc) => this.documentToObservation(doc));
  }

  async delete(id: number): Promise<boolean> {
    const client = await this.redisClient.getClient();
    const obs = await this.getById(id);

    if (!obs) {
      return false;
    }

    // Remove from hash
    await client.del(this.getKey(id));

    // Remove from timeline
    await client.zRem(this.getTimelineKey(obs.project), id.toString());

    return true;
  }

  async deleteOlderThan(epochMs: number): Promise<number> {
    const client = await this.redisClient.getClient();

    // Find old observations
    const results = await client.ft.search(
      `${this.redisClient.getKeyPrefix()}idx:obs`,
      `@created_at_epoch:[-inf ${epochMs}]`,
      { LIMIT: { from: 0, size: 10000 } }
    );

    let deleted = 0;
    for (const doc of results.documents) {
      const id = parseInt(doc.value.id as string, 10);
      if (await this.delete(id)) {
        deleted++;
      }
    }

    return deleted;
  }

  async exists(id: number): Promise<boolean> {
    const client = await this.redisClient.getClient();
    return (await client.exists(this.getKey(id))) > 0;
  }

  async count(options: ObservationQueryOptions = {}): Promise<number> {
    const client = await this.redisClient.getClient();
    const { project, types, since_epoch, until_epoch } = options;

    const queryParts: string[] = ['*'];

    if (project) {
      queryParts[0] = `@project:{${this.escapeTag(project)}}`;
    }

    if (types && types.length > 0) {
      const typeQuery = types.map((t) => this.escapeTag(t)).join('|');
      queryParts.push(`@type:{${typeQuery}}`);
    }

    if (since_epoch) {
      queryParts.push(`@created_at_epoch:[${since_epoch} +inf]`);
    }

    if (until_epoch) {
      queryParts.push(`@created_at_epoch:[-inf ${until_epoch}]`);
    }

    const results = await client.ft.search(
      `${this.redisClient.getKeyPrefix()}idx:obs`,
      queryParts.join(' '),
      { LIMIT: { from: 0, size: 0 } }
    );

    return results.total;
  }

  /**
   * Cache an observation from PostgreSQL
   */
  async cache(observation: StoredObservation): Promise<void> {
    const client = await this.redisClient.getClient();

    const hashData: Record<string, string | Buffer> = {
      id: observation.id.toString(),
      memory_session_id: observation.memory_session_id,
      project: observation.project,
      type: observation.type,
      title: observation.title || '',
      subtitle: observation.subtitle || '',
      facts: JSON.stringify(observation.facts || []),
      narrative: observation.narrative || '',
      concepts: JSON.stringify(observation.concepts || []),
      files_read: JSON.stringify(observation.files_read || []),
      files_modified: JSON.stringify(observation.files_modified || []),
      prompt_number: (observation.prompt_number || 0).toString(),
      discovery_tokens: observation.discovery_tokens.toString(),
      created_at: observation.created_at,
      created_at_epoch: observation.created_at_epoch.toString(),
    };

    if (observation.embedding) {
      hashData.embedding = embeddingToBuffer(observation.embedding);
    }

    const key = this.getKey(observation.id);
    await client.hSet(key, hashData);
    await client.expire(key, this.redisClient.getHotTierTTL());

    // Add to timeline
    await client.zAdd(this.getTimelineKey(observation.project), {
      score: observation.created_at_epoch,
      value: observation.id.toString(),
    });
  }

  private escapeTag(value: string): string {
    // Escape special characters for RediSearch TAG fields
    return value.replace(/[,.<>{}[\]"':;!@#$%^&*()\-+=~]/g, '\\$&');
  }

  private hashToObservation(data: Record<string, string>): StoredObservation {
    return {
      id: parseInt(data.id, 10),
      memory_session_id: data.memory_session_id,
      project: data.project,
      type: data.type as StoredObservation['type'],
      title: data.title || null,
      subtitle: data.subtitle || null,
      facts: data.facts ? JSON.parse(data.facts) : null,
      narrative: data.narrative || null,
      concepts: data.concepts ? JSON.parse(data.concepts) : null,
      files_read: data.files_read ? JSON.parse(data.files_read) : null,
      files_modified: data.files_modified ? JSON.parse(data.files_modified) : null,
      prompt_number: data.prompt_number ? parseInt(data.prompt_number, 10) : null,
      discovery_tokens: parseInt(data.discovery_tokens || '0', 10),
      embedding: data.embedding ? bufferToEmbedding(Buffer.from(data.embedding)) : undefined,
      created_at: data.created_at,
      created_at_epoch: parseInt(data.created_at_epoch, 10),
    };
  }

  private documentToObservation(doc: any): StoredObservation {
    const value = doc.value;
    return {
      id: parseInt(value.id, 10),
      memory_session_id: value.memory_session_id,
      project: value.project,
      type: value.type as StoredObservation['type'],
      title: value.title || null,
      subtitle: value.subtitle || null,
      facts: value.facts ? JSON.parse(value.facts) : null,
      narrative: value.narrative || null,
      concepts: value.concepts ? JSON.parse(value.concepts) : null,
      files_read: value.files_read ? JSON.parse(value.files_read) : null,
      files_modified: value.files_modified ? JSON.parse(value.files_modified) : null,
      prompt_number: value.prompt_number ? parseInt(value.prompt_number, 10) : null,
      discovery_tokens: parseInt(value.discovery_tokens || '0', 10),
      embedding: value.embedding ? bufferToEmbedding(Buffer.from(value.embedding)) : undefined,
      created_at: value.created_at,
      created_at_epoch: parseInt(value.created_at_epoch, 10),
    };
  }
}

export class RedisObservationSearch implements IObservationSearchEngine {
  private redisClient: RedisClientWrapper;
  private store: RedisObservationStore;

  constructor(client?: RedisClientWrapper) {
    this.redisClient = client || getRedisClient();
    this.store = new RedisObservationStore(this.redisClient);
  }

  async vectorSearch(options: VectorSearchOptions): Promise<SearchResult<StoredObservation>[]> {
    const client = await this.redisClient.getClient();
    const {
      embedding,
      limit = 10,
      project,
      types,
      since_epoch,
      until_epoch,
      minScore = 0,
    } = options;

    // Build filter query
    const filterParts: string[] = [];

    if (project) {
      filterParts.push(`@project:{${this.escapeTag(project)}}`);
    }

    if (types && types.length > 0) {
      const typeQuery = types.map((t) => this.escapeTag(t)).join('|');
      filterParts.push(`@type:{${typeQuery}}`);
    }

    if (since_epoch) {
      filterParts.push(`@created_at_epoch:[${since_epoch} +inf]`);
    }

    if (until_epoch) {
      filterParts.push(`@created_at_epoch:[-inf ${until_epoch}]`);
    }

    const filterQuery = filterParts.length > 0 ? filterParts.join(' ') : '*';
    const embeddingBuffer = embeddingToBuffer(embedding);

    // KNN search
    const query = `(${filterQuery})=>[KNN ${limit * 2} @embedding $vec AS score]`;

    const results = await client.ft.search(
      `${this.redisClient.getKeyPrefix()}idx:obs`,
      query,
      {
        PARAMS: { vec: embeddingBuffer },
        SORTBY: { BY: 'score', DIRECTION: 'ASC' }, // Lower distance = better
        LIMIT: { from: 0, size: limit * 2 },
        DIALECT: 2,
      }
    );

    // Convert distance to similarity score (1 - distance for cosine)
    return results.documents
      .map((doc) => ({
        item: this.documentToObservation(doc),
        score: 1 - (parseFloat(doc.value.score as string) || 0),
        source: 'vector' as const,
      }))
      .filter((r) => r.score >= minScore)
      .slice(0, limit);
  }

  async textSearch(options: TextSearchOptions): Promise<SearchResult<StoredObservation>[]> {
    const client = await this.redisClient.getClient();
    const {
      query,
      limit = 10,
      project,
      types,
      since_epoch,
      until_epoch,
    } = options;

    // Build query
    const queryParts: string[] = [];

    // Text search on title and narrative
    queryParts.push(`(@title:${this.escapeText(query)} | @narrative:${this.escapeText(query)})`);

    if (project) {
      queryParts.push(`@project:{${this.escapeTag(project)}}`);
    }

    if (types && types.length > 0) {
      const typeQuery = types.map((t) => this.escapeTag(t)).join('|');
      queryParts.push(`@type:{${typeQuery}}`);
    }

    if (since_epoch) {
      queryParts.push(`@created_at_epoch:[${since_epoch} +inf]`);
    }

    if (until_epoch) {
      queryParts.push(`@created_at_epoch:[-inf ${until_epoch}]`);
    }

    const results = await client.ft.search(
      `${this.redisClient.getKeyPrefix()}idx:obs`,
      queryParts.join(' '),
      {
        LIMIT: { from: 0, size: limit },
        SORTBY: { BY: 'created_at_epoch', DIRECTION: 'DESC' },
      }
    );

    // RediSearch text search doesn't return scores the same way, normalize
    const maxIdx = results.documents.length;
    return results.documents.map((doc, idx) => ({
      item: this.documentToObservation(doc),
      score: (maxIdx - idx) / maxIdx, // Simple position-based scoring
      source: 'bm25' as const,
    }));
  }

  async hybridSearch(options: HybridSearchOptions): Promise<SearchResult<StoredObservation>[]> {
    const {
      query,
      embedding,
      limit = 10,
      project,
      types,
      since_epoch,
      until_epoch,
    } = options;

    const [vectorResults, textResults] = await Promise.all([
      this.vectorSearch({
        embedding,
        limit: limit * 2,
        project,
        types,
        since_epoch,
        until_epoch,
      }),
      this.textSearch({
        query,
        limit: limit * 2,
        project,
        types,
        since_epoch,
        until_epoch,
      }),
    ]);

    const fused = reciprocalRankFusion(vectorResults, textResults, { k: 60 });
    return fused.slice(0, limit);
  }

  async index(observation: StoredObservation): Promise<void> {
    // Redis auto-indexes on store, just ensure it's cached
    await this.store.cache(observation);
  }

  async indexBatch(observations: StoredObservation[]): Promise<void> {
    for (const obs of observations) {
      await this.index(obs);
    }
  }

  async removeFromIndex(id: number): Promise<void> {
    await this.store.delete(id);
  }

  private escapeTag(value: string): string {
    return value.replace(/[,.<>{}[\]"':;!@#$%^&*()\-+=~]/g, '\\$&');
  }

  private escapeText(value: string): string {
    // Escape special characters for text search
    return value.replace(/[\\@!{}()|\-=~\[\]^"'+*?:]/g, '\\$&');
  }

  private documentToObservation(doc: any): StoredObservation {
    const value = doc.value;
    return {
      id: parseInt(value.id, 10),
      memory_session_id: value.memory_session_id,
      project: value.project,
      type: value.type as StoredObservation['type'],
      title: value.title || null,
      subtitle: value.subtitle || null,
      facts: value.facts ? JSON.parse(value.facts) : null,
      narrative: value.narrative || null,
      concepts: value.concepts ? JSON.parse(value.concepts) : null,
      files_read: value.files_read ? JSON.parse(value.files_read) : null,
      files_modified: value.files_modified ? JSON.parse(value.files_modified) : null,
      prompt_number: value.prompt_number ? parseInt(value.prompt_number, 10) : null,
      discovery_tokens: parseInt(value.discovery_tokens || '0', 10),
      embedding: value.embedding ? bufferToEmbedding(Buffer.from(value.embedding)) : undefined,
      created_at: value.created_at,
      created_at_epoch: parseInt(value.created_at_epoch, 10),
    };
  }
}

// Singleton instances
let observationStoreInstance: RedisObservationStore | null = null;
let observationSearchInstance: RedisObservationSearch | null = null;

export function getRedisObservationStore(): RedisObservationStore {
  if (!observationStoreInstance) {
    observationStoreInstance = new RedisObservationStore();
  }
  return observationStoreInstance;
}

export function getRedisObservationSearch(): RedisObservationSearch {
  if (!observationSearchInstance) {
    observationSearchInstance = new RedisObservationSearch();
  }
  return observationSearchInstance;
}
