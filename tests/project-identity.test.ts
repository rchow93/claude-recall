import { describe, test, expect, beforeEach } from 'bun:test';
import { resolveProjectId, clearProjectIdCache } from '../src/utils/project-identity';
import path from 'path';

beforeEach(() => {
  clearProjectIdCache();
});

describe('resolveProjectId', () => {
  test('returns git remote for a git repo', () => {
    // This repo itself should resolve to its git remote
    const cwd = path.resolve(__dirname, '..');
    const id = resolveProjectId(cwd);
    expect(id).toContain('/');
    expect(id).toContain('claude-recall');
    expect(id).not.toContain('.git');
    expect(id).not.toContain('https://');
    expect(id).not.toContain('git@');
  });

  test('returns lowercase normalized path', () => {
    const cwd = path.resolve(__dirname, '..');
    const id = resolveProjectId(cwd);
    expect(id).toBe(id.toLowerCase());
  });

  test('returns absolute path for non-git directory', () => {
    const tmpDir = '/tmp';
    const id = resolveProjectId(tmpDir);
    // /tmp has no .git, so should return absolute path
    expect(id).toBe(path.resolve(tmpDir));
  });

  test('handles null/undefined/empty cwd', () => {
    expect(resolveProjectId(null)).toBe('unknown-project');
    expect(resolveProjectId(undefined)).toBe('unknown-project');
    expect(resolveProjectId('')).toBe('unknown-project');
    expect(resolveProjectId('  ')).toBe('unknown-project');
  });

  test('caches results per cwd', () => {
    const cwd = path.resolve(__dirname, '..');
    const first = resolveProjectId(cwd);
    const second = resolveProjectId(cwd);
    expect(first).toBe(second);
  });

  test('subdirectory resolves to same project as root', () => {
    const root = path.resolve(__dirname, '..');
    const sub = path.resolve(__dirname, '..', 'src');
    const rootId = resolveProjectId(root);
    const subId = resolveProjectId(sub);
    expect(rootId).toBe(subId);
  });

  test('clearProjectIdCache resets cache', () => {
    const cwd = path.resolve(__dirname, '..');
    resolveProjectId(cwd);
    clearProjectIdCache();
    // Should not throw — just re-resolves
    const id = resolveProjectId(cwd);
    expect(id).toContain('claude-recall');
  });
});
