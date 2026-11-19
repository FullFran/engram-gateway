import type { DatabaseSync, SQLInputValue, SQLOutputValue } from 'node:sqlite';
import { SqliteAuditLog, insertAuditEvent } from '../../audit/index.js';
import type { AuditEvent, AuditFilter, AuditRecord } from '../../audit/index.js';
import { isRole } from '../../authz/index.js';
import type { Role } from '../../authz/index.js';
import { SqliteBrainRepository } from '../../brains/index.js';
import { immediateTransaction } from '../../shared/sqlite-database.js';
import type { AdminStore } from '../application/ports.js';
import type { BrainView, GrantSource, GrantView, ServiceAccountView, UserStatus, UserView } from '../domain/views.js';

type Row = Record<string, SQLOutputValue>;

const toBrain = (row: Row): BrainView => ({
  slug: String(row.slug), dataDir: String(row.data_dir), cloudSync: Number(row.cloud_sync) === 1,
  status: row.status === 'archived' ? 'archived' : 'active'
});

const USER_STATUSES: readonly string[] = ['invited', 'active', 'disabled'];
const toUser = (row: Row): UserView => ({
  login: String(row.github_login),
  // An unknown status is shown as disabled: the authorization queries only admit `active`.
  status: USER_STATUSES.includes(String(row.status)) ? String(row.status) as UserStatus : 'disabled',
  isAdmin: Number(row.is_admin) === 1,
  kind: row.kind === 'service' ? 'service' : 'human'
});

const toGrant = (row: Row): GrantView | undefined => {
  const role = row.role;
  if (!isRole(role)) return undefined;
  return { login: String(row.github_login), brain: String(row.slug), role, source: row.source === 'api' ? 'api' : 'config' };
};

const GRANT_SELECT = `SELECT u.github_login, b.slug, g.role, g.source FROM grants g
  JOIN users u ON u.id = g.user_id JOIN brains b ON b.id = g.brain_id`;

/**
 * The admin use cases' view of the gateway database. Brain rows are written
 * through the brains repository (#4), audit rows through the audit module's
 * insert (#8), both inside the caller's transaction.
 */
export class SqliteAdminStore implements AdminStore {
  private readonly brainRepo: SqliteBrainRepository;
  private readonly auditLog: SqliteAuditLog;

  constructor(private readonly db: DatabaseSync) {
    this.brainRepo = new SqliteBrainRepository(db);
    this.auditLog = new SqliteAuditLog(db);
  }

  transaction<T>(work: () => T): T {
    return immediateTransaction(this.db, work);
  }

  isAdmin(login: string): boolean {
    return this.db.prepare("SELECT 1 AS ok FROM users WHERE github_login = ? AND is_admin = 1 AND status = 'active' AND kind = 'human'").get(login) !== undefined;
  }

  brain(slug: string): BrainView | undefined {
    const row = this.db.prepare('SELECT slug, data_dir, cloud_sync, status FROM brains WHERE slug = ?').get(slug);
    return row ? toBrain(row) : undefined;
  }

  brains(): BrainView[] {
    return this.db.prepare('SELECT slug, data_dir, cloud_sync, status FROM brains ORDER BY slug').all().map(toBrain);
  }

  createBrain(slug: string, dataDir: string): void {
    if (this.brainRepo.exists(slug)) throw new Error(`brain ${slug} already exists`);
    this.brainRepo.ensure(slug, dataDir);
    // Instance admins own every brain, as `bootstrapAccess` makes them at startup.
    this.db.prepare(
      `INSERT INTO grants (user_id, brain_id, role, source)
       SELECT u.id, b.id, 'owner', 'config' FROM users u, brains b WHERE u.is_admin = 1 AND b.slug = ?`
    ).run(slug);
  }

  archiveBrain(slug: string): void {
    this.brainRepo.archive(slug);
  }

  user(login: string): UserView | undefined {
    const row = this.db.prepare('SELECT github_login, status, is_admin, kind FROM users WHERE github_login = ?').get(login);
    return row ? toUser(row) : undefined;
  }

  users(): UserView[] {
    return this.db.prepare('SELECT github_login, status, is_admin, kind FROM users ORDER BY github_login COLLATE NOCASE').all().map(toUser);
  }

  insertUser(login: string, status: UserStatus): void {
    this.db.prepare('INSERT INTO users (github_login, status) VALUES (?, ?)').run(login, status);
  }

  insertServiceAccount(login: string, owner: string): void {
    this.db.prepare(
      `INSERT INTO users (github_login, status, kind, owner_user_id)
       SELECT ?, 'active', 'service', id FROM users WHERE github_login = ?`
    ).run(login, owner);
  }

  serviceAccounts(): ServiceAccountView[] {
    return this.db.prepare(
      `SELECT u.github_login, u.status, o.github_login AS owner FROM users u LEFT JOIN users o ON o.id = u.owner_user_id
       WHERE u.kind = 'service' ORDER BY u.github_login COLLATE NOCASE`
    ).all().map(row => ({ login: String(row.github_login), status: toUser(row).status, owner: row.owner === null ? null : String(row.owner) }));
  }

  setUserStatus(login: string, status: UserStatus): void {
    this.db.prepare('UPDATE users SET status = ? WHERE github_login = ?').run(status, login);
  }

  grant(login: string, brain: string): GrantView | undefined {
    const row = this.db.prepare(`${GRANT_SELECT} WHERE u.github_login = ? AND b.slug = ?`).get(login, brain);
    return row ? toGrant(row) : undefined;
  }

  grants(filter: { brain?: string; login?: string }): GrantView[] {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (filter.brain !== undefined) { where.push('b.slug = ?'); params.push(filter.brain); }
    if (filter.login !== undefined) { where.push('u.github_login = ?'); params.push(filter.login); }
    const sql = `${GRANT_SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY b.slug, u.github_login COLLATE NOCASE`;
    return this.db.prepare(sql).all(...params).flatMap(row => toGrant(row) ?? []);
  }

  putGrant(login: string, brain: string, role: Role, source: GrantSource): void {
    const result = this.db.prepare(
      `INSERT INTO grants (user_id, brain_id, role, source)
       SELECT u.id, b.id, ?, ? FROM users u, brains b WHERE u.github_login = ? AND b.slug = ?
       ON CONFLICT (user_id, brain_id) DO UPDATE SET role = excluded.role, source = excluded.source`
    ).run(role, source, login, brain);
    if (Number(result.changes) !== 1) throw new Error(`cannot grant ${role} on ${brain} to ${login}`);
  }

  deleteGrant(login: string, brain: string): void {
    this.db.prepare(
      `DELETE FROM grants WHERE user_id = (SELECT id FROM users WHERE github_login = ?)
         AND brain_id = (SELECT id FROM brains WHERE slug = ?)`
    ).run(login, brain);
  }

  audit(event: AuditEvent): void {
    insertAuditEvent(this.db, event);
  }

  readAudit(filter: AuditFilter): Iterable<AuditRecord> {
    return this.auditLog.read(filter);
  }

  countAudit(filter: AuditFilter, upTo: number): number {
    // Same filter as SqliteAuditLog.read; the LIMIT stops the scan at `upTo`.
    const where = ['1 = 1'];
    const params: SQLInputValue[] = [];
    if (filter.brain !== undefined) { where.push('brain_id = ?'); params.push(filter.brain); }
    if (filter.fromMs !== undefined) { where.push('at_ms >= ?'); params.push(filter.fromMs); }
    if (filter.toMs !== undefined) { where.push('at_ms < ?'); params.push(filter.toMs); }
    const row = this.db.prepare(`SELECT count(*) AS n FROM (SELECT 1 FROM audit_log WHERE ${where.join(' AND ')} LIMIT ?)`).get(...params, upTo);
    return Number(row?.n ?? 0);
  }
}
