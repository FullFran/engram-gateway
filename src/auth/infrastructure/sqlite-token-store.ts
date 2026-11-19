import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type { RegisteredClient } from '../domain/client.js';
import type { CodeRecord, DeviceLoginRecord, RefreshTokenRecord, TokenRecord } from '../domain/token.js';
import type { Clock, RandomSource, TokenStore } from '../application/ports.js';
import { cryptoRandom, systemClock } from './node-crypto.js';
import { openGatewayDatabase } from '../../shared/gateway-database.js';
import { immediateTransaction } from '../../shared/sqlite-database.js';

/** Used codes are kept a little longer so a replay is still recognised. */
const USED_CODE_GRACE_SECONDS = 600;
/** A family revoked before it was created (a replay won the race) is remembered this long. */
const REVOKED_FAMILY_TOMBSTONE_SECONDS = 86_400;

type Row = Record<string, SQLOutputValue>;

function tokenRecord(row: Row): TokenRecord {
  return {
    clientId: String(row.client_id), login: String(row.login), scope: String(row.scope), resource: String(row.resource),
    expiresAt: Number(row.expires_at), familyId: String(row.family_id),
    ...(row.connection_id !== null && row.connection_id !== undefined ? { connectionId: Number(row.connection_id) } : {})
  };
}

function refreshRecord(row: Row): RefreshTokenRecord {
  return row.used_at === null ? tokenRecord(row) : { ...tokenRecord(row), usedAt: Number(row.used_at) };
}

function codeRecord(row: Row): CodeRecord {
  const record: CodeRecord = {
    clientId: String(row.client_id), redirectUri: String(row.redirect_uri), codeChallenge: String(row.code_challenge),
    scope: String(row.scope), resource: String(row.resource), login: String(row.login), expiresAt: Number(row.expires_at),
    used: Number(row.used) === 1
  };
  if (row.family_id !== null) record.familyId = String(row.family_id);
  if (row.connection_id !== null && row.connection_id !== undefined) record.connectionId = Number(row.connection_id);
  return record;
}

/**
 * Auth state in the gateway SQLite database. Keys of the token and code
 * tables are SHA-256 hashes; raw tokens, codes and client secrets are never
 * written.
 *
 * Several gateways may share the file (two containers during a blue-green
 * deploy): WAL lets readers run alongside a writer, and every change runs in
 * a `BEGIN IMMEDIATE` transaction, so single-use decisions (codes, refresh
 * tokens, tickets) are exact across processes. Expired rows are pruned at the
 * start of each write, as the JSON store did.
 */
export class SqliteTokenStore implements TokenStore {
  /** Opens (and migrates) the database at `path`; for callers that do not share the connection. */
  static open(path: string, clock: Clock = systemClock, random: RandomSource = cryptoRandom): SqliteTokenStore {
    return new SqliteTokenStore(openGatewayDatabase(path), clock, random);
  }

  constructor(private readonly db: DatabaseSync, private readonly clock: Clock = systemClock, private readonly random: RandomSource = cryptoRandom) {}

  private now(): number {
    return Math.floor(this.clock.nowMs() / 1000);
  }

  private get(sql: string, ...params: (string | number)[]): Row | undefined {
    return this.db.prepare(sql).get(...params);
  }

  private run(sql: string, ...params: (string | number | null)[]): number {
    return Number(this.db.prepare(sql).run(...params).changes);
  }

  /** Runs `change` in a write transaction, after pruning expired rows. */
  private transact<T>(change: () => T): T {
    return immediateTransaction(this.db, () => {
      this.prune();
      return change();
    });
  }

  private prune(): void {
    const now = this.now();
    this.run('DELETE FROM access_tokens WHERE expires_at <= ?', now);
    this.run('DELETE FROM refresh_tokens WHERE expires_at <= ?', now);
    this.run('DELETE FROM token_families WHERE expires_at <= ?', now);
    this.run('DELETE FROM auth_codes WHERE expires_at + ? <= ?', USED_CODE_GRACE_SECONDS, now);
    this.run('DELETE FROM used_once WHERE expires_at <= ?', now);
    this.run('DELETE FROM device_logins WHERE expires_at_ms <= ?', this.clock.nowMs());
  }

  clientCount(): number {
    return Number(this.get('SELECT count(*) AS n FROM clients')!.n);
  }

  getClient(clientId: string): RegisteredClient | undefined {
    const row = this.get('SELECT record FROM clients WHERE client_id = ?', clientId);
    return row ? JSON.parse(String(row.record)) as RegisteredClient : undefined;
  }

  addClient(client: RegisteredClient): void {
    this.transact(() => this.run('INSERT OR REPLACE INTO clients (client_id, record) VALUES (?, ?)', client.clientId, JSON.stringify(client)));
  }

  createFamily(expiresAt: number, id: string = this.random.token(16)): string {
    // A family revoked before it existed (a replay won the race) stays revoked.
    this.transact(() => this.run(
      'INSERT INTO token_families (id, expires_at) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET expires_at = max(expires_at, excluded.expires_at)',
      id, expiresAt
    ));
    return id;
  }

  isFamilyActive(familyId: string): boolean {
    return this.get('SELECT 1 FROM token_families WHERE id = ? AND revoked_at IS NULL AND expires_at > ?', familyId, this.now()) !== undefined;
  }

  extendFamily(familyId: string, expiresAt: number): void {
    this.transact(() => this.run('UPDATE token_families SET expires_at = max(expires_at, ?) WHERE id = ?', expiresAt, familyId));
  }

  revokeFamily(familyId: string): void {
    this.transact(() => {
      const now = this.now();
      this.run(
        'INSERT INTO token_families (id, expires_at, revoked_at) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET revoked_at = excluded.revoked_at',
        familyId, now + REVOKED_FAMILY_TOMBSTONE_SECONDS, now
      );
      this.run('DELETE FROM access_tokens WHERE family_id = ?', familyId);
      this.run('UPDATE refresh_tokens SET used_at = ? WHERE family_id = ? AND used_at IS NULL', now, familyId);
    });
  }

  putTokens(access: { hash: string; record: TokenRecord }, refresh: { hash: string; record: RefreshTokenRecord }): void {
    this.transact(() => {
      const a = access.record;
      this.run(
        'INSERT OR REPLACE INTO access_tokens (hash, client_id, login, scope, resource, expires_at, family_id, connection_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        access.hash, a.clientId, a.login, a.scope, a.resource, a.expiresAt, a.familyId, a.connectionId ?? null
      );
      const r = refresh.record;
      this.run(
        'INSERT OR REPLACE INTO refresh_tokens (hash, client_id, login, scope, resource, expires_at, family_id, used_at, connection_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        refresh.hash, r.clientId, r.login, r.scope, r.resource, r.expiresAt, r.familyId, r.usedAt ?? null, r.connectionId ?? null
      );
    });
  }

  getAccessToken(hash: string): TokenRecord | undefined {
    const row = this.get('SELECT * FROM access_tokens WHERE hash = ? AND expires_at > ?', hash, this.now());
    if (!row) return undefined;
    const record = tokenRecord(row);
    return this.isFamilyActive(record.familyId) ? record : undefined;
  }

  getRefreshToken(hash: string): RefreshTokenRecord | undefined {
    const row = this.get('SELECT * FROM refresh_tokens WHERE hash = ? AND expires_at > ?', hash, this.now());
    return row ? refreshRecord(row) : undefined;
  }

  markRefreshTokenUsed(hash: string): boolean {
    return this.transact(() => this.run('UPDATE refresh_tokens SET used_at = ? WHERE hash = ? AND used_at IS NULL', this.now(), hash) === 1);
  }

  putCode(hash: string, record: CodeRecord): void {
    this.transact(() => this.run(
      `INSERT OR REPLACE INTO auth_codes (hash, client_id, redirect_uri, code_challenge, scope, resource, login, expires_at, used, family_id, connection_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      hash, record.clientId, record.redirectUri, record.codeChallenge, record.scope, record.resource, record.login,
      record.expiresAt, record.used ? 1 : 0, record.familyId ?? null, record.connectionId ?? null
    ));
  }

  useCode(hash: string, clientId: string): CodeRecord | undefined {
    return this.transact(() => {
      const row = this.get('SELECT * FROM auth_codes WHERE hash = ?', hash);
      if (!row) return undefined;
      const before = codeRecord(row);
      if (before.clientId !== clientId) return undefined;
      if (!before.used) {
        // The family is fixed when the code burns, so a replay on another
        // gateway can revoke it even before its tokens exist.
        before.familyId = this.random.token(16);
        this.run('UPDATE auth_codes SET used = 1, family_id = ? WHERE hash = ?', before.familyId, hash);
      }
      return before;
    });
  }

  claimOnce(key: string, expiresAt: number): boolean {
    return this.transact(() => this.run('INSERT INTO used_once (key, expires_at) VALUES (?, ?) ON CONFLICT (key) DO NOTHING', key, expiresAt) === 1);
  }

  deviceLoginCount(): number {
    return Number(this.get('SELECT count(*) AS n FROM device_logins WHERE expires_at_ms > ?', this.clock.nowMs())!.n);
  }

  private liveDeviceLogin(nonce: string): DeviceLoginRecord | undefined {
    const row = this.get('SELECT record FROM device_logins WHERE nonce = ? AND expires_at_ms > ?', nonce, this.clock.nowMs());
    return row ? JSON.parse(String(row.record)) as DeviceLoginRecord : undefined;
  }

  getDeviceLogin(nonce: string): DeviceLoginRecord | undefined {
    return this.liveDeviceLogin(nonce);
  }

  private writeDeviceLogin(nonce: string, record: DeviceLoginRecord): void {
    this.run('INSERT OR REPLACE INTO device_logins (nonce, expires_at_ms, record) VALUES (?, ?, ?)', nonce, record.expiresAt, JSON.stringify(record));
  }

  putDeviceLogin(nonce: string, record: DeviceLoginRecord): void {
    this.transact(() => this.writeDeviceLogin(nonce, record));
  }

  updateDeviceLogin(nonce: string, change: (record: DeviceLoginRecord) => DeviceLoginRecord | undefined): DeviceLoginRecord | undefined {
    return this.transact(() => {
      const record = this.liveDeviceLogin(nonce);
      if (!record) return undefined;
      const next = change(record);
      if (next) this.writeDeviceLogin(nonce, next);
      return next;
    });
  }

  deleteDeviceLogin(nonce: string): void {
    this.transact(() => this.run('DELETE FROM device_logins WHERE nonce = ?', nonce));
  }
}
