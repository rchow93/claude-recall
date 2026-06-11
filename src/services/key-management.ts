import { randomBytes, pbkdf2Sync } from 'crypto';
import { readFileSync, writeFileSync, chmodSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir, hostname, userInfo } from 'os';
import { logger } from '../utils/logger.js';

const KEY_LENGTH = 32;
const KEY_FILENAME = '.encryption-key';
const PBKDF2_ITERATIONS = 600_000;

function getDataDir(): string {
  return process.env.CLAUDE_RECALL_DATA_DIR || join(homedir(), '.claude-recall');
}

function getKeyPath(): string {
  return join(getDataDir(), KEY_FILENAME);
}

function deriveMachineKey(): Buffer {
  const machineId = `${hostname()}:${userInfo().username}:claude-recall-encryption`;
  return pbkdf2Sync(machineId, 'claude-recall-salt-v1', PBKDF2_ITERATIONS, KEY_LENGTH, 'sha512');
}

function generateRandomKey(): Buffer {
  return randomBytes(KEY_LENGTH);
}

export function loadOrCreateKey(): Buffer {
  const envKey = process.env.CLAUDE_RECALL_ENCRYPTION_KEY;
  if (envKey) {
    const buf = Buffer.from(envKey, 'hex');
    if (buf.length !== KEY_LENGTH) {
      throw new Error(`CLAUDE_RECALL_ENCRYPTION_KEY must be ${KEY_LENGTH * 2} hex chars (${KEY_LENGTH} bytes)`);
    }
    return buf;
  }

  const keyPath = getKeyPath();
  if (existsSync(keyPath)) {
    try {
      const hex = readFileSync(keyPath, 'utf8').trim();
      const buf = Buffer.from(hex, 'hex');
      if (buf.length === KEY_LENGTH) return buf;
      logger.warn('ENCRYPTION', 'Key file has wrong length, regenerating');
    } catch {
      logger.warn('ENCRYPTION', 'Failed to read key file, regenerating');
    }
  }

  const key = generateRandomKey();
  try {
    writeFileSync(keyPath, key.toString('hex') + '\n', { mode: 0o600 });
    chmodSync(keyPath, 0o600);
    logger.info('ENCRYPTION', 'Generated new encryption key');
  } catch (err) {
    logger.warn('ENCRYPTION', 'Could not persist key file, deriving from machine identity', undefined, err as Error);
    return deriveMachineKey();
  }
  return key;
}

export function encryptionEnabled(): boolean {
  return (process.env.CLAUDE_RECALL_ENCRYPTION ?? 'on').toLowerCase() !== 'off';
}

let _cachedKey: Buffer | null = null;

export function getEncryptionKey(): Buffer {
  if (!_cachedKey) {
    _cachedKey = loadOrCreateKey();
  }
  return _cachedKey;
}

export function clearKeyCache(): void {
  _cachedKey = null;
}
