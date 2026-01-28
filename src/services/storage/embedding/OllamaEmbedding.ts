/**
 * Ollama Embedding Service
 * Uses nomic-embed-text for 768-dimensional embeddings
 */

import { getTieredStorageConfig, type OllamaConfig } from '../config.js';

interface OllamaEmbeddingResponse {
  embedding: number[];
}

interface OllamaErrorResponse {
  error: string;
}

export class OllamaEmbeddingService {
  private config: OllamaConfig;
  private available: boolean | null = null;

  constructor(config?: Partial<OllamaConfig>) {
    const defaultConfig = getTieredStorageConfig().ollama;
    this.config = { ...defaultConfig, ...config };
  }

  /**
   * Check if Ollama service is available
   */
  async isAvailable(): Promise<boolean> {
    if (this.available !== null) {
      return this.available;
    }

    try {
      const response = await fetch(`${this.config.host}/api/tags`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        this.available = false;
        return false;
      }

      const data = await response.json() as { models?: Array<{ name: string }> };
      const models = data.models || [];

      // Check if our embedding model is available
      const hasModel = models.some(m =>
        m.name === this.config.embeddingModel ||
        m.name.startsWith(`${this.config.embeddingModel}:`)
      );

      if (!hasModel) {
        console.warn(`[OllamaEmbedding] Model ${this.config.embeddingModel} not found. Available models: ${models.map(m => m.name).join(', ')}`);
        this.available = false;
        return false;
      }

      this.available = true;
      return true;
    } catch (error) {
      console.warn(`[OllamaEmbedding] Ollama not available: ${error instanceof Error ? error.message : 'unknown error'}`);
      this.available = false;
      return false;
    }
  }

  /**
   * Generate embedding for a single text
   */
  async generateEmbedding(text: string): Promise<number[]> {
    if (!text || !text.trim()) {
      throw new Error('Cannot generate embedding for empty text');
    }

    const response = await fetch(`${this.config.host}/api/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.config.embeddingModel,
        prompt: text.trim(),
      }),
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });

    if (!response.ok) {
      const error = await response.json() as OllamaErrorResponse;
      throw new Error(`Ollama embedding failed: ${error.error || response.statusText}`);
    }

    const data = await response.json() as OllamaEmbeddingResponse;

    if (!data.embedding || !Array.isArray(data.embedding)) {
      throw new Error('Invalid embedding response from Ollama');
    }

    if (data.embedding.length !== this.config.embeddingDimension) {
      console.warn(`[OllamaEmbedding] Unexpected dimension: got ${data.embedding.length}, expected ${this.config.embeddingDimension}`);
    }

    return data.embedding;
  }

  /**
   * Generate embeddings for multiple texts in batch
   */
  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    // Ollama doesn't support true batch embedding yet, so we parallelize
    const validTexts = texts.filter(t => t && t.trim());

    if (validTexts.length === 0) {
      return [];
    }

    // Process in batches of 10 to avoid overwhelming the service
    const batchSize = 10;
    const results: number[][] = [];

    for (let i = 0; i < validTexts.length; i += batchSize) {
      const batch = validTexts.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(text => this.generateEmbedding(text))
      );
      results.push(...batchResults);
    }

    return results;
  }

  /**
   * Get embedding dimension
   */
  getDimension(): number {
    return this.config.embeddingDimension;
  }

  /**
   * Get model name
   */
  getModelName(): string {
    return this.config.embeddingModel;
  }
}

/**
 * Singleton instance
 */
let embeddingServiceInstance: OllamaEmbeddingService | null = null;

export function getOllamaEmbeddingService(): OllamaEmbeddingService {
  if (!embeddingServiceInstance) {
    embeddingServiceInstance = new OllamaEmbeddingService();
  }
  return embeddingServiceInstance;
}

/**
 * Reset instance (for testing)
 */
export function resetOllamaEmbeddingService(): void {
  embeddingServiceInstance = null;
}

/**
 * Helper: Create searchable text from observation fields
 */
export function createObservationSearchText(observation: {
  title?: string | null;
  subtitle?: string | null;
  narrative?: string | null;
  facts?: string[] | null;
  concepts?: string[] | null;
}): string {
  const parts: string[] = [];

  if (observation.title) {
    parts.push(observation.title);
  }
  if (observation.subtitle) {
    parts.push(observation.subtitle);
  }
  if (observation.narrative) {
    parts.push(observation.narrative);
  }
  if (observation.facts && observation.facts.length > 0) {
    parts.push(observation.facts.join(' '));
  }
  if (observation.concepts && observation.concepts.length > 0) {
    parts.push(observation.concepts.join(' '));
  }

  return parts.join(' ').trim();
}

/**
 * Helper: Create searchable text from summary fields
 */
export function createSummarySearchText(summary: {
  request?: string | null;
  investigated?: string | null;
  learned?: string | null;
  completed?: string | null;
  next_steps?: string | null;
  notes?: string | null;
}): string {
  const parts: string[] = [];

  if (summary.request) {
    parts.push(summary.request);
  }
  if (summary.investigated) {
    parts.push(summary.investigated);
  }
  if (summary.learned) {
    parts.push(summary.learned);
  }
  if (summary.completed) {
    parts.push(summary.completed);
  }
  if (summary.next_steps) {
    parts.push(summary.next_steps);
  }
  if (summary.notes) {
    parts.push(summary.notes);
  }

  return parts.join(' ').trim();
}
