#!/usr/bin/env node
/**
 * Storage Configuration CLI
 *
 * Manage claude-recall storage tiers from the command line.
 *
 * Usage:
 *   node scripts/storage-config.js                    # Show current config
 *   node scripts/storage-config.js set <mode>         # Set storage mode
 *   node scripts/storage-config.js connect            # Configure connections
 *   node scripts/storage-config.js connect --local    # Use local defaults
 *   node scripts/storage-config.js connect --remote   # Set remote host
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createInterface } from 'readline';

const SETTINGS_PATH = join(homedir(), '.claude-recall', 'settings.json');
const WORKER_URL = 'http://127.0.0.1:37777';

// ANSI colors
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  white: '\x1b[37m',
};

// ============================================================================
// STORAGE MODE DEFINITIONS
// ============================================================================

const MODES = {
  'sqlite-only': {
    name: 'sqlite-only',
    title: 'SQLite Only',
    description: 'Local SQLite database only. No network dependencies.',
    details: [
      'All data stored in ~/.claude-recall/claude-recall.db',
      'Works offline, no external services needed',
      'Data stays on this machine only',
      'Best for: Single machine, simple setup, privacy',
    ],
    requires: [],
  },
  'sqlite-primary': {
    name: 'sqlite-primary',
    title: 'SQLite Primary + Tiered Sync',
    description: 'SQLite writes first, then syncs to PostgreSQL/Redis.',
    details: [
      'Writes to SQLite immediately (fast, reliable)',
      'Background sync copies data to PostgreSQL (pgvector)',
      'Redis caches recent data for fast search',
      'If network fails, local data is safe',
      'Best for: Reliability, local-first with cloud backup',
    ],
    requires: ['DATABASE_URL', 'OLLAMA_HOST'],
    optional: ['REDIS_HOST'],
  },
  'tiered-primary': {
    name: 'tiered-primary',
    title: 'Tiered Primary (Cross-Machine)',
    description: 'PostgreSQL/Redis as primary storage, SQLite as fallback.',
    details: [
      'Writes to PostgreSQL (pgvector) first',
      'Redis caches hot data for fast retrieval',
      'SQLite only used if PostgreSQL is unreachable',
      'Multiple machines can share the same context',
      'Best for: Cross-machine sync, team sharing',
    ],
    requires: ['DATABASE_URL', 'REDIS_HOST', 'OLLAMA_HOST'],
  },
  'tiered-cold-only': {
    name: 'tiered-cold-only',
    title: 'PostgreSQL Only (No Redis)',
    description: 'PostgreSQL as primary, no Redis cache.',
    details: [
      'Writes directly to PostgreSQL (pgvector)',
      'No Redis cache layer (simpler setup)',
      'SQLite as fallback if PostgreSQL is down',
      'Slightly slower search than with Redis',
      'Best for: Simpler infra, don\'t want Redis',
    ],
    requires: ['DATABASE_URL', 'OLLAMA_HOST'],
  },
};

// ============================================================================
// HELPERS
// ============================================================================

function loadSettings() {
  if (!existsSync(SETTINGS_PATH)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function saveSettings(settings) {
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
}

async function fetchJson(endpoint) {
  try {
    const response = await fetch(`${WORKER_URL}${endpoint}`, {
      signal: AbortSignal.timeout(3000)
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Wait for user to press Enter, c, or q
 * Returns 'change-mode', 'configure', or null
 */
async function waitForAction() {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      resolve(null);
      return;
    }

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    const onKeypress = (key) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('data', onKeypress);

      if (key === '\r' || key === '\n') {
        resolve('change-mode');
      } else if (key === 'c' || key === 'C') {
        resolve('configure');
      } else if (key === '\u0003' || key === 'q' || key === 'Q') {
        console.log();
        resolve(null);
      } else {
        // Any other key - exit
        console.log();
        resolve(null);
      }
    };

    process.stdin.on('data', onKeypress);
  });
}

/**
 * Interactive connection configuration
 */
async function configureConnectionsInteractive(settings) {
  console.log(`\n${c.bold}${c.cyan}Configure Connections${c.reset}`);
  console.log(`${c.dim}1) Local Docker (localhost)${c.reset}`);
  console.log(`${c.dim}2) Remote server${c.reset}`);
  console.log(`${c.dim}q) Cancel${c.reset}\n`);

  const choice = await prompt(`${c.cyan}Select [1/2/q]:${c.reset} `);

  if (choice === '1') {
    await configureConnections('local');
  } else if (choice === '2') {
    await configureConnections('remote');
  } else {
    console.log(`${c.dim}Cancelled${c.reset}\n`);
  }
}

/**
 * Interactive mode selector using arrow keys
 * Returns the selected mode key or null if cancelled
 */
async function interactiveModeSelect(currentMode) {
  const modes = Object.keys(MODES);
  let selectedIndex = modes.indexOf(currentMode);
  if (selectedIndex === -1) selectedIndex = 0;

  // Hide cursor and enable raw mode
  process.stdout.write('\x1B[?25l'); // Hide cursor

  function render() {
    // Clear previous render (move up and clear)
    const totalLines = modes.length + 4;
    process.stdout.write(`\x1B[${totalLines}A`); // Move up
    process.stdout.write('\x1B[0J'); // Clear from cursor to end

    console.log(`\n${c.bold}${c.cyan}Select Storage Mode${c.reset} ${c.dim}(↑/↓ to navigate, Enter to select, q to cancel)${c.reset}\n`);

    for (let i = 0; i < modes.length; i++) {
      const key = modes[i];
      const m = MODES[key];
      const isSelected = i === selectedIndex;
      const isCurrent = key === currentMode;

      if (isSelected) {
        // Highlighted row
        console.log(`  ${c.cyan}▶${c.reset} ${c.bold}${c.white}${m.name.padEnd(18)}${c.reset} ${m.description}${isCurrent ? ` ${c.green}(current)${c.reset}` : ''}`);
      } else {
        // Normal row
        console.log(`    ${c.dim}${m.name.padEnd(18)}${c.reset} ${c.dim}${m.description}${isCurrent ? ` (current)` : ''}${c.reset}`);
      }
    }
    console.log();
  }

  // Initial render - add blank lines first so we have something to clear
  console.log('\n\n\n\n\n\n');
  render();

  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      // Not a TTY, can't do interactive selection
      process.stdout.write('\x1B[?25h'); // Show cursor
      resolve(null);
      return;
    }

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    const onKeypress = (key) => {
      if (key === '\u0003' || key === 'q' || key === 'Q') {
        // Ctrl+C or q - cancel
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onKeypress);
        process.stdout.write('\x1B[?25h'); // Show cursor
        console.log(`${c.dim}Cancelled${c.reset}\n`);
        resolve(null);
        return;
      }

      if (key === '\r' || key === '\n') {
        // Enter - select
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onKeypress);
        process.stdout.write('\x1B[?25h'); // Show cursor
        resolve(modes[selectedIndex]);
        return;
      }

      if (key === '\u001B[A' || key === 'k') {
        // Up arrow or k
        selectedIndex = (selectedIndex - 1 + modes.length) % modes.length;
        render();
      } else if (key === '\u001B[B' || key === 'j') {
        // Down arrow or j
        selectedIndex = (selectedIndex + 1) % modes.length;
        render();
      }
    };

    process.stdin.on('data', onKeypress);
  });
}

function printHeader(text) {
  console.log(`\n${c.bold}${c.cyan}${text}${c.reset}`);
  console.log('─'.repeat(60));
}

function printSubHeader(text) {
  console.log(`\n  ${c.bold}${text}${c.reset}`);
}

function printRow(label, value, color = c.reset) {
  console.log(`  ${c.dim}${label.padEnd(24)}${c.reset}${color}${value}${c.reset}`);
}

function formatNumber(n) {
  return n.toLocaleString();
}

function formatTime(epochMs) {
  if (!epochMs) return 'never';
  const date = new Date(epochMs);
  const now = Date.now();
  const diffMs = now - epochMs;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

// ============================================================================
// COMMANDS
// ============================================================================

async function showStatus() {
  const settings = loadSettings();
  const storageDetails = await fetchJson('/api/storage/details');
  const workerStats = await fetchJson('/api/stats');

  // Determine current mode from settings
  const hasDatabase = !!settings.DATABASE_URL;
  const hasRedis = !!settings.REDIS_HOST;
  const hasOllama = !!settings.OLLAMA_HOST;
  const configuredMode = settings.CLAUDE_RECALL_STORAGE_MODE || 'sqlite-primary';

  let effectiveMode = 'sqlite-only';
  if (hasDatabase && hasOllama) {
    if (configuredMode === 'tiered-primary' && hasRedis) {
      effectiveMode = 'tiered-primary';
    } else if (configuredMode === 'tiered-primary' && !hasRedis) {
      effectiveMode = 'tiered-cold-only';
    } else {
      effectiveMode = 'sqlite-primary';
    }
  }

  const mode = MODES[effectiveMode];

  // Header with current mode
  printHeader('Storage Configuration');
  console.log(`\n  ${c.bold}${c.green}▶ ${mode.title}${c.reset}`);
  console.log(`  ${c.dim}${mode.description}${c.reset}`);

  // Connection status
  printHeader('Connections');

  // PostgreSQL
  if (hasDatabase) {
    try {
      const url = new URL(settings.DATABASE_URL);
      const status = storageDetails?.postgres?.connected ? `${c.green}●${c.reset}` : `${c.red}●${c.reset}`;
      printRow('PostgreSQL:', `${status} ${url.host}${url.pathname}`,
        storageDetails?.postgres?.connected ? c.green : c.yellow);
    } catch {
      printRow('PostgreSQL:', '● configured', c.green);
    }
  } else {
    printRow('PostgreSQL:', `${c.dim}○${c.reset} not configured`, c.dim);
  }

  // Redis
  if (hasRedis) {
    const status = storageDetails?.redis?.connected ? `${c.green}●${c.reset}` : `${c.red}●${c.reset}`;
    printRow('Redis:', `${status} ${settings.REDIS_HOST}:${settings.REDIS_PORT || 6379}`,
      storageDetails?.redis?.connected ? c.green : c.yellow);
  } else {
    printRow('Redis:', `${c.dim}○${c.reset} not configured`, c.dim);
  }

  // Ollama
  if (hasOllama) {
    const status = storageDetails?.ollama?.connected ? `${c.green}●${c.reset}` : `${c.red}●${c.reset}`;
    const modelStatus = storageDetails?.ollama?.modelAvailable ? '✓' : '?';
    printRow('Ollama:', `${status} ${settings.OLLAMA_HOST} [${modelStatus} ${storageDetails?.ollama?.embeddingModel || 'nomic-embed-text'}]`,
      storageDetails?.ollama?.connected ? c.green : c.yellow);
  } else {
    printRow('Ollama:', `${c.dim}○${c.reset} not configured`, c.dim);
  }

  // Data counts per tier
  if (storageDetails) {
    printHeader('Data Counts');

    printSubHeader('SQLite (Local)');
    printRow('Observations:', formatNumber(storageDetails.sqlite?.observations || 0));
    printRow('Sessions:', formatNumber(storageDetails.sqlite?.sessions || 0));
    printRow('Summaries:', formatNumber(storageDetails.sqlite?.summaries || 0));

    if (storageDetails.postgres?.connected) {
      printSubHeader('PostgreSQL (pgvector)');
      printRow('Observations:', formatNumber(storageDetails.postgres?.observations || 0));
      printRow('Summaries:', formatNumber(storageDetails.postgres?.summaries || 0));
    }

    if (storageDetails.redis?.connected) {
      printSubHeader('Redis (Hot Cache)');
      printRow('Cached observations:', formatNumber(storageDetails.redis?.cachedObservations || 0));
      printRow('TTL:', `${storageDetails.redis?.ttlHours || 48} hours`);
    }

    // Projects breakdown
    const projects = storageDetails.sqlite?.projects || [];
    if (projects.length > 0) {
      printHeader('Projects');
      console.log();
      console.log(`  ${c.dim}${'Project'.padEnd(30)} ${'Observations'.padStart(12)} ${'Last Activity'.padStart(14)}${c.reset}`);
      console.log(`  ${'─'.repeat(56)}`);

      for (const p of projects.slice(0, 10)) {
        const lastActivity = formatTime(p.last_activity);
        console.log(`  ${c.white}${p.project.padEnd(30)}${c.reset} ${c.cyan}${formatNumber(p.observations).padStart(12)}${c.reset} ${c.dim}${lastActivity.padStart(14)}${c.reset}`);
      }

      if (projects.length > 10) {
        console.log(`  ${c.dim}... and ${projects.length - 10} more projects${c.reset}`);
      }
    }

    // Active sessions
    const activeSessions = storageDetails.activeSessions || [];
    if (activeSessions.length > 0) {
      printHeader('Active Sessions');
      console.log();
      for (const s of activeSessions) {
        console.log(`  ${c.green}●${c.reset} ${c.bold}${s.project}${c.reset}`);
        console.log(`    ${c.dim}Session #${s.sessionId} • ${s.promptCount} prompts${c.reset}`);
      }
    }
  } else {
    printHeader('Worker Status');
    console.log(`  ${c.yellow}Worker not running or unreachable${c.reset}`);
    console.log(`  ${c.dim}Start a Claude Code session to start the worker${c.reset}`);
  }

  // Prompt to change mode
  console.log(`\n${c.dim}Press ${c.cyan}Enter${c.dim} to change storage mode, ${c.cyan}c${c.dim} to configure connections, or ${c.cyan}q${c.dim} to exit${c.reset}`);

  // Wait for user input
  if (process.stdin.isTTY) {
    const action = await waitForAction();
    if (action === 'change-mode') {
      const selected = await interactiveModeSelect(effectiveMode);
      if (selected && selected !== effectiveMode) {
        await setMode(selected);
      }
    } else if (action === 'configure') {
      await configureConnectionsInteractive(settings);
    }
  }
}

async function setMode(mode) {
  if (!MODES[mode]) {
    console.error(`${c.red}Error: Unknown mode '${mode}'${c.reset}`);
    console.error(`Valid modes: ${Object.keys(MODES).join(', ')}`);
    process.exit(1);
  }

  const settings = loadSettings();
  const m = MODES[mode];

  // Check requirements
  const missing = [];
  for (const req of m.requires || []) {
    if (!settings[req]) {
      missing.push(req);
    }
  }

  if (missing.length > 0) {
    console.error(`${c.red}Error: ${mode} requires: ${missing.join(', ')}${c.reset}`);
    console.error(`${c.dim}Run 'npm run storage:connect' to configure connections first${c.reset}`);
    process.exit(1);
  }

  // Apply mode
  if (mode === 'sqlite-only') {
    delete settings.CLAUDE_RECALL_STORAGE_MODE;
    delete settings.DATABASE_URL;
    delete settings.REDIS_HOST;
    delete settings.REDIS_PORT;
    delete settings.OLLAMA_HOST;
  } else if (mode === 'sqlite-primary') {
    settings.CLAUDE_RECALL_STORAGE_MODE = 'sqlite-primary';
  } else if (mode === 'tiered-primary') {
    settings.CLAUDE_RECALL_STORAGE_MODE = 'tiered-primary';
  } else if (mode === 'tiered-cold-only') {
    settings.CLAUDE_RECALL_STORAGE_MODE = 'tiered-primary';
    delete settings.REDIS_HOST;
    delete settings.REDIS_PORT;
  }

  saveSettings(settings);

  console.log(`\n${c.green}✓ Storage mode set to: ${c.bold}${m.title}${c.reset}`);
  console.log(`  ${c.dim}${m.description}${c.reset}\n`);

  console.log(`${c.yellow}⚠ Restart the worker for changes to take effect:${c.reset}`);
  console.log(`  ${c.dim}curl -X POST http://127.0.0.1:37777/api/admin/shutdown${c.reset}`);
  console.log(`  ${c.dim}(Worker auto-restarts on next Claude Code action)${c.reset}\n`);
}

async function configureConnections(preset) {
  const settings = loadSettings();

  console.log(`\n${c.bold}${c.cyan}Configure Storage Connections${c.reset}\n`);

  if (preset === 'local') {
    // Local Docker defaults
    settings.DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/claude_recall';
    settings.REDIS_HOST = 'localhost';
    settings.REDIS_PORT = '6379';
    settings.OLLAMA_HOST = 'http://localhost:11434';

    saveSettings(settings);
    console.log(`${c.green}✓ Configured for local Docker:${c.reset}`);
    printRow('PostgreSQL:', 'localhost:5432/claude_recall');
    printRow('Redis:', 'localhost:6379');
    printRow('Ollama:', 'http://localhost:11434');
    console.log(`\n${c.dim}Make sure Docker containers are running:${c.reset}`);
    console.log(`  ${c.dim}docker compose -f docker-compose.tiered.yml up -d${c.reset}\n`);
    return;
  }

  if (preset === 'remote') {
    // Interactive remote setup
    console.log(`${c.dim}Enter connection details (press Enter for defaults):${c.reset}\n`);

    const currentDbUrl = settings.DATABASE_URL || '';
    const currentRedisHost = settings.REDIS_HOST || '';
    const currentRedisPort = settings.REDIS_PORT || '6379';
    const currentOllamaHost = settings.OLLAMA_HOST || 'http://localhost:11434';

    // PostgreSQL
    console.log(`${c.cyan}PostgreSQL (pgvector)${c.reset}`);
    const dbHost = await prompt(`  Host [${currentDbUrl ? 'keep current' : 'localhost'}]: `);
    if (dbHost) {
      const dbPort = await prompt(`  Port [5432]: `) || '5432';
      const dbUser = await prompt(`  User [postgres]: `) || 'postgres';
      const dbPass = await prompt(`  Password [postgres]: `) || 'postgres';
      const dbName = await prompt(`  Database [claude_recall]: `) || 'claude_recall';
      settings.DATABASE_URL = `postgres://${dbUser}:${dbPass}@${dbHost}:${dbPort}/${dbName}`;
    } else if (!currentDbUrl) {
      settings.DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/claude_recall';
    }

    // Redis
    console.log(`\n${c.cyan}Redis${c.reset}`);
    const redisHost = await prompt(`  Host [${currentRedisHost || 'localhost'}]: `);
    if (redisHost) {
      settings.REDIS_HOST = redisHost;
      const redisPort = await prompt(`  Port [${currentRedisPort}]: `);
      if (redisPort) settings.REDIS_PORT = redisPort;
    } else if (!currentRedisHost) {
      settings.REDIS_HOST = 'localhost';
      settings.REDIS_PORT = '6379';
    }

    // Ollama
    console.log(`\n${c.cyan}Ollama (embeddings)${c.reset}`);
    const ollamaHost = await prompt(`  URL [${currentOllamaHost}]: `);
    if (ollamaHost) {
      settings.OLLAMA_HOST = ollamaHost;
    } else if (!currentOllamaHost) {
      settings.OLLAMA_HOST = 'http://localhost:11434';
    }

    saveSettings(settings);
    console.log(`\n${c.green}✓ Connections configured${c.reset}\n`);
    return;
  }

  // Show menu
  console.log(`${c.dim}Choose a preset:${c.reset}\n`);
  console.log(`  ${c.cyan}npm run storage:connect local${c.reset}`);
  console.log(`    PostgreSQL: localhost:5432`);
  console.log(`    Redis: localhost:6379`);
  console.log(`    Ollama: localhost:11434`);
  console.log();
  console.log(`  ${c.cyan}npm run storage:connect remote${c.reset}`);
  console.log(`    Interactive setup for remote servers`);
  console.log(`    Enables cross-machine context sharing`);
  console.log();
}

function printHelp() {
  console.log(`
${c.bold}Claude-Recall Storage Configuration${c.reset}

${c.cyan}Usage:${c.reset}
  npm run storage                   Interactive dashboard (view & change settings)
  npm run storage:set <mode>        Set storage mode directly
  npm run storage:connect local     Configure for local Docker
  npm run storage:connect remote    Configure for remote server

${c.cyan}Interactive Dashboard:${c.reset}
  Run ${c.bold}npm run storage${c.reset} to see current config. From there:
    ${c.cyan}Enter${c.reset}  Select storage mode (arrow keys)
    ${c.cyan}c${c.reset}      Configure connections
    ${c.cyan}q${c.reset}      Exit

${c.cyan}Storage Modes:${c.reset}

  ${c.bold}sqlite-only${c.reset}
    Local SQLite database only. No network needed.

  ${c.bold}sqlite-primary${c.reset}
    SQLite writes first, then syncs to PostgreSQL/Redis.
    If network fails, local data is safe.

  ${c.bold}tiered-primary${c.reset}
    PostgreSQL + Redis as primary storage.
    ${c.green}Enables cross-machine context sharing.${c.reset}

  ${c.bold}tiered-cold-only${c.reset}
    PostgreSQL only (no Redis cache).

${c.cyan}Quick Start:${c.reset}

  # Run the interactive dashboard
  npm run storage

  # Or use direct commands:
  docker compose -f docker-compose.tiered.yml up -d
  npm run storage:connect local
  npm run storage:set tiered-primary
`);
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'status';

  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
  } else if (command === 'status' || !command) {
    await showStatus();
  } else if (command === 'set') {
    const mode = args[1];
    if (!mode) {
      // Interactive mode selection
      const settings = loadSettings();
      const currentMode = settings.CLAUDE_RECALL_STORAGE_MODE || 'sqlite-only';
      const selected = await interactiveModeSelect(currentMode);
      if (selected) {
        await setMode(selected);
      }
    } else {
      await setMode(mode);
    }
  } else if (command === 'connect') {
    await configureConnections(args[1]);
  } else {
    console.error(`${c.red}Unknown command: ${command}${c.reset}`);
    printHelp();
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`${c.red}Error: ${err.message}${c.reset}`);
  process.exit(1);
});
