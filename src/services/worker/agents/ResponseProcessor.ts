/**
 * ResponseProcessor: Shared response processing for all agent implementations
 *
 * Responsibility:
 * - Parse observations and summaries from agent responses
 * - Execute atomic database transactions
 * - Orchestrate tiered storage sync (fire-and-forget)
 * - Broadcast to SSE clients
 * - Clean up processed messages
 *
 * This module extracts 150+ lines of duplicate code from SDKAgent, GeminiAgent, and OpenRouterAgent.
 */

import { logger } from '../../../utils/logger.js';
import { parseObservations, parseSummary, type ParsedObservation, type ParsedSummary } from '../../../sdk/parser.js';
import { updateCursorContextForProject } from '../../integrations/CursorHooksInstaller.js';
import { updateFolderClaudeMdFiles } from '../../../utils/claude-md-utils.js';
import { getWorkerPort } from '../../../shared/worker-utils.js';
import type { ActiveSession } from '../../worker-types.js';
import type { DatabaseManager } from '../DatabaseManager.js';
import type { SessionManager } from '../SessionManager.js';
import type { WorkerRef, StorageResult } from './types.js';
import { broadcastObservation, broadcastSummary } from './ObservationBroadcaster.js';
import { cleanupProcessedMessages } from './SessionCleanupHelper.js';
import type { ObservationInput } from '../../storage/interfaces/IObservationStore.js';
import type { SessionSummaryInput } from '../../storage/interfaces/ISummaryStore.js';
import { getTieredStorageConfig } from '../../storage/config.js';

/**
 * Process agent response text (parse XML, save to database, sync to tiered storage, broadcast SSE)
 *
 * This is the unified response processor that handles:
 * 1. Adding response to conversation history (for provider interop)
 * 2. Parsing observations and summaries from XML
 * 3. Atomic database transaction to store observations + summary
 * 4. Async tiered storage sync (fire-and-forget, failures are non-critical)
 * 5. SSE broadcast to web UI clients
 * 6. Session cleanup
 *
 * @param text - Response text from the agent
 * @param session - Active session being processed
 * @param dbManager - Database manager for storage operations
 * @param sessionManager - Session manager for message tracking
 * @param worker - Worker reference for SSE broadcasting (optional)
 * @param discoveryTokens - Token cost delta for this response
 * @param originalTimestamp - Original epoch when message was queued (for accurate timestamps)
 * @param agentName - Name of the agent for logging (e.g., 'SDK', 'Gemini', 'OpenRouter')
 */
export async function processAgentResponse(
  text: string,
  session: ActiveSession,
  dbManager: DatabaseManager,
  sessionManager: SessionManager,
  worker: WorkerRef | undefined,
  discoveryTokens: number,
  originalTimestamp: number | null,
  agentName: string,
  projectRoot?: string
): Promise<void> {
  // Add assistant response to shared conversation history for provider interop
  if (text) {
    session.conversationHistory.push({ role: 'assistant', content: text });
  }

  // Parse observations and summary
  const observations = parseObservations(text, session.contentSessionId);
  const summary = parseSummary(text, session.sessionDbId);

  // Convert nullable fields to empty strings for storeSummary (if summary exists)
  const summaryForStore = normalizeSummaryForStorage(summary);

  // Get session store for atomic transaction
  const sessionStore = dbManager.getSessionStore();

  // CRITICAL: Must use memorySessionId (not contentSessionId) for FK constraint
  if (!session.memorySessionId) {
    throw new Error('Cannot store observations: memorySessionId not yet captured');
  }

  // Log pre-storage with session ID chain for verification
  logger.info('DB', `STORING | sessionDbId=${session.sessionDbId} | memorySessionId=${session.memorySessionId} | obsCount=${observations.length} | hasSummary=${!!summaryForStore}`, {
    sessionId: session.sessionDbId,
    memorySessionId: session.memorySessionId
  });

  // Check storage mode and tiered availability
  const config = getTieredStorageConfig();
  const storageMode = config.storageMode;
  const tieredStorage = dbManager.getTieredStorage();
  const useTieredPrimary = storageMode === 'tiered-primary' && tieredStorage !== null;

  let result: StorageResult;

  if (useTieredPrimary) {
    // TIERED-PRIMARY MODE: PostgreSQL + Redis first, SQLite as fallback
    logger.info('DB', `Using tiered-primary mode`, { sessionId: session.sessionDbId });

    try {
      // Build tiered inputs
      const tieredObsInputs: ObservationInput[] = observations.map((obs) => ({
        memory_session_id: session.memorySessionId!,
        project: session.project,
        type: obs.type,
        title: obs.title,
        subtitle: obs.subtitle,
        facts: obs.facts,
        narrative: obs.narrative,
        concepts: obs.concepts,
        files_read: obs.files_read,
        files_modified: obs.files_modified,
        prompt_number: session.lastPromptNumber,
        discovery_tokens: discoveryTokens,
        created_at_epoch: originalTimestamp ?? Date.now(),
      }));

      // Store observations to tiered storage (PostgreSQL)
      const storedObs = await tieredStorage.storeObservations(tieredObsInputs);
      const observationIds = storedObs.map(o => o.id);
      const createdAtEpoch = storedObs[0]?.created_at_epoch ?? Date.now();

      // Store summary to tiered storage if present
      let summaryId: number | null = null;
      if (summaryForStore) {
        const summaryInput: SessionSummaryInput = {
          memory_session_id: session.memorySessionId!,
          project: session.project,
          request: summaryForStore.request,
          investigated: summaryForStore.investigated,
          learned: summaryForStore.learned,
          completed: summaryForStore.completed,
          next_steps: summaryForStore.next_steps,
          notes: summaryForStore.notes,
          discovery_tokens: discoveryTokens,
        };
        const storedSummary = await tieredStorage.storeSummary(summaryInput);
        summaryId = storedSummary.id;
      }

      result = { observationIds, summaryId, createdAtEpoch };

      logger.info('DB', `STORED (tiered-primary) | obsCount=${observationIds.length} | summaryId=${summaryId || 'none'}`, {
        sessionId: session.sessionDbId,
      });

      // Backup to SQLite (fire-and-forget, for local redundancy)
      sessionStore.storeObservations(
        session.memorySessionId,
        session.project,
        observations,
        summaryForStore,
        session.lastPromptNumber,
        discoveryTokens,
        originalTimestamp ?? undefined
      );
      logger.debug('DB', 'SQLite backup completed (tiered-primary mode)', { sessionId: session.sessionDbId });

    } catch (tieredError) {
      // Tiered storage failed - fall back to SQLite
      logger.warn('DB', `Tiered storage failed, falling back to SQLite`, {
        sessionId: session.sessionDbId,
        error: tieredError instanceof Error ? tieredError.message : String(tieredError),
      });

      result = sessionStore.storeObservations(
        session.memorySessionId,
        session.project,
        observations,
        summaryForStore,
        session.lastPromptNumber,
        discoveryTokens,
        originalTimestamp ?? undefined
      );

      logger.info('DB', `STORED (SQLite fallback) | obsCount=${result.observationIds.length} | summaryId=${result.summaryId || 'none'}`, {
        sessionId: session.sessionDbId,
      });
    }
  } else {
    // SQLITE-PRIMARY MODE (default): SQLite first, sync to tiered after
    result = sessionStore.storeObservations(
      session.memorySessionId,
      session.project,
      observations,
      summaryForStore,
      session.lastPromptNumber,
      discoveryTokens,
      originalTimestamp ?? undefined
    );

    // Log storage result with IDs for end-to-end traceability
    logger.info('DB', `STORED (sqlite-primary) | sessionDbId=${session.sessionDbId} | memorySessionId=${session.memorySessionId} | obsCount=${result.observationIds.length} | obsIds=[${result.observationIds.join(',')}] | summaryId=${result.summaryId || 'none'}`, {
      sessionId: session.sessionDbId,
      memorySessionId: session.memorySessionId
    });
  }

  // AFTER primary storage commits - async operations (broadcast, folder updates)
  await syncAndBroadcastObservations(
    observations,
    result,
    session,
    dbManager,
    worker,
    discoveryTokens,
    agentName,
    projectRoot,
    useTieredPrimary  // Skip tiered sync if already done as primary
  );

  // Sync and broadcast summary if present
  await syncAndBroadcastSummary(
    summary,
    summaryForStore,
    result,
    session,
    dbManager,
    worker,
    discoveryTokens,
    agentName,
    useTieredPrimary  // Skip tiered sync if already done as primary
  );

  // Clean up session state
  cleanupProcessedMessages(session, worker);
}

/**
 * Normalize summary for storage (convert null fields to empty strings)
 */
function normalizeSummaryForStorage(summary: ParsedSummary | null): {
  request: string;
  investigated: string;
  learned: string;
  completed: string;
  next_steps: string;
  notes: string | null;
} | null {
  if (!summary) return null;

  return {
    request: summary.request || '',
    investigated: summary.investigated || '',
    learned: summary.learned || '',
    completed: summary.completed || '',
    next_steps: summary.next_steps || '',
    notes: summary.notes
  };
}

/**
 * Sync observations to tiered storage and broadcast to SSE clients
 * @param skipTieredSync - If true, skip tiered storage sync (already done as primary)
 */
async function syncAndBroadcastObservations(
  observations: ParsedObservation[],
  result: StorageResult,
  session: ActiveSession,
  dbManager: DatabaseManager,
  worker: WorkerRef | undefined,
  discoveryTokens: number,
  agentName: string,
  projectRoot?: string,
  skipTieredSync: boolean = false
): Promise<void> {
  for (let i = 0; i < observations.length; i++) {
    const obsId = result.observationIds[i];
    const obs = observations[i];

    // Broadcast to SSE clients (for web UI)
    // BUGFIX: Use obs.files_read and obs.files_modified (not obs.files)
    broadcastObservation(worker, {
      id: obsId,
      memory_session_id: session.memorySessionId,
      session_id: session.contentSessionId,
      type: obs.type,
      title: obs.title,
      subtitle: obs.subtitle,
      text: null,  // text field is not in ParsedObservation
      narrative: obs.narrative || null,
      facts: JSON.stringify(obs.facts || []),
      concepts: JSON.stringify(obs.concepts || []),
      files_read: JSON.stringify(obs.files_read || []),
      files_modified: JSON.stringify(obs.files_modified || []),
      project: session.project,
      prompt_number: session.lastPromptNumber,
      created_at_epoch: result.createdAtEpoch
    });
  }

  // Sync to Tiered Storage (fire-and-forget) - skip if already written as primary
  if (!skipTieredSync) {
    const tieredStorage = dbManager.getTieredStorage();
    if (tieredStorage && observations.length > 0) {
      const tieredInputs: ObservationInput[] = observations.map((obs) => ({
        memory_session_id: session.memorySessionId!,
        project: session.project,
        type: obs.type,
        title: obs.title,
        subtitle: obs.subtitle,
        facts: obs.facts,
        narrative: obs.narrative,
        concepts: obs.concepts,
        files_read: obs.files_read,
        files_modified: obs.files_modified,
        prompt_number: session.lastPromptNumber,
        discovery_tokens: discoveryTokens,
        created_at_epoch: result.createdAtEpoch,
      }));

      tieredStorage.storeObservations(tieredInputs).then((stored) => {
        logger.debug('TIERED', `${stored.length} observations synced to tiered storage`, {
          sessionId: session.sessionDbId,
          project: session.project,
        });
      }).catch((error) => {
        logger.error('TIERED', `${agentName} tiered storage sync failed, continuing without PG/Redis`, {
          sessionId: session.sessionDbId,
          obsCount: observations.length,
        }, error);
      });
    }
  }

  // Update folder CLAUDE.md files for touched folders (fire-and-forget)
  // This runs per-observation batch to ensure folders are updated as work happens
  const allFilePaths: string[] = [];
  for (const obs of observations) {
    allFilePaths.push(...(obs.files_modified || []));
    allFilePaths.push(...(obs.files_read || []));
  }

  if (allFilePaths.length > 0) {
    updateFolderClaudeMdFiles(
      allFilePaths,
      session.project,
      getWorkerPort(),
      projectRoot
    ).catch(error => {
      logger.warn('FOLDER_INDEX', 'CLAUDE.md update failed (non-critical)', { project: session.project }, error as Error);
    });
  }
}

/**
 * Sync summary to tiered storage and broadcast to SSE clients
 * @param skipTieredSync - If true, skip tiered storage sync (already done as primary)
 */
async function syncAndBroadcastSummary(
  summary: ParsedSummary | null,
  summaryForStore: { request: string; investigated: string; learned: string; completed: string; next_steps: string; notes: string | null } | null,
  result: StorageResult,
  session: ActiveSession,
  dbManager: DatabaseManager,
  worker: WorkerRef | undefined,
  discoveryTokens: number,
  agentName: string,
  skipTieredSync: boolean = false
): Promise<void> {
  if (!summaryForStore || !result.summaryId) {
    return;
  }

  // Sync to Tiered Storage (fire-and-forget) - skip if already written as primary
  if (!skipTieredSync) {
    const tieredStorage = dbManager.getTieredStorage();
    if (tieredStorage) {
      const summaryInput: SessionSummaryInput = {
        memory_session_id: session.memorySessionId!,
        project: session.project,
        request: summaryForStore.request,
        investigated: summaryForStore.investigated,
        learned: summaryForStore.learned,
        completed: summaryForStore.completed,
        next_steps: summaryForStore.next_steps,
        notes: summaryForStore.notes,
        prompt_number: session.lastPromptNumber,
        discovery_tokens: discoveryTokens,
        created_at_epoch: result.createdAtEpoch,
      };

      tieredStorage.storeSummary(summaryInput).then((stored) => {
        logger.debug('TIERED', 'Summary synced to tiered storage', {
          summaryId: result.summaryId,
          sessionId: session.sessionDbId,
          project: session.project,
        });
      }).catch((error) => {
        logger.error('TIERED', `${agentName} tiered storage summary sync failed, continuing without PG/Redis`, {
          summaryId: result.summaryId,
          sessionId: session.sessionDbId,
        }, error);
      });
    }
  }

  // Broadcast to SSE clients (for web UI)
  broadcastSummary(worker, {
    id: result.summaryId,
    session_id: session.contentSessionId,
    request: summary!.request,
    investigated: summary!.investigated,
    learned: summary!.learned,
    completed: summary!.completed,
    next_steps: summary!.next_steps,
    notes: summary!.notes,
    project: session.project,
    prompt_number: session.lastPromptNumber,
    created_at_epoch: result.createdAtEpoch
  });

  // Update Cursor context file for registered projects (fire-and-forget)
  updateCursorContextForProject(session.project, getWorkerPort()).catch(error => {
    logger.warn('CURSOR', 'Context update failed (non-critical)', { project: session.project }, error as Error);
  });
}
