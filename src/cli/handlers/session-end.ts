/**
 * Session End Handler - SessionEnd
 *
 * Marks the session as completed in the database when the user exits Claude Code.
 * This ensures sessions don't remain stuck in 'active' status forever.
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { ensureWorkerRunning, getWorkerPort } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';

export const sessionEndHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    // Ensure worker is running before any other logic
    await ensureWorkerRunning();

    const { sessionId } = input;
    const port = getWorkerPort();

    logger.debug('HOOK', 'SessionEnd: Marking session as completed', {
      contentSessionId: sessionId,
      workerPort: port
    });

    try {
      // Send to worker to mark session as completed
      const response = await fetch(`http://127.0.0.1:${port}/api/sessions/end`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contentSessionId: sessionId
        })
      });

      if (!response.ok) {
        logger.warn('HOOK', 'SessionEnd: Failed to mark session completed', {
          contentSessionId: sessionId,
          status: response.status
        });
      } else {
        logger.debug('HOOK', 'SessionEnd: Session marked as completed', { contentSessionId: sessionId });
      }
    } catch (error) {
      // Don't fail the hook if we can't reach the worker
      // The session will stay active but that's better than blocking the user
      logger.warn('HOOK', 'SessionEnd: Could not reach worker', { contentSessionId: sessionId, error });
    }

    return { continue: true, suppressOutput: true };
  }
};
