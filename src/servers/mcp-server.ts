/**
 * Claude-recall MCP Search Server - Direct SQLite
 *
 * Queries SQLite directly instead of proxying through worker HTTP API.
 * Searches both raw_observations (new) and observations (legacy) tables.
 */

// Version injected at build time by esbuild define
declare const __DEFAULT_PACKAGE_VERSION__: string;
const packageVersion = typeof __DEFAULT_PACKAGE_VERSION__ !== 'undefined' ? __DEFAULT_PACKAGE_VERSION__ : '0.0.0-dev';

import { logger } from '../utils/logger.js';

// CRITICAL: Redirect console to stderr BEFORE other imports
// MCP uses stdio transport where stdout is reserved for JSON-RPC protocol messages.
const _originalLog = console['log'];
console['log'] = (...args: any[]) => {
  logger.error('CONSOLE', 'Intercepted console output (MCP protocol protection)', undefined, { args });
};

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { openDatabase } from '../services/sqlite/DirectDB.js';
import { parseDateExpression } from '../utils/date-parse.js';
import { decrypt } from '../services/encryption.js';
import { getEncryptionKey, encryptionEnabled } from '../services/key-management.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { matchesAutoApproveRule } from '../utils/message-rules.js';

import type { Database, Statement } from 'bun:sqlite';

// Open database at startup — WAL mode supports concurrent readers
let db: Database;
try {
  db = openDatabase();
} catch (error) {
  logger.error('SYSTEM', 'Failed to open database', undefined, error as Error);
  process.exit(1);
}

/**
 * Prepared statement cache to avoid leaking statement handles.
 * bun:sqlite Statement objects hold native resources; creating one per request leaks memory.
 * Cache by SQL string, finalize all on shutdown.
 */
const stmtCache = new Map<string, Statement>();
function cachedPrepare(sql: string): Statement {
  let stmt = stmtCache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    stmtCache.set(sql, stmt);
  }
  return stmt;
}

function finalizeAllStatements(): void {
  for (const stmt of stmtCache.values()) {
    try { stmt.finalize(); } catch { /* ignore */ }
  }
  stmtCache.clear();
}

interface SearchRow {
  id: number;
  source: string;
  content_session_id: string;
  project: string;
  tool_name: string | null;
  title: string | null;
  type: string | null;
  created_at: string;
  created_at_epoch: number;
}

interface RawObsFullRow {
  id: number;
  content_session_id: string;
  project: string;
  tool_name: string;
  tool_input: string | null;
  tool_response: string | null;
  cwd: string | null;
  prompt_number: number | null;
  created_at: string;
  created_at_epoch: number;
  encrypted: number;
}

function decryptField(value: string | null, rowEncrypted: number): string | null {
  if (!value || !rowEncrypted) return value;
  try {
    return decrypt(value, getEncryptionKey());
  } catch {
    return value;
  }
}

interface LegacyObsRow {
  id: number;
  memory_session_id: string;
  project: string;
  text: string | null;
  type: string;
  title: string | null;
  subtitle: string | null;
  facts: string | null;
  narrative: string | null;
  created_at: string;
  created_at_epoch: number;
}

/**
 * Search across raw_observations (FTS5), legacy observations, and consolidated_sessions.
 * Builds SQL dynamically based on which filters are present (project, since, until, query).
 * The full SQL string is the cache key, so identical query shapes still hit the prepared statement cache.
 */
function handleSearch(args: Record<string, any>): { content: Array<{ type: 'text'; text: string }> } {
  const query = args.query as string || '';
  const limit = Math.min(Number(args.limit) || 20, 100);
  const project = args.cross_project ? undefined : (args.project as string | undefined);
  const offset = Number(args.offset) || 0;

  // Date filters (since / until)
  const since = args.since != null ? parseDateExpression(args.since) : null;
  const until = args.until != null ? parseDateExpression(args.until) : null;

  if (args.since != null && since == null) {
    return { content: [{ type: 'text' as const, text: `Could not parse 'since': "${args.since}". Try formats like "3 days ago", "yesterday", "2026-04-25", or epoch seconds.` }] };
  }
  if (args.until != null && until == null) {
    return { content: [{ type: 'text' as const, text: `Could not parse 'until': "${args.until}". Try formats like "3 days ago", "yesterday", "2026-04-25", or epoch seconds.` }] };
  }

  const results: SearchRow[] = [];
  const hasQuery = !!query.trim();
  const ftsQuery = hasQuery ? query.split(/\s+/).map(term => `"${term.replace(/"/g, '')}"`).join(' ') : '';
  const likePattern = hasQuery ? `%${query}%` : '';

  // ─── raw_observations ───
  // Try FTS5 first, fall back to LIKE on syntax error
  let rawAdded = false;
  if (hasQuery) {
    try {
      const { sql, params } = buildRawSearchSql({ mode: 'fts', project, since, until, limit, offset, ftsQuery });
      const rows = cachedPrepare(sql).all(...params) as SearchRow[];
      results.push(...rows);
      rawAdded = true;
    } catch {
      // FTS syntax error — fall through to LIKE
    }
  }
  if (!rawAdded) {
    const mode = hasQuery ? 'like' : 'none';
    const { sql, params } = buildRawSearchSql({ mode, project, since, until, limit, offset, likePattern });
    const rows = cachedPrepare(sql).all(...params) as SearchRow[];
    results.push(...rows);
  }

  // ─── legacy observations ───
  try {
    const legacyLimit = Math.floor(limit / 2);
    const { sql, params } = buildLegacySearchSql({ hasQuery, project, since, until, limit: legacyLimit, offset, likePattern });
    const rows = cachedPrepare(sql).all(...params) as SearchRow[];
    results.push(...rows);
  } catch {
    // Legacy table may not exist
  }

  // ─── consolidated_sessions ───
  try {
    const cLimit = Math.floor(limit / 4);
    const { sql, params } = buildConsolidatedSearchSql({ hasQuery, project, since, until, limit: cLimit, likePattern });
    const rows = cachedPrepare(sql).all(...params) as SearchRow[];
    results.push(...rows);
  } catch {
    // consolidated_sessions table may not exist yet
  }

  // Sort combined results by time, format compact index
  results.sort((a, b) => b.created_at_epoch - a.created_at_epoch);
  const lines = results.slice(0, limit).map(r => {
    const source = r.source === 'raw' ? 'R' : r.source === 'consolidated' ? 'C' : 'L';
    const tool = r.tool_name || r.type || '';
    const title = r.title || '';
    return `[${source}:${r.id}] ${r.created_at} | ${r.project} | ${tool} ${title}`.trim();
  });

  // Build window descriptor for the result message
  const windowDesc = describeWindow(since, until);

  return {
    content: [{
      type: 'text' as const,
      text: lines.length > 0
        ? `Found ${results.length} results${windowDesc}:\n\n${lines.join('\n')}\n\nUse get_observations(ids=[...]) for full details. R=raw, L=legacy, C=consolidated.`
        : `No results found${windowDesc}.`
    }]
  };
}

function describeWindow(since: number | null, until: number | null): string {
  if (since == null && until == null) return '';
  const fmt = (e: number) => new Date(e * 1000).toISOString().slice(0, 19) + 'Z';
  if (since != null && until != null) return ` (between ${fmt(since)} and ${fmt(until)})`;
  if (since != null) return ` (since ${fmt(since)})`;
  return ` (until ${fmt(until!)})`;
}

interface RawSearchOpts {
  mode: 'fts' | 'like' | 'none';
  project?: string;
  since?: number | null;
  until?: number | null;
  limit: number;
  offset: number;
  ftsQuery?: string;
  likePattern?: string;
}

function buildRawSearchSql(opts: RawSearchOpts): { sql: string; params: any[] } {
  const useFTS = opts.mode === 'fts';
  const conditions: string[] = [];
  const params: any[] = [];
  const tableAlias = useFTS ? 'r' : '';
  const colPrefix = useFTS ? 'r.' : '';

  if (opts.mode === 'fts') {
    conditions.push('raw_observations_fts MATCH ?');
    params.push(opts.ftsQuery!);
  } else if (opts.mode === 'like') {
    conditions.push(`(${colPrefix}tool_name LIKE ? OR ${colPrefix}tool_input LIKE ?)`);
    params.push(opts.likePattern!, opts.likePattern!);
  }

  if (opts.project) {
    conditions.push(`${colPrefix}project = ?`);
    params.push(opts.project);
  }
  if (opts.since != null) {
    conditions.push(`${colPrefix}created_at_epoch >= ?`);
    params.push(opts.since);
  }
  if (opts.until != null) {
    conditions.push(`${colPrefix}created_at_epoch <= ?`);
    params.push(opts.until);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const from = useFTS
    ? `FROM raw_observations r JOIN raw_observations_fts f ON r.id = f.rowid`
    : `FROM raw_observations`;
  const orderBy = `ORDER BY ${colPrefix}created_at_epoch DESC LIMIT ? OFFSET ?`;
  params.push(opts.limit, opts.offset);

  const sql = `SELECT ${colPrefix}id, 'raw' as source, ${colPrefix}content_session_id, ${colPrefix}project, ${colPrefix}tool_name,
                NULL as title, NULL as type, ${colPrefix}created_at, ${colPrefix}created_at_epoch
         ${from}
         ${where}
         ${orderBy}`;
  return { sql, params };
}

interface LegacySearchOpts {
  hasQuery: boolean;
  project?: string;
  since?: number | null;
  until?: number | null;
  limit: number;
  offset: number;
  likePattern: string;
}

function buildLegacySearchSql(opts: LegacySearchOpts): { sql: string; params: any[] } {
  // Legacy `observations` table stores created_at_epoch in MILLISECONDS,
  // while raw_observations and our `since`/`until` use SECONDS.
  // Normalize on read with CASE so values >10^10 (clearly ms) get divided by 1000.
  const epochExpr = '(CASE WHEN created_at_epoch > 10000000000 THEN created_at_epoch / 1000 ELSE created_at_epoch END)';

  const conditions: string[] = [];
  const params: any[] = [];

  if (opts.hasQuery) {
    conditions.push('(title LIKE ? OR text LIKE ? OR narrative LIKE ?)');
    params.push(opts.likePattern, opts.likePattern, opts.likePattern);
  }
  if (opts.project) {
    conditions.push('project = ?');
    params.push(opts.project);
  }
  if (opts.since != null) {
    conditions.push(`${epochExpr} >= ?`);
    params.push(opts.since);
  }
  if (opts.until != null) {
    conditions.push(`${epochExpr} <= ?`);
    params.push(opts.until);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(opts.limit, opts.offset);

  // Return normalized created_at_epoch (seconds) so sorting matches raw_observations
  const sql = `SELECT id, 'legacy' as source, COALESCE(memory_session_id, '') as content_session_id,
                project, NULL as tool_name, title, type, created_at, ${epochExpr} as created_at_epoch
         FROM observations
         ${where}
         ORDER BY ${epochExpr} DESC LIMIT ? OFFSET ?`;
  return { sql, params };
}

interface ConsolidatedSearchOpts {
  hasQuery: boolean;
  project?: string;
  since?: number | null;
  until?: number | null;
  limit: number;
  likePattern: string;
}

function buildConsolidatedSearchSql(opts: ConsolidatedSearchOpts): { sql: string; params: any[] } {
  const conditions: string[] = [];
  const params: any[] = [];

  if (opts.hasQuery) {
    conditions.push('summary LIKE ?');
    params.push(opts.likePattern);
  }
  if (opts.project) {
    conditions.push('project = ?');
    params.push(opts.project);
  }
  if (opts.since != null) {
    conditions.push('original_started_at_epoch >= ?');
    params.push(opts.since);
  }
  if (opts.until != null) {
    conditions.push('original_started_at_epoch <= ?');
    params.push(opts.until);
  }

  // Skip the consolidated query entirely if there are no useful filters AND no query
  // (returning all consolidated rows isn't useful and is potentially expensive)
  if (conditions.length === 0) {
    return { sql: 'SELECT * FROM consolidated_sessions WHERE 0 LIMIT 0', params: [] };
  }

  params.push(opts.limit);

  const sql = `SELECT id, 'consolidated' as source, content_session_id, project, NULL as tool_name,
                NULL as title, NULL as type, original_started_at as created_at, original_started_at_epoch as created_at_epoch
         FROM consolidated_sessions
         WHERE ${conditions.join(' AND ')}
         ORDER BY original_started_at_epoch DESC LIMIT ?`;
  return { sql, params };
}

/**
 * Timeline: get context around a specific observation or time window
 */
function handleTimeline(args: Record<string, any>): { content: Array<{ type: 'text'; text: string }> } {
  const anchor = Number(args.anchor) || 0;
  const depthBefore = Math.min(Number(args.depth_before) || 3, 20);
  const depthAfter = Math.min(Number(args.depth_after) || 3, 20);
  const project = args.project as string | undefined;
  const source = (args.source as string) || 'raw';

  if (!anchor) {
    return { content: [{ type: 'text' as const, text: 'Error: anchor (observation ID) is required' }] };
  }

  if (source === 'legacy') {
    const anchorObs = cachedPrepare('SELECT created_at_epoch, project FROM observations WHERE id = ?').get(anchor) as { created_at_epoch: number; project: string } | undefined;
    if (!anchorObs) {
      return { content: [{ type: 'text' as const, text: `Legacy observation ${anchor} not found` }] };
    }

    const epochBefore = anchorObs.created_at_epoch - 3600 * depthBefore;
    const epochAfter = anchorObs.created_at_epoch + 3600 * depthAfter;
    const rows = project
      ? cachedPrepare(
          `SELECT id, COALESCE(memory_session_id, '') as session_id, project, type, title, created_at, created_at_epoch
           FROM observations WHERE created_at_epoch >= ? AND created_at_epoch <= ? AND project = ?
           ORDER BY created_at_epoch ASC LIMIT 50`
        ).all(epochBefore, epochAfter, project) as any[]
      : cachedPrepare(
          `SELECT id, COALESCE(memory_session_id, '') as session_id, project, type, title, created_at, created_at_epoch
           FROM observations WHERE created_at_epoch >= ? AND created_at_epoch <= ?
           ORDER BY created_at_epoch ASC LIMIT 50`
        ).all(epochBefore, epochAfter) as any[];

    const lines = rows.map(r => `[L:${r.id}]${r.id === anchor ? ' >>> ' : ' '}${r.created_at} | ${r.project} | ${r.type} ${r.title || ''}`);
    return { content: [{ type: 'text' as const, text: lines.join('\n') || 'No timeline data found.' }] };
  }

  // Raw observations timeline
  const anchorObs = cachedPrepare('SELECT created_at_epoch, project FROM raw_observations WHERE id = ?').get(anchor) as { created_at_epoch: number; project: string } | undefined;
  if (!anchorObs) {
    return { content: [{ type: 'text' as const, text: `Raw observation ${anchor} not found` }] };
  }

  const epochBefore = anchorObs.created_at_epoch - 3600 * depthBefore;
  const epochAfter = anchorObs.created_at_epoch + 3600 * depthAfter;
  const rows = project
    ? cachedPrepare(
        `SELECT id, content_session_id, project, tool_name, created_at, created_at_epoch
         FROM raw_observations WHERE created_at_epoch >= ? AND created_at_epoch <= ? AND project = ?
         ORDER BY created_at_epoch ASC LIMIT 50`
      ).all(epochBefore, epochAfter, project) as any[]
    : cachedPrepare(
        `SELECT id, content_session_id, project, tool_name, created_at, created_at_epoch
         FROM raw_observations WHERE created_at_epoch >= ? AND created_at_epoch <= ?
         ORDER BY created_at_epoch ASC LIMIT 50`
      ).all(epochBefore, epochAfter) as any[];

  const lines = rows.map((r: any) => `[R:${r.id}]${r.id === anchor ? ' >>> ' : ' '}${r.created_at} | ${r.project} | ${r.tool_name}`);

  return { content: [{ type: 'text' as const, text: lines.join('\n') || 'No timeline data found.' }] };
}

/**
 * Parse prefixed IDs (e.g. "R:1", "L:5") into { source, id } pairs.
 * Accepts both prefixed strings and plain numbers.
 */
function parseIds(ids: Array<string | number>): { rawIds: number[]; legacyIds: number[]; consolidatedIds: number[] } {
  const rawIds: number[] = [];
  const legacyIds: number[] = [];
  const consolidatedIds: number[] = [];
  for (const id of ids) {
    const s = String(id).trim();
    if (s.startsWith('R:') || s.startsWith('r:')) {
      const num = Number(s.slice(2));
      if (!isNaN(num) && num > 0) rawIds.push(num);
    } else if (s.startsWith('L:') || s.startsWith('l:')) {
      const num = Number(s.slice(2));
      if (!isNaN(num) && num > 0) legacyIds.push(num);
    } else if (s.startsWith('C:') || s.startsWith('c:')) {
      const num = Number(s.slice(2));
      if (!isNaN(num) && num > 0) consolidatedIds.push(num);
    } else {
      const num = Number(s);
      if (!isNaN(num) && num > 0) {
        rawIds.push(num);
        legacyIds.push(num);
      }
    }
  }
  return { rawIds: rawIds.slice(0, 50), legacyIds: legacyIds.slice(0, 50), consolidatedIds: consolidatedIds.slice(0, 50) };
}

/**
 * Get full details for specific observation IDs.
 * IDs can be prefixed: R:1 (raw), L:5 (legacy), or plain numbers (search both).
 */
function handleGetObservations(args: Record<string, any>): { content: Array<{ type: 'text'; text: string }> } {
  const ids = args.ids as Array<string | number>;
  if (!ids || ids.length === 0) {
    return { content: [{ type: 'text' as const, text: 'Error: ids array is required' }] };
  }

  const maxLen = typeof args.max_length === 'number' ? Math.min(Math.max(args.max_length, 100), 50000) : 2000;

  const { rawIds, legacyIds, consolidatedIds } = parseIds(ids);
  const results: any[] = [];

  // Fetch from raw_observations
  if (rawIds.length > 0) {
    const rawPlaceholders = rawIds.map(() => '?').join(',');
    const rawRows = db.prepare(
      `SELECT * FROM raw_observations WHERE id IN (${rawPlaceholders}) ORDER BY created_at_epoch DESC`
    ).all(...rawIds) as RawObsFullRow[];

    for (const r of rawRows) {
      const response = decryptField(r.tool_response, r.encrypted);
      results.push({
        source: 'raw',
        id: r.id,
        session: r.content_session_id,
        project: r.project,
        tool_name: r.tool_name,
        tool_input: r.tool_input ? truncate(r.tool_input, maxLen) : null,
        tool_response: response ? truncate(response, maxLen) : null,
        cwd: r.cwd,
        prompt_number: r.prompt_number,
        created_at: r.created_at
      });
    }
  }

  // Fetch from legacy observations
  if (legacyIds.length > 0) {
    try {
      const legacyPlaceholders = legacyIds.map(() => '?').join(',');
      const legacyRows = db.prepare(
        `SELECT * FROM observations WHERE id IN (${legacyPlaceholders}) ORDER BY created_at_epoch DESC`
      ).all(...legacyIds) as LegacyObsRow[];

      for (const r of legacyRows) {
        results.push({
          source: 'legacy',
          id: r.id,
          session: r.memory_session_id,
          project: r.project,
          type: r.type,
          title: r.title,
          subtitle: r.subtitle,
          text: r.text ? truncate(r.text, maxLen) : null,
          facts: r.facts,
          narrative: r.narrative ? truncate(r.narrative, maxLen) : null,
          created_at: r.created_at
        });
      }
    } catch {
      // Legacy table may not exist
    }
  }

  // Fetch from consolidated_sessions
  if (consolidatedIds.length > 0) {
    try {
      const cPlaceholders = consolidatedIds.map(() => '?').join(',');
      const cRows = db.prepare(
        `SELECT * FROM consolidated_sessions WHERE id IN (${cPlaceholders}) ORDER BY original_started_at_epoch DESC`
      ).all(...consolidatedIds) as any[];

      for (const r of cRows) {
        results.push({
          source: 'consolidated',
          id: r.id,
          session: r.content_session_id,
          project: r.project,
          summary: decryptField(r.summary, r.encrypted ?? 0),
          prompt_count: r.prompt_count,
          tool_use_count: r.tool_use_count,
          files_touched: r.files_touched,
          commands_run: r.commands_run,
          original_started_at: r.original_started_at,
          consolidated_at: r.consolidated_at
        });
      }
    } catch {
      // consolidated_sessions table may not exist yet
    }
  }

  return {
    content: [{
      type: 'text' as const,
      text: results.length > 0
        ? JSON.stringify(results, null, 2)
        : `No observations found for IDs: ${ids.join(', ')}`
    }]
  };
}

function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen) + '...[truncated]' : s;
}

/**
 * Forget: delete observations matching a query or specific IDs.
 * Requires confirm=true to actually delete; otherwise does a dry run.
 */
function handleForget(args: Record<string, any>): { content: Array<{ type: 'text'; text: string }> } {
  const query = args.query as string | undefined;
  const ids = args.ids as Array<string | number> | undefined;
  const confirm = args.confirm === true;

  if (!query && (!ids || ids.length === 0)) {
    return { content: [{ type: 'text' as const, text: 'Error: provide either query or ids to identify observations to forget.' }] };
  }

  let rawIdsToDelete: number[] = [];

  if (ids && ids.length > 0) {
    const parsed = parseIds(ids);
    rawIdsToDelete = parsed.rawIds;
    // Also delete legacy if specified
    if (confirm && parsed.legacyIds.length > 0) {
      const legacyPlaceholders = parsed.legacyIds.map(() => '?').join(',');
      try { db.run(`DELETE FROM observations WHERE id IN (${legacyPlaceholders})`, ...parsed.legacyIds); } catch {}
    }
  } else if (query) {
    // Find matching raw observation IDs via FTS
    const ftsQuery = query.split(/\s+/).map(term => `"${term.replace(/"/g, '')}"`).join(' ');
    try {
      const rows = db.prepare(
        `SELECT r.id FROM raw_observations r
         JOIN raw_observations_fts f ON r.id = f.rowid
         WHERE raw_observations_fts MATCH ?
         ORDER BY r.created_at_epoch DESC LIMIT 100`
      ).all(ftsQuery) as Array<{ id: number }>;
      rawIdsToDelete = rows.map(r => r.id);
    } catch {
      // FTS syntax error — fallback to LIKE
      const likePattern = `%${query}%`;
      const rows = db.prepare(
        `SELECT id FROM raw_observations
         WHERE tool_name LIKE ? OR tool_input LIKE ?
         ORDER BY created_at_epoch DESC LIMIT 100`
      ).all(likePattern, likePattern) as Array<{ id: number }>;
      rawIdsToDelete = rows.map(r => r.id);
    }
  }

  if (rawIdsToDelete.length === 0) {
    return { content: [{ type: 'text' as const, text: 'No matching observations found.' }] };
  }

  if (!confirm) {
    // Dry run — show what would be deleted
    const sample = rawIdsToDelete.slice(0, 5);
    const sampleRows = sample.map(id => {
      const row = db.prepare('SELECT id, tool_name, created_at FROM raw_observations WHERE id = ?').get(id) as any;
      return row ? `[R:${row.id}] ${row.created_at} | ${row.tool_name}` : `[R:${id}] (not found)`;
    });
    return {
      content: [{
        type: 'text' as const,
        text: `Would delete ${rawIdsToDelete.length} observations. Sample:\n${sampleRows.join('\n')}\n\nCall forget() again with confirm=true to delete.`
      }]
    };
  }

  // Actually delete
  const placeholders = rawIdsToDelete.map(() => '?').join(',');
  const result = db.run(`DELETE FROM raw_observations WHERE id IN (${placeholders})`, ...rawIdsToDelete);

  // Also check consolidated_sessions if query provided
  let consolidatedDeleted = 0;
  if (query) {
    try {
      const cResult = db.run(`DELETE FROM consolidated_sessions WHERE summary LIKE ?`, `%${query}%`);
      consolidatedDeleted = cResult.changes;
    } catch { /* table may not exist yet */ }
  }

  return {
    content: [{
      type: 'text' as const,
      text: `Deleted ${result.changes} raw observations${consolidatedDeleted > 0 ? ` and ${consolidatedDeleted} consolidated sessions` : ''}. These memories have been permanently removed.`
    }]
  };
}

/**
 * Send a message to another project's Claude Code session (WOR-137)
 */
function handleSendMessage(args: Record<string, any>): { content: Array<{ type: 'text'; text: string }> } {
  const to = args.to as string;
  const message = args.message as string;
  const from = args.from as string;
  const subject = (args.subject as string | undefined) ?? null;
  const messageType = (args.type as string | undefined) ?? 'request';
  const priority = (args.priority as string | undefined) ?? 'normal';
  const ttlHours = (args.ttl_hours as number | undefined) ?? 24;
  const parentMessageId = (args.parent_message_id as number | undefined) ?? null;

  if (!to || !message || !from) {
    return { content: [{ type: 'text' as const, text: 'Error: "to", "message", and "from" are required parameters.' }] };
  }

  const validTypes = ['request', 'notify', 'question'];
  if (!validTypes.includes(messageType)) {
    return { content: [{ type: 'text' as const, text: `Error: type must be one of: ${validTypes.join(', ')}` }] };
  }

  const validPriorities = ['low', 'normal', 'high', 'urgent'];
  if (!validPriorities.includes(priority)) {
    return { content: [{ type: 'text' as const, text: `Error: priority must be one of: ${validPriorities.join(', ')}` }] };
  }

  const nowEpoch = Math.floor(Date.now() / 1000);
  const ttlSeconds = Math.floor(ttlHours * 3600);

  // Resolve source session ID from most recent active session for this project
  const session = cachedPrepare(
    "SELECT content_session_id FROM sdk_sessions WHERE project = ? ORDER BY started_at_epoch DESC LIMIT 1"
  ).get(from) as { content_session_id: string } | null;

  const sourceSessionId = session?.content_session_id ?? 'unknown';

  const result = cachedPrepare(`
    INSERT INTO inter_session_messages (
      source_project, source_session_id, target_project,
      message_type, priority, subject, body, parent_message_id,
      status, created_at_epoch, ttl_seconds
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_approval', ?, ?)
  `).run(from, sourceSessionId, to, messageType, priority, subject, message, parentMessageId, nowEpoch, ttlSeconds);

  const messageId = Number(result.lastInsertRowid);

  let autoApproved = false;
  if (matchesAutoApproveRule(from, to, messageType, priority)) {
    cachedPrepare(
      `UPDATE inter_session_messages SET status = 'approved', approved_at_epoch = ? WHERE id = ?`
    ).run(nowEpoch, messageId);
    autoApproved = true;
  }

  const parts = [
    `Message #${messageId} sent to **${to}**.`,
    `Type: ${messageType} | Priority: ${priority} | TTL: ${ttlHours}h`,
    subject ? `Subject: ${subject}` : null,
    parentMessageId ? `Thread: reply to #${parentMessageId}` : null,
    '',
    autoApproved
      ? 'Status: **approved** (auto-approved by matching rule). The target session will receive this message on its next tool use.'
      : 'Status: **pending_approval** — awaiting operator approval in the pro dashboard.\nThe target session will receive this message via hook injection once approved.'
  ].filter(Boolean);

  return { content: [{ type: 'text' as const, text: parts.join('\n') }] };
}

function handleCheckInbox(args: Record<string, any>): { content: Array<{ type: 'text'; text: string }> } {
  const from = args.from as string;
  const statusFilter = (args.status as string | undefined) ?? null;
  const limit = Math.min(Math.max((args.limit as number | undefined) ?? 10, 1), 50);

  if (!from) {
    return { content: [{ type: 'text' as const, text: 'Error: "from" (your project name) is required.' }] };
  }

  const validStatuses = ['pending_approval', 'approved', 'delivered', 'completed', 'rejected', 'expired'];
  if (statusFilter && !validStatuses.includes(statusFilter)) {
    return { content: [{ type: 'text' as const, text: `Error: status must be one of: ${validStatuses.join(', ')}` }] };
  }

  let query: string;
  let params: any[];

  if (statusFilter) {
    query = `
      SELECT id, source_project, target_project, message_type, priority, subject, body,
             status, created_at_epoch, delivered_at_epoch, completed_at_epoch, response_body, parent_message_id
      FROM inter_session_messages
      WHERE (target_project = ? OR source_project = ?) AND status = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `;
    params = [from, from, statusFilter, limit];
  } else {
    query = `
      SELECT id, source_project, target_project, message_type, priority, subject, body,
             status, created_at_epoch, delivered_at_epoch, completed_at_epoch, response_body, parent_message_id
      FROM inter_session_messages
      WHERE (target_project = ? OR source_project = ?) AND status NOT IN ('expired')
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `;
    params = [from, from, limit];
  }

  const messages = cachedPrepare(query).all(...params) as Array<{
    id: number; source_project: string; target_project: string; message_type: string;
    priority: string; subject: string | null; body: string; status: string;
    created_at_epoch: number; delivered_at_epoch: number | null; completed_at_epoch: number | null;
    response_body: string | null; parent_message_id: number | null;
  }>;

  if (messages.length === 0) {
    return { content: [{ type: 'text' as const, text: `No messages found for project "${from}"${statusFilter ? ` with status "${statusFilter}"` : ''}.` }] };
  }

  const lines: string[] = [`## Inbox for ${from} (${messages.length} message${messages.length !== 1 ? 's' : ''})`, ''];

  for (const msg of messages) {
    const direction = msg.target_project === from ? 'INCOMING' : 'OUTGOING';
    const peer = direction === 'INCOMING' ? msg.source_project : msg.target_project;
    const created = new Date(msg.created_at_epoch * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');

    lines.push(`### #${msg.id} [${direction}] ${msg.status.toUpperCase()}`);
    lines.push(`- **${direction === 'INCOMING' ? 'From' : 'To'}:** ${peer} | **Type:** ${msg.message_type} | **Priority:** ${msg.priority}`);
    if (msg.subject) lines.push(`- **Subject:** ${msg.subject}`);
    if (msg.parent_message_id) lines.push(`- **Thread:** reply to #${msg.parent_message_id}`);
    lines.push(`- **Created:** ${created}`);
    lines.push(`- **Body:** ${msg.body.length > 200 ? msg.body.slice(0, 200) + '...' : msg.body}`);
    if (msg.response_body) {
      lines.push(`- **Response:** ${msg.response_body.length > 200 ? msg.response_body.slice(0, 200) + '...' : msg.response_body}`);
    }
    if (msg.status === 'delivered' && direction === 'INCOMING') {
      lines.push(`- **Action:** reply_message(message_id=${msg.id}, response="...", from="${from}")`);
    }
    lines.push('');
  }

  return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
}

function handleReplyMessage(args: Record<string, any>): { content: Array<{ type: 'text'; text: string }> } {
  const messageId = args.message_id as number;
  const response = args.response as string;
  const from = args.from as string;

  if (!messageId || !response || !from) {
    return { content: [{ type: 'text' as const, text: 'Error: "message_id", "response", and "from" (your project name) are required.' }] };
  }

  const msg = cachedPrepare(
    'SELECT id, target_project, source_project, status, subject FROM inter_session_messages WHERE id = ?'
  ).get(messageId) as { id: number; target_project: string; source_project: string; status: string; subject: string | null } | null;

  if (!msg) {
    return { content: [{ type: 'text' as const, text: `Error: message #${messageId} not found.` }] };
  }

  if (msg.target_project !== from) {
    return { content: [{ type: 'text' as const, text: `Error: message #${messageId} was sent to "${msg.target_project}", not "${from}". You can only reply to messages addressed to your project.` }] };
  }

  if (msg.status !== 'delivered') {
    return { content: [{ type: 'text' as const, text: `Error: message #${messageId} has status "${msg.status}". Only delivered messages can be replied to.` }] };
  }

  const nowEpoch = Math.floor(Date.now() / 1000);

  cachedPrepare(
    `UPDATE inter_session_messages SET status = 'completed', completed_at_epoch = ?, response_body = ? WHERE id = ?`
  ).run(nowEpoch, response, messageId);

  // Insert a reply message back to the source project so they see it in their inbox
  const session = cachedPrepare(
    "SELECT content_session_id FROM sdk_sessions WHERE project = ? ORDER BY started_at_epoch DESC LIMIT 1"
  ).get(from) as { content_session_id: string } | null;
  const sourceSessionId = session?.content_session_id ?? 'unknown';

  const replyResult = cachedPrepare(`
    INSERT INTO inter_session_messages (
      source_project, source_session_id, target_project,
      message_type, priority, subject, body, parent_message_id,
      status, created_at_epoch, ttl_seconds
    ) VALUES (?, ?, ?, 'reply', 'normal', ?, ?, ?, 'pending_approval', ?, 86400)
  `).run(from, sourceSessionId, msg.source_project, msg.subject ? `Re: ${msg.subject}` : null, response, messageId, nowEpoch);

  const replyId = Number(replyResult.lastInsertRowid);

  const parts = [
    `Message #${messageId} marked as **completed** with your response.`,
    `Reply message #${replyId} sent back to **${msg.source_project}** (pending approval).`,
  ];

  return { content: [{ type: 'text' as const, text: parts.join('\n') }] };
}

/**
 * Tool definitions
 */
const tools = [
  {
    name: '__IMPORTANT',
    description: `3-LAYER WORKFLOW (ALWAYS FOLLOW):
1. search(query) → Get index with IDs (~50-100 tokens/result)
2. timeline(anchor=ID) → Get context around interesting results
3. get_observations([IDs]) → Fetch full details ONLY for filtered IDs
NEVER fetch full details without filtering first. 10x token savings.`,
    inputSchema: {
      type: 'object',
      properties: {}
    },
    handler: async () => ({
      content: [{
        type: 'text' as const,
        text: `# Memory Search Workflow

**3-Layer Pattern (ALWAYS follow this):**

1. **Search** - Get index of results with IDs
   \`search(query="...", limit=20, project="...")\`
   Returns: Table with IDs, dates (~50-100 tokens/result)

2. **Timeline** - Get context around interesting results
   \`timeline(anchor=<ID>, depth_before=3, depth_after=3)\`
   Returns: Chronological context

3. **Fetch** - Get full details ONLY for relevant IDs
   \`get_observations(ids=[...])\`
   Returns: Complete details (~500-1000 tokens/result)

**Why:** 10x token savings. Never fetch full details without filtering first.
Prefix R: = raw observations, L: = legacy observations, C: = consolidated sessions.`
      }]
    })
  },
  {
    name: 'search',
    description: 'Step 1: Search memory. Returns index with IDs. Params: query, limit, project, offset, cross_project, since, until.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (FTS5 for raw observations, LIKE for legacy). Optional — omit to search by date alone.' },
        limit: { type: 'number', description: 'Max results (default 20, max 100)' },
        project: { type: 'string', description: 'Filter by project name' },
        offset: { type: 'number', description: 'Pagination offset' },
        cross_project: { type: 'boolean', description: 'Search across all projects (ignores project filter)' },
        since: {
          description: 'Only return results from this point in time onward. Accepts: relative ("3 days ago", "2h ago", "yesterday"), ISO date ("2026-04-25"), epoch seconds.',
          oneOf: [{ type: 'string' }, { type: 'number' }]
        },
        until: {
          description: 'Only return results up to this point in time. Same formats as `since`. Use both `since` and `until` to define a window.',
          oneOf: [{ type: 'string' }, { type: 'number' }]
        }
      },
      additionalProperties: true
    },
    handler: async (args: any) => handleSearch(args)
  },
  {
    name: 'timeline',
    description: 'Step 2: Get context around results. Params: anchor (observation ID), depth_before, depth_after, project, source (raw|legacy)',
    inputSchema: {
      type: 'object',
      properties: {
        anchor: { type: 'number', description: 'Observation ID to center timeline on' },
        depth_before: { type: 'number', description: 'Hours before anchor (default 3)' },
        depth_after: { type: 'number', description: 'Hours after anchor (default 3)' },
        project: { type: 'string', description: 'Filter by project name' },
        source: { type: 'string', description: 'raw (default) or legacy' }
      },
      required: ['anchor'],
      additionalProperties: true
    },
    handler: async (args: any) => handleTimeline(args)
  },
  {
    name: 'get_observations',
    description: 'Step 3: Fetch full details for filtered IDs. Params: ids (array of observation IDs), max_length (optional, default 2000)',
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { oneOf: [{ type: 'number' }, { type: 'string' }] },
          description: 'Array of observation IDs — use R:1 for raw, L:5 for legacy, or plain numbers'
        },
        max_length: {
          type: 'number',
          description: 'Max characters per field (default 2000, max 50000). Use higher values to retrieve full file contents.'
        }
      },
      required: ['ids'],
      additionalProperties: true
    },
    handler: async (args: any) => handleGetObservations(args)
  },
  {
    name: 'send_message',
    description: 'Send a message to another project\'s Claude Code session. Messages require operator approval in the pro dashboard before delivery. The target session receives the message via hook injection.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Target project name (e.g. "SmartRouter", "RecruiterPilot")' },
        message: { type: 'string', description: 'Message body' },
        from: { type: 'string', description: 'Source project name (your current project)' },
        subject: { type: 'string', description: 'Short subject line (optional)' },
        type: { type: 'string', enum: ['request', 'notify', 'question'], description: 'Message type: request (action needed), notify (FYI), question (answer needed). Default: request' },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'], description: 'Priority level. Default: normal' },
        ttl_hours: { type: 'number', description: 'Hours until message expires. Default: 24' },
        parent_message_id: { type: 'number', description: 'ID of message being replied to (for threading)' }
      },
      required: ['to', 'message', 'from'],
      additionalProperties: false
    },
    handler: async (args: any) => handleSendMessage(args)
  },
  {
    name: 'check_inbox',
    description: 'Check your inter-session message inbox. Shows incoming messages (sent to your project) and outgoing messages (sent from your project). Use to see pending, delivered, or completed messages.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Your current project name — used to identify which messages are incoming vs outgoing' },
        status: { type: 'string', enum: ['pending_approval', 'approved', 'delivered', 'completed', 'rejected', 'expired'], description: 'Filter by message status. Omit to see all non-expired messages.' },
        limit: { type: 'number', description: 'Max results (default 10, max 50)' }
      },
      required: ['from'],
      additionalProperties: false
    },
    handler: async (args: any) => handleCheckInbox(args)
  },
  {
    name: 'reply_message',
    description: 'Reply to a delivered inter-session message. Marks the original message as completed and sends a reply back to the source project (pending operator approval).',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: { type: 'number', description: 'ID of the delivered message to reply to' },
        response: { type: 'string', description: 'Your response body' },
        from: { type: 'string', description: 'Your current project name — must match the target_project of the message' }
      },
      required: ['message_id', 'response', 'from'],
      additionalProperties: false
    },
    handler: async (args: any) => handleReplyMessage(args)
  },
  {
    name: 'forget',
    description: 'Delete observations matching a query or specific IDs. Use to remove sensitive or unwanted memories. Requires confirm=true to actually delete.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query to find observations to delete' },
        ids: {
          type: 'array',
          items: { oneOf: [{ type: 'number' }, { type: 'string' }] },
          description: 'Specific IDs to delete (R:1, L:5)'
        },
        confirm: { type: 'boolean', description: 'Must be true to actually delete. Without it, shows what would be deleted.' }
      },
      additionalProperties: true
    },
    handler: async (args: any) => handleForget(args)
  }
];

// Create the MCP server
const server = new Server(
  {
    name: 'mcp-search-server',
    version: packageVersion,
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Register tools/list handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    }))
  };
});

// Register tools/call handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = tools.find(t => t.name === request.params.name);

  if (!tool) {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  try {
    return await tool.handler(request.params.arguments || {});
  } catch (error) {
    logger.error('SYSTEM', 'Tool execution failed', { tool: request.params.name }, error as Error);
    return {
      content: [{
        type: 'text' as const,
        text: `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`
      }],
      isError: true
    };
  }
});

// Cleanup function
async function cleanup() {
  logger.info('SYSTEM', 'MCP server shutting down');
  finalizeAllStatements();
  try { db.close(); } catch { /* ignore */ }
  process.exit(0);
}

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('SYSTEM', 'Claude-recall search server started (direct SQLite mode)');
}

main().catch((error) => {
  logger.error('SYSTEM', 'Fatal error', undefined, error);
  process.exit(0);
});
