#!/usr/bin/env node
/**
 * Sync plugin to Claude marketplace directory
 *
 * Structure (matching thedotmack/claude-mem convention):
 *   ~/.claude/plugins/marketplaces/richardchow/
 *     .claude-plugin/marketplace.json   (marketplace metadata)
 *     package.json                       (needed by worker-service.cjs at marketplace root)
 *     plugin/                            (source: "./plugin" in marketplace.json)
 *       .claude-plugin/plugin.json
 *       hooks/hooks.json
 *       modes/code.json
 *       package.json
 *       scripts/
 *       ui/
 *
 * Also syncs to the plugin cache used by `claude plugin install`.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const rootDir = path.join(__dirname, '..');
const pluginDir = path.join(rootDir, 'plugin');
const homeDir = require('os').homedir();
const marketplaceDir = path.join(homeDir, '.claude', 'plugins', 'marketplaces', 'richardchow');
const pluginTargetDir = path.join(marketplaceDir, 'plugin');

// Read version from package.json
const pkgJson = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf-8'));
const version = pkgJson.version || '0.0.0';
const cacheDir = path.join(homeDir, '.claude', 'plugins', 'cache', 'richardchow', 'claude-recall-plugin', version);

console.log('');
console.log('=================================');
console.log('  Sync to Marketplace');
console.log('=================================');
console.log('');
console.log(`Source: ${pluginDir}`);
console.log(`Marketplace: ${marketplaceDir}`);
console.log(`Plugin target: ${pluginTargetDir}`);
console.log(`Cache target: ${cacheDir}`);
console.log('');

// Ensure directories exist
fs.mkdirSync(pluginTargetDir, { recursive: true });
fs.mkdirSync(cacheDir, { recursive: true });

// Plugin-level files
const pluginItems = [
  '.mcp.json',
  'hooks',
  'package.json',
  'scripts',
  'modes',
  'skills',
  'ui',
];

let synced = 0;

// 1. Sync marketplace metadata (.claude-plugin/ with marketplace.json)
console.log('Marketplace metadata:');
const claudePluginSrc = path.join(pluginDir, '.claude-plugin');
const claudePluginDest = path.join(marketplaceDir, '.claude-plugin');
if (fs.existsSync(claudePluginSrc)) {
  if (fs.existsSync(claudePluginDest)) {
    fs.rmSync(claudePluginDest, { recursive: true });
  }
  fs.cpSync(claudePluginSrc, claudePluginDest, { recursive: true });
  console.log('  ✓ .claude-plugin/');
  synced++;
}

// 2. Copy package.json to marketplace root (worker-service.cjs needs it there)
const pkgSrc = path.join(pluginDir, 'package.json');
if (fs.existsSync(pkgSrc)) {
  fs.copyFileSync(pkgSrc, path.join(marketplaceDir, 'package.json'));
  console.log('  ✓ package.json (marketplace root)');
}

// 3. Sync plugin files to marketplace/plugin/
console.log('Plugin files:');
for (const item of pluginItems) {
  const src = path.join(pluginDir, item);
  const dest = path.join(pluginTargetDir, item);

  if (!fs.existsSync(src)) {
    console.log(`  ⚠ Skipping ${item} (not found)`);
    continue;
  }

  const stat = fs.statSync(src);

  if (stat.isDirectory()) {
    if (fs.existsSync(dest)) {
      fs.rmSync(dest, { recursive: true });
    }
    fs.cpSync(src, dest, { recursive: true });
    console.log(`  ✓ ${item}/`);
  } else {
    fs.copyFileSync(src, dest);
    console.log(`  ✓ ${item}`);
  }

  synced++;
}

// Copy .claude-plugin/plugin.json to plugin subdirectory
const pluginMetaSrc = path.join(pluginDir, '.claude-plugin', 'plugin.json');
const pluginMetaDir = path.join(pluginTargetDir, '.claude-plugin');
if (fs.existsSync(pluginMetaSrc)) {
  fs.mkdirSync(pluginMetaDir, { recursive: true });
  fs.copyFileSync(pluginMetaSrc, path.join(pluginMetaDir, 'plugin.json'));
  console.log('  ✓ .claude-plugin/plugin.json');
  synced++;
}

// 4. Sync to cache (used by claude plugin install)
console.log('Cache:');
for (const item of pluginItems) {
  const src = path.join(pluginDir, item);
  const dest = path.join(cacheDir, item);

  if (!fs.existsSync(src)) continue;

  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    if (fs.existsSync(dest)) {
      fs.rmSync(dest, { recursive: true });
    }
    fs.cpSync(src, dest, { recursive: true });
  } else {
    fs.copyFileSync(src, dest);
  }
}
// Also copy plugin.json to cache
if (fs.existsSync(pluginMetaSrc)) {
  const cacheMetaDir = path.join(cacheDir, '.claude-plugin');
  fs.mkdirSync(cacheMetaDir, { recursive: true });
  fs.copyFileSync(pluginMetaSrc, path.join(cacheMetaDir, 'plugin.json'));
}
console.log('  ✓ Cache synced');

console.log('');
console.log(`Synced ${synced} items to marketplace`);
console.log('');
