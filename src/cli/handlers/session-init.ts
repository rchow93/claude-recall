/**
 * Session Init Handler - UserPromptSubmit
 *
 * Extracted from new-hook.ts - initializes session and starts SDK agent.
 * Enhanced with per-prompt RAG retrieval for context injection.
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { ensureWorkerRunning, getWorkerPort } from '../../shared/worker-utils.js';
import { getProjectName } from '../../utils/project-name.js';
import { logger } from '../../utils/logger.js';

/**
 * RAG query response type
 */
interface RAGQueryResponse {
  context: string;
  stats: {
    observationCount: number;
    summaryCount: number;
    queryTimeMs: number;
    hotTierHit: boolean;
    available: boolean;
    error?: string;
  };
}

/**
 * Query RAG system for relevant context based on user prompt
 * Gracefully degrades to empty context if RAG is unavailable
 */
async function queryRAGContext(
  port: number,
  prompt: string,
  project: string,
  tokenBudget: number = 2000
): Promise<{ context: string; stats: RAGQueryResponse['stats'] }> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/rag/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: prompt,
        project,
        limit: 5,
        tokenBudget
      })
    });

    if (!response.ok) {
      logger.debug('HOOK', 'RAG query failed with status', { status: response.status });
      return { context: '', stats: { observationCount: 0, summaryCount: 0, queryTimeMs: 0, hotTierHit: false, available: false } };
    }

    const result = await response.json() as RAGQueryResponse;
    return { context: result.context, stats: result.stats };
  } catch (err) {
    logger.debug('HOOK', 'RAG query error', { error: err instanceof Error ? err.message : String(err) });
    return { context: '', stats: { observationCount: 0, summaryCount: 0, queryTimeMs: 0, hotTierHit: false, available: false } };
  }
}

export const sessionInitHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    // Ensure worker is running before any other logic
    await ensureWorkerRunning();

    const { sessionId, cwd, prompt } = input;

    if (!prompt) {
      throw new Error('sessionInitHandler requires prompt');
    }

    const project = getProjectName(cwd);
    const port = getWorkerPort();

    logger.debug('HOOK', 'session-init: Calling /api/sessions/init', { contentSessionId: sessionId, project });

    // Initialize session via HTTP - handles DB operations and privacy checks
    const initResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contentSessionId: sessionId,
        project,
        prompt
      })
      // Note: Removed signal to avoid Windows Bun cleanup issue (libuv assertion)
    });

    if (!initResponse.ok) {
      throw new Error(`Session initialization failed: ${initResponse.status}`);
    }

    const initResult = await initResponse.json() as {
      sessionDbId: number;
      promptNumber: number;
      skipped?: boolean;
      reason?: string;
    };
    const sessionDbId = initResult.sessionDbId;
    const promptNumber = initResult.promptNumber;

    logger.debug('HOOK', 'session-init: Received from /api/sessions/init', { sessionDbId, promptNumber, skipped: initResult.skipped });

    // Debug-level alignment log for detailed tracing
    logger.debug('HOOK', `[ALIGNMENT] Hook Entry | contentSessionId=${sessionId} | prompt#=${promptNumber} | sessionDbId=${sessionDbId}`);

    // Check if prompt was entirely private (worker performs privacy check)
    if (initResult.skipped && initResult.reason === 'private') {
      logger.info('HOOK', `INIT_COMPLETE | sessionDbId=${sessionDbId} | promptNumber=${promptNumber} | skipped=true | reason=private`, {
        sessionId: sessionDbId
      });
      return { continue: true, suppressOutput: true };
    }

    // Only initialize SDK agent for Claude Code (not Cursor)
    // Cursor doesn't use the SDK agent - it only needs session/observation storage
    if (input.platform !== 'cursor' && sessionDbId) {
      // Strip leading slash from commands for memory agent
      // /review 101 -> review 101 (more semantic for observations)
      const cleanedPrompt = prompt.startsWith('/') ? prompt.substring(1) : prompt;

      logger.debug('HOOK', 'session-init: Calling /sessions/{sessionDbId}/init', { sessionDbId, promptNumber });

      // Initialize SDK agent session via HTTP (starts the agent!)
      const response = await fetch(`http://127.0.0.1:${port}/sessions/${sessionDbId}/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userPrompt: cleanedPrompt, promptNumber })
        // Note: Removed signal to avoid Windows Bun cleanup issue (libuv assertion)
      });

      if (!response.ok) {
        throw new Error(`SDK agent start failed: ${response.status}`);
      }
    } else if (input.platform === 'cursor') {
      logger.debug('HOOK', 'session-init: Skipping SDK agent init for Cursor platform', { sessionDbId, promptNumber });
    }

    logger.info('HOOK', `INIT_COMPLETE | sessionDbId=${sessionDbId} | promptNumber=${promptNumber} | project=${project}`, {
      sessionId: sessionDbId
    });

    // Per-prompt RAG: Retrieve relevant context for injection
    // This runs in parallel with other operations for minimal latency impact
    const ragResult = await queryRAGContext(port, prompt, project, 2000);

    if (ragResult.context && ragResult.context.trim()) {
      logger.debug('HOOK', 'RAG context retrieved', {
        sessionId: sessionDbId,
        promptNumber,
        contextLength: ragResult.context.length,
        observationCount: ragResult.stats.observationCount,
        summaryCount: ragResult.stats.summaryCount,
        queryTimeMs: ragResult.stats.queryTimeMs,
        hotTierHit: ragResult.stats.hotTierHit
      });

      // Return with RAG context for injection
      return {
        continue: true,
        suppressOutput: true,
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: ragResult.context
        }
      };
    }

    // No RAG context available
    return { continue: true, suppressOutput: true };
  }
};
