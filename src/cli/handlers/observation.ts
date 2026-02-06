/**
 * Observation Handler - PostToolUse
 *
 * Stores raw tool data directly to SQLite. No worker daemon, no subprocess.
 * Caps tool_response at 10KB to prevent DB bloat.
 * Periodically captures assistant responses from the transcript (~every 10 min).
 * Runs periodic cleanup of old observations when DB exceeds 10GB.
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { openDatabase } from '../../services/sqlite/DirectDB.js';
import { getProjectName } from '../../utils/project-name.js';
import { logger } from '../../utils/logger.js';
import { readFileSync } from 'fs';

/** Max size for tool_response storage (10KB). Larger responses are truncated. */
const MAX_RESPONSE_BYTES = 10_000;
/** Max size for tool_input storage (10KB). */
const MAX_INPUT_BYTES = 10_000;
/** Max database page count before cleanup triggers. 10GB / 4096 = 2,621,440 pages */
const MAX_DB_PAGES = 2_621_440;
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
  const capped = responsesJson.length > 50_000
    ? responsesJson.slice(0, 50_000) + '...[truncated]'
    : responsesJson;

  // Delete previous snapshot for this session, insert fresh one
  db.run(
    `DELETE FROM raw_observations WHERE content_session_id = ? AND tool_name = '_assistant_responses'`,
    [sessionId]
  );
  db.run(
    `INSERT INTO raw_observations (content_session_id, project, tool_name, tool_input, tool_response, cwd, prompt_number, created_at, created_at_epoch)
     VALUES (?, ?, '_assistant_responses', NULL, ?, ?, ?, ?, ?)`,
    [sessionId, project, capped, cwd, promptNumber, new Date().toISOString(), nowEpoch]
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

      // Get current prompt number for this session
      const session = db.prepare(
        'SELECT prompt_counter FROM sdk_sessions WHERE content_session_id = ?'
      ).get(sessionId) as { prompt_counter: number } | undefined;
      const promptNumber = session?.prompt_counter ?? 0;

      // Truncate large payloads to prevent DB bloat
      const inputStr = truncateStr(stringify(toolInput), MAX_INPUT_BYTES);
      const responseStr = truncateStr(stringify(toolResponse), MAX_RESPONSE_BYTES);

      db.run(
        `INSERT INTO raw_observations (content_session_id, project, tool_name, tool_input, tool_response, cwd, prompt_number, created_at, created_at_epoch)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [sessionId, project, toolName, inputStr, responseStr, cwd, promptNumber, now.toISOString(), nowEpoch]
      );

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

      // Periodic size-based cleanup: delete oldest observations when DB exceeds 10GB
      if (Math.random() < CLEANUP_PROBABILITY) {
        const pageCount = (db.prepare('PRAGMA page_count').get() as { page_count: number })?.page_count ?? 0;
        if (pageCount > MAX_DB_PAGES) {
          const totalRows = (db.prepare('SELECT COUNT(*) as cnt FROM raw_observations').get() as { cnt: number })?.cnt ?? 0;
          const deleteCount = Math.max(100, Math.floor(totalRows * CLEANUP_BATCH_PERCENT));
          const deleted = db.run(
            `DELETE FROM raw_observations WHERE id IN (
              SELECT id FROM raw_observations ORDER BY created_at_epoch ASC LIMIT ?
            )`,
            [deleteCount]
          );
          if (deleted.changes > 0) {
            logger.info('HOOK', `Size cleanup: deleted ${deleted.changes} oldest observations (DB was ${Math.round(pageCount * 4096 / 1024 / 1024)}MB, limit 10GB)`);
          }
        }
      }

      logger.debug('HOOK', 'Raw observation stored', { toolName });
    } finally {
      db.close();
    }

    return { continue: true, suppressOutput: true };
  }
};
