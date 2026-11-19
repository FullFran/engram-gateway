import type { DatabaseSync } from 'node:sqlite';
import type { Authorship } from '../domain/authorship.js';
import type { AuthorshipRepository, RecordedWrite } from '../application/ports.js';

/** `users.id` for a login, creating the user on first sight (as the audit log does). */
function userId(db: DatabaseSync, login: string): number {
  db.prepare('INSERT INTO users (github_login) VALUES (?) ON CONFLICT (github_login) DO NOTHING').run(login);
  const row = db.prepare('SELECT id FROM users WHERE github_login = ?').get(login);
  return Number(row!.id);
}

/**
 * `observation_authors` in the gateway database (migration 0005). Users are
 * stored by `users.id` and logins joined in at read time, so renaming or
 * anonymising a user is an edit of `users`.
 */
export class SqliteAuthorshipRepository implements AuthorshipRepository {
  constructor(private readonly db: DatabaseSync) {}

  recordWrite(write: RecordedWrite): void {
    const user = userId(this.db, write.login);
    const createsAuthor = write.kind === 'save';
    this.db.prepare(
      `INSERT INTO observation_authors (brain_id, observation_id, sync_id, user_id, last_writer_id, first_written_at, last_written_at, connection_id, last_connection_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (brain_id, observation_id) DO UPDATE SET
         sync_id = coalesce(excluded.sync_id, sync_id),
         last_writer_id = excluded.last_writer_id,
         last_written_at = excluded.last_written_at,
         last_connection_id = excluded.last_connection_id`
    ).run(
      write.brain, write.observationId, write.syncId ?? null,
      createsAuthor ? user : null, user, createsAuthor ? write.atMs : null, write.atMs,
      createsAuthor ? write.connectionId ?? null : null, write.connectionId ?? null
    );
  }

  remove(brain: string, observationId: number): void {
    this.db.prepare('DELETE FROM observation_authors WHERE brain_id = ? AND observation_id = ?').run(brain, observationId);
  }

  find(brain: string, ids: readonly number[]): Authorship[] {
    if (ids.length === 0) return [];
    const rows = this.db.prepare(
      `SELECT a.observation_id, f.github_login AS saved_by, l.github_login AS last_updated_by
       FROM observation_authors a
       LEFT JOIN users f ON f.id = a.user_id
       LEFT JOIN users l ON l.id = a.last_writer_id
       WHERE a.brain_id = ? AND a.observation_id IN (SELECT value FROM json_each(?))`
    ).all(brain, JSON.stringify(ids));
    const byId = new Map(rows.map(row => [Number(row.observation_id), {
      observationId: Number(row.observation_id),
      savedBy: row.saved_by === null ? null : String(row.saved_by),
      lastUpdatedBy: row.last_updated_by === null ? null : String(row.last_updated_by)
    }]));
    return ids.flatMap(id => byId.get(id) ?? []);
  }
}
