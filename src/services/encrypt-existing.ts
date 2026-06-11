import type { Database } from 'bun:sqlite';
import { encrypt } from './encryption.js';
import { getEncryptionKey, encryptionEnabled } from './key-management.js';
import { logger } from '../utils/logger.js';

const BATCH_SIZE = 500;

export function encryptExistingData(db: Database): void {
  if (!encryptionEnabled()) return;

  const key = getEncryptionKey();

  const unencryptedObs = (db.prepare(
    'SELECT COUNT(*) as cnt FROM raw_observations WHERE encrypted = 0 AND tool_response IS NOT NULL'
  ).get() as { cnt: number })?.cnt ?? 0;

  const unencryptedCons = (db.prepare(
    'SELECT COUNT(*) as cnt FROM consolidated_sessions WHERE encrypted = 0'
  ).get() as { cnt: number })?.cnt ?? 0;

  if (unencryptedObs === 0 && unencryptedCons === 0) return;

  logger.info('ENCRYPTION', `Encrypting existing data: ${unencryptedObs} observations, ${unencryptedCons} consolidated sessions`);

  let obsEncrypted = 0;
  const updateObs = db.prepare('UPDATE raw_observations SET tool_response = ?, encrypted = 1 WHERE id = ?');

  while (true) {
    const rows = db.prepare(
      'SELECT id, tool_response FROM raw_observations WHERE encrypted = 0 AND tool_response IS NOT NULL LIMIT ?'
    ).all(BATCH_SIZE) as Array<{ id: number; tool_response: string }>;

    if (rows.length === 0) break;

    const tx = db.transaction(() => {
      for (const row of rows) {
        try {
          const encrypted = encrypt(row.tool_response, key);
          updateObs.run(encrypted, row.id);
          obsEncrypted++;
        } catch {
          db.run('UPDATE raw_observations SET encrypted = 0 WHERE id = ?', [row.id]);
        }
      }
    });
    tx();
  }

  let consEncrypted = 0;
  const updateCons = db.prepare('UPDATE consolidated_sessions SET summary = ?, encrypted = 1 WHERE id = ?');

  while (true) {
    const rows = db.prepare(
      'SELECT id, summary FROM consolidated_sessions WHERE encrypted = 0 LIMIT ?'
    ).all(BATCH_SIZE) as Array<{ id: number; summary: string }>;

    if (rows.length === 0) break;

    const tx = db.transaction(() => {
      for (const row of rows) {
        try {
          const encrypted = encrypt(row.summary, key);
          updateCons.run(encrypted, row.id);
          consEncrypted++;
        } catch {
          db.run('UPDATE consolidated_sessions SET encrypted = 0 WHERE id = ?', [row.id]);
        }
      }
    });
    tx();
  }

  logger.info('ENCRYPTION', `Encrypted ${obsEncrypted} observations, ${consEncrypted} consolidated sessions`);
}
