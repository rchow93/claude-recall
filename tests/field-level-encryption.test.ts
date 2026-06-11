import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { randomBytes } from 'crypto';
import { Database } from 'bun:sqlite';
import { encrypt, decrypt, isEncrypted } from '../src/services/encryption';
import { MigrationRunner } from '../src/services/sqlite/migrations/runner';

let db: Database;
const key = randomBytes(32);
const sessionId = 'fle-test-session';
const project = 'fle-test-project';

beforeAll(() => {
  db = new Database(':memory:', { create: true, readwrite: true });
  db.run('PRAGMA journal_mode = WAL');
  const runner = new MigrationRunner(db);
  runner.runAllMigrations();

  db.run(
    `INSERT INTO sdk_sessions (content_session_id, project, started_at, started_at_epoch, status, prompt_counter)
     VALUES (?, ?, '2026-06-11T00:00:00Z', 1749600000, 'active', 1)`,
    [sessionId, project]
  );
});

afterAll(() => {
  db.close();
});

describe('migration 28 — FTS5 triggers dropped', () => {
  test('raw_obs_ai trigger does not exist', () => {
    const triggers = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND name='raw_obs_ai'"
    ).all();
    expect(triggers).toHaveLength(0);
  });

  test('raw_obs_ad trigger does not exist', () => {
    const triggers = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND name='raw_obs_ad'"
    ).all();
    expect(triggers).toHaveLength(0);
  });

  test('raw_obs_au trigger does not exist', () => {
    const triggers = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND name='raw_obs_au'"
    ).all();
    expect(triggers).toHaveLength(0);
  });

  test('user_prompts_ai trigger does not exist', () => {
    const triggers = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND name='user_prompts_ai'"
    ).all();
    expect(triggers).toHaveLength(0);
  });

  test('user_prompts_ad trigger does not exist', () => {
    const triggers = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND name='user_prompts_ad'"
    ).all();
    expect(triggers).toHaveLength(0);
  });

  test('user_prompts_au trigger does not exist', () => {
    const triggers = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND name='user_prompts_au'"
    ).all();
    expect(triggers).toHaveLength(0);
  });

  test('FTS5 virtual tables still exist', () => {
    const rawFts = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='raw_observations_fts'"
    ).all();
    expect(rawFts).toHaveLength(1);

    const promptsFts = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='user_prompts_fts'"
    ).all();
    expect(promptsFts).toHaveLength(1);
  });
});

describe('tool_input field-level encryption', () => {
  const plainInput = '{"file_path":"/etc/secrets/api-keys.json"}';
  const plainResponse = '{"content":"sk-secret-12345"}';

  test('encrypted tool_input stored in primary column, plaintext in FTS5', () => {
    const encInput = encrypt(plainInput, key);
    const encResponse = encrypt(plainResponse, key);

    db.run(
      `INSERT INTO raw_observations (content_session_id, project, tool_name, tool_input, tool_response, cwd, prompt_number, created_at, created_at_epoch, relevance_score, redacted, encrypted)
       VALUES (?, ?, 'Read', ?, ?, '/tmp', 1, '2026-06-11T00:00:00Z', 1749600000, 0.8, 0, 1)`,
      [sessionId, project, encInput, encResponse]
    );

    const lastId = (db.prepare('SELECT last_insert_rowid() as id').get() as { id: number }).id;

    // Manual FTS5 insert with plaintext
    db.run(
      `INSERT INTO raw_observations_fts(rowid, tool_name, tool_input) VALUES (?, 'Read', ?)`,
      [lastId, plainInput]
    );

    // Primary column is encrypted
    const row = db.prepare('SELECT tool_input, tool_response, encrypted FROM raw_observations WHERE id = ?').get(lastId) as any;
    expect(isEncrypted(row.tool_input)).toBe(true);
    expect(isEncrypted(row.tool_response)).toBe(true);
    expect(row.encrypted).toBe(1);

    // Decrypt yields original plaintext
    expect(decrypt(row.tool_input, key)).toBe(plainInput);
    expect(decrypt(row.tool_response, key)).toBe(plainResponse);

    // FTS5 search on plaintext still works
    const ftsResults = db.prepare(
      `SELECT r.id FROM raw_observations r
       JOIN raw_observations_fts f ON r.id = f.rowid
       WHERE raw_observations_fts MATCH '"api-keys"'`
    ).all() as Array<{ id: number }>;
    expect(ftsResults.length).toBeGreaterThanOrEqual(1);
    expect(ftsResults.some(r => r.id === lastId)).toBe(true);
  });

  test('FTS5 search does NOT match encrypted column content', () => {
    // Searching for the encrypted prefix should NOT match in FTS5
    const results = db.prepare(
      `SELECT rowid FROM raw_observations_fts WHERE raw_observations_fts MATCH '"$ENCRYPTED$"'`
    ).all();
    expect(results).toHaveLength(0);
  });
});

describe('prompt_text field-level encryption', () => {
  const plainPrompt = 'Fix the authentication bug in the login handler';

  test('encrypted prompt_text stored in primary column, plaintext in FTS5', () => {
    const encPrompt = encrypt(plainPrompt, key);

    db.run(
      `INSERT INTO user_prompts (content_session_id, prompt_number, prompt_text, created_at, created_at_epoch, encrypted)
       VALUES (?, 1, ?, '2026-06-11T00:00:01Z', 1749600001, 1)`,
      [sessionId, encPrompt]
    );

    const lastId = (db.prepare('SELECT last_insert_rowid() as id').get() as { id: number }).id;

    // Manual FTS5 insert with plaintext
    db.run(
      `INSERT INTO user_prompts_fts(rowid, prompt_text) VALUES (?, ?)`,
      [lastId, plainPrompt]
    );

    // Primary column is encrypted
    const row = db.prepare('SELECT prompt_text, encrypted FROM user_prompts WHERE id = ?').get(lastId) as any;
    expect(isEncrypted(row.prompt_text)).toBe(true);
    expect(row.encrypted).toBe(1);
    expect(decrypt(row.prompt_text, key)).toBe(plainPrompt);

    // FTS5 search on plaintext still works
    const ftsResults = db.prepare(
      `SELECT rowid FROM user_prompts_fts WHERE user_prompts_fts MATCH '"authentication bug"'`
    ).all() as Array<{ rowid: number }>;
    expect(ftsResults.length).toBeGreaterThanOrEqual(1);
    expect(ftsResults.some(r => r.rowid === lastId)).toBe(true);
  });
});

describe('batch migration of existing data', () => {
  const plainInput2 = '{"command":"ls -la"}';
  const plainResponse2 = 'total 42\ndrwxr-xr-x  8 user  staff  256 Jun 10 12:00 .';
  const plainPrompt2 = 'Show me the directory listing';
  let obsId: number;
  let promptId: number;

  test('insert plaintext rows (simulating pre-encryption data)', () => {
    db.run(
      `INSERT INTO raw_observations (content_session_id, project, tool_name, tool_input, tool_response, cwd, prompt_number, created_at, created_at_epoch, relevance_score, redacted, encrypted)
       VALUES (?, ?, 'Bash', ?, ?, '/tmp', 2, '2026-06-11T00:01:00Z', 1749600060, 0.5, 0, 0)`,
      [sessionId, project, plainInput2, plainResponse2]
    );
    obsId = (db.prepare('SELECT last_insert_rowid() as id').get() as { id: number }).id;

    // FTS5 entry for this row
    db.run(
      `INSERT INTO raw_observations_fts(rowid, tool_name, tool_input) VALUES (?, 'Bash', ?)`,
      [obsId, plainInput2]
    );

    db.run(
      `INSERT INTO user_prompts (content_session_id, prompt_number, prompt_text, created_at, created_at_epoch, encrypted)
       VALUES (?, 2, ?, '2026-06-11T00:01:00Z', 1749600060, 0)`,
      [sessionId, plainPrompt2]
    );
    promptId = (db.prepare('SELECT last_insert_rowid() as id').get() as { id: number }).id;

    db.run(
      `INSERT INTO user_prompts_fts(rowid, prompt_text) VALUES (?, ?)`,
      [promptId, plainPrompt2]
    );
  });

  test('batch encrypt observations — both tool_input and tool_response', () => {
    const rows = db.prepare(
      'SELECT id, tool_input, tool_response FROM raw_observations WHERE encrypted = 0 AND (tool_response IS NOT NULL OR tool_input IS NOT NULL)'
    ).all() as Array<{ id: number; tool_input: string | null; tool_response: string | null }>;

    expect(rows.length).toBeGreaterThanOrEqual(1);
    const target = rows.find(r => r.id === obsId)!;
    expect(target).toBeDefined();

    for (const row of rows) {
      const encResp = row.tool_response ? encrypt(row.tool_response, key) : null;
      const encInp = row.tool_input ? encrypt(row.tool_input, key) : null;
      db.run(
        'UPDATE raw_observations SET tool_response = ?, tool_input = ?, encrypted = 1 WHERE id = ?',
        [encResp ?? row.tool_response, encInp ?? row.tool_input, row.id]
      );
    }

    const after = db.prepare('SELECT tool_input, tool_response, encrypted FROM raw_observations WHERE id = ?').get(obsId) as any;
    expect(after.encrypted).toBe(1);
    expect(isEncrypted(after.tool_input)).toBe(true);
    expect(isEncrypted(after.tool_response)).toBe(true);
    expect(decrypt(after.tool_input, key)).toBe(plainInput2);
    expect(decrypt(after.tool_response, key)).toBe(plainResponse2);
  });

  test('batch encrypt prompts', () => {
    const rows = db.prepare(
      'SELECT id, prompt_text FROM user_prompts WHERE encrypted = 0 AND prompt_text IS NOT NULL'
    ).all() as Array<{ id: number; prompt_text: string }>;

    expect(rows.length).toBeGreaterThanOrEqual(1);

    for (const row of rows) {
      const enc = encrypt(row.prompt_text, key);
      db.run('UPDATE user_prompts SET prompt_text = ?, encrypted = 1 WHERE id = ?', [enc, row.id]);
    }

    const after = db.prepare('SELECT prompt_text, encrypted FROM user_prompts WHERE id = ?').get(promptId) as any;
    expect(after.encrypted).toBe(1);
    expect(isEncrypted(after.prompt_text)).toBe(true);
    expect(decrypt(after.prompt_text, key)).toBe(plainPrompt2);
  });

  test('FTS5 search still works after primary column encryption', () => {
    // The FTS5 index retains plaintext tokens from before encryption
    const ftsObs = db.prepare(
      `SELECT rowid FROM raw_observations_fts WHERE raw_observations_fts MATCH '"ls -la"'`
    ).all() as Array<{ rowid: number }>;
    expect(ftsObs.some(r => r.rowid === obsId)).toBe(true);

    const ftsPrompt = db.prepare(
      `SELECT rowid FROM user_prompts_fts WHERE user_prompts_fts MATCH '"directory listing"'`
    ).all() as Array<{ rowid: number }>;
    expect(ftsPrompt.some(r => r.rowid === promptId)).toBe(true);
  });
});

describe('mixed encrypted/plaintext data', () => {
  test('rows with encrypted=1 but tool_input still plaintext (upgrade path)', () => {
    // Simulate a row where tool_response was encrypted (WOR-127) but tool_input was not
    const encResponse = encrypt('response data', key);
    db.run(
      `INSERT INTO raw_observations (content_session_id, project, tool_name, tool_input, tool_response, cwd, prompt_number, created_at, created_at_epoch, relevance_score, redacted, encrypted)
       VALUES (?, ?, 'Bash', '{"command":"echo hi"}', ?, '/tmp', 3, '2026-06-11T00:02:00Z', 1749600120, 0.3, 0, 1)`,
      [sessionId, project, encResponse]
    );
    const id = (db.prepare('SELECT last_insert_rowid() as id').get() as { id: number }).id;

    // tool_input is plaintext, tool_response is encrypted
    const row = db.prepare('SELECT tool_input, tool_response FROM raw_observations WHERE id = ?').get(id) as any;
    expect(isEncrypted(row.tool_input)).toBe(false);
    expect(isEncrypted(row.tool_response)).toBe(true);

    // Phase 2 migration: encrypt tool_input on these rows
    const needsInput = db.prepare(
      `SELECT id, tool_input FROM raw_observations WHERE encrypted = 1 AND tool_input IS NOT NULL AND tool_input NOT LIKE '$ENCRYPTED$%'`
    ).all() as Array<{ id: number; tool_input: string }>;
    expect(needsInput.length).toBeGreaterThanOrEqual(1);

    for (const r of needsInput) {
      db.run('UPDATE raw_observations SET tool_input = ? WHERE id = ?', [encrypt(r.tool_input, key), r.id]);
    }

    const after = db.prepare('SELECT tool_input, tool_response FROM raw_observations WHERE id = ?').get(id) as any;
    expect(isEncrypted(after.tool_input)).toBe(true);
    expect(isEncrypted(after.tool_response)).toBe(true);
    expect(decrypt(after.tool_input, key)).toBe('{"command":"echo hi"}');
  });
});
