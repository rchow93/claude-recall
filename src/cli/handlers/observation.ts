/**
 * Observation Handler - PostToolUse
 *
 * Stores raw tool data directly to SQLite. No worker daemon, no subprocess.
 * Caps tool_response at 50KB to prevent DB bloat.
 * Periodically captures assistant responses from the transcript (~every 10 min).
 * Runs periodic cleanup of old observations when DB exceeds 10GB.
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { openDatabase } from '../../services/sqlite/DirectDB.js';
import { getProjectName } from '../../utils/project-name.js';
import { logger } from '../../utils/logger.js';
import { readFileSync } from 'fs';
import { computeRelevanceScore } from './relevance.js';
import { redactSensitiveContent, containsSensitivePatterns } from '../../utils/privacy.js';
import { consolidateOldSessions, applyTimeDecay, smartCleanup } from '../../services/consolidation.js';
import { extractLatestUsage, estimateCostUsd } from '../../utils/transcript-usage.js';
import { encrypt } from '../../services/encryption.js';
import { getEncryptionKey, encryptionEnabled } from '../../services/key-management.js';

/** Max size for tool_response storage (50KB). Larger responses are truncated. */
const MAX_RESPONSE_BYTES = 50_000;
/** Max size for tool_input storage (50KB). */
const MAX_INPUT_BYTES = 50_000;
/** Default max DB size in GB. Configurable via CLAUDE_RECALL_MAX_DB_SIZE_GB. */
const DEFAULT_MAX_DB_SIZE_GB = 10;
const PAGE_SIZE = 4096;
/** Only check DB size ~1% of the time to avoid overhead */
const CLEANUP_PROBABILITY = 0.01;
/** Delete oldest 10% of raw_observations when over size limit */
const CLEANUP_BATCH_PERCENT = 0.10;
/** Capture transcript every 10 minutes (600 seconds) */
const TRANSCRIPT_CAPTURE_INTERVAL = 600;
/** Max chars per assistant response */
const MAX_ASSISTANT_RESPONSE_CHARS = 10_000;

function truncateStr(s: string | null, maxLen: number): string | null {
  if (s == null) return null;
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + '...[truncated at ' + maxLen + ' chars]';
}

function stringify(val: unknown): string | null {
  if (val == null) return null;
  if (typeof val === 'string') return val;
  return JSON.stringify(val);
}

/**
 * Extract text from a transcript message content field.
 */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((block: any) => block.type === 'text' && typeof block.text === 'string')
      .map((block: any) => block.text)
      .join('\n');
  }
  return '';
}

/**
 * Read the conversation transcript and extract assistant responses.
 * Replaces any previous _assistant_responses for this session.
 */
function captureTranscript(db: any, sessionId: string, project: string, cwd: string, transcriptPath: string, nowEpoch: number): void {
  let data: string;
  try {
    data = readFileSync(transcriptPath, 'utf-8');
  } catch {
    return; // File not readable, skip silently
  }

  const lines = data.split('\n').filter(l => l.trim());
  const responses: Array<{ prompt_number: number; text: string }> = [];
  let promptNumber = 0;

  for (const line of lines) {
    try {
      const msg = JSON.parse(line);
      const role = msg.role ?? msg.message?.role;
      if (role === 'user') promptNumber++;
      if (role === 'assistant') {
        const content = msg.content ?? msg.message?.content;
        const text = extractText(content);
        if (text.trim()) {
          responses.push({
            prompt_number: promptNumber,
            text: text.length > MAX_ASSISTANT_RESPONSE_CHARS
              ? text.slice(0, MAX_ASSISTANT_RESPONSE_CHARS) + '...[truncated]'
              : text
          });
        }
      }
    } catch { /* skip malformed lines */ }
  }

  if (responses.length === 0) return;

  const responsesJson = JSON.stringify(responses);
  let capped: string = responsesJson.length > 50_000
    ? responsesJson.slice(0, 50_000) + '...[truncated]'
    : responsesJson;

  // Encrypt transcript content at rest
  let transcriptEncrypted = 0;
  if (encryptionEnabled()) {
    try {
      capped = encrypt(capped, getEncryptionKey());
      transcriptEncrypted = 1;
    } catch { /* fall through to plaintext */ }
  }

  // Delete previous snapshot for this session, insert fresh one
  db.run(
    `DELETE FROM raw_observations WHERE content_session_id = ? AND tool_name = '_assistant_responses'`,
    [sessionId]
  );
  db.run(
    `INSERT INTO raw_observations (content_session_id, project, tool_name, tool_input, tool_response, cwd, prompt_number, created_at, created_at_epoch, encrypted)
     VALUES (?, ?, '_assistant_responses', NULL, ?, ?, ?, ?, ?, ?)`,
    [sessionId, project, capped, cwd, promptNumber, new Date().toISOString(), nowEpoch, transcriptEncrypted]
  );

  logger.debug('HOOK', `Captured ${responses.length} assistant responses from transcript`);
}

export const observationHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const { sessionId, cwd, toolName, toolInput, toolResponse, transcriptPath } = input;

    if (!toolName) {
      throw new Error('observationHandler requires toolName');
    }
    if (!cwd) {
      throw new Error(`Missing cwd in PostToolUse hook input for session ${sessionId}, tool ${toolName}`);
    }

    const project = getProjectName(cwd);
    const now = new Date();
    const nowEpoch = Math.floor(now.getTime() / 1000);
    const db = openDatabase();

    try {
      // Ensure session exists
      db.run(
        `INSERT OR IGNORE INTO sdk_sessions (content_session_id, project, started_at, started_at_epoch, status)
         VALUES (?, ?, ?, ?, 'active')`,
        [sessionId, project, now.toISOString(), nowEpoch]
      );

      // Get current prompt number and privacy state for this session
      const session = db.prepare(
        'SELECT prompt_counter, privacy_suppressed FROM sdk_sessions WHERE content_session_id = ?'
      ).get(sessionId) as { prompt_counter: number; privacy_suppressed: number } | undefined;
      const promptNumber = session?.prompt_counter ?? 0;

      // Skip storage entirely if privacy suppression is active
      if (session?.privacy_suppressed) {
        logger.debug('HOOK', 'Observation skipped — privacy suppression active', { toolName });
        return { continue: true, suppressOutput: true };
      }

      // Truncate large payloads to prevent DB bloat
      let inputStr = truncateStr(stringify(toolInput), MAX_INPUT_BYTES);
      let responseStr = truncateStr(stringify(toolResponse), MAX_RESPONSE_BYTES);

      // Auto-redact sensitive content (API keys, tokens, passwords)
      // Enabled by default for security. Set CLAUDE_RECALL_REDACT_SECRETS=false to disable.
      const shouldRedact = (process.env.CLAUDE_RECALL_REDACT_SECRETS ?? 'true').toLowerCase() !== 'false';
      let redacted = 0;
      if (shouldRedact && inputStr && containsSensitivePatterns(inputStr)) {
        inputStr = redactSensitiveContent(inputStr);
        redacted = 1;
      }
      if (shouldRedact && responseStr && containsSensitivePatterns(responseStr)) {
        responseStr = redactSensitiveContent(responseStr);
        redacted = 1;
      }

      // Compute relevance score for smart prioritization
      const recentTools = db.prepare(
        `SELECT tool_name, tool_input FROM raw_observations
         WHERE content_session_id = ? ORDER BY id DESC LIMIT 5`
      ).all(sessionId) as Array<{ tool_name: string; tool_input: string | null }>;

      const lastPrompt = db.prepare(
        `SELECT prompt_text FROM user_prompts
         WHERE content_session_id = ? ORDER BY prompt_number DESC LIMIT 1`
      ).get(sessionId) as { prompt_text: string } | undefined;

      const relevanceScore = computeRelevanceScore({
        toolName,
        toolInput,
        toolResponse,
        recentTools,
        lastPromptText: lastPrompt?.prompt_text,
      });

      // Extract model/usage from transcript (non-blocking — null if unavailable)
      const usage = transcriptPath ? extractLatestUsage(transcriptPath) : null;
      const model = usage?.model ?? null;

      // Encrypt tool_response at rest (tool_input stays plaintext for FTS5 search)
      let encrypted = 0;
      if (encryptionEnabled() && responseStr) {
        try {
          const key = getEncryptionKey();
          responseStr = encrypt(responseStr, key);
          encrypted = 1;
        } catch (err) {
          logger.warn('ENCRYPTION', 'Failed to encrypt tool_response, storing plaintext', undefined, err as Error);
        }
      }

      db.run(
        `INSERT INTO raw_observations (content_session_id, project, tool_name, tool_input, tool_response, cwd, prompt_number, created_at, created_at_epoch, relevance_score, redacted, model, encrypted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [sessionId, project, toolName, inputStr, responseStr, cwd, promptNumber, now.toISOString(), nowEpoch, relevanceScore, redacted, model, encrypted]
      );

      // Upsert per-turn usage into api_usage (deduped by session + prompt_number)
      if (usage && promptNumber > 0) {
        const costUsd = estimateCostUsd(usage);
        db.run(
          `INSERT INTO api_usage (content_session_id, prompt_number, model, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, cost_usd, service_tier, created_at, created_at_epoch)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(content_session_id, prompt_number) DO UPDATE SET
             model = excluded.model,
             input_tokens = excluded.input_tokens,
             output_tokens = excluded.output_tokens,
             cache_creation_input_tokens = excluded.cache_creation_input_tokens,
             cache_read_input_tokens = excluded.cache_read_input_tokens,
             cost_usd = excluded.cost_usd,
             service_tier = excluded.service_tier`,
          [sessionId, promptNumber, usage.model, usage.inputTokens, usage.outputTokens,
           usage.cacheCreationInputTokens, usage.cacheReadInputTokens, costUsd,
           usage.serviceTier, now.toISOString(), nowEpoch]
        );
      }

      // Periodic transcript capture: every ~10 minutes, snapshot assistant responses
      // Check when we last captured for this session
      if (transcriptPath) {
        const lastCapture = db.prepare(
          `SELECT created_at_epoch FROM raw_observations
           WHERE content_session_id = ? AND tool_name = '_assistant_responses'
           ORDER BY id DESC LIMIT 1`
        ).get(sessionId) as { created_at_epoch: number } | undefined;

        const sinceLastCapture = lastCapture
          ? nowEpoch - lastCapture.created_at_epoch
          : Infinity;

        if (sinceLastCapture >= TRANSCRIPT_CAPTURE_INTERVAL) {
          captureTranscript(db, sessionId, project, cwd, transcriptPath, nowEpoch);
        }
      }

      // Periodic maintenance: consolidation, time decay, and size-based cleanup
      if (Math.random() < CLEANUP_PROBABILITY) {
        // Consolidate old sessions (>7 days) into compressed summaries
        consolidateOldSessions(db);

        // Decay relevance scores for observations older than 30 days
        applyTimeDecay(db);

        // Size-based cleanup: delete low-relevance observations when DB exceeds configured limit
        const maxSizeGb = Math.max(1, parseFloat(process.env.CLAUDE_RECALL_MAX_DB_SIZE_GB ?? '') || DEFAULT_MAX_DB_SIZE_GB);
        const maxPages = Math.floor(maxSizeGb * 1024 * 1024 * 1024 / PAGE_SIZE);
        const pageCount = (db.prepare('PRAGMA page_count').get() as { page_count: number })?.page_count ?? 0;
        if (pageCount > maxPages) {
          const currentSizeMb = Math.round(pageCount * PAGE_SIZE / 1024 / 1024);
          const limitMb = Math.round(maxSizeGb * 1024);
          logger.warn('HOOK', `Database size (${currentSizeMb}MB) exceeds configured limit (${limitMb}MB) — cleanup in progress, removing lowest-relevance 10% of observations`);
          const totalRows = (db.prepare('SELECT COUNT(*) as cnt FROM raw_observations').get() as { cnt: number })?.cnt ?? 0;
          const deleteCount = Math.max(100, Math.floor(totalRows * CLEANUP_BATCH_PERCENT));
          smartCleanup(db, deleteCount);
        }
      }

      logger.debug('HOOK', 'Raw observation stored', { toolName });
    } finally {
      db.close();
    }

    return { continue: true, suppressOutput: true };
  }
};
