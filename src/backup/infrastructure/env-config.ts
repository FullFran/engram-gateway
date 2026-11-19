import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { DailySchedule } from '../domain/snapshot.js';
import { BACKUP_KEY_BYTES } from './aes-gcm-cipher.js';

export type BackupConfig =
  | { enabled: false }
  | {
      enabled: true;
      /** Absolute directory of the snapshots. */
      dir: string;
      /** Snapshots kept per brain and for the gateway database. */
      retention: number;
      /** Daily run time (UTC), or `'off'` for on-demand runs only (`backup now`). */
      schedule: DailySchedule | 'off';
      /** Random delay added to each scheduled run. */
      jitterMs: number;
      key: Buffer;
      previousKeys: Buffer[];
    };

const DEFAULT_RETENTION = 14;
const DEFAULT_SCHEDULE: DailySchedule = { hour: 3, minute: 0 };
const DEFAULT_JITTER_SECONDS = 300;

/**
 * A 32-byte key written as base64 (`openssl rand -base64 32`) or 64 hex
 * characters. Errors name the file only, never its content.
 */
export function parseBackupKey(raw: string, source: string): Buffer {
  const value = raw.trim();
  let key: Buffer | undefined;
  if (/^[0-9a-fA-F]{64}$/.test(value)) key = Buffer.from(value, 'hex');
  else if (/^[A-Za-z0-9+/]+={0,2}$/.test(value)) key = Buffer.from(value, 'base64');
  if (!key || key.length !== BACKUP_KEY_BYTES) {
    throw new Error(`${source} must hold a ${BACKUP_KEY_BYTES}-byte key as base64 or 64 hex characters (generate one with \`openssl rand -base64 32\`)`);
  }
  return key;
}

function readKeyFile(name: string, path: string): Buffer {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`${name}: cannot read ${path} (${(error as NodeJS.ErrnoException).code ?? 'error'})`);
  }
  return parseBackupKey(raw, `${name} (${path})`);
}

function count(name: string, raw: string | undefined, fallback: number, min: number): number {
  const value = raw?.trim();
  if (!value) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < min) throw new Error(`${name} must be an integer >= ${min}, got ${JSON.stringify(value)}`);
  return Number(value);
}

function schedule(raw: string | undefined): DailySchedule | 'off' {
  const value = raw?.trim();
  if (!value) return DEFAULT_SCHEDULE;
  if (value.toLowerCase() === 'off') return 'off';
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw new Error(`BACKUP_SCHEDULE must be HH:MM (UTC) or off, got ${JSON.stringify(value)}`);
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/**
 * Backup settings from the environment. Backups are on when `BACKUP_DIR` is
 * set; then `BACKUP_KEY_FILE` must name a readable key, or startup fails.
 * - `BACKUP_DIR`: absolute directory of the snapshots (a local filesystem, not NFS).
 * - `BACKUP_KEY_FILE`: file holding the 32-byte encryption key.
 * - `BACKUP_PREVIOUS_KEY_FILES`: comma-separated older key files, to read snapshots taken before a rotation.
 * - `BACKUP_RETENTION`: snapshots kept per brain and for the gateway database (default 14).
 * - `BACKUP_SCHEDULE`: daily run time `HH:MM` in UTC (default `03:00`), or `off`.
 * - `BACKUP_JITTER`: up to this many seconds of random delay per run (default 300).
 */
export function resolveBackupConfig(env: Readonly<Record<string, string | undefined>>): BackupConfig {
  const dirRaw = env.BACKUP_DIR?.trim();
  if (!dirRaw) return { enabled: false };
  if (!isAbsolute(dirRaw)) throw new Error(`BACKUP_DIR must be an absolute path, got ${JSON.stringify(dirRaw)}`);
  const keyFile = env.BACKUP_KEY_FILE?.trim();
  if (!keyFile) throw new Error('BACKUP_DIR is set but BACKUP_KEY_FILE is not: backups are never written unencrypted. Set BACKUP_KEY_FILE to a file holding a key from `openssl rand -base64 32`.');
  const previous = (env.BACKUP_PREVIOUS_KEY_FILES ?? '').split(',').map(item => item.trim()).filter(Boolean);
  return {
    enabled: true,
    dir: resolve(dirRaw),
    retention: count('BACKUP_RETENTION', env.BACKUP_RETENTION, DEFAULT_RETENTION, 1),
    schedule: schedule(env.BACKUP_SCHEDULE),
    jitterMs: count('BACKUP_JITTER', env.BACKUP_JITTER, DEFAULT_JITTER_SECONDS, 0) * 1000,
    key: readKeyFile('BACKUP_KEY_FILE', keyFile),
    previousKeys: previous.map(path => readKeyFile('BACKUP_PREVIOUS_KEY_FILES', path))
  };
}
