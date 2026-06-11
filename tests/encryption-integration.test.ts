import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { randomBytes } from 'crypto';
import { Database } from 'bun:sqlite';
import { encrypt, decrypt, isEncrypted } from '../src/services/encryption';
import { MigrationRunner } from '../src/services/sqlite/migrations/runner';

let db: Database;
const key = randomBytes(32);

beforeAll(() => {
  db = new Database(':memory:', { create: true, readwrite: true });
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA foreign_keys = ON');
  const runner = new MigrationRunner(db);
  runner.runAllMigrations();
});

afterAll(() => {
  db.close();
});

describe('migration 26 — encrypted columns exist', () => {
  test('raw_observations has encrypted column', () => {
    const cols = db.prepare('PRAGMA table_info(raw_observations)').all() as Array<{ name: string }>;
    expect(cols.some(c => c.name === 'encrypted')).toBe(true);
  });

  test('user_prompts has encrypted column', () => {
    const cols = db.prepare('PRAGMA table_info(user_prompts)').all() as Array<{ name: string }>;
    expect(cols.some(c => c.name === 'encrypted')).toBe(true);
  });

  test('consolidated_sessions has encrypted column', () => {
    const cols = db.prepare('PRAGMA table_info(consolidated_sessions)').all() as Array<{ name: string }>;
    expect(cols.some(c => c.name === 'encrypted')).toBe(true);
  });
});

describe('encrypt → store → read → decrypt round-trip', () => {
  const sessionId = 'test-session-001';
  const plainResponse = '{"success":true,"content":"This is a secret file content with API key sk-1234"}';

  test('insert encrypted observation', () => {
    db.run(
      `INSERT INTO sdk_sessions (content_session_id, project, started_at, started_at_epoch, status, prompt_counter)
       VALUES (?, 'test-project', '2026-06-11T00:00:00Z', 1749600000, 'active', 1)`,
      [sessionId]
    );

    const encryptedResponse = encrypt(plainResponse, key);
    expect(isEncrypted(encryptedResponse)).toBe(true);

    db.run(
      `INSERT INTO raw_observations (content_session_id, project, tool_name, tool_input, tool_response, cwd, prompt_number, created_at, created_at_epoch, relevance_score, redacted, encrypted)
       VALUES (?, 'test-project', 'Read', '{"file_path":"/tmp/secret.txt"}', ?, '/tmp', 1, '2026-06-11T00:00:00Z', 1749600000, 0.8, 0, 1)`,
      [sessionId, encryptedResponse]
    );
  });

  test('raw SELECT returns encrypted ciphertext', () => {
    const row = db.prepare(
      'SELECT tool_response, encrypted FROM raw_observations WHERE content_session_id = ? AND tool_name = ?'
    ).get(sessionId, 'Read') as { tool_response: string; encrypted: number };

    expect(row.encrypted).toBe(1);
    expect(row.tool_response.startsWith('$ENCRYPTED$')).toBe(true);
    expect(row.tool_response).not.toContain('secret file content');
    expect(row.tool_response).not.toContain('sk-1234');
  });

  test('decrypt recovers original content', () => {
    const row = db.prepare(
      'SELECT tool_response, encrypted FROM raw_observations WHERE content_session_id = ? AND tool_name = ?'
    ).get(sessionId, 'Read') as { tool_response: string; encrypted: number };

    const decrypted = decrypt(row.tool_response, key);
    expect(decrypted).toBe(plainResponse);
  });
});

describe('FTS5 search still works with encrypted tool_response', () => {
  test('FTS5 indexes tool_input (plaintext), not tool_response', () => {
    // Insert observation with searchable tool_input but encrypted tool_response
    const sessionId = 'test-session-fts';
    db.run(
      `INSERT OR IGNORE INTO sdk_sessions (content_session_id, project, started_at, started_at_epoch, status, prompt_counter)
       VALUES (?, 'fts-project', '2026-06-11T00:00:00Z', 1749600000, 'active', 1)`,
      [sessionId]
    );

    const encResponse = encrypt('secret response data', key);
    db.run(
      `INSERT INTO raw_observations (content_session_id, project, tool_name, tool_input, tool_response, cwd, prompt_number, created_at, created_at_epoch, relevance_score, redacted, encrypted)
       VALUES (?, 'fts-project', 'Bash', '{"command":"grep -r uniqueSearchTerm123 ."}', ?, '/tmp', 1, '2026-06-11T00:01:00Z', 1749600060, 0.7, 0, 1)`,
      [sessionId, encResponse]
    );

    // FTS5 should find by tool_input content
    const results = db.prepare(
      `SELECT ro.id, ro.tool_name, ro.tool_response, ro.encrypted
       FROM raw_observations_fts
       JOIN raw_observations ro ON ro.id = raw_observations_fts.rowid
       WHERE raw_observations_fts MATCH 'uniqueSearchTerm123'`
    ).all() as Array<{ id: number; tool_name: string; tool_response: string; encrypted: number }>;

    expect(results.length).toBe(1);
    expect(results[0].tool_name).toBe('Bash');
    expect(results[0].encrypted).toBe(1);
    // tool_response is still encrypted in the result
    expect(results[0].tool_response.startsWith('$ENCRYPTED$')).toBe(true);
    // But we can decrypt it
    expect(decrypt(results[0].tool_response, key)).toBe('secret response data');
  });

  test('FTS5 does NOT find by encrypted tool_response content', () => {
    // Searching for content inside the encrypted response should return nothing
    const results = db.prepare(
      `SELECT COUNT(*) as cnt FROM raw_observations_fts WHERE raw_observations_fts MATCH 'secret response data'`
    ).get() as { cnt: number };
    expect(results.cnt).toBe(0);
  });
});

describe('mixed encrypted/unencrypted data', () => {
  test('plaintext rows coexist with encrypted rows', () => {
    const sessionId = 'test-session-mixed';
    db.run(
      `INSERT OR IGNORE INTO sdk_sessions (content_session_id, project, started_at, started_at_epoch, status, prompt_counter)
       VALUES (?, 'mixed-project', '2026-06-11T00:00:00Z', 1749600000, 'active', 2)`,
      [sessionId]
    );

    // Insert one plaintext, one encrypted
    db.run(
      `INSERT INTO raw_observations (content_session_id, project, tool_name, tool_input, tool_response, cwd, prompt_number, created_at, created_at_epoch, encrypted)
       VALUES (?, 'mixed-project', 'Read', '{"file_path":"a.txt"}', 'plaintext response', '/tmp', 1, '2026-06-11T00:00:00Z', 1749600000, 0)`,
      [sessionId]
    );

    const encResponse = encrypt('encrypted response', key);
    db.run(
      `INSERT INTO raw_observations (content_session_id, project, tool_name, tool_input, tool_response, cwd, prompt_number, created_at, created_at_epoch, encrypted)
       VALUES (?, 'mixed-project', 'Read', '{"file_path":"b.txt"}', ?, '/tmp', 2, '2026-06-11T00:01:00Z', 1749600060, 1)`,
      [sessionId, encResponse]
    );

    const rows = db.prepare(
      'SELECT tool_response, encrypted FROM raw_observations WHERE content_session_id = ? ORDER BY prompt_number ASC'
    ).all(sessionId) as Array<{ tool_response: string; encrypted: number }>;

    expect(rows.length).toBe(2);

    // Row 1: plaintext
    expect(rows[0].encrypted).toBe(0);
    expect(rows[0].tool_response).toBe('plaintext response');

    // Row 2: encrypted
    expect(rows[1].encrypted).toBe(1);
    expect(decrypt(rows[1].tool_response, key)).toBe('encrypted response');
  });
});

describe('encrypted _assistant_responses', () => {
  test('store and retrieve encrypted assistant responses', () => {
    const sessionId = 'test-session-assistant';
    db.run(
      `INSERT OR IGNORE INTO sdk_sessions (content_session_id, project, started_at, started_at_epoch, status, prompt_counter)
       VALUES (?, 'assistant-project', '2026-06-11T00:00:00Z', 1749600000, 'active', 1)`,
      [sessionId]
    );

    const responses = JSON.stringify([
      { prompt_number: 1, text: 'I analyzed the code and found a bug in the auth module.' }
    ]);
    const encResponses = encrypt(responses, key);

    db.run(
      `INSERT INTO raw_observations (content_session_id, project, tool_name, tool_input, tool_response, cwd, prompt_number, created_at, created_at_epoch, encrypted)
       VALUES (?, 'assistant-project', '_assistant_responses', NULL, ?, '/tmp', 1, '2026-06-11T00:00:00Z', 1749600000, 1)`,
      [sessionId, encResponses]
    );

    const row = db.prepare(
      `SELECT tool_response, encrypted FROM raw_observations
       WHERE content_session_id = ? AND tool_name = '_assistant_responses'`
    ).get(sessionId) as { tool_response: string; encrypted: number };

    expect(row.encrypted).toBe(1);
    const decrypted = decrypt(row.tool_response, key);
    const parsed = JSON.parse(decrypted);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].text).toContain('bug in the auth module');
  });
});

describe('encrypted consolidated_sessions', () => {
  test('store and retrieve encrypted summary', () => {
    const summary = 'P1: Fix the login bug\nP2: Add unit tests for auth\nP3: Deploy to staging';
    const encSummary = encrypt(summary, key);

    db.run(
      `INSERT INTO consolidated_sessions (content_session_id, project, summary, prompt_count, tool_use_count, original_started_at_epoch, consolidated_at, consolidated_at_epoch, encrypted)
       VALUES ('cons-session-001', 'cons-project', ?, 3, 10, 1749600000, '2026-06-11T01:00:00Z', 1749603600, 1)`,
      [encSummary]
    );

    const row = db.prepare(
      'SELECT summary, encrypted FROM consolidated_sessions WHERE content_session_id = ?'
    ).get('cons-session-001') as { summary: string; encrypted: number };

    expect(row.encrypted).toBe(1);
    expect(row.summary.startsWith('$ENCRYPTED$')).toBe(true);
    expect(decrypt(row.summary, key)).toBe(summary);
  });
});

describe('batch encryption of existing unencrypted data', () => {
  test('encrypt-existing migrates plaintext rows', () => {
    const sessionId = 'test-session-migrate';
    db.run(
      `INSERT OR IGNORE INTO sdk_sessions (content_session_id, project, started_at, started_at_epoch, status, prompt_counter)
       VALUES (?, 'migrate-project', '2026-06-11T00:00:00Z', 1749600000, 'active', 1)`,
      [sessionId]
    );

    // Insert 3 plaintext observations
    for (let i = 0; i < 3; i++) {
      db.run(
        `INSERT INTO raw_observations (content_session_id, project, tool_name, tool_input, tool_response, cwd, prompt_number, created_at, created_at_epoch, encrypted)
         VALUES (?, 'migrate-project', 'Read', '{"file_path":"file${i}.txt"}', 'plaintext content ${i}', '/tmp', ${i + 1}, '2026-06-11T00:0${i}:00Z', ${1749600000 + i * 60}, 0)`,
        [sessionId]
      );
    }

    // Verify they're plaintext
    const before = db.prepare(
      'SELECT COUNT(*) as cnt FROM raw_observations WHERE content_session_id = ? AND encrypted = 0 AND tool_response IS NOT NULL'
    ).get(sessionId) as { cnt: number };
    expect(before.cnt).toBe(3);

    // Run batch encryption
    const updateStmt = db.prepare('UPDATE raw_observations SET tool_response = ?, encrypted = 1 WHERE id = ?');
    const rows = db.prepare(
      'SELECT id, tool_response FROM raw_observations WHERE content_session_id = ? AND encrypted = 0 AND tool_response IS NOT NULL'
    ).all(sessionId) as Array<{ id: number; tool_response: string }>;

    const tx = db.transaction(() => {
      for (const row of rows) {
        const enc = encrypt(row.tool_response, key);
        updateStmt.run(enc, row.id);
      }
    });
    tx();

    // Verify all encrypted now
    const after = db.prepare(
      'SELECT COUNT(*) as cnt FROM raw_observations WHERE content_session_id = ? AND encrypted = 0'
    ).get(sessionId) as { cnt: number };
    expect(after.cnt).toBe(0);

    // Verify we can decrypt all
    const encRows = db.prepare(
      'SELECT tool_response FROM raw_observations WHERE content_session_id = ? AND tool_name != \'_assistant_responses\' ORDER BY prompt_number ASC'
    ).all(sessionId) as Array<{ tool_response: string }>;

    for (let i = 0; i < 3; i++) {
      expect(decrypt(encRows[i].tool_response, key)).toBe(`plaintext content ${i}`);
    }
  });
});

describe('decrypt passthrough for plaintext', () => {
  test('decrypt() returns plaintext unchanged when no prefix', () => {
    expect(decrypt('just plain text', key)).toBe('just plain text');
    expect(decrypt('{"json":"value"}', key)).toBe('{"json":"value"}');
  });

  test('isEncrypted returns false for plaintext', () => {
    expect(isEncrypted('plain text')).toBe(false);
    expect(isEncrypted('$NOT_ENCRYPTED$abc')).toBe(false);
  });
});
