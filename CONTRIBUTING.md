# Contributing to claude-recall

Thanks for considering a contribution! This guide covers the basics.

## Getting Started

```bash
git clone https://github.com/askqai/claude-recall.git
cd claude-recall
npm install
node scripts/build-hooks.js
```

**Prerequisites:** Node.js 18+, Bun 1.0+

## Development Workflow

1. Make changes in `src/`
2. Run `node scripts/build-hooks.js` to rebuild hooks and MCP server
3. Built artifacts land in `plugin/scripts/` (hook-command.js, mcp-server.cjs)
4. Test by using Claude Code with the hooks pointed at your local build

## Project Structure

```
src/
  cli/handlers/    # Hook handlers (context, observation, session-init, summarize, session-end)
  servers/         # MCP server with search/timeline/get_observations/forget tools
  services/        # SQLite database, migrations, consolidation
  shared/          # Settings, paths, constants
  utils/           # Privacy redaction, date parsing, logging
plugin/
  hooks/           # Hook definitions (hooks.json)
  scripts/         # Built artifacts (committed to git for zero-build install)
scripts/           # Build script, setup utilities
```

## Key Conventions

- **Single production dependency.** Don't add dependencies unless absolutely necessary.
- **No AI/LLM calls.** All compression and scoring is deterministic.
- **No background processes.** Hooks write directly to SQLite. MCP server is stdio-based.
- **Version in three places.** `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` must all match.
- **Built artifacts are committed.** Users install via the plugin marketplace and should never need to run a build step. Always rebuild before committing changes to `src/`.

## Submitting Changes

1. Fork the repo and create a feature branch
2. Make your changes and rebuild (`node scripts/build-hooks.js`)
3. Verify the built files in `plugin/scripts/` are updated
4. Open a pull request with a clear description of what changed and why

## Reporting Issues

Open an issue at [github.com/askqai/claude-recall/issues](https://github.com/askqai/claude-recall/issues) with:
- Claude Code version
- OS and architecture
- Steps to reproduce
- Relevant log output from `~/.claude-recall/logs/`

## License

By contributing, you agree that your contributions will be licensed under the Apache 2.0 License.
