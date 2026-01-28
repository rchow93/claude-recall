#!/usr/bin/env node
/**
 * Build script for claude-recall
 *
 * Compiles TypeScript source to JavaScript bundles for:
 * - Worker service (plugin/scripts/worker-service.cjs)
 * - MCP server (plugin/scripts/mcp-server.cjs)
 * - Context generator (plugin/scripts/context-generator.cjs)
 */

import { build } from 'esbuild';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');

// Read package version for build-time injection
// CRITICAL: This version is compared against the installed plugin's package.json
// by the 'start' command. If they don't match, the worker is shut down and restarted
// on every hook invocation, causing observations to be lost.
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
    // Native modules that can't be bundled
    'better-sqlite3',
    'bun:sqlite',
    // Large dependencies that should be installed separately
    '@anthropic-ai/claude-agent-sdk',
  ],
};

async function buildWorkerService() {
  console.log('Building worker-service.cjs...');
  await build({
    ...commonOptions,
    entryPoints: [path.join(rootDir, 'src/services/worker-service.ts')],
    outfile: path.join(rootDir, 'plugin/scripts/worker-service.cjs'),
    define: {
      'process.env.NODE_ENV': '"production"',
      '__DEFAULT_PACKAGE_VERSION__': JSON.stringify(packageVersion),
    },
  });
  console.log('  ✓ worker-service.cjs');
}

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

async function buildContextGenerator() {
  console.log('Building context-generator.cjs...');
  await build({
    ...commonOptions,
    entryPoints: [path.join(rootDir, 'src/services/context-generator.ts')],
    outfile: path.join(rootDir, 'plugin/scripts/context-generator.cjs'),
  });
  console.log('  ✓ context-generator.cjs');
}

async function buildHookCommand() {
  console.log('Building hook-command (ESM)...');
  await build({
    ...commonOptions,
    format: 'esm',
    entryPoints: [path.join(rootDir, 'src/cli/hook-command.ts')],
    outfile: path.join(rootDir, 'plugin/scripts/hook-command.js'),
  });
  console.log('  ✓ hook-command.js');
}

async function buildTypeDeclarations() {
  console.log('Building type declarations...');
  try {
    execSync('npx tsc --emitDeclarationOnly --declaration --outDir dist', {
      cwd: rootDir,
      stdio: 'inherit',
    });
    console.log('  ✓ Type declarations');
  } catch (err) {
    console.log('  ⚠ Type declarations failed (non-fatal)');
  }
}

async function main() {
  console.log('');
  console.log('=================================');
  console.log('  claude-recall Build');
  console.log('=================================');
  console.log('');

  const startTime = Date.now();

  try {
    // Build all targets in parallel
    await Promise.all([
      buildWorkerService(),
      buildMCPServer(),
      buildContextGenerator(),
      buildHookCommand(),
    ]);

    // Type declarations (optional, can fail)
    await buildTypeDeclarations();

    const elapsed = Date.now() - startTime;
    console.log('');
    console.log(`Build complete in ${elapsed}ms`);
    console.log('');
  } catch (err) {
    console.error('Build failed:', err);
    process.exit(1);
  }
}

main();
