#!/usr/bin/env bash
# Idempotently append claude-recall usage instructions to ~/.claude/CLAUDE.md
# Safe to run multiple times — uses a marker to detect existing injection.

set -euo pipefail

CLAUDE_MD="${HOME}/.claude/CLAUDE.md"
MARKER="<!-- claude-recall-instructions -->"

if [ -f "$CLAUDE_MD" ] && grep -qF "$MARKER" "$CLAUDE_MD" 2>/dev/null; then
  echo "✓ claude-recall instructions already present in $CLAUDE_MD"
  exit 0
fi

mkdir -p "$(dirname "$CLAUDE_MD")"

cat >> "$CLAUDE_MD" << 'INJECT_EOF'

<!-- claude-recall-instructions -->
## Claude-Recall (Persistent Memory)

You have access to claude-recall MCP tools for searching past conversation history across all projects and sessions.

### 3-Layer Search Workflow (ALWAYS follow this pattern)
1. **search(query)** → Returns a compact index with observation IDs (~50-100 tokens per result). This is NOT the full content — it's an index for filtering.
2. **timeline(anchor=ID)** → Get chronological context around an interesting result (±3 hours).
3. **get_observations(ids=[...])** → Fetch full details (tool inputs, outputs, assistant responses) ONLY for the IDs you actually need (~500-1000 tokens each).

**Why this matters:** Skipping to get_observations without filtering first wastes 10x the tokens. The search results are IDs, not content — always drill down.

### ID Prefixes
- `R:` = raw observations (recent, full fidelity)
- `L:` = legacy observations (older format)
- `C:` = consolidated sessions (compressed summaries of old sessions)

### Search Features
- **Date filtering**: `since="3 days ago"`, `until="yesterday"`, ISO dates, epoch seconds
- **Cross-project**: `cross_project=true` to search all repos
- **Project filter**: `project="my-app"` to narrow scope
- **Privacy**: User prompts tagged with `<private>` or `<no-recall>` are not stored
- **Forget**: `forget(query="...", confirm=true)` to delete specific memories

### What's Stored
- Full user prompts (verbatim, FTS5-searchable)
- Full assistant responses (up to 10K chars each)
- All tool calls with inputs and outputs
- Session metadata and timestamps
<!-- end-claude-recall-instructions -->
INJECT_EOF

echo "✓ claude-recall instructions injected into $CLAUDE_MD"
