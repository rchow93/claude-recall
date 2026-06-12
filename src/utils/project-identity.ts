import path from 'path';
import { existsSync } from 'fs';
import { execSync } from 'child_process';
import { logger } from './logger.js';

const cache = new Map<string, string>();

function normalizeGitRemoteUrl(url: string): string | null {
  let normalized = url.trim();
  if (!normalized) return null;

  // SSH: git@github.com:org/repo.git → org/repo
  const sshMatch = normalized.match(/^git@[^:]+:(.+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1].toLowerCase();

  // HTTPS: https://github.com/org/repo.git → org/repo
  try {
    const parsed = new URL(normalized);
    let pathname = parsed.pathname;
    if (pathname.startsWith('/')) pathname = pathname.slice(1);
    if (pathname.endsWith('.git')) pathname = pathname.slice(0, -4);
    if (pathname.endsWith('/')) pathname = pathname.slice(0, -1);
    return pathname.toLowerCase() || null;
  } catch {
    return null;
  }
}

function findGitRoot(dir: string): string | null {
  let current = path.resolve(dir);
  const root = path.parse(current).root;

  while (current !== root) {
    if (existsSync(path.join(current, '.git'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/**
 * Resolve a canonical project ID for the given working directory.
 *
 * Resolution chain (first non-null wins):
 * 1. Git remote origin URL, normalized (e.g. "askqai/claude-recall")
 * 2. Absolute path (e.g. "/Users/me/Code/my-app")
 *
 * Results are cached per cwd for the lifetime of the process.
 */
export function resolveProjectId(cwd: string | null | undefined): string {
  if (!cwd || cwd.trim() === '') {
    return 'unknown-project';
  }

  const resolved = path.resolve(cwd);

  const cached = cache.get(resolved);
  if (cached) return cached;

  // Step 1: Check for git repo (filesystem check, no subprocess)
  const gitRoot = findGitRoot(resolved);

  if (gitRoot) {
    try {
      const remoteUrl = execSync('git remote get-url origin', {
        cwd: gitRoot,
        timeout: 3000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).toString();

      const normalized = normalizeGitRemoteUrl(remoteUrl);
      if (normalized) {
        cache.set(resolved, normalized);
        logger.debug('PROJECT_ID', 'Resolved via git remote', { cwd: resolved, projectId: normalized });
        return normalized;
      }
    } catch {
      // No remote configured, or git command failed — fall through
    }
  }

  // Step 2: Absolute path as canonical ID
  cache.set(resolved, resolved);
  logger.debug('PROJECT_ID', 'Resolved via absolute path', { cwd: resolved, projectId: resolved });
  return resolved;
}

export function clearProjectIdCache(): void {
  cache.clear();
}
