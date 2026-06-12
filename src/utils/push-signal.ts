import { mkdirSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';

const PUSH_DIR = join(homedir(), '.claude-recall', 'push');

function ensurePushDir(): void {
  if (!existsSync(PUSH_DIR)) {
    mkdirSync(PUSH_DIR, { recursive: true });
  }
}

function safeFilename(projectId: string): string {
  return createHash('md5').update(projectId).digest('hex');
}

export function writeSignalFile(targetProjectId: string): void {
  ensurePushDir();
  const signalPath = join(PUSH_DIR, `${safeFilename(targetProjectId)}.signal`);
  writeFileSync(signalPath, String(Date.now()), 'utf-8');
}

export function consumeSignalFile(projectId: string): boolean {
  const signalPath = join(PUSH_DIR, `${safeFilename(projectId)}.signal`);
  if (existsSync(signalPath)) {
    try {
      unlinkSync(signalPath);
      return true;
    } catch {
      return false;
    }
  }
  const allSignal = join(PUSH_DIR, 'all.signal');
  if (existsSync(allSignal)) {
    try {
      unlinkSync(allSignal);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}
