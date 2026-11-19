import type { DatabaseSync } from 'node:sqlite';
import { immediateTransaction } from '../../shared/sqlite-database.js';
import type { AccessSnapshot, GrantStore } from '../application/ports.js';
import { isRole } from '../domain/role.js';
import type { Role } from '../domain/role.js';

/**
 * Users, brains and grants in the gateway database. Every read is one
 * indexed lookup, run on each request: there is no authorization cache.
 * Logins compare case-insensitively (`users.github_login` is NOCASE).
 */
export class SqliteGrantRepository implements GrantStore {
  constructor(private readonly db: DatabaseSync) {}

  roleOf(login: string, brain: string): Role | undefined {
    const row = this.db.prepare(
      `SELECT g.role FROM grants g
       JOIN users u ON u.id = g.user_id
       JOIN brains b ON b.id = g.brain_id
       WHERE u.github_login = ? AND b.slug = ? AND u.status = 'active'`
    ).get(login, brain);
    const role = row?.role;
    // A role the code does not know grants nothing.
    return isRole(role) ? role : undefined;
  }

  hasAccess(login: string): boolean {
    const row = this.db.prepare(
      `SELECT 1 AS ok FROM users u
       WHERE u.github_login = ? AND u.status = 'active'
         AND (u.is_admin = 1 OR EXISTS (SELECT 1 FROM grants g WHERE g.user_id = u.id))`
    ).get(login);
    return row !== undefined;
  }

  isAdmin(login: string): boolean {
    return this.db.prepare("SELECT 1 AS ok FROM users WHERE github_login = ? AND is_admin = 1 AND status = 'active'").get(login) !== undefined;
  }

  brainSlugs(): string[] {
    return this.db.prepare('SELECT slug FROM brains ORDER BY slug').all().map(row => String(row.slug));
  }

  replaceAll(snapshot: AccessSnapshot): void {
    const addUser = this.db.prepare('INSERT INTO users (github_login) VALUES (?) ON CONFLICT (github_login) DO NOTHING');
    for (const login of [...snapshot.admins, ...snapshot.grants.map(grant => grant.login)]) addUser.run(login);
    this.db.prepare('UPDATE users SET is_admin = 0 WHERE is_admin <> 0').run();
    const promote = this.db.prepare('UPDATE users SET is_admin = 1 WHERE github_login = ?');
    for (const login of snapshot.admins) promote.run(login);
    this.db.prepare('DELETE FROM grants').run();
    const grant = this.db.prepare(
      `INSERT INTO grants (user_id, brain_id, role)
       SELECT u.id, b.id, ? FROM users u, brains b WHERE u.github_login = ? AND b.slug = ?`
    );
    for (const { login, brain, role } of snapshot.grants) {
      if (Number(grant.run(role, login, brain).changes) !== 1) throw new Error(`cannot grant ${role} on ${brain} to ${login}: unknown brain`);
    }
  }

  transaction<T>(work: () => T): T {
    return immediateTransaction(this.db, work);
  }
}
