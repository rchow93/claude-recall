import type { Database } from 'bun:sqlite';
import { encrypt } from './encryption.js';
import { getEncryptionKey, encryptionEnabled } from './key-management.js';
import { logger } from '../utils/logger.js';

const BATCH_SIZE = 500;

export function encryptExistingData(db: Database): void {
  if (!encryptionEnabled()) return;

  const key = getEncryptionKey();

  // Phase 1: Encrypt raw_observations — tool_response (legacy: encrypted=0)
  const unencryptedObs = (db.prepare(
    'SELECT COUNT(*) as cnt FROM raw_observations WHERE encrypted = 0 AND tool_response IS NOT NULL'
  ).get() as { cnt: number })?.cnt ?? 0;

  // Phase 2: Encrypt raw_observations — tool_input on already-encrypted rows
  // These rows have encrypted=1 (tool_response done) but tool_input still plaintext
  const plaintextInputCount = (db.prepare(
    `SELECT COUNT(*) as cnt FROM raw_observations
     WHERE encrypted = 1 AND tool_input IS NOT NULL AND tool_input NOT LIKE '$ENCRYPTED$%'`
  ).get() as { cnt: number })?.cnt ?? 0;

  // Phase 3: Encrypt raw_observations — both fields on unencrypted rows
  // (tool_input on encrypted=0 rows is handled alongside tool_response in phase 1)

  // Phase 4: Encrypt user_prompts.prompt_text
  const unencryptedPrompts = (db.prepare(
    'SELECT COUNT(*) as cnt FROM user_prompts WHERE encrypted = 0 AND prompt_text IS NOT NULL'
  ).get() as { cnt: number })?.cnt ?? 0;

  // Phase 5: Encrypt consolidated_sessions.summary
  const unencryptedCons = (db.prepare(
    'SELECT COUNT(*) as cnt FROM consolidated_sessions WHERE encrypted = 0'
  ).get() as { cnt: number })?.cnt ?? 0;

  if (unencryptedObs === 0 && plaintextInputCount === 0 && unencryptedPrompts === 0 && unencryptedCons === 0) return;

  logger.info('ENCRYPTION', `Encrypting existing data: ${unencryptedObs} obs (response), ${plaintextInputCount} obs (input), ${unencryptedPrompts} prompts, ${unencryptedCons} consolidated`);

  // Phase 1: Encrypt tool_response + tool_input on unencrypted rows
  let obsEncrypted = 0;
  while (true) {
    const rows = db.prepare(
      'SELECT id, tool_response, tool_input FROM raw_observations WHERE encrypted = 0 AND (tool_response IS NOT NULL OR tool_input IS NOT NULL) LIMIT ?'
    ).all(BATCH_SIZE) as Array<{ id: number; tool_response: string | null; tool_input: string | null }>;

    if (rows.length === 0) break;

    const tx = db.transaction(() => {
      for (const row of rows) {
        try {
          const encResponse = row.tool_response ? encrypt(row.tool_response, key) : null;
          const encInput = row.tool_input ? encrypt(row.tool_input, key) : null;
          db.run(
            'UPDATE raw_observations SET tool_response = ?, tool_input = ?, encrypted = 1 WHERE id = ?',
            [encResponse ?? row.tool_response, encInput ?? row.tool_input, row.id]
          );
          obsEncrypted++;
        } catch {
          // Leave as-is on failure
        }
      }
    });
    tx();
  }

  // Phase 2: Encrypt tool_input on rows where tool_response is already encrypted
  let inputsEncrypted = 0;
  while (true) {
    const rows = db.prepare(
      `SELECT id, tool_input FROM raw_observations
       WHERE encrypted = 1 AND tool_input IS NOT NULL AND tool_input NOT LIKE '$ENCRYPTED$%'
       LIMIT ?`
    ).all(BATCH_SIZE) as Array<{ id: number; tool_input: string }>;

    if (rows.length === 0) break;

    const tx = db.transaction(() => {
      for (const row of rows) {
        try {
          const encInput = encrypt(row.tool_input, key);
          db.run('UPDATE raw_observations SET tool_input = ? WHERE id = ?', [encInput, row.id]);
          inputsEncrypted++;
        } catch {
          // Leave as-is on failure
        }
      }
    });
    tx();
  }

  // Phase 3: Encrypt user_prompts.prompt_text
  let promptsEncrypted = 0;
  while (true) {
    const rows = db.prepare(
      'SELECT id, prompt_text FROM user_prompts WHERE encrypted = 0 AND prompt_text IS NOT NULL LIMIT ?'
    ).all(BATCH_SIZE) as Array<{ id: number; prompt_text: string }>;

    if (rows.length === 0) break;

    const tx = db.transaction(() => {
      for (const row of rows) {
        try {
          const enc = encrypt(row.prompt_text, key);
          db.run('UPDATE user_prompts SET prompt_text = ?, encrypted = 1 WHERE id = ?', [enc, row.id]);
          promptsEncrypted++;
        } catch {
          // Leave as-is on failure
        }
      }
    });
    tx();
  }

  // Phase 4: Encrypt consolidated_sessions.summary
  let consEncrypted = 0;
  while (true) {
    const rows = db.prepare(
      'SELECT id, summary FROM consolidated_sessions WHERE encrypted = 0 LIMIT ?'
    ).all(BATCH_SIZE) as Array<{ id: number; summary: string }>;

    if (rows.length === 0) break;

    const tx = db.transaction(() => {
      for (const row of rows) {
        try {
          const enc = encrypt(row.summary, key);
          db.run('UPDATE consolidated_sessions SET summary = ?, encrypted = 1 WHERE id = ?', [enc, row.id]);
          consEncrypted++;
        } catch {
          // Leave as-is on failure
        }
      }
    });
    tx();
  }

  logger.info('ENCRYPTION', `Encrypted ${obsEncrypted} obs (full), ${inputsEncrypted} obs (input only), ${promptsEncrypted} prompts, ${consEncrypted} consolidated`);
}
