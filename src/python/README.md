# claude-recall Tiered Storage (Python)

A Python implementation of the claude-recall tiered memory system, providing persistent AI memory across coding sessions with Redis hot tier and PostgreSQL cold tier.

## Features

- **Two-tier storage architecture**
  - Hot tier (Redis): ~1-5ms latency, 48-hour TTL
  - Cold tier (PostgreSQL): ~100-200ms latency, 20-day retention

- **Hybrid search**
  - Vector similarity search (pgvector/RediSearch)
  - Full-text search (PostgreSQL tsvector)
  - Reciprocal Rank Fusion (RRF) for result merging

- **Hierarchical summarization**
  - Raw observations → Session summaries (24h)
  - Session summaries → Weekly summaries (7d)
  - Weekly summaries → Project facts

- **Per-prompt RAG retrieval**
  - Context injection on every user prompt
  - Hot-first query routing
  - Automatic cache warming

## Quick Start

### Option A: One-Command Install (Recommended)

```bash
cd src/python
./scripts/install.sh
```

This will:
- Start PostgreSQL and Redis (auto-restart on boot)
- Install the Python service as a background daemon
- Configure auto-start on login
- Pull the Ollama embedding model

After installation, the service runs automatically - even after reboot.

### Option B: Manual Setup

#### 1. Start Infrastructure

```bash
cd src/python

# Start PostgreSQL and Redis via Docker
docker compose up -d postgres redis
```

This starts:
- **PostgreSQL** with pgvector on `localhost:5432`
- **Redis** with RediSearch on `localhost:6379`

#### 2. Install Ollama (for embeddings)

```bash
# Install Ollama (macOS)
brew install ollama

# Or download from https://ollama.com

# Pull the embedding model
ollama pull nomic-embed-text
```

#### 3. Configure Environment

```bash
# Copy the sample environment file
cp .env.sample .env

# Edit if needed (defaults work for local Docker setup)
nano .env
```

#### 4. Install Python Dependencies

```bash
# Using pip
pip install -e .

# Or using uv (faster)
uv pip install -e .
```

#### 5. Run the Service

```bash
# API server only
python -m claude_recall

# With background workers (summarization + retention cleanup)
python -m claude_recall --workers

# Development mode with auto-reload
python -m claude_recall --reload
```

The API will be available at **http://localhost:37778**.

## Persistent Operation (Auto-Start on Boot)

The install script sets up everything to run persistently. After a reboot:

1. **Docker Desktop** starts automatically (if configured in Docker settings)
2. **PostgreSQL & Redis** containers auto-restart (`restart: unless-stopped`)
3. **Python service** starts via launchd (macOS)

### Manual Service Management

```bash
# Check status
launchctl list | grep claude-recall

# Stop service
launchctl unload ~/Library/LaunchAgents/com.claude-recall.tiered-storage.plist

# Start service
launchctl load ~/Library/LaunchAgents/com.claude-recall.tiered-storage.plist

# Restart service
launchctl kickstart -k gui/$(id -u)/com.claude-recall.tiered-storage

# View logs
tail -f ~/.claude-recall/logs/claude-recall.log
tail -f ~/.claude-recall/logs/claude-recall.error.log
```

### Uninstall

```bash
./scripts/uninstall.sh
```

## Configuration

All settings are loaded from environment variables or a `.env` file.

### Quick Setup

```bash
cp .env.sample .env
```

### Key Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:5432/claude_recall` | PostgreSQL connection string |
| `REDIS_HOST` | `localhost` | Redis server hostname |
| `REDIS_PORT` | `6379` | Redis server port |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama API URL |
| `PG_RETENTION_DAYS` | `20` | Days to keep data in cold tier |
| `REDIS_HOT_TIER_TTL` | `172800` | Hot tier TTL in seconds (48h) |
| `CLAUDE_RECALL_SERVER_PORT` | `37778` | API server port |
| `CLAUDE_RECALL_USE_LOCAL_EMBEDDINGS` | `false` | Use sentence-transformers instead of Ollama |

### All Configuration Options

See `.env.sample` for the complete list of configuration options with descriptions.

### Remote Services

To connect to remote services instead of local Docker:

```bash
# Remote PostgreSQL
DATABASE_URL=postgres://user:password@db.example.com:5432/claude_recall

# Remote Redis
REDIS_HOST=redis.example.com
REDIS_PORT=6379
REDIS_PASSWORD=your-password

# Remote Ollama
OLLAMA_HOST=http://ollama.example.com:11434
```

## API Endpoints

### Health Check

```bash
curl http://localhost:37778/health
```

Response:
```json
{
  "status": "healthy",
  "hot_tier": true,
  "cold_tier": true
}
```

### RAG Context Retrieval

```bash
# Query for relevant context
curl -X POST http://localhost:37778/rag/query \
  -H "Content-Type: application/json" \
  -d '{
    "query": "How did we implement authentication?",
    "project": "my-project",
    "limit": 10
  }'
```

Response:
```json
{
  "query": "How did we implement authentication?",
  "results": [
    {
      "id": 123,
      "type": "observation",
      "title": "Added JWT authentication",
      "content": "Implemented JWT-based auth...",
      "score": 0.89,
      "rank": 1,
      "source": "hot"
    }
  ],
  "total_results": 5,
  "hot_tier_hits": 3,
  "cold_tier_hits": 2,
  "sources_used": ["hot", "cold"]
}
```

### Cache Warming

```bash
# Warm cache on session start
curl -X POST http://localhost:37778/rag/warm \
  -H "Content-Type: application/json" \
  -d '{
    "project": "my-project",
    "files": ["src/auth.py", "src/api.py"],
    "concepts": ["authentication", "jwt"]
  }'
```

### Observations

```bash
# Store an observation
curl -X POST http://localhost:37778/observations \
  -H "Content-Type: application/json" \
  -d '{
    "memory_session_id": "session-123",
    "project": "my-project",
    "type": "decision",
    "title": "Added JWT authentication",
    "narrative": "Implemented JWT-based auth using PyJWT library..."
  }'

# Get recent observations
curl "http://localhost:37778/observations?project=my-project&limit=20"

# Get by ID
curl http://localhost:37778/observations/1

# Delete
curl -X DELETE http://localhost:37778/observations/1
```

### Session Summaries

```bash
# Store a summary
curl -X POST http://localhost:37778/summaries \
  -H "Content-Type: application/json" \
  -d '{
    "memory_session_id": "session-123",
    "project": "my-project",
    "request": "Implement user authentication",
    "learned": "JWT is better than sessions for stateless APIs",
    "completed": "Added login, logout, and token refresh endpoints"
  }'

# Get by session ID
curl http://localhost:37778/summaries/session/session-123
```

### Search

```bash
# Search by concepts
curl "http://localhost:37778/search/concepts?concepts=authentication,jwt&project=my-project"

# Search by files
curl "http://localhost:37778/search/files?files=src/auth.py,src/api.py&project=my-project"
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         USER PROMPT                                 │
└─────────────────────────┬───────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     RAG Query Router                                │
│  1. Generate embedding for user query (Ollama/local)               │
│  2. Query hot tier (Redis) - ~1-5ms                                │
│  3. If insufficient results, query cold tier (PostgreSQL)          │
│  4. Merge results with Reciprocal Rank Fusion (RRF)                │
└─────────────────────────┬───────────────────────────────────────────┘
                          │
          ┌───────────────┴───────────────┐
          ▼                               ▼
┌─────────────────────┐       ┌─────────────────────────────────────┐
│   HOT TIER (Redis)  │       │       COLD TIER (PostgreSQL)        │
│   ~1-5ms latency    │       │       ~100-200ms latency            │
├─────────────────────┤       ├─────────────────────────────────────┤
│ • Recent obs (48h)  │◄─────▶│ • All observations (20-day)         │
│ • RediSearch vector │ sync  │ • pgvector embeddings               │
│ • TTL expiration    │       │ • tsvector full-text search         │
│ • Session summaries │       │ • Weekly summaries                  │
└─────────────────────┘       │ • Project facts                     │
                              └─────────────────────────────────────┘
                                              │
                                              ▼
                              ┌─────────────────────────────────────┐
                              │     Background Workers              │
                              │  • Summarization (every 6h)         │
                              │  • Retention cleanup (daily)        │
                              └─────────────────────────────────────┘
```

## Project Structure

```
src/python/
├── .env.sample              # Sample configuration
├── docker-compose.yml       # PostgreSQL + Redis
├── Dockerfile               # Container deployment
├── pyproject.toml           # Python project config
├── requirements.txt         # Dependencies
├── README.md                # This file
│
└── claude_recall/
    ├── __init__.py
    ├── __main__.py          # CLI entry point
    ├── config.py            # Pydantic settings (loads .env)
    ├── models.py            # Data models
    │
    ├── api/
    │   ├── app.py           # FastAPI application
    │   └── routes.py        # REST endpoints
    │
    ├── embedding/
    │   └── service.py       # Ollama + local fallback
    │
    ├── storage/
    │   ├── cold/            # PostgreSQL tier
    │   │   ├── postgres_client.py
    │   │   ├── observation_store.py
    │   │   ├── summary_store.py
    │   │   └── hybrid_search.py
    │   │
    │   ├── hot/             # Redis tier
    │   │   ├── redis_client.py
    │   │   ├── observation_store.py
    │   │   └── vector_search.py
    │   │
    │   └── tiered/          # Coordination layer
    │       ├── manager.py       # Write-through caching
    │       ├── query_router.py  # Hot-first queries
    │       └── cache_warmer.py  # Session start warming
    │
    └── workers/
        ├── summarization.py # Hierarchical consolidation
        └── retention.py     # Data cleanup
```

## Docker Deployment

### Development (databases only)

```bash
# Start just PostgreSQL and Redis
docker compose up -d postgres redis

# Run Python app locally
python -m claude_recall --workers
```

### Production (full stack)

```bash
# Start everything including the Python service
docker compose --profile full up -d
```

### Custom Docker Build

```bash
# Build the image
docker build -t claude-recall-python .

# Run with environment variables
docker run -d \
  -p 37778:37778 \
  -e DATABASE_URL=postgres://user:pass@host:5432/db \
  -e REDIS_HOST=redis-host \
  -e OLLAMA_HOST=http://ollama-host:11434 \
  claude-recall-python
```

## Development

### Running Tests

```bash
# Install dev dependencies
pip install -e ".[dev]"

# Run tests
pytest

# With coverage
pytest --cov=claude_recall
```

### Type Checking

```bash
mypy claude_recall/
```

### Linting & Formatting

```bash
# Check
ruff check claude_recall/

# Fix
ruff check --fix claude_recall/

# Format
ruff format claude_recall/
```

## Integration with Claude Code

To use this as the backend for the Claude Code plugin, configure the hooks to call this API:

```javascript
// In your hook handler
const response = await fetch('http://localhost:37778/rag/query', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    query: userPrompt,
    project: workingDirectory,
  }),
});

const context = await response.json();
// Inject context.results into Claude's context
```

## Troubleshooting

### "Connection refused" errors

Make sure Docker containers are running:
```bash
docker compose ps
docker compose logs postgres
docker compose logs redis
```

### "Ollama not available" warnings

The service will fall back to local embeddings. To use Ollama:
```bash
# Check Ollama is running
curl http://localhost:11434/api/tags

# Pull the model
ollama pull nomic-embed-text
```

### Slow first query

The first query may be slow while:
- Redis indexes are being created
- Embedding model is being loaded

Subsequent queries will be faster.

### Reset everything

```bash
# Stop and remove containers + volumes
docker compose down -v

# Restart fresh
docker compose up -d postgres redis
```

## License

Same as claude-recall main project (AGPL-3.0).
