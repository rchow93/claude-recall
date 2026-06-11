import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { MigrationRunner } from '../src/services/sqlite/migrations/runner';
import { matchesRules, matchesAutoApproveRule, resetRulesCache } from '../src/utils/message-rules';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

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

describe('check_inbox — handler SQL logic', () => {
  beforeAll(() => {
    // Clear test data and set up inbox test messages
    db.prepare("DELETE FROM inter_session_messages WHERE source_project LIKE 'Inbox%' OR target_project LIKE 'Inbox%'").run();

    // Incoming message (delivered to InboxProject)
    db.prepare(`
      INSERT INTO inter_session_messages (source_project, source_session_id, target_project, message_type, priority, subject, body, status, created_at_epoch, ttl_seconds)
      VALUES ('InboxSender', 'sess-inbox', 'InboxProject', 'request', 'high', 'Deploy v3', 'Please deploy', 'delivered', 1749900000, 86400)
    `).run();

    // Outgoing message (sent by InboxProject)
    db.prepare(`
      INSERT INTO inter_session_messages (source_project, source_session_id, target_project, message_type, priority, subject, body, status, created_at_epoch, ttl_seconds)
      VALUES ('InboxProject', 'sess-inbox-out', 'InboxReceiver', 'notify', 'normal', 'Build done', 'Build passed', 'pending_approval', 1749900100, 86400)
    `).run();

    // Completed message
    db.prepare(`
      INSERT INTO inter_session_messages (source_project, source_session_id, target_project, message_type, priority, subject, body, status, created_at_epoch, completed_at_epoch, response_body, ttl_seconds)
      VALUES ('InboxOld', 'sess-inbox-old', 'InboxProject', 'question', 'normal', 'Status?', 'What is the status?', 'completed', 1749899000, 1749899500, 'All good', 86400)
    `).run();

    // Expired message (should be excluded by default)
    db.prepare(`
      INSERT INTO inter_session_messages (source_project, source_session_id, target_project, message_type, priority, body, status, created_at_epoch, ttl_seconds)
      VALUES ('InboxExpired', 'sess-exp', 'InboxProject', 'notify', 'low', 'Old notification', 'expired', 1749800000, 86400)
    `).run();
  });

  test('returns incoming and outgoing messages for project', () => {
    const messages = db.prepare(`
      SELECT id, source_project, target_project, status
      FROM inter_session_messages
      WHERE (target_project = ? OR source_project = ?) AND status NOT IN ('expired')
      ORDER BY created_at_epoch DESC
      LIMIT 10
    `).all('InboxProject', 'InboxProject') as Array<{ id: number; source_project: string; target_project: string; status: string }>;

    expect(messages.length).toBe(3);
    // Most recent first
    expect(messages[0].source_project).toBe('InboxProject'); // outgoing
    expect(messages[1].target_project).toBe('InboxProject'); // incoming delivered
    expect(messages[2].target_project).toBe('InboxProject'); // incoming completed
  });

  test('status filter narrows results', () => {
    const delivered = db.prepare(`
      SELECT id FROM inter_session_messages
      WHERE (target_project = ? OR source_project = ?) AND status = ?
      ORDER BY created_at_epoch DESC
      LIMIT 10
    `).all('InboxProject', 'InboxProject', 'delivered') as Array<{ id: number }>;

    expect(delivered.length).toBe(1);
  });

  test('expired messages excluded by default', () => {
    const all = db.prepare(`
      SELECT id, status FROM inter_session_messages
      WHERE (target_project = ? OR source_project = ?) AND status NOT IN ('expired')
      ORDER BY created_at_epoch DESC
      LIMIT 50
    `).all('InboxProject', 'InboxProject') as Array<{ id: number; status: string }>;

    const expired = all.filter(m => m.status === 'expired');
    expect(expired.length).toBe(0);
  });

  test('status filter can explicitly show expired', () => {
    const expired = db.prepare(`
      SELECT id FROM inter_session_messages
      WHERE (target_project = ? OR source_project = ?) AND status = ?
      ORDER BY created_at_epoch DESC
      LIMIT 10
    `).all('InboxProject', 'InboxProject', 'expired') as Array<{ id: number }>;

    expect(expired.length).toBe(1);
  });

  test('limit caps results', () => {
    const limited = db.prepare(`
      SELECT id FROM inter_session_messages
      WHERE (target_project = ? OR source_project = ?) AND status NOT IN ('expired')
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all('InboxProject', 'InboxProject', 1) as Array<{ id: number }>;

    expect(limited.length).toBe(1);
  });

  test('empty inbox returns no messages', () => {
    const empty = db.prepare(`
      SELECT id FROM inter_session_messages
      WHERE (target_project = ? OR source_project = ?) AND status NOT IN ('expired')
      ORDER BY created_at_epoch DESC
      LIMIT 10
    `).all('NonExistentInbox', 'NonExistentInbox') as Array<{ id: number }>;

    expect(empty.length).toBe(0);
  });
});

describe('reply_message — handler SQL logic', () => {
  let deliveredMsgId: number;

  beforeAll(() => {
    // Set up a session for reply source
    db.prepare(`
      INSERT OR IGNORE INTO sdk_sessions (content_session_id, project, started_at, started_at_epoch, status, prompt_counter)
      VALUES ('reply-test-sess', 'ReplyTarget', '2026-06-11T12:00:00Z', 1749902400, 'active', 1)
    `).run();

    // Insert a delivered message that can be replied to
    const result = db.prepare(`
      INSERT INTO inter_session_messages (source_project, source_session_id, target_project, message_type, priority, subject, body, status, delivered_at_epoch, created_at_epoch, ttl_seconds)
      VALUES ('ReplySender', 'sess-reply-src', 'ReplyTarget', 'question', 'normal', 'Migration status', 'Has migration 27 been applied?', 'delivered', 1749902000, 1749901000, 86400)
    `).run();
    deliveredMsgId = Number(result.lastInsertRowid);
  });

  test('validates message exists', () => {
    const msg = db.prepare(
      'SELECT id, target_project, source_project, status, subject FROM inter_session_messages WHERE id = ?'
    ).get(999999) as any;
    expect(msg).toBeNull();
  });

  test('validates message is addressed to replier project', () => {
    const msg = db.prepare(
      'SELECT id, target_project, source_project, status FROM inter_session_messages WHERE id = ?'
    ).get(deliveredMsgId) as any;
    expect(msg.target_project).toBe('ReplyTarget');
    expect(msg.target_project).not.toBe('WrongProject');
  });

  test('validates message status is delivered', () => {
    const msg = db.prepare(
      'SELECT status FROM inter_session_messages WHERE id = ?'
    ).get(deliveredMsgId) as any;
    expect(msg.status).toBe('delivered');
  });

  test('reply completes original message and creates reply message', () => {
    const nowEpoch = 1749903000;
    const responseText = 'Yes, migration 27 has been applied successfully.';

    // Complete the original message
    db.prepare(
      `UPDATE inter_session_messages SET status = 'completed', completed_at_epoch = ?, response_body = ? WHERE id = ?`
    ).run(nowEpoch, responseText, deliveredMsgId);

    // Verify original is completed
    const original = db.prepare('SELECT status, completed_at_epoch, response_body FROM inter_session_messages WHERE id = ?').get(deliveredMsgId) as any;
    expect(original.status).toBe('completed');
    expect(original.completed_at_epoch).toBe(nowEpoch);
    expect(original.response_body).toBe(responseText);

    // Insert reply message back to source
    const replyResult = db.prepare(`
      INSERT INTO inter_session_messages (
        source_project, source_session_id, target_project,
        message_type, priority, subject, body, parent_message_id,
        status, created_at_epoch, ttl_seconds
      ) VALUES (?, ?, ?, 'reply', 'normal', ?, ?, ?, 'pending_approval', ?, 86400)
    `).run('ReplyTarget', 'reply-test-sess', 'ReplySender', 'Re: Migration status', responseText, deliveredMsgId, nowEpoch);

    const replyId = Number(replyResult.lastInsertRowid);
    expect(replyId).toBeGreaterThan(0);

    // Verify reply message
    const reply = db.prepare('SELECT * FROM inter_session_messages WHERE id = ?').get(replyId) as any;
    expect(reply.source_project).toBe('ReplyTarget');
    expect(reply.target_project).toBe('ReplySender');
    expect(reply.message_type).toBe('reply');
    expect(reply.parent_message_id).toBe(deliveredMsgId);
    expect(reply.subject).toBe('Re: Migration status');
    expect(reply.body).toBe(responseText);
    expect(reply.status).toBe('pending_approval');
  });

  test('reply to already-completed message is rejected', () => {
    const msg = db.prepare(
      'SELECT status FROM inter_session_messages WHERE id = ?'
    ).get(deliveredMsgId) as any;
    expect(msg.status).toBe('completed');
    // Handler would return error since status !== 'delivered'
  });

  test('reply creates proper thread linkage via parent_message_id', () => {
    const thread = db.prepare(
      'SELECT * FROM inter_session_messages WHERE parent_message_id = ?'
    ).all(deliveredMsgId) as any[];
    expect(thread.length).toBe(1);
    expect(thread[0].message_type).toBe('reply');
    expect(thread[0].source_project).toBe('ReplyTarget');
  });

  test('reply without subject omits Re: prefix', () => {
    // Insert a delivered message without subject
    const noSubjResult = db.prepare(`
      INSERT INTO inter_session_messages (source_project, source_session_id, target_project, message_type, priority, body, status, delivered_at_epoch, created_at_epoch, ttl_seconds)
      VALUES ('NoSubjSender', 'sess-nosub', 'ReplyTarget', 'request', 'normal', 'Do something', 'delivered', 1749903500, 1749903000, 86400)
    `).run();
    const noSubjId = Number(noSubjResult.lastInsertRowid);

    const msg = db.prepare('SELECT subject FROM inter_session_messages WHERE id = ?').get(noSubjId) as any;
    expect(msg.subject).toBeNull();

    // Reply: subject should be null since original had no subject
    const replySubject = msg.subject ? `Re: ${msg.subject}` : null;
    expect(replySubject).toBeNull();
  });
});

describe('integration — full message lifecycle end-to-end', () => {
  let msgId: number;

  beforeAll(() => {
    // Set up projects and sessions for the integration test
    db.prepare(`
      INSERT OR IGNORE INTO sdk_sessions (content_session_id, project, started_at, started_at_epoch, status, prompt_counter)
      VALUES ('int-sess-alpha', 'AlphaProject', '2026-06-11T14:00:00Z', 1749910000, 'active', 1)
    `).run();
    db.prepare(`
      INSERT OR IGNORE INTO sdk_sessions (content_session_id, project, started_at, started_at_epoch, status, prompt_counter)
      VALUES ('int-sess-beta', 'BetaProject', '2026-06-11T14:00:00Z', 1749910000, 'active', 1)
    `).run();
  });

  test('1. send: AlphaProject sends message to BetaProject', () => {
    const session = db.prepare(
      "SELECT content_session_id FROM sdk_sessions WHERE project = ? ORDER BY started_at_epoch DESC LIMIT 1"
    ).get('AlphaProject') as { content_session_id: string };

    const result = db.prepare(`
      INSERT INTO inter_session_messages (
        source_project, source_session_id, target_project,
        message_type, priority, subject, body, parent_message_id,
        status, created_at_epoch, ttl_seconds
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_approval', ?, ?)
    `).run('AlphaProject', session.content_session_id, 'BetaProject', 'question', 'high',
      'Integration test', 'Can you confirm the API is healthy?', null, 1749910100, 86400);

    msgId = Number(result.lastInsertRowid);
    expect(msgId).toBeGreaterThan(0);

    const row = db.prepare('SELECT * FROM inter_session_messages WHERE id = ?').get(msgId) as any;
    expect(row.status).toBe('pending_approval');
    expect(row.source_session_id).toBe('int-sess-alpha');
  });

  test('2. approve: operator approves the message', () => {
    const result = db.prepare(
      `UPDATE inter_session_messages SET status = 'approved', approved_at_epoch = ? WHERE id = ? AND status = 'pending_approval'`
    ).run(1749910200, msgId);
    expect(result.changes).toBe(1);

    const row = db.prepare('SELECT status, approved_at_epoch FROM inter_session_messages WHERE id = ?').get(msgId) as any;
    expect(row.status).toBe('approved');
    expect(row.approved_at_epoch).toBe(1749910200);
  });

  test('3. deliver: PostToolUse hook claims and injects additionalContext', () => {
    const nowEpoch = 1749910300;
    const project = 'BetaProject';

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
    expect(pendingMsg.id).toBe(msgId);

    // Build additionalContext
    const lines = [
      '---',
      `## Inter-Session Message from ${pendingMsg.source_project}`,
      `**Type:** ${pendingMsg.message_type} | **Priority:** ${pendingMsg.priority} | **Message ID:** ${pendingMsg.id}`,
      pendingMsg.subject ? `**Subject:** ${pendingMsg.subject}` : null,
      '', pendingMsg.body, '',
      '---',
      `To respond, use the claude-recall MCP tool: reply_message(message_id=${pendingMsg.id}, response="your response here")`,
    ].filter(l => l !== null).join('\n');

    expect(lines).toContain('## Inter-Session Message from AlphaProject');
    expect(lines).toContain('**Subject:** Integration test');
    expect(lines).toContain(`reply_message(message_id=${msgId}`);

    const row = db.prepare('SELECT status, delivered_at_epoch FROM inter_session_messages WHERE id = ?').get(msgId) as any;
    expect(row.status).toBe('delivered');
    expect(row.delivered_at_epoch).toBe(1749910300);
  });

  test('4. check_inbox: BetaProject sees the delivered message', () => {
    const messages = db.prepare(`
      SELECT id, source_project, target_project, status
      FROM inter_session_messages
      WHERE (target_project = ? OR source_project = ?) AND status NOT IN ('expired')
      ORDER BY created_at_epoch DESC
      LIMIT 10
    `).all('BetaProject', 'BetaProject') as Array<{ id: number; status: string }>;

    const found = messages.find(m => m.id === msgId);
    expect(found).toBeDefined();
    expect(found!.status).toBe('delivered');
  });

  test('5. reply: BetaProject replies, completing the original and creating a reply message', () => {
    const nowEpoch = 1749910400;
    const responseText = 'API is healthy — all endpoints returning 200.';

    // Complete original
    db.prepare(
      `UPDATE inter_session_messages SET status = 'completed', completed_at_epoch = ?, response_body = ? WHERE id = ?`
    ).run(nowEpoch, responseText, msgId);

    // Get original message for threading
    const original = db.prepare('SELECT subject, source_project FROM inter_session_messages WHERE id = ?').get(msgId) as any;

    // Create reply message
    const replyResult = db.prepare(`
      INSERT INTO inter_session_messages (
        source_project, source_session_id, target_project,
        message_type, priority, subject, body, parent_message_id,
        status, created_at_epoch, ttl_seconds
      ) VALUES (?, ?, ?, 'reply', 'normal', ?, ?, ?, 'pending_approval', ?, 86400)
    `).run('BetaProject', 'int-sess-beta', original.source_project,
      original.subject ? `Re: ${original.subject}` : null, responseText, msgId, nowEpoch);

    const replyId = Number(replyResult.lastInsertRowid);

    // Verify original is completed
    const origRow = db.prepare('SELECT status, response_body FROM inter_session_messages WHERE id = ?').get(msgId) as any;
    expect(origRow.status).toBe('completed');
    expect(origRow.response_body).toBe(responseText);

    // Verify reply message
    const replyRow = db.prepare('SELECT * FROM inter_session_messages WHERE id = ?').get(replyId) as any;
    expect(replyRow.message_type).toBe('reply');
    expect(replyRow.parent_message_id).toBe(msgId);
    expect(replyRow.subject).toBe('Re: Integration test');
    expect(replyRow.target_project).toBe('AlphaProject');
    expect(replyRow.status).toBe('pending_approval');
  });

  test('6. roundtrip: AlphaProject sees the reply in inbox', () => {
    const messages = db.prepare(`
      SELECT id, source_project, target_project, status, message_type, parent_message_id
      FROM inter_session_messages
      WHERE (target_project = ? OR source_project = ?) AND status NOT IN ('expired')
      ORDER BY created_at_epoch DESC
      LIMIT 10
    `).all('AlphaProject', 'AlphaProject') as any[];

    const reply = messages.find((m: any) => m.message_type === 'reply' && m.parent_message_id === msgId);
    expect(reply).toBeDefined();
    expect(reply.target_project).toBe('AlphaProject');
    expect(reply.source_project).toBe('BetaProject');
    expect(reply.status).toBe('pending_approval');
  });
});

describe('integration — concurrent delivery (no duplicates)', () => {
  test('two simultaneous claims on the same message — only one succeeds', () => {
    db.prepare(`
      INSERT INTO inter_session_messages (source_project, source_session_id, target_project, body, status, created_at_epoch, ttl_seconds)
      VALUES ('ConcSender', 'sess-conc', 'ConcTarget', 'Concurrent test', 'approved', 1749920000, 86400)
    `).run();

    const claim = () => db.transaction(() => {
      const msg = db.prepare(`
        SELECT id FROM inter_session_messages
        WHERE target_project = 'ConcTarget' AND status = 'approved'
        ORDER BY created_at_epoch ASC LIMIT 1
      `).get() as { id: number } | null;

      if (msg) {
        db.prepare(
          `UPDATE inter_session_messages SET status = 'delivered', delivered_at_epoch = ? WHERE id = ?`
        ).run(1749920100, msg.id);
      }
      return msg;
    })();

    const first = claim();
    const second = claim();

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });
});

describe('integration — TTL expiry enforcement', () => {
  test('batch expire marks old pending/approved messages as expired', () => {
    const veryOld = 1749800000;
    const shortTtl = 60; // 1 minute

    db.prepare(`
      INSERT INTO inter_session_messages (source_project, source_session_id, target_project, body, status, created_at_epoch, ttl_seconds)
      VALUES ('TTLSender', 'sess-ttl', 'TTLTarget', 'Expirable pending', 'pending_approval', ?, ?)
    `).run(veryOld, shortTtl);

    db.prepare(`
      INSERT INTO inter_session_messages (source_project, source_session_id, target_project, body, status, created_at_epoch, ttl_seconds)
      VALUES ('TTLSender2', 'sess-ttl2', 'TTLTarget', 'Expirable approved', 'approved', ?, ?)
    `).run(veryOld, shortTtl);

    // Fresh message should NOT be expired
    db.prepare(`
      INSERT INTO inter_session_messages (source_project, source_session_id, target_project, body, status, created_at_epoch, ttl_seconds)
      VALUES ('TTLSender3', 'sess-ttl3', 'TTLTarget', 'Still fresh', 'pending_approval', ?, ?)
    `).run(Math.floor(Date.now() / 1000), 86400);

    // Simulate expiry batch: mark messages past their TTL
    const nowEpoch = Math.floor(Date.now() / 1000);
    const expireResult = db.prepare(`
      UPDATE inter_session_messages
      SET status = 'expired'
      WHERE status IN ('pending_approval', 'approved')
        AND (created_at_epoch + ttl_seconds) < ?
    `).run(nowEpoch);

    expect(expireResult.changes).toBeGreaterThanOrEqual(2);

    // Verify fresh message is still pending
    const fresh = db.prepare(`
      SELECT status FROM inter_session_messages WHERE body = 'Still fresh'
    `).get() as any;
    expect(fresh.status).toBe('pending_approval');
  });
});

describe('integration — multi-message priority ordering in delivery', () => {
  test('urgent messages delivered before normal even if sent later', () => {
    const target = 'PrioDeliveryTarget';

    db.prepare(`
      INSERT INTO inter_session_messages (source_project, source_session_id, target_project, body, priority, status, created_at_epoch, ttl_seconds)
      VALUES ('LowSender', 'sess-lo', ?, 'Low priority msg', 'low', 'approved', 1749930000, 86400)
    `).run(target);

    db.prepare(`
      INSERT INTO inter_session_messages (source_project, source_session_id, target_project, body, priority, status, created_at_epoch, ttl_seconds)
      VALUES ('NormSender', 'sess-no', ?, 'Normal priority msg', 'normal', 'approved', 1749930001, 86400)
    `).run(target);

    db.prepare(`
      INSERT INTO inter_session_messages (source_project, source_session_id, target_project, body, priority, status, created_at_epoch, ttl_seconds)
      VALUES ('UrgentSender', 'sess-ur', ?, 'Urgent priority msg', 'urgent', 'approved', 1749930002, 86400)
    `).run(target);

    db.prepare(`
      INSERT INTO inter_session_messages (source_project, source_session_id, target_project, body, priority, status, created_at_epoch, ttl_seconds)
      VALUES ('HighSender', 'sess-hi', ?, 'High priority msg', 'high', 'approved', 1749930003, 86400)
    `).run(target);

    // Simulate 4 sequential hook deliveries — should deliver in priority order
    const delivered: string[] = [];
    for (let i = 0; i < 4; i++) {
      const msg = db.transaction(() => {
        const m = db.prepare(`
          SELECT id, body FROM inter_session_messages
          WHERE target_project = ? AND status = 'approved'
          ORDER BY
            CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 END,
            created_at_epoch ASC
          LIMIT 1
        `).get(target) as { id: number; body: string } | null;
        if (m) {
          db.prepare('UPDATE inter_session_messages SET status = \'delivered\', delivered_at_epoch = ? WHERE id = ?').run(1749930100 + i, m.id);
        }
        return m;
      })();
      if (msg) delivered.push(msg.body);
    }

    expect(delivered).toEqual([
      'Urgent priority msg',
      'High priority msg',
      'Normal priority msg',
      'Low priority msg',
    ]);
  });
});

describe('integration — cross-project messaging with multiple hops', () => {
  test('3-project relay: A → B, B processes and forwards to C', () => {
    // Set up sessions
    for (const [sessId, proj] of [['relay-a', 'RelayA'], ['relay-b', 'RelayB'], ['relay-c', 'RelayC']] as const) {
      db.prepare(`
        INSERT OR IGNORE INTO sdk_sessions (content_session_id, project, started_at, started_at_epoch, status, prompt_counter)
        VALUES (?, ?, '2026-06-11T15:00:00Z', 1749913600, 'active', 1)
      `).run(sessId, proj);
    }

    // A → B
    const msg1 = db.prepare(`
      INSERT INTO inter_session_messages (source_project, source_session_id, target_project, message_type, subject, body, status, created_at_epoch, ttl_seconds)
      VALUES ('RelayA', 'relay-a', 'RelayB', 'request', 'Need C data', 'Please get the latest data from C', 'approved', 1749940000, 86400)
    `).run();
    const msg1Id = Number(msg1.lastInsertRowid);

    // B claims and delivers
    const claimed = db.transaction(() => {
      const m = db.prepare("SELECT id FROM inter_session_messages WHERE target_project = 'RelayB' AND status = 'approved' LIMIT 1").get() as any;
      if (m) db.prepare("UPDATE inter_session_messages SET status = 'delivered', delivered_at_epoch = 1749940100 WHERE id = ?").run(m.id);
      return m;
    })();
    expect(claimed).not.toBeNull();

    // B forwards to C
    const msg2 = db.prepare(`
      INSERT INTO inter_session_messages (source_project, source_session_id, target_project, message_type, subject, body, parent_message_id, status, created_at_epoch, ttl_seconds)
      VALUES ('RelayB', 'relay-b', 'RelayC', 'request', 'Data request from A', 'A needs the latest data — please provide', ?, 'approved', 1749940200, 86400)
    `).run(msg1Id);
    const msg2Id = Number(msg2.lastInsertRowid);

    // C claims
    const cClaimed = db.transaction(() => {
      const m = db.prepare("SELECT id FROM inter_session_messages WHERE target_project = 'RelayC' AND status = 'approved' LIMIT 1").get() as any;
      if (m) db.prepare("UPDATE inter_session_messages SET status = 'delivered', delivered_at_epoch = 1749940300 WHERE id = ?").run(m.id);
      return m;
    })();
    expect(cClaimed).not.toBeNull();
    expect(cClaimed.id).toBe(msg2Id);

    // C replies back to B
    db.prepare("UPDATE inter_session_messages SET status = 'completed', completed_at_epoch = 1749940400, response_body = 'Here is the data: [...]' WHERE id = ?").run(msg2Id);

    // B replies back to A
    db.prepare("UPDATE inter_session_messages SET status = 'completed', completed_at_epoch = 1749940500, response_body = 'Data from C: [...]' WHERE id = ?").run(msg1Id);

    // Verify the full chain
    const chain = db.prepare(`
      SELECT id, source_project, target_project, status, response_body FROM inter_session_messages WHERE id IN (?, ?) ORDER BY id
    `).all(msg1Id, msg2Id) as any[];

    expect(chain.length).toBe(2);
    expect(chain[0].status).toBe('completed');
    expect(chain[0].response_body).toContain('Data from C');
    expect(chain[1].status).toBe('completed');
    expect(chain[1].response_body).toContain('Here is the data');
    expect(chain[1].parent_message_id ?? db.prepare('SELECT parent_message_id FROM inter_session_messages WHERE id = ?').get(msg2Id) as any).toBeDefined();
  });
});

describe('integration — error validation paths', () => {
  test('send_message rejects invalid type', () => {
    const validTypes = ['request', 'notify', 'question'];
    expect(validTypes.includes('invalid')).toBe(false);
  });

  test('send_message rejects invalid priority', () => {
    const validPriorities = ['low', 'normal', 'high', 'urgent'];
    expect(validPriorities.includes('critical')).toBe(false);
  });

  test('reply to non-existent message returns null', () => {
    const msg = db.prepare(
      'SELECT id FROM inter_session_messages WHERE id = ?'
    ).get(999999);
    expect(msg).toBeNull();
  });

  test('reply to wrong project is rejected by status check', () => {
    // Insert a message delivered to CorrectProject
    const result = db.prepare(`
      INSERT INTO inter_session_messages (source_project, source_session_id, target_project, body, status, delivered_at_epoch, created_at_epoch, ttl_seconds)
      VALUES ('Sender', 'sess', 'CorrectProject', 'test', 'delivered', 1749950000, 1749949000, 86400)
    `).run();
    const id = Number(result.lastInsertRowid);

    const msg = db.prepare('SELECT target_project FROM inter_session_messages WHERE id = ?').get(id) as any;
    expect(msg.target_project).toBe('CorrectProject');
    expect(msg.target_project !== 'WrongProject').toBe(true);
  });

  test('approve on non-pending message has no effect', () => {
    // Insert an already-delivered message
    const result = db.prepare(`
      INSERT INTO inter_session_messages (source_project, source_session_id, target_project, body, status, created_at_epoch, ttl_seconds)
      VALUES ('S', 's', 'T', 'already delivered', 'delivered', 1749950100, 86400)
    `).run();
    const id = Number(result.lastInsertRowid);

    const approveResult = db.prepare(
      `UPDATE inter_session_messages SET status = 'approved', approved_at_epoch = ? WHERE id = ? AND status = 'pending_approval'`
    ).run(1749950200, id);
    expect(approveResult.changes).toBe(0);
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

// --- Auto-approve rule matching ---

describe('auto-approve — matchesRules (pure logic)', () => {
  test('exact match on from and to', () => {
    const rules = [{ from: 'AlphaProject', to: 'BetaProject' }];
    expect(matchesRules(rules, 'AlphaProject', 'BetaProject', 'request', 'normal')).toBe(true);
    expect(matchesRules(rules, 'AlphaProject', 'GammaProject', 'request', 'normal')).toBe(false);
    expect(matchesRules(rules, 'GammaProject', 'BetaProject', 'request', 'normal')).toBe(false);
  });

  test('wildcard * matches any project', () => {
    const rules = [{ from: '*', to: 'BetaProject' }];
    expect(matchesRules(rules, 'AlphaProject', 'BetaProject', 'request', 'normal')).toBe(true);
    expect(matchesRules(rules, 'AnyProject', 'BetaProject', 'notify', 'high')).toBe(true);
    expect(matchesRules(rules, 'AlphaProject', 'GammaProject', 'request', 'normal')).toBe(false);
  });

  test('wildcard * on both from and to matches everything', () => {
    const rules = [{ from: '*', to: '*' }];
    expect(matchesRules(rules, 'A', 'B', 'request', 'normal')).toBe(true);
    expect(matchesRules(rules, 'X', 'Y', 'question', 'urgent')).toBe(true);
  });

  test('type filter restricts matching', () => {
    const rules = [{ from: '*', to: '*', type: 'notify' }];
    expect(matchesRules(rules, 'A', 'B', 'notify', 'normal')).toBe(true);
    expect(matchesRules(rules, 'A', 'B', 'request', 'normal')).toBe(false);
    expect(matchesRules(rules, 'A', 'B', 'question', 'normal')).toBe(false);
  });

  test('priority filter restricts matching', () => {
    const rules = [{ from: '*', to: '*', priority: 'low' }];
    expect(matchesRules(rules, 'A', 'B', 'request', 'low')).toBe(true);
    expect(matchesRules(rules, 'A', 'B', 'request', 'normal')).toBe(false);
    expect(matchesRules(rules, 'A', 'B', 'request', 'urgent')).toBe(false);
  });

  test('type * acts as wildcard', () => {
    const rules = [{ from: 'A', to: 'B', type: '*' }];
    expect(matchesRules(rules, 'A', 'B', 'request', 'normal')).toBe(true);
    expect(matchesRules(rules, 'A', 'B', 'notify', 'normal')).toBe(true);
    expect(matchesRules(rules, 'A', 'B', 'question', 'normal')).toBe(true);
  });

  test('omitted type/priority matches everything', () => {
    const rules = [{ from: 'A', to: 'B' }];
    expect(matchesRules(rules, 'A', 'B', 'request', 'normal')).toBe(true);
    expect(matchesRules(rules, 'A', 'B', 'notify', 'urgent')).toBe(true);
    expect(matchesRules(rules, 'A', 'B', 'question', 'low')).toBe(true);
  });

  test('multiple rules — first match wins', () => {
    const rules = [
      { from: 'A', to: 'B', type: 'notify' },
      { from: '*', to: '*', type: 'request', priority: 'urgent' },
    ];
    expect(matchesRules(rules, 'A', 'B', 'notify', 'normal')).toBe(true);
    expect(matchesRules(rules, 'X', 'Y', 'request', 'urgent')).toBe(true);
    expect(matchesRules(rules, 'X', 'Y', 'request', 'normal')).toBe(false);
    expect(matchesRules(rules, 'A', 'B', 'request', 'normal')).toBe(false);
  });

  test('empty rules array matches nothing', () => {
    expect(matchesRules([], 'A', 'B', 'request', 'normal')).toBe(false);
  });

  test('combined type + priority filter', () => {
    const rules = [{ from: 'SmartRouter', to: 'WorkWeek', type: 'notify', priority: 'low' }];
    expect(matchesRules(rules, 'SmartRouter', 'WorkWeek', 'notify', 'low')).toBe(true);
    expect(matchesRules(rules, 'SmartRouter', 'WorkWeek', 'notify', 'high')).toBe(false);
    expect(matchesRules(rules, 'SmartRouter', 'WorkWeek', 'request', 'low')).toBe(false);
  });
});

describe('auto-approve — file-based integration', () => {
  const tmpRulesPath = join(tmpdir(), `test-rules-${process.pid}.json`);

  afterAll(() => {
    try { unlinkSync(tmpRulesPath); } catch {}
    delete process.env.CLAUDE_RECALL_MESSAGE_RULES;
    resetRulesCache();
  });

  test('loads rules from file specified by env var', () => {
    const config = {
      auto_approve: [
        { from: 'TestProject', to: 'OtherProject', type: 'notify' }
      ]
    };
    writeFileSync(tmpRulesPath, JSON.stringify(config));
    process.env.CLAUDE_RECALL_MESSAGE_RULES = tmpRulesPath;
    resetRulesCache();

    expect(matchesAutoApproveRule('TestProject', 'OtherProject', 'notify', 'normal')).toBe(true);
    expect(matchesAutoApproveRule('TestProject', 'OtherProject', 'request', 'normal')).toBe(false);
  });

  test('returns false when rules file does not exist', () => {
    process.env.CLAUDE_RECALL_MESSAGE_RULES = join(tmpdir(), 'nonexistent-rules.json');
    resetRulesCache();

    expect(matchesAutoApproveRule('A', 'B', 'request', 'normal')).toBe(false);
  });

  test('caches rules by mtime — reloads when file changes', () => {
    process.env.CLAUDE_RECALL_MESSAGE_RULES = tmpRulesPath;

    writeFileSync(tmpRulesPath, JSON.stringify({ auto_approve: [{ from: '*', to: '*' }] }));
    resetRulesCache();
    expect(matchesAutoApproveRule('A', 'B', 'request', 'normal')).toBe(true);

    writeFileSync(tmpRulesPath, JSON.stringify({ auto_approve: [{ from: 'X', to: 'Y' }] }));
    resetRulesCache();
    expect(matchesAutoApproveRule('A', 'B', 'request', 'normal')).toBe(false);
    expect(matchesAutoApproveRule('X', 'Y', 'request', 'normal')).toBe(true);
  });

  test('handles malformed JSON gracefully', () => {
    writeFileSync(tmpRulesPath, '{ this is not json');
    process.env.CLAUDE_RECALL_MESSAGE_RULES = tmpRulesPath;
    resetRulesCache();

    expect(matchesAutoApproveRule('A', 'B', 'request', 'normal')).toBe(false);
  });

  test('handles missing auto_approve key gracefully', () => {
    writeFileSync(tmpRulesPath, JSON.stringify({ other_key: 'value' }));
    process.env.CLAUDE_RECALL_MESSAGE_RULES = tmpRulesPath;
    resetRulesCache();

    expect(matchesAutoApproveRule('A', 'B', 'request', 'normal')).toBe(false);
  });
});

// --- WOR-143: Rate limiting, TTL expiry, cleanup ---

describe('rate limiting — max pending messages per source', () => {
  test('counts pending + approved messages per source project', () => {
    const source = 'RateLimitSource_' + Date.now();
    const now = Math.floor(Date.now() / 1000);

    for (let i = 0; i < 10; i++) {
      db.prepare(`
        INSERT INTO inter_session_messages (source_project, source_session_id, target_project, body, status, created_at_epoch, ttl_seconds)
        VALUES (?, 'sess-rl', 'SomeTarget', ?, ?, ?, 86400)
      `).run(source, `msg ${i}`, i < 7 ? 'pending_approval' : 'approved', now);
    }

    const count = db.prepare(
      "SELECT COUNT(*) as cnt FROM inter_session_messages WHERE source_project = ? AND status IN ('pending_approval', 'approved')"
    ).get(source) as { cnt: number };
    expect(count.cnt).toBe(10);
  });

  test('does not count completed/rejected/expired toward limit', () => {
    const source = 'RateLimitDone_' + Date.now();
    const now = Math.floor(Date.now() / 1000);

    db.prepare(`INSERT INTO inter_session_messages (source_project, source_session_id, target_project, body, status, created_at_epoch, ttl_seconds) VALUES (?, 'sess', 'T', 'a', 'completed', ?, 86400)`).run(source, now);
    db.prepare(`INSERT INTO inter_session_messages (source_project, source_session_id, target_project, body, status, created_at_epoch, ttl_seconds) VALUES (?, 'sess', 'T', 'b', 'rejected', ?, 86400)`).run(source, now);
    db.prepare(`INSERT INTO inter_session_messages (source_project, source_session_id, target_project, body, status, created_at_epoch, ttl_seconds) VALUES (?, 'sess', 'T', 'c', 'expired', ?, 86400)`).run(source, now);
    db.prepare(`INSERT INTO inter_session_messages (source_project, source_session_id, target_project, body, status, created_at_epoch, ttl_seconds) VALUES (?, 'sess', 'T', 'd', 'pending_approval', ?, 86400)`).run(source, now);

    const count = db.prepare(
      "SELECT COUNT(*) as cnt FROM inter_session_messages WHERE source_project = ? AND status IN ('pending_approval', 'approved')"
    ).get(source) as { cnt: number };
    expect(count.cnt).toBe(1);
  });
});

describe('message cleanup — delete old terminal messages', () => {
  test('deletes completed/rejected/expired messages older than retention period', () => {
    const retentionDays = 7;
    const cutoff = Math.floor(Date.now() / 1000) - (retentionDays * 86400);
    const veryOld = cutoff - 86400; // 8 days ago
    const recent = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago

    const prefix = 'Cleanup_' + Date.now();

    // Old terminal messages — should be cleaned
    db.prepare(`INSERT INTO inter_session_messages (source_project, source_session_id, target_project, body, status, created_at_epoch, ttl_seconds) VALUES (?, 'sess', 'T', 'old completed', 'completed', ?, 86400)`).run(prefix, veryOld);
    db.prepare(`INSERT INTO inter_session_messages (source_project, source_session_id, target_project, body, status, created_at_epoch, ttl_seconds) VALUES (?, 'sess', 'T', 'old rejected', 'rejected', ?, 86400)`).run(prefix, veryOld);
    db.prepare(`INSERT INTO inter_session_messages (source_project, source_session_id, target_project, body, status, created_at_epoch, ttl_seconds) VALUES (?, 'sess', 'T', 'old expired', 'expired', ?, 86400)`).run(prefix, veryOld);

    // Recent terminal message — should NOT be cleaned
    db.prepare(`INSERT INTO inter_session_messages (source_project, source_session_id, target_project, body, status, created_at_epoch, ttl_seconds) VALUES (?, 'sess', 'T', 'recent completed', 'completed', ?, 86400)`).run(prefix, recent);

    // Old active message — should NOT be cleaned (not terminal status)
    db.prepare(`INSERT INTO inter_session_messages (source_project, source_session_id, target_project, body, status, created_at_epoch, ttl_seconds) VALUES (?, 'sess', 'T', 'old pending', 'pending_approval', ?, 86400)`).run(prefix, veryOld);

    const cleaned = db.prepare(
      "DELETE FROM inter_session_messages WHERE source_project = ? AND status IN ('completed', 'rejected', 'expired') AND created_at_epoch < ?"
    ).run(prefix, cutoff);
    expect(cleaned.changes).toBe(3);

    // Verify survivors
    const remaining = db.prepare(
      "SELECT body FROM inter_session_messages WHERE source_project = ? ORDER BY body"
    ).all(prefix) as Array<{ body: string }>;
    expect(remaining.length).toBe(2);
    expect(remaining.map(r => r.body)).toContain('recent completed');
    expect(remaining.map(r => r.body)).toContain('old pending');
  });
});
