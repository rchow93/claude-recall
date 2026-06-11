/**
 * Sidecar Manager — auto-detects and spawns claude-recall-pro binary.
 *
 * On SessionStart, checks for the compiled pro binary at ~/.claude-recall/bin/claude-recall-pro.
 * If found, spawns it as a detached background process and returns the dashboard URL.
 * Tracks state in ~/.claude-recall/pro.state to avoid duplicate spawns.
 *
 * Env vars:
 *   CLAUDE_RECALL_PRO_BINARY    — override binary path
 *   CLAUDE_RECALL_PRO_SIDECAR   — 'off' to disable auto-spawn
 *   CLAUDE_RECALL_UI_PORT       — override port (default 37778)
 */

import { spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { DATA_DIR } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';

const BIN_DIR = join(DATA_DIR, 'bin');
const STATE_FILE = join(DATA_DIR, 'pro.state');
const DEFAULT_PORT = 37778;
const BINARY_NAME = process.platform === 'win32' ? 'claude-recall-pro.exe' : 'claude-recall-pro';
const BINARY_PATH = process.env.CLAUDE_RECALL_PRO_BINARY || join(BIN_DIR, BINARY_NAME);

const HEALTH_TIMEOUT_MS = 2000;
const READY_WAIT_MS = 3000;
const READY_POLL_MS = 300;

export interface SidecarInfo {
  url: string;
  token: string;
  pid: number;
  port: number;
}

interface SidecarState {
  pid: number;
  port: number;
  token: string;
  startedAt: string;
}

function readState(): SidecarState | null {
  try {
    if (!existsSync(STATE_FILE)) return null;
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

function writeState(state: SidecarState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function clearState(): void {
  try { unlinkSync(STATE_FILE); } catch {}
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function isHealthy(port: number, token: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    const resp = await fetch(`http://127.0.0.1:${port}/api/health?token=${token}`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return resp.ok;
  } catch {
    return false;
  }
}

async function waitForReady(port: number, token: string): Promise<boolean> {
  const deadline = Date.now() + READY_WAIT_MS;
  while (Date.now() < deadline) {
    if (await isHealthy(port, token)) return true;
    await new Promise(r => setTimeout(r, READY_POLL_MS));
  }
  return false;
}

export async function ensureSidecarRunning(): Promise<SidecarInfo | null> {
  if ((process.env.CLAUDE_RECALL_PRO_SIDECAR ?? '').toLowerCase() === 'off') {
    return null;
  }

  if (!existsSync(BINARY_PATH)) {
    logger.debug('SIDECAR', 'Pro binary not found', { path: BINARY_PATH });
    return null;
  }

  const port = parseInt(process.env.CLAUDE_RECALL_UI_PORT || String(DEFAULT_PORT), 10);

  // Check existing state — reuse if still alive and healthy
  const state = readState();
  if (state && isProcessAlive(state.pid)) {
    if (await isHealthy(state.port, state.token)) {
      logger.debug('SIDECAR', 'Pro already running', { pid: state.pid, port: state.port });
      return {
        url: `http://127.0.0.1:${state.port}?token=${state.token}`,
        token: state.token,
        pid: state.pid,
        port: state.port,
      };
    }
    logger.debug('SIDECAR', 'Stale sidecar — PID alive but not healthy, respawning', { pid: state.pid });
  }

  // Spawn new instance
  const token = randomBytes(24).toString('hex');

  try {
    const child = spawn(BINARY_PATH, [], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        CLAUDE_RECALL_UI_TOKEN: token,
        CLAUDE_RECALL_UI_PORT: String(port),
      },
    });

    child.unref();

    const pid = child.pid;
    if (!pid) {
      logger.warn('SIDECAR', 'Failed to spawn pro binary — no PID');
      return null;
    }

    writeState({ pid, port, token, startedAt: new Date().toISOString() });

    const ready = await waitForReady(port, token);
    if (!ready) {
      logger.warn('SIDECAR', 'Pro binary spawned but not responding yet', { pid, port });
    }

    const url = `http://127.0.0.1:${port}?token=${token}`;
    logger.debug('SIDECAR', `Pro sidecar launched → ${url}`, { pid, port });

    return { url, token, pid, port };
  } catch (err) {
    logger.warn('SIDECAR', 'Failed to spawn pro binary', { error: String(err) });
    return null;
  }
}

export function stopSidecar(): void {
  const state = readState();
  if (!state) return;

  if (isProcessAlive(state.pid)) {
    try {
      process.kill(state.pid, 'SIGTERM');
      logger.debug('SIDECAR', 'Stopped pro sidecar', { pid: state.pid });
    } catch {
      logger.warn('SIDECAR', 'Failed to stop pro sidecar', { pid: state.pid });
    }
  }

  clearState();
}
