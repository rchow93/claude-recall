/**
 * Extract model and token usage from the Claude Code transcript JSONL.
 *
 * The transcript file contains one JSON object per line. Assistant messages
 * include message.model and message.usage with full token breakdown:
 *   - input_tokens (non-cached input)
 *   - output_tokens
 *   - cache_creation_input_tokens
 *   - cache_read_input_tokens
 *   - service_tier
 *
 * We read the tail of the file (last 200KB) to find the most recent
 * assistant message without loading the entire transcript into memory.
 */

import { openSync, readSync, fstatSync, closeSync } from 'fs';

export interface TranscriptUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  serviceTier: string | null;
}

const TAIL_BYTES = 200_000;

const MODEL_PRICING: Record<string, { inputPer1M: number; outputPer1M: number; cacheReadPer1M: number; cacheWritePer1M: number }> = {
  'claude-opus-4-8':   { inputPer1M: 15,  outputPer1M: 75,  cacheReadPer1M: 1.5,  cacheWritePer1M: 18.75 },
  'claude-opus-4-6':   { inputPer1M: 15,  outputPer1M: 75,  cacheReadPer1M: 1.5,  cacheWritePer1M: 18.75 },
  'claude-sonnet-4-6': { inputPer1M: 3,   outputPer1M: 15,  cacheReadPer1M: 0.3,  cacheWritePer1M: 3.75  },
  'claude-haiku-4-5':  { inputPer1M: 0.8, outputPer1M: 4,   cacheReadPer1M: 0.08, cacheWritePer1M: 1     },
};

export function estimateCostUsd(usage: TranscriptUsage): number {
  const baseModel = Object.keys(MODEL_PRICING).find(k => usage.model.startsWith(k));
  const pricing = baseModel ? MODEL_PRICING[baseModel] : MODEL_PRICING['claude-sonnet-4-6'];

  const inputCost = (usage.inputTokens / 1_000_000) * pricing.inputPer1M;
  const outputCost = (usage.outputTokens / 1_000_000) * pricing.outputPer1M;
  const cacheReadCost = (usage.cacheReadInputTokens / 1_000_000) * pricing.cacheReadPer1M;
  const cacheWriteCost = (usage.cacheCreationInputTokens / 1_000_000) * pricing.cacheWritePer1M;

  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}

export function extractLatestUsage(transcriptPath: string): TranscriptUsage | null {
  let fd: number;
  try {
    fd = openSync(transcriptPath, 'r');
  } catch {
    return null;
  }

  try {
    const stat = fstatSync(fd);
    const fileSize = stat.size;
    if (fileSize === 0) return null;

    const readStart = Math.max(0, fileSize - TAIL_BYTES);
    const readLen = fileSize - readStart;
    const buf = Buffer.alloc(readLen);
    readSync(fd, buf, 0, readLen, readStart);

    const tail = buf.toString('utf-8');
    const lines = tail.split('\n');

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;

      try {
        const obj = JSON.parse(line);
        const msg = obj.message;
        if (!msg || msg.role !== 'assistant') continue;

        const model = msg.model;
        const usage = msg.usage;
        if (!model || !usage) continue;
        if (model === '<synthetic>') continue;

        return {
          model,
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
          cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
          cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
          serviceTier: usage.service_tier ?? null,
        };
      } catch {
        continue;
      }
    }

    return null;
  } finally {
    closeSync(fd);
  }
}
