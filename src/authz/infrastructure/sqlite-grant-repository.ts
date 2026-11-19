import type { DatabaseSync } from 'node:sqlite';
import { immediateTransaction } from '../../shared/sqlite-database.js';
import type { AccessSnapshot, GrantStore } from '../application/ports.js';
import { isRole } from '../domain/role.js';
import type { Role } from '../domain/role.js';

/**
 * Users, brains and grants in the gateway database. Every read is one
 * indexed lookup, run on each request: there is no authorization cache.
 * Logins compare case-insensitively (`users.github_login` is NOCASE).
 * An archived brain grants nothing; its grant rows are kept.
 */
export class SqliteGrantRepository implements GrantStore {
  constructor(private readonly db: DatabaseSync) {}

  roleOf(login: string, brain: string): Role | undefined {
    const row = this.db.prepare(
      `SELECT g.role FROM grants g
       JOIN users u ON u.id = g.user_id
       JOIN brains b ON b.id = g.brain_id
       WHERE u.github_login = ? AND b.slug = ? AND u.status = 'active' AND b.status = 'active'`
    ).get(login, brain);
    const role = row?.role;
    // A role the code does not know grants nothing.
    return isRole(role) ? role : undefined;
  }

  hasAccess(login: string): boolean {
    return this.access(login)?.status === 'active';
  }

  admitSignIn(login: string): boolean {
    const found = this.access(login);
    if (!found) return false;
    if (found.status === 'active') return true;
    if (found.status !== 'invited') return false;
    this.db.prepare("UPDATE users SET status = 'active' WHERE github_login = ? AND status = 'invited'").run(login);
    return true;
  }

  /**
   * The user's status when they are an admin or hold a grant on a brain that
   * is not archived. Service accounts (#7) never sign in: they have none.
   */
  private access(login: string): { status: string } | undefined {
    const row = this.db.prepare(
      `SELECT u.status FROM users u
       WHERE u.github_login = ? AND u.kind = 'human'
         AND (u.is_admin = 1 OR EXISTS (
           SELECT 1 FROM grants g JOIN brains b ON b.id = g.brain_id WHERE g.user_id = u.id AND b.status = 'active'))`
    ).get(login);
    return row ? { status: String(row.status) } : undefined;
  }

  isAdmin(login: string): boolean {
    return this.db.prepare("SELECT 1 AS ok FROM users WHERE github_login = ? AND is_admin = 1 AND status = 'active' AND kind = 'human'").get(login) !== undefined;
  }

  grantsOf(login: string): { brain: string; role: Role }[] {
    return this.db.prepare(
      `SELECT b.slug, g.role FROM grants g
       JOIN users u ON u.id = g.user_id
       JOIN brains b ON b.id = g.brain_id
       WHERE u.github_login = ? AND u.status = 'active' AND b.status = 'active'
       ORDER BY b.slug`
    ).all(login).flatMap(row => isRole(row.role) ? [{ brain: String(row.slug), role: row.role }] : []);
  }

  brainSlugs(): string[] {
    return this.db.prepare('SELECT slug FROM brains ORDER BY slug').all().map(row => String(row.slug));
  }

  replaceConfigured(snapshot: AccessSnapshot): void {
    const addUser = this.db.prepare('INSERT INTO users (github_login) VALUES (?) ON CONFLICT (github_login) DO NOTHING');
    const service = this.db.prepare("SELECT github_login FROM users WHERE github_login = ? AND kind = 'service'");
    for (const login of snapshot.admins) {
      // Fails the start inside the caller's transaction, before any grant changes.
      if (service.get(login)) throw new Error(`${login} is a service account; it cannot be an instance admin (remove it from ALLOWED_GITHUB_LOGINS)`);
    }
    for (const login of [...snapshot.admins, ...snapshot.grants.map(grant => grant.login)]) addUser.run(login);
    this.db.prepare('UPDATE users SET is_admin = 0 WHERE is_admin <> 0').run();
    const promote = this.db.prepare('UPDATE users SET is_admin = 1 WHERE github_login = ?');
    for (const login of snapshot.admins) promote.run(login);
    // Grants created through the admin API (`source = 'api'`) are kept; a
    // configured grant for the same user and brain takes that row over.
    this.db.prepare("DELETE FROM grants WHERE source = 'config'").run();
    const grant = this.db.prepare(
      `INSERT INTO grants (user_id, brain_id, role, source)
       SELECT u.id, b.id, ?, 'config' FROM users u, brains b WHERE u.github_login = ? AND b.slug = ?
       ON CONFLICT (user_id, brain_id) DO UPDATE SET role = excluded.role, source = 'config'`
    );
    for (const { login, brain, role } of snapshot.grants) {
      if (Number(grant.run(role, login, brain).changes) !== 1) throw new Error(`cannot grant ${role} on ${brain} to ${login}: unknown brain`);
    }
  }

  transaction<T>(work: () => T): T {
    return immediateTransaction(this.db, work);
  }
}
