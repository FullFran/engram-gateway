import { existsSync, readFileSync, renameSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { RegisteredClient } from '../domain/client.js';
import type { CodeRecord, DeviceLoginRecord, RefreshTokenRecord, TokenRecord } from '../domain/token.js';
import { immediateTransaction } from '../../shared/sqlite-database.js';

/** The JSON auth store (`auth-store.json`, version 1) that the SQLite database replaces. */
interface JsonStoreData {
  version: 1;
  clients?: Record<string, RegisteredClient>;
  accessTokens?: Record<string, TokenRecord>;
  refreshTokens?: Record<string, RefreshTokenRecord>;
  families?: Record<string, { expiresAt: number; revokedAt?: number }>;
  codes?: Record<string, CodeRecord>;
  usedOnce?: Record<string, number>;
  deviceLogins?: Record<string, DeviceLoginRecord>;
}

export interface JsonImportCounts {
  clients: number;
  families: number;
  accessTokens: number;
  refreshTokens: number;
  codes: number;
  usedOnce: number;
  deviceLogins: number;
}

export type JsonImportResult =
  | { status: 'absent' }
  | { status: 'imported'; counts: JsonImportCounts; renamedTo: string }
  /** Imported on an earlier start; `renamedTo` is set when this start moved a leftover file aside. */
  | { status: 'already-imported'; renamedTo?: string }
  /** The database already holds auth state from elsewhere; the JSON file is left untouched. */
  | { status: 'skipped-not-empty' };

const IMPORT_KEY = 'json_token_store_import';
const AUTH_TABLES = ['clients', 'token_families', 'access_tokens', 'refresh_tokens', 'auth_codes', 'used_once', 'device_logins'];

function parse(path: string): JsonStoreData {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<JsonStoreData>;
  if (parsed.version !== 1) throw new Error(`Unsupported auth store version in ${path}`);
  return parsed as JsonStoreData;
}

/** Moves the file to `<path>.imported` (or a free `.imported.N`); never overwrites, never deletes. */
function moveAside(path: string): string {
  let target = `${path}.imported`;
  for (let n = 1; existsSync(target); n += 1) target = `${path}.imported.${n}`;
  renameSync(path, target);
  return target;
}

function insertAll(db: DatabaseSync, data: JsonStoreData): JsonImportCounts {
  const entries = <T>(map: Record<string, T> | undefined) => Object.entries(map ?? {});
  const client = db.prepare('INSERT INTO clients (client_id, record) VALUES (?, ?)');
  for (const [id, record] of entries(data.clients)) client.run(id, JSON.stringify(record));
  const family = db.prepare('INSERT INTO token_families (id, expires_at, revoked_at) VALUES (?, ?, ?)');
  for (const [id, record] of entries(data.families)) family.run(id, record.expiresAt, record.revokedAt ?? null);
  const access = db.prepare('INSERT INTO access_tokens (hash, client_id, login, scope, resource, expires_at, family_id) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const [hash, r] of entries(data.accessTokens)) access.run(hash, r.clientId, r.login, r.scope, r.resource, r.expiresAt, r.familyId);
  const refresh = db.prepare('INSERT INTO refresh_tokens (hash, client_id, login, scope, resource, expires_at, family_id, used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  for (const [hash, r] of entries(data.refreshTokens)) refresh.run(hash, r.clientId, r.login, r.scope, r.resource, r.expiresAt, r.familyId, r.usedAt ?? null);
  const code = db.prepare(
    `INSERT INTO auth_codes (hash, client_id, redirect_uri, code_challenge, scope, resource, login, expires_at, used, family_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const [hash, r] of entries(data.codes)) {
    code.run(hash, r.clientId, r.redirectUri, r.codeChallenge, r.scope, r.resource, r.login, r.expiresAt, r.used ? 1 : 0, r.familyId ?? null);
  }
  const once = db.prepare('INSERT INTO used_once (key, expires_at) VALUES (?, ?)');
  for (const [key, expiresAt] of entries(data.usedOnce)) once.run(key, expiresAt);
  const device = db.prepare('INSERT INTO device_logins (nonce, expires_at_ms, record) VALUES (?, ?, ?)');
  for (const [nonce, record] of entries(data.deviceLogins)) device.run(nonce, record.expiresAt, JSON.stringify(record));
  return {
    clients: entries(data.clients).length, families: entries(data.families).length,
    accessTokens: entries(data.accessTokens).length, refreshTokens: entries(data.refreshTokens).length,
    codes: entries(data.codes).length, usedOnce: entries(data.usedOnce).length, deviceLogins: entries(data.deviceLogins).length
  };
}

/**
 * One-time upgrade from the JSON auth store: when the database holds no auth
 * state yet and `jsonPath` exists, copies everything in one transaction
 * (records the import in `gateway_meta`), then renames the file to
 * `*.imported`. Idempotent across restarts and racing processes: the check
 * and the copy share a `BEGIN IMMEDIATE` transaction, and a later start only
 * renames a leftover file (a crash between commit and rename). The JSON file
 * is never deleted or changed (an existing `*.imported` is never overwritten); a database already in use is never
 * overwritten.
 */
export function importJsonTokenStore(db: DatabaseSync, jsonPath: string): JsonImportResult {
  if (!existsSync(jsonPath)) return { status: 'absent' };
  const outcome = immediateTransaction(db, (): 'already-imported' | 'skipped-not-empty' | JsonImportCounts => {
    if (db.prepare('SELECT 1 FROM gateway_meta WHERE key = ?').get(IMPORT_KEY)) return 'already-imported';
    if (AUTH_TABLES.some(table => db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get())) return 'skipped-not-empty';
    const counts = insertAll(db, parse(jsonPath));
    db.prepare('INSERT INTO gateway_meta (key, value) VALUES (?, ?)').run(IMPORT_KEY, JSON.stringify({ source: jsonPath, importedAt: new Date().toISOString(), counts }));
    return counts;
  });
  if (outcome === 'skipped-not-empty') return { status: 'skipped-not-empty' };
  // Rename under the write lock, so racing gateways move the file at most once.
  const renamedTo = immediateTransaction(db, () => {
    const record = JSON.parse(String(db.prepare('SELECT value FROM gateway_meta WHERE key = ?').get(IMPORT_KEY)!.value)) as { renamedTo?: string };
    // Once moved aside, a file at `jsonPath` was written after the import (an old gateway during the deploy): leave it.
    if (record.renamedTo || !existsSync(jsonPath)) return undefined;
    const target = moveAside(jsonPath);
    db.prepare('UPDATE gateway_meta SET value = ? WHERE key = ?').run(JSON.stringify({ ...record, renamedTo: target }), IMPORT_KEY);
    return target;
  });
  if (outcome === 'already-imported') return renamedTo ? { status: 'already-imported', renamedTo } : { status: 'already-imported' };
  return { status: 'imported', counts: outcome, renamedTo: renamedTo! };
}
