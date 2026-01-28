# Claude-Recall Tiered Memory Architecture

## Overview

The tiered memory system provides fast, scalable persistent memory for Claude Code sessions using a two-tier architecture:

- **Hot Tier (Redis)**: Fast retrieval (~1-5ms), recent data (48h), vector search via RediSearch
- **Cold Tier (PostgreSQL)**: Long-term storage (20-day retention), hybrid search (pgvector + BM25)

Plus: Hierarchical summarization and per-prompt RAG retrieval.

## Requirements

- **Bun**: Required runtime (the worker uses `bun:sqlite` for SQLite operations)
- **Node.js**: 18+ for build tooling
- **PostgreSQL 16+** with pgvector extension
- **Redis Stack** (includes RediSearch for vector search)
- **Ollama**: For generating embeddings

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         USER PROMPT                                 │
└─────────────────────────┬───────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│                  UserPromptSubmit Hook                              │
│  1. Initialize session                                              │
│  2. Query RAG for relevant context                                  │
│  3. Inject context into Claude's conversation                       │
└─────────────────────────┬───────────────────────────────────────────┘
                          │
          ┌───────────────┴───────────────┐
          ▼                               ▼
┌─────────────────────┐       ┌─────────────────────────────────────┐
│   HOT TIER (Redis)  │       │       COLD TIER (PostgreSQL)        │
│   ~1-5ms latency    │       │       ~100-200ms latency            │
├─────────────────────┤       ├─────────────────────────────────────┤
│ • Recent obs (48h)  │──────▶│ • All obs (20-day retention)        │
│ • Tree summaries    │ sync  │ • pgvector embeddings               │
│ • Pinned facts      │       │ • tsvector full-text (BM25)         │
│ • RediSearch vector │       │ • Hybrid search + RRF               │
│ • TTL expiration    │       │ • Optional reranker                 │
└─────────────────────┘       └─────────────────────────────────────┘
          │                               │
          └───────────────┬───────────────┘
                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│              HIERARCHICAL SUMMARIZATION (Background)                │
│  Raw Observations → Session Summaries (24h) → Weekly (7d) → Facts  │
└─────────────────────────────────────────────────────────────────────┘
```

## Prerequisites

### 1. PostgreSQL with pgvector

```bash
# macOS (Homebrew)
brew install postgresql@16
brew install pgvector

# Start PostgreSQL
brew services start postgresql@16

# Create database and enable extension
psql postgres -c "CREATE DATABASE claude_recall;"
psql claude_recall -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

**Docker alternative:**
```bash
docker run -d \
  --name claude-recall-postgres \
  -e POSTGRES_DB=claude_recall \
  -e POSTGRES_PASSWORD=password \
  -p 5432:5432 \
  pgvector/pgvector:pg16
```

### 2. Redis with RediSearch

```bash
# macOS (Homebrew)
brew tap redis-stack/redis-stack
brew install redis-stack

# Start Redis Stack (includes RediSearch)
brew services start redis-stack

# Verify RediSearch is loaded
redis-cli MODULE LIST | grep -i search
```

**Docker alternative:**
```bash
docker run -d \
  --name claude-recall-redis \
  -p 6379:6379 \
  redis/redis-stack:latest
```

### 3. Ollama for Embeddings

```bash
# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# Pull the embedding model (768 dimensions, fast, good quality)
ollama pull nomic-embed-text

# Verify it works
curl http://localhost:11434/api/embeddings -d '{
  "model": "nomic-embed-text",
  "prompt": "test embedding"
}'
```

### 4. Node.js Dependencies

```bash
cd claude-recall
npm install
```

## Configuration

Configuration is loaded from `~/.claude-recall/settings.json` with fallback to environment variables.

### Settings File (Recommended)

Edit `~/.claude-recall/settings.json`:

```json
{
  "CLAUDE_RECALL_MODEL": "claude-opus-4-5",
  "DATABASE_URL": "postgres://user:password@localhost:5432/claude_recall",
  "REDIS_HOST": "localhost",
  "REDIS_PORT": "6379",
  "OLLAMA_HOST": "http://localhost:11434",
  "CLAUDE_RECALL_WORKER_PORT": "37777",
  "CLAUDE_RECALL_WORKER_HOST": "127.0.0.1"
}
```

### Using Existing Docker Containers

If you already have PostgreSQL and Redis running in Docker, just point to them:

```json
{
  "DATABASE_URL": "postgres://myuser:mypassword@localhost:5433/claude_recall",
  "REDIS_HOST": "localhost",
  "REDIS_PORT": "6380"
}
```

**Important**: Create the `claude_recall` database and enable pgvector:

```bash
# Connect to your existing PostgreSQL container
docker exec -it your-postgres-container psql -U your_user -c "CREATE DATABASE claude_recall;"
docker exec -it your-postgres-container psql -U your_user -d claude_recall -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

### Environment Variables (Alternative)

You can also set environment variables (settings.json takes precedence):

```bash
# PostgreSQL
DATABASE_URL=postgres://user:password@localhost:5432/claude_recall
PG_MAX_CONNECTIONS=10
PG_IDLE_TIMEOUT_MS=30000
PG_RETENTION_DAYS=20

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=        # Optional
REDIS_DB=0
REDIS_HOT_TIER_TTL=172800  # 48 hours in seconds

# Ollama
OLLAMA_HOST=http://localhost:11434
OLLAMA_EMBEDDING_MODEL=nomic-embed-text
OLLAMA_EMBEDDING_DIM=768
OLLAMA_TIMEOUT_MS=30000

# Search
SEARCH_USE_RERANKER=false
SEARCH_TOKEN_BUDGET=2000
SEARCH_DEFAULT_LIMIT=10
SEARCH_HYBRID_VECTOR_WEIGHT=0.5

# Summarization
SUMMARIZATION_SESSION_DELAY_HOURS=24
SUMMARIZATION_WEEKLY_DELAY_DAYS=7
SUMMARIZATION_INTERVAL_MS=21600000  # 6 hours
```

### All Configuration Keys

| Key | Default | Description |
|-----|---------|-------------|
| `DATABASE_URL` | `postgres://localhost:5432/claude_recall` | PostgreSQL connection string |
| `PG_MAX_CONNECTIONS` | `10` | Max database connections |
| `PG_IDLE_TIMEOUT_MS` | `30000` | Connection idle timeout |
| `PG_RETENTION_DAYS` | `20` | Days to retain observations |
| `REDIS_HOST` | `localhost` | Redis host |
| `REDIS_PORT` | `6379` | Redis port |
| `REDIS_PASSWORD` | (none) | Redis password (optional) |
| `REDIS_DB` | `0` | Redis database number |
| `REDIS_HOT_TIER_TTL` | `172800` | Hot tier TTL in seconds (48h) |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama API host |
| `OLLAMA_EMBEDDING_MODEL` | `nomic-embed-text` | Embedding model |
| `OLLAMA_EMBEDDING_DIM` | `768` | Embedding dimensions |
| `OLLAMA_TIMEOUT_MS` | `30000` | Ollama request timeout |
| `SEARCH_USE_RERANKER` | `false` | Enable reranker |
| `SEARCH_TOKEN_BUDGET` | `2000` | Token budget for context |
| `SEARCH_DEFAULT_LIMIT` | `10` | Default search limit |
| `SEARCH_HYBRID_VECTOR_WEIGHT` | `0.5` | Vector vs text weight (0-1) |
```

## Usage

### Automatic (via Hooks)

Once configured, the tiered memory system works automatically:

1. **On Session Start**: Cache is warmed for your project
2. **On Each Prompt**: RAG retrieves relevant context and injects it
3. **On Tool Use**: `ResponseProcessor` stores observations to SQLite (atomic transaction), then fire-and-forget syncs to both Chroma and tiered storage (`TieredStorageManager.storeObservations()`)
4. **On Summary**: Session summaries flow to tiered storage via `TieredStorageManager.storeSummary()` (same fire-and-forget pattern)
5. **Background**: Summaries are consolidated hierarchically

#### Write Path Detail

```
PostToolUse Hook → Worker → ResponseProcessor
  1. SQLite atomic transaction (observations + summary)
  2. Chroma sync (fire-and-forget)
  3. TieredStorageManager.storeObservations() (fire-and-forget)
     → PostgreSQL cold tier (always)
     → Redis hot tier cache (if available)
  4. SSE broadcast to web UI
```

`DatabaseManager` owns the `TieredStorageManager` lifecycle:
- Initialized at worker startup with graceful degradation (if PG/Redis are down, logs a warning and continues with SQLite + Chroma only)
- Exposed via `dbManager.getTieredStorage()` (returns `null` if unavailable)
- Closed on worker shutdown before ChromaSync and SQLite

### Manual API Usage

The worker service exposes REST endpoints:

```bash
# Query for relevant context (RAG)
curl -X POST http://127.0.0.1:37777/api/rag/query \
  -H "Content-Type: application/json" \
  -d '{
    "query": "How did we implement the auth system?",
    "project": "my-project",
    "limit": 5,
    "tokenBudget": 2000
  }'

# Warm cache for a project
curl -X POST http://127.0.0.1:37777/api/rag/warm \
  -H "Content-Type: application/json" \
  -d '{"project": "my-project"}'

# Check RAG system status
curl http://127.0.0.1:37777/api/rag/status
```

### Programmatic Usage (TypeScript)

In the worker service, `DatabaseManager` handles tiered storage initialization automatically:

```typescript
// DatabaseManager initializes tiered storage at startup (graceful degradation)
const dbManager = new DatabaseManager();
await dbManager.initialize();
// Logs "TieredStorageManager initialized" or warns and continues with SQLite only

// Check if tiered storage is available
const tieredStorage = dbManager.getTieredStorage(); // null if PG/Redis unavailable

// Store observations (typically done by ResponseProcessor, shown here for reference)
if (tieredStorage) {
  await tieredStorage.storeObservations([{
    memory_session_id: 'session-123',
    project: 'my-project',
    type: 'decision',
    title: 'Chose PostgreSQL for persistence',
    narrative: 'Selected PostgreSQL with pgvector for hybrid search capabilities...',
    concepts: ['database', 'architecture'],
    files_modified: ['src/db/client.ts'],
  }]);

  await tieredStorage.storeSummary({
    memory_session_id: 'session-123',
    project: 'my-project',
    request: 'Set up database persistence',
    investigated: 'Evaluated PostgreSQL vs MySQL',
    learned: 'pgvector supports hybrid search',
    completed: 'Configured PostgreSQL with pgvector',
    next_steps: 'Add Redis caching layer',
  });
}
```

For standalone usage outside the worker (e.g., scripts):

```typescript
import {
  initializeTieredStorage,
  getTieredStorageManager,
} from './services/storage';

// Initialize directly (worker uses DatabaseManager instead)
await initializeTieredStorage();
const manager = getTieredStorageManager();
await manager.storeObservation({ /* ... */ });
```

For RAG queries:

```typescript
import {
  initializeQueryRouter,
  initializeCacheWarmer,
} from './services/storage';

// QueryRouter and CacheWarmer are lazily initialized by RAGRoutes
// For standalone usage:
const router = await initializeQueryRouter();
const warmer = await initializeCacheWarmer();

await warmer.warmForProject('my-project');

const results = await router.queryForRAG({
  query: 'What database decisions have we made?',
  project: 'my-project',
  limit: 5,
});

const context = router.formatForInjection(results, 2000);
console.log(context);
```

## Multi-Tenancy & Project Isolation

The system fully supports multiple projects/terminals with complete data isolation:

### How Projects Are Identified

- **Project name** is derived from your working directory (e.g., `/Users/you/Code/my-app` → `my-app`)
- Every observation, summary, and fact is tagged with the `project` field
- All queries automatically filter by the current project

### Shared Infrastructure, Isolated Data

| Component | Shared or Isolated |
|-----------|-------------------|
| PostgreSQL database | Shared (`claude_recall`) |
| Redis instance | Shared |
| Data within them | **Isolated by `project` field** |

### Example: Multiple Terminals

```
Terminal 1: cd ~/Code/project-a && claude
  → project = "project-a"
  → Only sees/stores project-a memories

Terminal 2: cd ~/Code/project-b && claude
  → project = "project-b"
  → Completely isolated from project-a
```

### Redis Key Namespacing

```
cm:observation:123          → Has project field in hash
cm:timeline:project-a       → Project-specific sorted set
cm:timeline:project-b       → Separate sorted set
cm:fact:project-a:456       → Project-namespaced facts
```

### PostgreSQL Queries Always Filter

```sql
-- All queries include project filter
SELECT * FROM observations
WHERE project = 'my-project'
ORDER BY created_at_epoch DESC;
```

### Session Behavior

- **New sessions**: Load hooks, start worker if needed, warm cache for current project
- **Running sessions**: Use hooks loaded at start (restart to pick up hook changes)
- **Worker service**: Shared by all terminals, serves requests for any project
- **Cache warming**: Happens per-project on session start

## Database Schema

### PostgreSQL Tables

```sql
-- Observations with vector embeddings
CREATE TABLE observations (
  id BIGSERIAL PRIMARY KEY,
  memory_session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('decision','bugfix','feature','refactor','discovery','change')),
  title TEXT,
  subtitle TEXT,
  facts JSONB DEFAULT '[]',
  narrative TEXT,
  concepts JSONB DEFAULT '[]',
  files_read JSONB DEFAULT '[]',
  files_modified JSONB DEFAULT '[]',
  prompt_number INTEGER,
  discovery_tokens INTEGER DEFAULT 0,
  embedding vector(768),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at_epoch BIGINT NOT NULL
);

-- Session summaries
CREATE TABLE session_summaries (
  id BIGSERIAL PRIMARY KEY,
  memory_session_id TEXT NOT NULL UNIQUE,
  project TEXT NOT NULL,
  request TEXT,
  investigated TEXT,
  learned TEXT,
  completed TEXT,
  next_steps TEXT,
  notes TEXT,
  files_read JSONB DEFAULT '[]',
  files_edited JSONB DEFAULT '[]',
  embedding vector(768),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at_epoch BIGINT NOT NULL
);

-- Weekly summaries (hierarchical consolidation)
CREATE TABLE weekly_summaries (
  id BIGSERIAL PRIMARY KEY,
  project TEXT NOT NULL,
  week_start DATE NOT NULL,
  summary_text TEXT NOT NULL,
  key_topics JSONB,
  embedding vector(768),
  source_session_ids BIGINT[],
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(project, week_start)
);

-- Project facts (stable knowledge)
CREATE TABLE project_facts (
  id BIGSERIAL PRIMARY KEY,
  project TEXT NOT NULL,
  fact_text TEXT NOT NULL,
  fact_type TEXT DEFAULT 'general',
  confidence FLOAT DEFAULT 1.0,
  embedding vector(768),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Redis Keys

```
cm:observation:{id}           → Hash with observation data + embedding
cm:timeline:{project}         → Sorted Set (score: epoch)
cm:summary:session:{id}       → Hash with summary data
cm:fact:{id}                  → Hash with fact data
cm:idx:obs                    → RediSearch vector index
cm:idx:summary                → RediSearch vector index
cm:idx:fact                   → RediSearch vector index
```

## Search Capabilities

### Vector Search (Semantic)
Uses cosine similarity on 768-dimensional embeddings from `nomic-embed-text`.

### Full-Text Search (BM25)
PostgreSQL `tsvector` for keyword matching with relevance ranking.

### Hybrid Search (RRF Fusion)
Combines vector and text search using Reciprocal Rank Fusion:
1. Execute both searches
2. Assign RRF scores: `1 / (k + rank)`
3. Sum scores for items appearing in both
4. Sort by combined score

### Optional Reranker
Can add Qwen3-Reranker-4B via vLLM for improved precision:

```bash
pip install vllm
vllm serve dengcao/Qwen3-Reranker-4B --port 8001
```

Set `SEARCH_USE_RERANKER=true` and `RERANKER_URL=http://localhost:8001`.

## Background Workers

### Summarization Worker (every 6 hours)
1. **Session Consolidation**: Observations > 24h old → session summaries
2. **Weekly Consolidation**: Session summaries > 7 days → weekly summaries
3. **Fact Extraction**: Extract stable facts from weekly summaries

### Retention Worker (daily)
Deletes data older than `PG_RETENTION_DAYS` (default: 20 days).

## Performance Targets

| Operation | Target Latency |
|-----------|---------------|
| Hot tier retrieval | < 5ms |
| Cold tier hybrid search | < 200ms |
| Context injection (total) | < 500ms |
| Cache warming (100 obs) | < 2s |

## Troubleshooting

### Redis not available
The system degrades gracefully - cold tier (PostgreSQL) is used directly.

### Ollama not running
Embeddings won't be generated; text search still works.

### "Cannot find module" errors
Run `npm install` to install pg, redis dependencies.

### Slow queries
1. Check PostgreSQL indexes are created (see schema)
2. Verify Redis has RediSearch module loaded
3. Consider increasing `PG_MAX_CONNECTIONS`

## File Locations

| Component | Path |
|-----------|------|
| Storage interfaces | `src/services/storage/interfaces/` |
| PostgreSQL implementation | `src/services/storage/cold/` |
| Redis implementation | `src/services/storage/hot/` |
| Tiered coordination | `src/services/storage/tiered/` |
| Background workers | `src/services/storage/workers/` |
| DatabaseManager (lifecycle) | `src/services/worker/DatabaseManager.ts` |
| ResponseProcessor (write path) | `src/services/worker/agents/ResponseProcessor.ts` |
| RAG API routes | `src/services/worker/http/routes/RAGRoutes.ts` |
| Hook modification | `src/cli/handlers/session-init.ts` |
| Configuration | `src/services/storage/config.ts` |
