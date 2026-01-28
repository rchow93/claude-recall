# Quick Start Guide

Get the tiered memory system running in 5 minutes.

## Prerequisites

- **Bun**: Required runtime ([install](https://bun.sh))
- **Docker** (or PostgreSQL 16 + Redis Stack installed locally)
- **Ollama**: For embeddings

## Option A: Using Existing Docker Containers

If you already have PostgreSQL (with pgvector) and Redis running:

### 1. Create the Database

```bash
# Connect to your existing PostgreSQL container
docker exec -it your-postgres-container psql -U your_user

# Create database and enable pgvector
CREATE DATABASE claude_recall;
\c claude_recall
CREATE EXTENSION IF NOT EXISTS vector;
\q
```

### 2. Configure Settings

Edit `~/.claude-recall/settings.json`:

```json
{
  "CLAUDE_RECALL_MODEL": "claude-opus-4-5",
  "DATABASE_URL": "postgres://your_user:your_password@localhost:your_port/claude_recall",
  "REDIS_HOST": "localhost",
  "REDIS_PORT": "6379",
  "OLLAMA_HOST": "http://localhost:11434"
}
```

### 3. Install Ollama Embedding Model

```bash
ollama pull nomic-embed-text
```

### 4. Install Plugin

In Claude Code:
```
> /plugin marketplace add askqai/claude-recall
> /plugin install claude-recall
```

### 5. Verify Plugin is Enabled

The plugin must be listed in `~/.claude/settings.json` under `enabledPlugins`. After installing, confirm the file contains:

```json
{
  "enabledPlugins": {
    "claude-recall-plugin@askqai": true
  }
}
```

If the entry is missing, add it manually. Without this, Claude Code will not fire the lifecycle hooks and **no observations will be captured**.

Restart Claude Code. The tiered storage will initialize automatically.

---

## Option B: Fresh Docker Setup

### 1. Start Services

Create `docker-compose.tiered.yml`:

```yaml
version: '3.8'
services:
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_DB: claude_recall
      POSTGRES_USER: claude_recall
      POSTGRES_PASSWORD: claude_recall
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
    restart: unless-stopped

  redis:
    image: redis/redis-stack:latest
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data
    restart: unless-stopped

volumes:
  postgres_data:
  redis_data:
```

Start the containers:
```bash
docker compose -f docker-compose.tiered.yml up -d
```

### 2. Install Ollama

```bash
# Install
curl -fsSL https://ollama.com/install.sh | sh

# Pull embedding model
ollama pull nomic-embed-text
```

### 3. Configure Settings

Edit `~/.claude-recall/settings.json`:

```json
{
  "CLAUDE_RECALL_MODEL": "claude-opus-4-5",
  "DATABASE_URL": "postgres://claude_recall:claude_recall@localhost:5432/claude_recall",
  "REDIS_HOST": "localhost",
  "REDIS_PORT": "6379",
  "OLLAMA_HOST": "http://localhost:11434"
}
```

### 4. Install Plugin

In Claude Code:
```
> /plugin marketplace add askqai/claude-recall
> /plugin install claude-recall
```

### 5. Verify Plugin is Enabled

Check that `~/.claude/settings.json` includes:

```json
{
  "enabledPlugins": {
    "claude-recall-plugin@askqai": true
  }
}
```

If the entry is missing, add it manually. Without this, hooks will not fire and no data will be captured.

Restart Claude Code.

---

## Option C: Using the Interactive Dashboard (Recommended)

The storage dashboard provides a single interface to view status and change settings.

### 1. Start Docker Services

```bash
docker compose -f docker-compose.tiered.yml up -d
ollama pull nomic-embed-text
```

### 2. Run the Interactive Dashboard

```bash
npm run storage
```

This shows:
- Current storage mode
- Connection status (green ● = connected, red ● = disconnected)
- Data counts in each tier (SQLite, PostgreSQL, Redis)
- Projects and their observation counts
- Active sessions

### 3. Configure from the Dashboard

From the dashboard, use these keys:

| Key | Action |
|-----|--------|
| **Enter** | Select storage mode (use arrow keys to navigate) |
| **c** | Configure connections (local Docker or remote server) |
| **q** | Exit |

**Example workflow:**
1. Press **c** → Select **1** for local Docker defaults
2. Press **Enter** → Use arrow keys to select **tiered-primary** → Press **Enter**
3. Done! Worker will use the new settings on next restart

---

## Verify Installation

### Storage Dashboard (Recommended)

```bash
npm run storage
```

Shows connections, data counts, and projects in a single view. Green ● indicates connected services.

### Check Worker Status (Alternative)

```bash
curl http://127.0.0.1:37777/health
# {"status":"ok","timestamp":...}
```

### Check RAG Status

```bash
curl http://127.0.0.1:37777/api/rag/status
# {"available":true,"storageInitialized":true,"hasQueryRouter":true,"hasCacheWarmer":true}
```

### Check Database Tables

```bash
docker exec your-postgres-container psql -U your_user -d claude_recall -c "\dt"
# Should show: observations, session_summaries, weekly_summaries, project_facts, etc.
```

---

## Using the System

Once installed, everything works automatically:

1. **On Session Start**: Cache is warmed for your project
2. **On Each Prompt**: RAG retrieves relevant context
3. **On Tool Use**: Observations are stored in both tiers
4. **Background**: Summaries are consolidated hierarchically

### Project Isolation

Data is isolated by working directory:

```bash
cd ~/Code/project-a && claude  # Only sees project-a memories
cd ~/Code/project-b && claude  # Only sees project-b memories
```

All sessions share the same database and Redis, but queries filter by project automatically.

### Session Behavior

- **Plugin is global**: Installed once, works in all terminals
- **Worker service**: Shared process on port 37777, serves all terminals
- **New features require restart**: Running sessions use hooks loaded at start
- **Survives reboots**: First `claude` command starts the worker automatically

### Manual RAG Query

```bash
curl -X POST http://127.0.0.1:37777/api/rag/query \
  -H "Content-Type: application/json" \
  -d '{
    "query": "What have I worked on?",
    "project": "my-project",
    "limit": 5
  }'
```

---

## Troubleshooting

### "bun: command not found"

Install Bun:
```bash
curl -fsSL https://bun.sh/install | bash
```

### "Cannot find module 'bun:sqlite'"

The worker must run with Bun, not Node.js. Check hooks.json uses `bun` commands.

### "Connection refused" to PostgreSQL/Redis

- Check containers are running: `docker ps`
- Verify ports in settings match your containers
- Test connectivity:
  ```bash
  docker exec your-postgres-container pg_isready
  docker exec your-redis-container redis-cli PING
  ```

### No observations being captured

If the worker is running but no data appears in the database:

1. **Check plugin is enabled**: `~/.claude/settings.json` must include `"claude-recall-plugin@askqai": true` in `enabledPlugins`. Without this, hooks don't fire.

2. **Check version mismatch**: The worker version must match the plugin version.
   ```bash
   curl -s http://127.0.0.1:37777/api/version
   cat ~/.claude/plugins/marketplaces/askqai/package.json | grep version
   ```
   If they don't match, the worker is being restarted on every hook. For developers building from source, run `npm run build-and-sync` to fix.

3. **Check logs for shutdown pattern**:
   ```bash
   tail -50 ~/.claude-recall/logs/claude-recall-$(date +%Y-%m-%d).log | grep -i shutdown
   ```
   If you see "Shutdown initiated" frequently, it's likely a version mismatch issue.

### RAG status shows `available: false`

1. Check Ollama is running: `curl http://localhost:11434/api/tags`
2. Verify DATABASE_URL is correct in settings.json
3. Check PostgreSQL has the pgvector extension enabled
4. Restart the worker: `cd ~/.claude/plugins/marketplaces/askqai && bun scripts/worker-service.cjs restart`

### No embeddings generated

```bash
# Test Ollama embedding
curl http://localhost:11434/api/embeddings -d '{"model":"nomic-embed-text","prompt":"test"}'
```

---

## Cross-Machine Setup

Share coding context between multiple machines (e.g., desktop and laptop).

### 1. Set Up Shared Server

Run PostgreSQL + Redis on a server accessible to all machines:

```bash
# On your server
docker compose -f docker-compose.tiered.yml up -d
```

Ensure ports 5432 (PostgreSQL) and 6379 (Redis) are accessible on your network.

### 2. Configure Each Machine

On each machine that will share context, run the interactive dashboard:

```bash
npm run storage
```

Then:
1. Press **c** → Select **2** for remote server
2. Enter your server's IP address when prompted
3. Press **Enter** → Select **tiered-primary** → Press **Enter**

### 3. Verify

The dashboard should show green ● for PostgreSQL and Redis connections.

### How It Works

- Project names are derived from directory names (e.g., `~/Code/my-app` → `my-app`)
- Both machines working on `~/Code/my-app` share the same context
- Observations, summaries, and embeddings are stored in the shared PostgreSQL
- Redis provides fast caching across machines
- Local SQLite serves as fallback if the network is unavailable

---

## Storage Modes Reference

Select any mode from the interactive dashboard (`npm run storage` → **Enter**):

| Mode | Description |
|------|-------------|
| **sqlite-only** | Local SQLite only. No network dependencies. |
| **sqlite-primary** | SQLite first, then syncs to PG/Redis. Safe if network fails. |
| **tiered-primary** | PG/Redis first, SQLite fallback. **Enables cross-machine sharing.** |
| **tiered-cold-only** | PostgreSQL only (no Redis). Simpler setup. |

Or use direct commands for scripting:
```bash
npm run storage:set sqlite-only
npm run storage:set sqlite-primary
npm run storage:set tiered-primary
npm run storage:set tiered-cold-only
```

---

## Next Steps

- Read [TIERED_MEMORY.md](./TIERED_MEMORY.md) for full architecture documentation
- Configure advanced settings in `~/.claude-recall/settings.json`
- View memories in the web UI at http://localhost:37777
- Run `npm run storage` anytime to view status and change settings
