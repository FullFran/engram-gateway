import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type { AuditEvent } from '../../audit/domain/audit-event.js';
import { insertAuditEvent } from '../../audit/infrastructure/sqlite-audit-log.js';
import { immediateTransaction } from '../../shared/sqlite-database.js';
import type { NewPat, PatRecord, PatSecrets, PatStore } from '../application/personal-access-tokens.js';
import type { ConnectionChoice } from '../domain/connection.js';
import { PAT_PREFIX } from '../domain/personal-access-token.js';
import type { PatScope, PatView } from '../domain/personal-access-token.js';
import type { SqliteConnectionStore } from './sqlite-connection-store.js';

type Row = Record<string, SQLOutputValue>;

/** `egw_pat_` + 32 random bytes (base64url); stored as hex SHA-256 only. */
export const nodePatSecrets: PatSecrets = {
  generate: () => `${PAT_PREFIX}${randomBytes(32).toString('base64url')}`,
  hash: secret => createHash('sha256').update(secret, 'utf8').digest('hex')
};

const SELECT_VIEW = `
  SELECT p.id, c.name, p.scope, p.created_at, p.expires_at, p.last_used_at, p.revoked_at,
    (SELECT group_concat(slug, ',') FROM (SELECT b.slug FROM connection_brains cb JOIN brains b ON b.id = cb.brain_id
       WHERE cb.connection_id = c.id ORDER BY b.slug)) AS brains
  FROM personal_access_tokens p
  JOIN connections c ON c.id = p.connection_id
  JOIN users u ON u.id = c.user_id`;

function view(row: Row): PatView {
  const brains = row.brains === null ? [] : String(row.brains).split(',');
  return {
    id: Number(row.id), name: String(row.name), brains, scope: String(row.scope) as PatScope,
    createdAt: Number(row.created_at), expiresAt: Number(row.expires_at),
    lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at),
    revokedAt: row.revoked_at === null ? null : Number(row.revoked_at)
  };
}

/**
 * PATs in the gateway database. The connection half (name, brains, roles)
 * is written by the connection store, in the same transaction as the PAT
 * row. Logins compare case-insensitively (`users.github_login` is NOCASE).
 */
export class SqlitePatStore implements PatStore {
  constructor(private readonly db: DatabaseSync, private readonly connections: SqliteConnectionStore) {}

  create(login: string, choice: ConnectionChoice, pat: NewPat, audit: (patId: number) => AuditEvent): PatView {
    // An expired token frees its name for the new one (a revoked one freed it when revoked).
    this.db.prepare(
      `UPDATE connections SET name = name || ' (expired ' || (SELECT p.id FROM personal_access_tokens p WHERE p.connection_id = connections.id) || ')'
       WHERE name = ? AND user_id = (SELECT id FROM users WHERE github_login = ?)
         AND id IN (SELECT connection_id FROM personal_access_tokens WHERE revoked_at IS NULL AND expires_at <= ?)`
    ).run(choice.name, login, pat.createdAt);
    let id = 0;
    this.connections.createToken(login, choice, connectionId => {
      id = Number(this.db.prepare(
        'INSERT INTO personal_access_tokens (connection_id, hash, scope, created_at, expires_at) VALUES (?, ?, ?, ?, ?)'
      ).run(connectionId, pat.hash, pat.scope, pat.createdAt, pat.expiresAt).lastInsertRowid);
      insertAuditEvent(this.db, audit(id));
    });
    return this.view(login, id)!;
  }

  list(login: string): PatView[] {
    return this.db.prepare(`${SELECT_VIEW} WHERE u.github_login = ? ORDER BY p.id DESC`).all(login).map(view);
  }

  view(login: string, id: number): PatView | undefined {
    const row = this.db.prepare(`${SELECT_VIEW} WHERE u.github_login = ? AND p.id = ?`).get(login, id);
    return row ? view(row) : undefined;
  }

  revoke(login: string, id: number, atS: number, audit: AuditEvent): boolean {
    return immediateTransaction(this.db, () => {
      const changes = this.db.prepare(
        `UPDATE personal_access_tokens SET revoked_at = ?
         WHERE id = ? AND revoked_at IS NULL
           AND connection_id IN (SELECT c.id FROM connections c JOIN users u ON u.id = c.user_id WHERE u.github_login = ?)`
      ).run(atS, id, login).changes;
      if (Number(changes) !== 1) return false;
      // Frees the name: the owner may give it to a new token.
      this.db.prepare(
        `UPDATE connections SET name = name || ' (revoked ' || ? || ')'
         WHERE id = (SELECT connection_id FROM personal_access_tokens WHERE id = ?)`
      ).run(String(id), id);
      insertAuditEvent(this.db, audit);
      return true;
    });
  }

  findByHash(hash: string): PatRecord | undefined {
    const row = this.db.prepare(
      `SELECT p.id, p.connection_id, p.expires_at, p.revoked_at, u.github_login AS login, u.status
       FROM personal_access_tokens p
       JOIN connections c ON c.id = p.connection_id
       JOIN users u ON u.id = c.user_id
       WHERE p.hash = ?`
    ).get(hash);
    if (!row) return undefined;
    return {
      id: Number(row.id), connectionId: Number(row.connection_id), login: String(row.login), ownerActive: row.status === 'active',
      expiresAt: Number(row.expires_at), revokedAt: row.revoked_at === null ? null : Number(row.revoked_at)
    };
  }

  touch(id: number, nowS: number, resolutionS: number): void {
    this.db.prepare('UPDATE personal_access_tokens SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at <= ?)')
      .run(nowS, id, nowS - resolutionS);
  }
}
