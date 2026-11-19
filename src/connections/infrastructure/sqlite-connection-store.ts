import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { isRole } from '../../authz/domain/role.js';
import type { Role } from '../../authz/domain/role.js';
import type { AuditEvent } from '../../audit/domain/audit-event.js';
import { insertAuditEvent } from '../../audit/infrastructure/sqlite-audit-log.js';
import { immediateTransaction } from '../../shared/sqlite-database.js';
import { ConnectionNameTakenError } from '../application/ports.js';
import type { ConnectionStore } from '../application/ports.js';
import type { Connection, ConnectionBrain, ConnectionChoice, ConnectionKind } from '../domain/connection.js';

type Row = Record<string, SQLOutputValue>;

/**
 * Connections in the gateway database. Every read is a few indexed lookups,
 * run on each request: there is no cache. Logins compare case-insensitively
 * (`users.github_login` is NOCASE).
 */
export class SqliteConnectionStore implements ConnectionStore {
  constructor(private readonly db: DatabaseSync) {}

  roleOn(connectionId: number, brain: string): Role | null | undefined {
    const row = this.db.prepare(
      `SELECT c.id, cb.role FROM connections c
       LEFT JOIN connection_brains cb ON cb.connection_id = c.id
         AND cb.brain_id = (SELECT id FROM brains WHERE slug = ?)
       WHERE c.id = ?`
    ).get(brain, connectionId);
    if (!row) return undefined;
    // A role the code does not know grants nothing.
    return isRole(row.role) ? row.role : null;
  }

  get(connectionId: number): Connection | undefined {
    const row = this.db.prepare(`${SELECT_CONNECTION} WHERE c.id = ?`).get(connectionId);
    return row ? this.connection(row) : undefined;
  }

  findOAuth(login: string, clientId: string): Connection | undefined {
    const row = this.db.prepare(`${SELECT_CONNECTION} WHERE u.github_login = ? AND c.kind = 'oauth' AND c.client_id = ?`).get(login, clientId);
    return row ? this.connection(row) : undefined;
  }

  saveOAuth(login: string, clientId: string, choice: ConnectionChoice): number {
    return immediateTransaction(this.db, () => {
      const userId = this.userId(login);
      const existing = this.db.prepare("SELECT id FROM connections WHERE user_id = ? AND kind = 'oauth' AND client_id = ?").get(userId, clientId);
      const id = existing ? Number(existing.id) : undefined;
      this.ensureNameFree(userId, choice.name, id);
      const connectionId = id ?? Number(this.db.prepare(
        "INSERT INTO connections (user_id, name, kind, client_id) VALUES (?, ?, 'oauth', ?)"
      ).run(userId, choice.name, clientId).lastInsertRowid);
      this.writeBrains(connectionId, choice);
      return connectionId;
    });
  }

  createToken(login: string, choice: ConnectionChoice, alongside?: (connectionId: number) => void): number {
    return immediateTransaction(this.db, () => {
      const userId = this.userId(login);
      this.ensureNameFree(userId, choice.name);
      const connectionId = Number(this.db.prepare("INSERT INTO connections (user_id, name, kind) VALUES (?, ?, 'token')").run(userId, choice.name).lastInsertRowid);
      this.writeBrains(connectionId, choice);
      alongside?.(connectionId);
      return connectionId;
    });
  }

  listOwned(login: string): Connection[] {
    return this.db.prepare(`${SELECT_CONNECTION} WHERE u.github_login = ? ORDER BY c.id`).all(login).map(row => this.connection(row));
  }

  attach(connectionId: number, brain: string, role: Role, makeDefault: boolean, audit?: AuditEvent): void {
    immediateTransaction(this.db, () => {
      const changes = this.db.prepare(
        `INSERT INTO connection_brains (connection_id, brain_id, role) SELECT ?, id, ? FROM brains WHERE slug = ?
         ON CONFLICT (connection_id, brain_id) DO UPDATE SET role = excluded.role`
      ).run(connectionId, role, brain).changes;
      if (Number(changes) !== 1) throw new Error(`unknown brain ${brain}`);
      if (makeDefault) {
        this.db.prepare('UPDATE connections SET default_brain_id = (SELECT id FROM brains WHERE slug = ?) WHERE id = ?').run(brain, connectionId);
      }
      if (audit) insertAuditEvent(this.db, audit);
    });
  }

  detach(connectionId: number, brain: string, audit?: AuditEvent): boolean {
    return immediateTransaction(this.db, () => {
      const changes = this.db.prepare(
        'DELETE FROM connection_brains WHERE connection_id = ? AND brain_id = (SELECT id FROM brains WHERE slug = ?)'
      ).run(connectionId, brain).changes;
      this.db.prepare('UPDATE connections SET default_brain_id = NULL WHERE id = ? AND default_brain_id = (SELECT id FROM brains WHERE slug = ?)')
        .run(connectionId, brain);
      const detached = Number(changes) === 1;
      if (detached && audit) insertAuditEvent(this.db, audit);
      return detached;
    });
  }

  private userId(login: string): number {
    const row = this.db.prepare('SELECT id FROM users WHERE github_login = ?').get(login);
    if (!row) throw new Error(`unknown user ${login}`);
    return Number(row.id);
  }

  private ensureNameFree(userId: number, name: string, except?: number): void {
    const row = this.db.prepare('SELECT id FROM connections WHERE user_id = ? AND name = ?').get(userId, name);
    if (row && Number(row.id) !== except) throw new ConnectionNameTakenError(name);
  }

  /** Replaces the connection's name, brains and default brain with `choice`. */
  private writeBrains(connectionId: number, choice: ConnectionChoice): void {
    this.db.prepare('DELETE FROM connection_brains WHERE connection_id = ?').run(connectionId);
    const attach = this.db.prepare(
      'INSERT INTO connection_brains (connection_id, brain_id, role) SELECT ?, id, ? FROM brains WHERE slug = ?'
    );
    for (const { brain, role } of choice.brains) {
      if (Number(attach.run(connectionId, role, brain).changes) !== 1) throw new Error(`unknown brain ${brain}`);
    }
    this.db.prepare('UPDATE connections SET name = ?, default_brain_id = (SELECT id FROM brains WHERE slug = ?) WHERE id = ?')
      .run(choice.name, choice.defaultBrain, connectionId);
  }

  private connection(row: Row): Connection {
    const brains: ConnectionBrain[] = this.db.prepare(
      `SELECT b.slug, cb.role FROM connection_brains cb JOIN brains b ON b.id = cb.brain_id
       WHERE cb.connection_id = ? ORDER BY b.slug`
    ).all(Number(row.id)).flatMap(brain => isRole(brain.role) ? [{ brain: String(brain.slug), role: brain.role }] : []);
    // A default brain the connection no longer has is no default (fail closed).
    const defaultBrain = row.default_slug !== null && brains.some(b => b.brain === String(row.default_slug)) ? String(row.default_slug) : undefined;
    return {
      id: Number(row.id),
      login: String(row.login),
      name: String(row.name),
      kind: String(row.kind) as ConnectionKind,
      ...(row.client_id !== null ? { clientId: String(row.client_id) } : {}),
      ...(defaultBrain ? { defaultBrain } : {}),
      brains
    };
  }
}

const SELECT_CONNECTION = `
  SELECT c.id, u.github_login AS login, c.name, c.kind, c.client_id, b.slug AS default_slug
  FROM connections c
  JOIN users u ON u.id = c.user_id
  LEFT JOIN brains b ON b.id = c.default_brain_id`;
