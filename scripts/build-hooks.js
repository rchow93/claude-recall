#!/usr/bin/env node
/**
 * Build script for claude-recall
 *
 * Compiles TypeScript source to JavaScript bundles for:
 * - Hook command (plugin/scripts/hook-command.js)
 * - MCP server (plugin/scripts/mcp-server.cjs)
 */

import { build } from 'esbuild';
import { readFileSync, existsSync, copyFileSync, readdirSync } from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');

const packageJson = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf-8'));
const packageVersion = packageJson.version;
console.log(`Package version: ${packageVersion}`);

// Common build options
const commonOptions = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: false,
  minify: false,
  external: [
    'better-sqlite3',
    'bun:sqlite',
  ],
};

async function buildMCPServer() {
  console.log('Building mcp-server.cjs...');
  await build({
    ...commonOptions,
    entryPoints: [path.join(rootDir, 'src/servers/mcp-server.ts')],
    outfile: path.join(rootDir, 'plugin/scripts/mcp-server.cjs'),
    banner: { js: '#!/usr/bin/env node' },
  });
  console.log('  ✓ mcp-server.cjs');
}

async function buildHookCommand() {
  console.log('Building hook-command.js (ESM)...');
  await build({
    ...commonOptions,
    format: 'esm',
    entryPoints: [path.join(rootDir, 'src/cli/hook-entry.ts')],
    outfile: path.join(rootDir, 'plugin/scripts/hook-command.js'),
  });
  console.log('  ✓ hook-command.js');
}

const BUILT_FILES = ['hook-command.js', 'mcp-server.cjs'];

function fileHash(filePath) {
  return createHash('md5').update(readFileSync(filePath)).digest('hex');
}

function findInstalledCopies() {
  const home = homedir();
  const locations = [];

  // Cache location: ~/.claude/plugins/cache/claude-recall/claude-recall/{version}/scripts/
  const cacheBase = path.join(home, '.claude/plugins/cache/claude-recall/claude-recall');
  if (existsSync(cacheBase)) {
    for (const version of readdirSync(cacheBase)) {
      const scriptsDir = path.join(cacheBase, version, 'scripts');
      if (existsSync(scriptsDir)) {
        locations.push({ label: `cache/${version}`, dir: scriptsDir });
      }
    }
  }

  // Marketplace location: ~/.claude/plugins/marketplaces/claude-recall/plugin/scripts/
  const marketDir = path.join(home, '.claude/plugins/marketplaces/claude-recall/plugin/scripts');
  if (existsSync(marketDir)) {
    locations.push({ label: 'marketplaces', dir: marketDir });
  }

  return locations;
}

function checkAndSyncInstalled(shouldSync) {
  const locations = findInstalledCopies();
  if (locations.length === 0) {
    console.log('No installed plugin copies found.');
    return;
  }

  const buildDir = path.join(rootDir, 'plugin/scripts');
  let staleCount = 0;
  let syncedCount = 0;

  for (const loc of locations) {
    for (const file of BUILT_FILES) {
      const builtPath = path.join(buildDir, file);
      const installedPath = path.join(loc.dir, file);

      if (!existsSync(installedPath)) continue;

      const builtHash = fileHash(builtPath);
      const installedHash = fileHash(installedPath);

      if (builtHash !== installedHash) {
        staleCount++;
        if (shouldSync) {
          copyFileSync(builtPath, installedPath);
          syncedCount++;
          console.log(`  \x1b[32m✓ synced\x1b[0m ${loc.label}/${file}`);
        } else {
          console.log(`  \x1b[33m⚠ stale\x1b[0m  ${loc.label}/${file}`);
        }
      } else {
        console.log(`  \x1b[90m✓ up-to-date\x1b[0m ${loc.label}/${file}`);
      }
    }
  }

  if (staleCount > 0 && !shouldSync) {
    console.log('');
    console.log(`\x1b[33m${staleCount} installed file(s) are stale. Run with --sync-installed to update.\x1b[0m`);
  } else if (syncedCount > 0) {
    console.log('');
    console.log(`\x1b[32m${syncedCount} file(s) synced to installed locations.\x1b[0m`);
  }
}

async function main() {
  const shouldSync = process.argv.includes('--sync-installed');

  console.log('');
  console.log('=================================');
  console.log('  claude-recall Build');
  console.log('=================================');
  console.log('');

  const startTime = Date.now();

  try {
    await Promise.all([
      buildMCPServer(),
      buildHookCommand(),
    ]);

    const elapsed = Date.now() - startTime;
    console.log('');
    console.log(`Build complete in ${elapsed}ms`);

    console.log('');
    console.log('Installed plugin check:');
    checkAndSyncInstalled(shouldSync);
    console.log('');
  } catch (err) {
    console.error('Build failed:', err);
    process.exit(1);
  }
}

main();
