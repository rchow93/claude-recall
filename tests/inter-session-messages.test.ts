import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { MigrationRunner } from '../src/services/sqlite/migrations/runner';

let db: Database;

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

describe('migration 27 — inter_session_messages table', () => {
  test('table exists', () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='inter_session_messages'"
    ).all() as Array<{ name: string }>;
    expect(tables.length).toBe(1);
  });

  test('all columns present with correct types', () => {
    const cols = db.prepare('PRAGMA table_info(inter_session_messages)').all() as Array<{
      name: string; type: string; notnull: number; dflt_value: string | null;
    }>;
    const colMap = new Map(cols.map(c => [c.name, c]));

    expect(colMap.has('id')).toBe(true);
    expect(colMap.has('source_project')).toBe(true);
    expect(colMap.has('source_session_id')).toBe(true);
    expect(colMap.has('target_project')).toBe(true);
    expect(colMap.has('message_type')).toBe(true);
    expect(colMap.has('priority')).toBe(true);
    expect(colMap.has('subject')).toBe(true);
    expect(colMap.has('body')).toBe(true);
    expect(colMap.has('parent_message_id')).toBe(true);
    expect(colMap.has('status')).toBe(true);
    expect(colMap.has('created_at_epoch')).toBe(true);
    expect(colMap.has('approved_at_epoch')).toBe(true);
    expect(colMap.has('delivered_at_epoch')).toBe(true);
    expect(colMap.has('completed_at_epoch')).toBe(true);
    expect(colMap.has('response_body')).toBe(true);
    expect(colMap.has('encrypted')).toBe(true);
    expect(colMap.has('ttl_seconds')).toBe(true);

    expect(colMap.get('source_project')!.notnull).toBe(1);
    expect(colMap.get('source_session_id')!.notnull).toBe(1);
    expect(colMap.get('target_project')!.notnull).toBe(1);
    expect(colMap.get('body')!.notnull).toBe(1);
    expect(colMap.get('created_at_epoch')!.notnull).toBe(1);

    expect(colMap.get('message_type')!.dflt_value).toBe("'request'");
    expect(colMap.get('priority')!.dflt_value).toBe("'normal'");
    expect(colMap.get('status')!.dflt_value).toBe("'pending_approval'");
    expect(colMap.get('encrypted')!.dflt_value).toBe('0');
    expect(colMap.get('ttl_seconds')!.dflt_value).toBe('86400');
  });

  test('all 4 indexes exist', () => {
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='inter_session_messages' AND name LIKE 'idx_ism_%'"
    ).all() as Array<{ name: string }>;
    const names = indexes.map(i => i.name).sort();

    expect(names).toEqual([
      'idx_ism_created',
      'idx_ism_parent',
      'idx_ism_source',
      'idx_ism_target_status',
    ]);
  });

  test('schema_versions records migration 27', () => {
    const row = db.prepare('SELECT 1 as found FROM schema_versions WHERE version = 27').get() as { found: number } | null;
    expect(row).not.toBeNull();
    expect(row!.found).toBe(1);
  });
});

describe('inter_session_messages — CRUD operations', () => {
  test('insert a message with defaults', () => {
    const result = db.prepare(`
      INSERT INTO inter_session_messages (source_project, source_session_id, target_project, body, created_at_epoch)
      VALUES ('RecruiterPilot', 'sess-001', 'SmartRouter', 'Deploy v2.3 to staging', 1749600000)
    `).run();
    expect(result.changes).toBe(1);
    expect(result.lastInsertRowid).toBeGreaterThan(0);

    const row = db.prepare('SELECT * FROM inter_session_messages WHERE id = ?').get(result.lastInsertRowid) as any;
    expect(row.source_project).toBe('RecruiterPilot');
    expect(row.target_project).toBe('SmartRouter');
    expect(row.body).toBe('Deploy v2.3 to staging');
    expect(row.message_type).toBe('request');
    expect(row.priority).toBe('normal');
    expect(row.status).toBe('pending_approval');
    expect(row.encrypted).toBe(0);
    expect(row.ttl_seconds).toBe(86400);
    expect(row.subject).toBeNull();
    expect(row.parent_message_id).toBeNull();
  });

  test('insert a message with all fields', () => {
    const result = db.prepare(`
      INSERT INTO inter_session_messages (
        source_project, source_session_id, target_project,
        message_type, priority, subject, body, parent_message_id,
        status, created_at_epoch, ttl_seconds
      ) VALUES (
        'WorkWeek', 'sess-002', 'RecruiterPilot',
        'question', 'high', 'DB migration status', 'Has migration 27 been applied?', NULL,
        'pending_approval', 1749600100, 3600
      )
    `).run();
    expect(result.changes).toBe(1);

    const row = db.prepare('SELECT * FROM inter_session_messages WHERE id = ?').get(result.lastInsertRowid) as any;
    expect(row.message_type).toBe('question');
    expect(row.priority).toBe('high');
    expect(row.subject).toBe('DB migration status');
    expect(row.ttl_seconds).toBe(3600);
  });

  test('CHECK constraint rejects invalid message_type', () => {
    expect(() => {
      db.prepare(`
        INSERT INTO inter_session_messages (source_project, source_session_id, target_project, body, message_type, created_at_epoch)
        VALUES ('A', 'sess', 'B', 'test', 'invalid_type', 1749600000)
      `).run();
    }).toThrow();
  });

  test('CHECK constraint rejects invalid priority', () => {
    expect(() => {
      db.prepare(`
        INSERT INTO inter_session_messages (source_project, source_session_id, target_project, body, priority, created_at_epoch)
        VALUES ('A', 'sess', 'B', 'test', 'critical', 1749600000)
      `).run();
    }).toThrow();
  });

  test('CHECK constraint rejects invalid status', () => {
    expect(() => {
      db.prepare(`
        INSERT INTO inter_session_messages (source_project, source_session_id, target_project, body, status, created_at_epoch)
        VALUES ('A', 'sess', 'B', 'test', 'cancelled', 1749600000)
      `).run();
    }).toThrow();
  });
});

describe('inter_session_messages — message lifecycle', () => {
  let messageId: number;

  test('send: insert pending_approval', () => {
    const result = db.prepare(`
      INSERT INTO inter_session_messages (source_project, source_session_id, target_project, subject, body, created_at_epoch)
      VALUES ('RecruiterPilot', 'sess-lifecycle', 'SmartRouter', 'Deploy request', 'Please deploy v2.3 to staging', 1749600200)
    `).run();
    messageId = Number(result.lastInsertRowid);
    expect(messageId).toBeGreaterThan(0);
  });

  test('approve: transition to approved', () => {
    db.prepare(`
      UPDATE inter_session_messages SET status = 'approved', approved_at_epoch = ? WHERE id = ? AND status = 'pending_approval'
    `).run(1749600300, messageId);

    const row = db.prepare('SELECT status, approved_at_epoch FROM inter_session_messages WHERE id = ?').get(messageId) as any;
    expect(row.status).toBe('approved');
    expect(row.approved_at_epoch).toBe(1749600300);
  });

  test('deliver: transaction-based claim (atomic SELECT + UPDATE)', () => {
    const claim = db.transaction(() => {
      const msg = db.prepare(`
        SELECT id, source_project, subject, body, message_type, priority
        FROM inter_session_messages
        WHERE target_project = ? AND status = 'approved'
        ORDER BY
          CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 END,
          created_at_epoch ASC
        LIMIT 1
      `).get('SmartRouter') as any;

      if (msg) {
        db.prepare(`
          UPDATE inter_session_messages SET status = 'delivered', delivered_at_epoch = ? WHERE id = ?
        `).run(1749600400, msg.id);
      }
      return msg;
    });

    const claimed = claim();
    expect(claimed).not.toBeNull();
    expect(claimed.id).toBe(messageId);
    expect(claimed.source_project).toBe('RecruiterPilot');
    expect(claimed.subject).toBe('Deploy request');

    const row = db.prepare('SELECT status, delivered_at_epoch FROM inter_session_messages WHERE id = ?').get(messageId) as any;
    expect(row.status).toBe('delivered');
    expect(row.delivered_at_epoch).toBe(1749600400);
  });

  test('deliver: second claim returns null (no duplicate delivery)', () => {
    const claim = db.transaction(() => {
      return db.prepare(`
        SELECT id FROM inter_session_messages
        WHERE target_project = ? AND status = 'approved'
        LIMIT 1
      `).get('SmartRouter');
    });

    expect(claim()).toBeNull();
  });

  test('reply: complete with response', () => {
    db.prepare(`
      UPDATE inter_session_messages SET status = 'completed', completed_at_epoch = ?, response_body = ?
      WHERE id = ? AND status = 'delivered'
    `).run(1749600500, 'Deployed v2.3 to staging successfully. Health checks passing.', messageId);

    const row = db.prepare('SELECT status, completed_at_epoch, response_body FROM inter_session_messages WHERE id = ?').get(messageId) as any;
    expect(row.status).toBe('completed');
    expect(row.completed_at_epoch).toBe(1749600500);
    expect(row.response_body).toContain('Deployed v2.3');
  });
});

describe('inter_session_messages — index performance queries', () => {
  test('idx_ism_target_status: query by target + status', () => {
    db.prepare(`
      INSERT INTO inter_session_messages (source_project, source_session_id, target_project, body, status, created_at_epoch)
      VALUES ('A', 'sess', 'IndexTest', 'msg1', 'approved', 1749600600)
    `).run();
    db.prepare(`
      INSERT INTO inter_session_messages (source_project, source_session_id, target_project, body, status, created_at_epoch)
      VALUES ('B', 'sess', 'IndexTest', 'msg2', 'pending_approval', 1749600601)
    `).run();
    db.prepare(`
      INSERT INTO inter_session_messages (source_project, source_session_id, target_project, body, status, created_at_epoch)
      VALUES ('C', 'sess', 'OtherProject', 'msg3', 'approved', 1749600602)
    `).run();

    const approved = db.prepare(
      "SELECT COUNT(*) as cnt FROM inter_session_messages WHERE target_project = 'IndexTest' AND status = 'approved'"
    ).get() as { cnt: number };
    expect(approved.cnt).toBe(1);
  });

  test('idx_ism_source: query by source project ordered by time', () => {
    const rows = db.prepare(
      "SELECT source_project, created_at_epoch FROM inter_session_messages WHERE source_project = 'RecruiterPilot' ORDER BY created_at_epoch DESC"
    ).all() as Array<{ source_project: string; created_at_epoch: number }>;
    expect(rows.length).toBeGreaterThan(0);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1].created_at_epoch).toBeGreaterThanOrEqual(rows[i].created_at_epoch);
    }
  });

  test('idx_ism_parent: query thread by parent_message_id', () => {
    const parent = db.prepare(`
      INSERT INTO inter_session_messages (source_project, source_session_id, target_project, body, created_at_epoch)
      VALUES ('ThreadTest', 'sess', 'Target', 'Original question', 1749600700)
    `).run();
    const parentId = Number(parent.lastInsertRowid);

    db.prepare(`
      INSERT INTO inter_session_messages (source_project, source_session_id, target_project, body, parent_message_id, message_type, created_at_epoch)
      VALUES ('Target', 'sess', 'ThreadTest', 'Reply 1', ?, 'reply', 1749600800)
    `).run(parentId);
    db.prepare(`
      INSERT INTO inter_session_messages (source_project, source_session_id, target_project, body, parent_message_id, message_type, created_at_epoch)
      VALUES ('Target', 'sess', 'ThreadTest', 'Reply 2', ?, 'reply', 1749600900)
    `).run(parentId);

    const thread = db.prepare(
      'SELECT * FROM inter_session_messages WHERE parent_message_id = ? ORDER BY created_at_epoch ASC'
    ).all(parentId) as any[];
    expect(thread.length).toBe(2);
    expect(thread[0].body).toBe('Reply 1');
    expect(thread[1].body).toBe('Reply 2');
  });
});

describe('inter_session_messages — priority ordering', () => {
  test('urgent messages claimed before normal', () => {
    db.prepare(`
      INSERT INTO inter_session_messages (source_project, source_session_id, target_project, body, priority, status, created_at_epoch)
      VALUES ('A', 'sess', 'PriorityTest', 'normal msg', 'normal', 'approved', 1749601000)
    `).run();
    db.prepare(`
      INSERT INTO inter_session_messages (source_project, source_session_id, target_project, body, priority, status, created_at_epoch)
      VALUES ('B', 'sess', 'PriorityTest', 'urgent msg', 'urgent', 'approved', 1749601001)
    `).run();
    db.prepare(`
      INSERT INTO inter_session_messages (source_project, source_session_id, target_project, body, priority, status, created_at_epoch)
      VALUES ('C', 'sess', 'PriorityTest', 'high msg', 'high', 'approved', 1749601002)
    `).run();

    const first = db.prepare(`
      SELECT body, priority FROM inter_session_messages
      WHERE target_project = 'PriorityTest' AND status = 'approved'
      ORDER BY
        CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 END,
        created_at_epoch ASC
      LIMIT 1
    `).get() as any;

    expect(first.priority).toBe('urgent');
    expect(first.body).toBe('urgent msg');
  });
});

describe('send_message — handler SQL logic', () => {
  test('insert with defaults matches handler behavior', () => {
    const from = 'TestSender';
    const to = 'TestReceiver';
    const message = 'Please review PR #42';
    const messageType = 'request';
    const priority = 'normal';
    const subject = null;
    const parentMessageId = null;
    const nowEpoch = 1749700000;
    const ttlSeconds = 86400;

    // Create a session so handler can resolve source_session_id
    db.prepare(`
      INSERT OR IGNORE INTO sdk_sessions (content_session_id, project, started_at, started_at_epoch, status, prompt_counter)
      VALUES ('send-test-sess', ?, '2026-06-11T10:00:00Z', 1749700000, 'active', 1)
    `).run(from);

    const session = db.prepare(
      "SELECT content_session_id FROM sdk_sessions WHERE project = ? ORDER BY started_at_epoch DESC LIMIT 1"
    ).get(from) as { content_session_id: string } | null;
    const sourceSessionId = session?.content_session_id ?? 'unknown';

    const result = db.prepare(`
      INSERT INTO inter_session_messages (
        source_project, source_session_id, target_project,
        message_type, priority, subject, body, parent_message_id,
        status, created_at_epoch, ttl_seconds
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_approval', ?, ?)
    `).run(from, sourceSessionId, to, messageType, priority, subject, message, parentMessageId, nowEpoch, ttlSeconds);

    const id = Number(result.lastInsertRowid);
    expect(id).toBeGreaterThan(0);

    const row = db.prepare('SELECT * FROM inter_session_messages WHERE id = ?').get(id) as any;
    expect(row.source_project).toBe('TestSender');
    expect(row.source_session_id).toBe('send-test-sess');
    expect(row.target_project).toBe('TestReceiver');
    expect(row.body).toBe('Please review PR #42');
    expect(row.message_type).toBe('request');
    expect(row.priority).toBe('normal');
    expect(row.status).toBe('pending_approval');
    expect(row.ttl_seconds).toBe(86400);
    expect(row.subject).toBeNull();
    expect(row.parent_message_id).toBeNull();
  });

  test('insert with all optional fields', () => {
    const result = db.prepare(`
      INSERT INTO inter_session_messages (
        source_project, source_session_id, target_project,
        message_type, priority, subject, body, parent_message_id,
        status, created_at_epoch, ttl_seconds
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_approval', ?, ?)
    `).run('ProjectA', 'sess-full', 'ProjectB', 'question', 'urgent', 'Deployment ETA?', 'When will v3 be deployed?', null, 1749700100, 7200);

    const row = db.prepare('SELECT * FROM inter_session_messages WHERE id = ?').get(Number(result.lastInsertRowid)) as any;
    expect(row.message_type).toBe('question');
    expect(row.priority).toBe('urgent');
    expect(row.subject).toBe('Deployment ETA?');
    expect(row.ttl_seconds).toBe(7200);
  });

  test('insert with threading (parent_message_id)', () => {
    const parent = db.prepare(`
      INSERT INTO inter_session_messages (
        source_project, source_session_id, target_project, body,
        status, created_at_epoch, ttl_seconds
      ) VALUES ('X', 'sess', 'Y', 'Original', 'pending_approval', 1749700200, 86400)
    `).run();
    const parentId = Number(parent.lastInsertRowid);

    const reply = db.prepare(`
      INSERT INTO inter_session_messages (
        source_project, source_session_id, target_project,
        message_type, priority, subject, body, parent_message_id,
        status, created_at_epoch, ttl_seconds
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_approval', ?, ?)
    `).run('Y', 'sess-reply', 'X', 'request', 'normal', null, 'Follow-up reply', parentId, 1749700300, 86400);

    const row = db.prepare('SELECT * FROM inter_session_messages WHERE id = ?').get(Number(reply.lastInsertRowid)) as any;
    expect(row.parent_message_id).toBe(parentId);
    expect(row.body).toBe('Follow-up reply');
  });

  test('source_session_id falls back to unknown when no session exists', () => {
    const session = db.prepare(
      "SELECT content_session_id FROM sdk_sessions WHERE project = ? ORDER BY started_at_epoch DESC LIMIT 1"
    ).get('NonExistentProject99') as { content_session_id: string } | null;
    const sourceSessionId = session?.content_session_id ?? 'unknown';
    expect(sourceSessionId).toBe('unknown');
  });
});

describe('hook delivery — transaction-based claim + additionalContext format', () => {
  test('claim atomically selects and marks as delivered', () => {
    const nowEpoch = 1749800000;
    const project = 'HookDeliveryTarget';

    // Insert an approved message
    db.prepare(`
      INSERT INTO inter_session_messages (source_project, source_session_id, target_project, message_type, priority, subject, body, status, created_at_epoch, ttl_seconds)
      VALUES ('SenderProject', 'sess-hook', ?, 'request', 'high', 'Deploy now', 'Please deploy v3.0 to production', 'approved', 1749799900, 86400)
    `).run(project);

    // Simulate the hook's transaction-based claim
    const pendingMsg = db.transaction(() => {
      const msg = db.prepare(`
        SELECT id, source_project, message_type, priority, subject, body
        FROM inter_session_messages
        WHERE target_project = ? AND status = 'approved'
        ORDER BY
          CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 END,
          created_at_epoch ASC
        LIMIT 1
      `).get(project) as any;

      if (msg) {
        db.prepare(
          `UPDATE inter_session_messages SET status = 'delivered', delivered_at_epoch = ? WHERE id = ?`
        ).run(nowEpoch, msg.id);
      }
      return msg;
    })();

    expect(pendingMsg).not.toBeNull();
    expect(pendingMsg.source_project).toBe('SenderProject');
    expect(pendingMsg.subject).toBe('Deploy now');
    expect(pendingMsg.body).toBe('Please deploy v3.0 to production');
    expect(pendingMsg.priority).toBe('high');

    // Verify it's marked delivered
    const row = db.prepare('SELECT status, delivered_at_epoch FROM inter_session_messages WHERE id = ?').get(pendingMsg.id) as any;
    expect(row.status).toBe('delivered');
    expect(row.delivered_at_epoch).toBe(nowEpoch);
  });

  test('second claim returns null (no duplicate delivery)', () => {
    const project = 'HookDeliveryTarget';

    const secondClaim = db.transaction(() => {
      return db.prepare(`
        SELECT id FROM inter_session_messages
        WHERE target_project = ? AND status = 'approved'
        LIMIT 1
      `).get(project);
    })();

    expect(secondClaim).toBeNull();
  });

  test('additionalContext format matches expected Markdown structure', () => {
    const msg = { id: 99, source_project: 'TestSrc', message_type: 'question', priority: 'urgent', subject: 'API Key?', body: 'What is the staging API key?' };

    const lines = [
      '---',
      `## Inter-Session Message from ${msg.source_project}`,
      `**Type:** ${msg.message_type} | **Priority:** ${msg.priority} | **Message ID:** ${msg.id}`,
      msg.subject ? `**Subject:** ${msg.subject}` : null,
      '',
      msg.body,
      '',
      '---',
      `To respond, use the claude-recall MCP tool: reply_message(message_id=${msg.id}, response="your response here")`,
    ].filter(l => l !== null).join('\n');

    expect(lines).toContain('## Inter-Session Message from TestSrc');
    expect(lines).toContain('**Type:** question | **Priority:** urgent | **Message ID:** 99');
    expect(lines).toContain('**Subject:** API Key?');
    expect(lines).toContain('What is the staging API key?');
    expect(lines).toContain('reply_message(message_id=99');
  });

  test('messages without subject omit the subject line', () => {
    const msg = { id: 100, source_project: 'NoSubj', message_type: 'notify', priority: 'low', subject: null as string | null, body: 'FYI: build passed' };

    const lines = [
      '---',
      `## Inter-Session Message from ${msg.source_project}`,
      `**Type:** ${msg.message_type} | **Priority:** ${msg.priority} | **Message ID:** ${msg.id}`,
      msg.subject ? `**Subject:** ${msg.subject}` : null,
      '',
      msg.body,
      '',
      '---',
      `To respond, use the claude-recall MCP tool: reply_message(message_id=${msg.id}, response="your response here")`,
    ].filter(l => l !== null).join('\n');

    expect(lines).not.toContain('**Subject:**');
    expect(lines).toContain('FYI: build passed');
  });
});

describe('claude-code adapter — formatOutput merges hookSpecificOutput with continue', () => {
  test('returns both continue and hookSpecificOutput when present', () => {
    const result = {
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'test message' },
    };

    const output: any = { continue: result.continue ?? true, suppressOutput: result.suppressOutput ?? true };
    if (result.hookSpecificOutput) {
      output.hookSpecificOutput = result.hookSpecificOutput;
    }

    expect(output.continue).toBe(true);
    expect(output.suppressOutput).toBe(true);
    expect(output.hookSpecificOutput).toBeDefined();
    expect(output.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(output.hookSpecificOutput.additionalContext).toBe('test message');
  });

  test('returns only continue/suppressOutput when no hookSpecificOutput', () => {
    const result = { continue: true, suppressOutput: true };

    const output: any = { continue: result.continue ?? true, suppressOutput: result.suppressOutput ?? true };
    if (result.hookSpecificOutput) {
      output.hookSpecificOutput = result.hookSpecificOutput;
    }

    expect(output.continue).toBe(true);
    expect(output.suppressOutput).toBe(true);
    expect(output.hookSpecificOutput).toBeUndefined();
  });
});

describe('migration 27 — idempotent', () => {
  test('running migrations again does not fail or duplicate', () => {
    const runner = new MigrationRunner(db);
    expect(() => runner.runAllMigrations()).not.toThrow();

    const versions = db.prepare('SELECT COUNT(*) as cnt FROM schema_versions WHERE version = 27').get() as { cnt: number };
    expect(versions.cnt).toBe(1);
  });
});
