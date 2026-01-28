# Claude-Recall: AI Development Instructions

Claude-recall is a Claude Code plugin providing persistent memory across sessions. It captures tool usage, compresses observations using the Claude Agent SDK, and injects relevant context into future sessions.

## Architecture

### Lifecycle Hooks

The plugin hooks into 5 Claude Code lifecycle events:

| Hook | Event | Handler | Purpose |
|------|-------|---------|---------|
| **SessionStart** | User opens Claude Code | `context.ts` | Inject RAG context from previous sessions |
| **UserPromptSubmit** | User sends prompt | `session-init.ts` | Create/resume session, save user prompt |
| **PostToolUse** | Claude uses a tool | `observation.ts` | Queue observation for AI processing |
| **Stop** | Claude stops responding | `summarize.ts` | Queue summary generation |
| **SessionEnd** | User exits Claude Code | `session-end.ts` | Mark session as `completed` in database |

Hook handlers are in `src/cli/handlers/`. They send requests to the worker API.

**Hooks** (`plugin/hooks/hooks.json`) - Defines which handlers run for each lifecycle event

**Worker Service** (`src/services/worker-service.ts`) - Express API on port 37777, Bun-managed, handles AI processing asynchronously

**Database** (`src/services/sqlite/`) - SQLite3 at `~/.claude-recall/claude-recall.db`

**DatabaseManager** (`src/services/worker/DatabaseManager.ts`) - Owns SQLite and TieredStorageManager lifecycle. Observations are written to SQLite first (atomic transaction), then synced to tiered storage (Redis/PostgreSQL) as fire-and-forget async writes via `ResponseProcessor`.

**SessionManager** (`src/services/worker/SessionManager.ts`) - Manages active sessions in memory, event-driven message queues, and coordinates between HTTP requests and SDK agent.

**SessionStore** (`src/services/sqlite/SessionStore.ts`) - Persistent session storage with status tracking (`active`, `completed`, `failed`).

**Search Skill** (`plugin/skills/mem-search/SKILL.md`) - HTTP API for searching past work, auto-invoked when users ask about history

**Viewer UI** (`src/ui/viewer/`) - React interface at http://localhost:37777, built to `plugin/ui/viewer.html`

### Storage Modes

Claude-recall supports four storage modes configured via `CLAUDE_RECALL_STORAGE_MODE` in settings.json:

| Mode | Write Path | Use Case |
|------|------------|----------|
| **sqlite-only** | SQLite only | Local, no network |
| **sqlite-primary** | SQLite → PG/Redis sync | Local-first, reliable |
| **tiered-primary** | PG/Redis → SQLite fallback | Cross-machine sharing |
| **tiered-cold-only** | PostgreSQL → SQLite fallback | No Redis, simpler |

**Storage CLI** (`scripts/storage-config.js`):
```bash
npm run storage                    # Dashboard: connections, counts, projects
npm run storage:set <mode>         # Change mode
npm run storage:connect local      # Configure for local Docker
npm run storage:connect remote     # Configure for remote server
```

**Storage Details Endpoint** (`GET /api/storage/details`):
Returns counts per tier, connection status, active sessions, and project breakdown.

### Tiered Storage Architecture

**Hot Tier (Redis)** (`src/services/storage/hot/`) - RediSearch vector search, 48h TTL, ~1-5ms latency

**Cold Tier (PostgreSQL)** (`src/services/storage/cold/`) - pgvector + BM25 hybrid search, 20-day retention

**RAG Routes** (`src/services/worker/http/routes/RAGRoutes.ts`) - Per-prompt context retrieval, receives `DatabaseManager` via constructor

**Write Path** (`src/services/worker/agents/ResponseProcessor.ts`):
- **sqlite-primary**: SQLite atomic write, then fire-and-forget sync to tiered storage
- **tiered-primary**: PostgreSQL write first, SQLite as fallback if PG fails

**Configuration** (`src/services/storage/config.ts`) - Reads from `~/.claude-recall/settings.json` then env vars

See `docs/TIERED_MEMORY.md` for full documentation.

### Session Lifecycle

Sessions track their status in the `sdk_sessions` table:

| Status | Meaning |
|--------|---------|
| `active` | Session is in progress |
| `completed` | User exited Claude Code normally (SessionEnd hook fired) |
| `failed` | Session encountered an error |

**Session Cleanup**: If sessions get stuck in `active` status (e.g., Claude Code crashes), use the cleanup endpoint:

```bash
curl -X POST http://127.0.0.1:37777/api/admin/cleanup-sessions \
  -H "Content-Type: application/json" \
  -d '{"maxAgeHours": 2}'
```

This marks sessions older than `maxAgeHours` as `completed`, excluding any currently active in memory.

## Privacy Tags
- `<private>content</private>` - User-level privacy control (manual, prevents storage)

**Implementation**: Tag stripping happens at hook layer (edge processing) before data reaches worker/database. See `src/utils/tag-stripping.ts` for shared utilities.

## Build Commands

```bash
npm run build-and-sync        # Build, sync to marketplace, restart worker
npm run build                 # Build only (no sync/restart)
npm run sync-marketplace      # Sync built plugin to marketplace

# Storage management
npm run storage               # Show storage dashboard
npm run storage:set <mode>    # sqlite-only, sqlite-primary, tiered-primary, tiered-cold-only
npm run storage:connect local # Configure local Docker connections
npm run storage:connect remote # Configure remote server (interactive)
```

### Version Injection (Critical)

The build script (`scripts/build-hooks.js`) injects the package version into the worker bundle via esbuild's `define` option:

```javascript
define: {
  '__DEFAULT_PACKAGE_VERSION__': JSON.stringify(packageVersion),
}
```

This ensures the worker reports the correct version via `/api/version`. The `start` command compares this against the installed plugin's `package.json` version. **If they don't match, the worker is shut down and restarted on every hook invocation**, causing observations to be lost.

**Symptoms of version mismatch**:
- `observations: 0` in stats despite tool usage
- Logs show `Shutdown initiated` ~50ms after `CLAIMED`
- Worker reports `"development"` or mismatched version

**Diagnosis**:
```bash
curl -s http://127.0.0.1:37777/api/version  # Worker version
cat ~/.claude/plugins/marketplaces/askqai/package.json | grep version  # Plugin version
```

**Fix**: Rebuild with `npm run build-and-sync` to inject the correct version.

## Configuration

Settings are managed in `~/.claude-recall/settings.json`. The file is auto-created with defaults on first run.

**Plugin Enablement**: The plugin must be enabled in `~/.claude/settings.json` under `enabledPlugins` with key `"claude-recall-plugin@askqai": true`. Without this entry, Claude Code will not fire lifecycle hooks and no observations will be captured.

## File Locations

- **Source**: `<project-root>/src/`
- **Built Plugin**: `<project-root>/plugin/`
- **Installed Plugin**: `~/.claude/plugins/marketplaces/askqai/`
- **Database (SQLite)**: `~/.claude-recall/claude-recall.db`
- **Settings**: `~/.claude-recall/settings.json`
- **Tiered Storage Config**: `src/services/storage/config.ts`
- **Tiered Storage Docs**: `docs/TIERED_MEMORY.md`

## Exit Code Strategy

Claude-recall hooks use specific exit codes per Claude Code's hook contract:

- **Exit 0**: Success or graceful shutdown (Windows Terminal closes tabs)
- **Exit 1**: Non-blocking error (stderr shown to user, continues)
- **Exit 2**: Blocking error (stderr fed to Claude for processing)

**Philosophy**: Worker/hook errors exit with code 0 to prevent Windows Terminal tab accumulation. The wrapper/plugin layer handles restart logic. ERROR-level logging is maintained for diagnostics.

See `private/context/claude-code/exit-codes.md` for full hook behavior matrix.

## Requirements

- **Bun** (all platforms - auto-installed if missing, required for bun:sqlite)
- Node.js

**For Tiered Storage (optional)**:
- PostgreSQL 16+ with pgvector extension
- Redis Stack (includes RediSearch)
- Ollama with nomic-embed-text model

## Pro Features Architecture

Claude-recall is designed with a clean separation between open-source core functionality and optional Pro features.

**Open-Source Core** (this repository):

- All worker API endpoints on localhost:37777 remain fully open and accessible
- Pro features are headless - no proprietary UI elements in this codebase
- Pro integration points are minimal: settings for license keys, tunnel provisioning logic
- The architecture ensures Pro features extend rather than replace core functionality

**Pro Features** (coming soon, external):

- Enhanced UI (Memory Stream) connects to the same localhost:37777 endpoints as the open viewer
- Additional features like advanced filtering, timeline scrubbing, and search tools
- Access gated by license validation, not by modifying core endpoints
- Users without Pro licenses continue using the full open-source viewer UI without limitation

This architecture preserves the open-source nature of the project while enabling sustainable development through optional paid features.

## Production Hardening

The codebase includes several safeguards for production reliability:

### Race Condition Prevention
- **Generator race guard** (`SessionRoutes.ts`): Double-check pattern prevents multiple SDK generators from starting for the same session
- **PostgreSQL pool lock** (`PostgresClient.ts`): Promise-based lock prevents concurrent pool initialization

### Timeout Protection
- **SDK message timeout** (`SDKAgent.ts`): 5-minute watchdog aborts sessions if SDK stops responding
- **Claude executable caching**: Path is cached after first lookup to avoid blocking `execSync` on every session

### Resource Limits
- **Queue depth limit**: Max 1000 messages per session prevents unbounded memory/disk growth
- **Stuck message detection**: Messages in `processing` state > 5 minutes are automatically reset

### Automatic Cleanup (every 10 minutes)
- **Stuck messages**: Reset messages stuck in `processing` > 5 minutes
- **Stale sessions**: Mark sessions stuck in `active` > 4 hours as `completed`
- **Old processed messages**: Clear processed messages > 24 hours old

### Manual Cleanup Endpoints
- **SessionEnd hook**: Marks sessions as `completed` when user exits Claude Code
- **Stale session cleanup**: `POST /api/admin/cleanup-sessions` marks old active sessions as completed
- **Failed message clearing**: `DELETE /api/pending-queue/failed` clears stuck messages

### Cache Status Tracking
- **Redis cache operations** return `_cached: boolean` so callers know if data was cached
- Silent failures are logged but don't block writes to PostgreSQL (source of truth)

### Monitoring Endpoints
```bash
# Queue health
curl http://127.0.0.1:37777/api/pending-queue

# Storage details (connections, counts, projects)
curl http://127.0.0.1:37777/api/storage/details

# Processing status
curl http://127.0.0.1:37777/api/processing-status
```

## Important

No need to edit the changelog ever, it's generated automatically.
