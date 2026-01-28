#!/bin/bash
# bun-runner.sh - Resolves absolute path to bun, then execs it with arguments
# This ensures hooks work regardless of PATH inheritance from Claude Code

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# 1. Check cached path from smart-install
if [ -f "$PLUGIN_ROOT/.bun-path" ]; then
  BUN="$(cat "$PLUGIN_ROOT/.bun-path")"
  if [ -x "$BUN" ]; then
    exec "$BUN" "$@"
  fi
fi

# 2. Try PATH
if command -v bun >/dev/null 2>&1; then
  exec bun "$@"
fi

# 3. Common installation paths
for candidate in \
  "$HOME/.bun/bin/bun" \
  "/usr/local/bin/bun" \
  "/opt/homebrew/bin/bun" \
  "/home/linuxbrew/.linuxbrew/bin/bun"; do
  if [ -x "$candidate" ]; then
    exec "$candidate" "$@"
  fi
done

echo "ERROR: bun not found. Install it: curl -fsSL https://bun.sh/install | bash" >&2
exit 1
