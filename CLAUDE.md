# Claude-Recall Development Guide

## Architecture
- **Runtime**: Bun (hooks + MCP server use `bun:sqlite`)
- **Build**: Node.js + esbuild → `plugin/scripts/hook-command.js` (ESM) + `plugin/scripts/mcp-server.cjs` (CJS)
- **Database**: SQLite in WAL mode at `~/.claude-recall/claude-recall.db`
- **Single production dependency**: `@modelcontextprotocol/sdk`

## Build & Test
```bash
npm install              # install deps
node scripts/build-hooks.js  # build hooks + MCP server
bun test                 # run tests
```

## Key Source Paths
- `src/servers/mcp-server.ts` — MCP server with 8 tools (search, timeline, get_observations, forget, __IMPORTANT, send_message, check_inbox, reply_message)
- `src/cli/handlers/context.ts` — SessionStart hook: Recovery Mode + Summary Mode
- `src/cli/handlers/observation.ts` — PostToolUse hook: relevance scoring, redaction, storage, message delivery + maintenance
- `src/cli/handlers/session-init.ts` — UserPromptSubmit hook: session creation, prompt storage
- `src/cli/handlers/summarize.ts` — Stop hook: assistant response extraction
- `src/services/sqlite/migrations/runner.ts` — Schema migrations (currently through #27)
- `src/utils/privacy.ts` — Auto-redaction patterns (8 categories)
- `src/utils/message-rules.ts` — Auto-approve rule matching with mtime-based file caching
- `src/cli/handlers/relevance.ts` — Relevance scoring heuristics

## Database Tables
| Table | Purpose |
|-------|---------|
| `raw_observations` | Tool uses with relevance scores (FTS5 indexed) |
| `user_prompts` | Full user prompt text (FTS5 indexed) |
| `sdk_sessions` | Session metadata, status, privacy flags |
| `consolidated_sessions` | Compressed summaries of old sessions |
| `inter_session_messages` | Cross-session message bus with priority, TTL, threading |

## Plugin Structure
- `.claude-plugin/plugin.json` — Plugin metadata (version must match package.json)
- `.claude-plugin/marketplace.json` — Marketplace listing
- `plugin/hooks/hooks.json` — Hook definitions using `${CLAUDE_PLUGIN_ROOT}`
- `.mcp.json` — MCP server registration

## Version Bumping
Update version in ALL three places: `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`
