import type { DatabaseSync, SQLInputValue, SQLOutputValue } from 'node:sqlite';
import type { AuditActor, AuditEvent, AuditMeta, AuditOutcome } from '../domain/audit-event.js';
import type { AuditFilter, AuditLog, AuditReader, AuditRecord } from '../application/ports.js';
import { immediateTransaction } from '../../shared/sqlite-database.js';

/** Rows fetched per query while reading; keeps an export's memory flat. */
const PAGE_SIZE = 500;

type Row = Record<string, SQLOutputValue>;

/** The opaque actor id: `users.id` for a user (created on first sight), the given id for the system. */
function actorId(db: DatabaseSync, actor: AuditActor): string {
  if (actor.kind === 'system') return actor.id;
  db.prepare('INSERT INTO users (github_login) VALUES (?) ON CONFLICT (github_login) DO NOTHING').run(actor.login);
  const row = db.prepare('SELECT id FROM users WHERE github_login = ?').get(actor.login);
  return String(row!.id);
}

/**
 * Inserts one audit row using the caller's open transaction, so an admin
 * mutation and its audit row commit or roll back together. Returns the id.
 */
export function insertAuditEvent(db: DatabaseSync, event: AuditEvent): number {
  const result = db.prepare(
    `INSERT INTO audit_log (at_ms, actor_kind, actor_id, brain_id, action, target, outcome, duration_ms, meta_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    event.atMs, event.actor.kind, actorId(db, event.actor), event.brain, event.action, event.target,
    event.outcome, event.durationMs, JSON.stringify(event.meta)
  );
  return Number(result.lastInsertRowid);
}

function record(row: Row): AuditRecord {
  return {
    id: Number(row.id),
    atMs: Number(row.at_ms),
    actorKind: row.actor_kind === 'system' ? 'system' : 'user',
    actorId: String(row.actor_id),
    actorLogin: row.actor_login === null ? null : String(row.actor_login),
    brain: row.brain_id === null ? null : String(row.brain_id),
    action: String(row.action),
    target: row.target === null ? null : String(row.target),
    outcome: String(row.outcome) as AuditOutcome,
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    meta: JSON.parse(String(row.meta_json)) as AuditMeta
  };
}

/**
 * The audit log in the gateway SQLite database. Append-only: the table's
 * triggers abort any UPDATE or DELETE. User actors are stored by `users.id`;
 * the login is joined in at read time, so anonymising a user edits `users`.
 */
export class SqliteAuditLog implements AuditLog, AuditReader {
  constructor(private readonly db: DatabaseSync) {}

  append(event: AuditEvent): number {
    return immediateTransaction(this.db, () => insertAuditEvent(this.db, event));
  }

  /** Oldest first, fetched in pages by id, so callers can stream any size of log. */
  *read(filter: AuditFilter = {}): Generator<AuditRecord> {
    const where = ['a.id > ?'];
    const params: SQLInputValue[] = [];
    if (filter.brain !== undefined) { where.push('a.brain_id = ?'); params.push(filter.brain); }
    if (filter.fromMs !== undefined) { where.push('a.at_ms >= ?'); params.push(filter.fromMs); }
    if (filter.toMs !== undefined) { where.push('a.at_ms < ?'); params.push(filter.toMs); }
    const page = this.db.prepare(
      `SELECT a.*, u.github_login AS actor_login FROM audit_log a
       LEFT JOIN users u ON a.actor_kind = 'user' AND u.id = CAST(a.actor_id AS INTEGER)
       WHERE ${where.join(' AND ')} ORDER BY a.id LIMIT ${PAGE_SIZE}`
    );
    let after = 0;
    for (;;) {
      const rows = page.all(after, ...params);
      for (const row of rows) yield record(row);
      if (rows.length < PAGE_SIZE) return;
      after = Number(rows[rows.length - 1]!.id);
    }
  }
}
