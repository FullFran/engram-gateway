import { auditCsvLines } from '../../audit/index.js';
import type { AuditActor, AuditFilter, AuditMeta, AuditOutcome, AuditQuery, AuditRecord } from '../../audit/index.js';
import { isGitHubLogin, isRole, ROLES } from '../../authz/index.js';
import { DEFAULT_BRAIN, brainDataDir, parseBrainSlug } from '../../brains/index.js';
import type { AdminActor } from '../domain/admin-actor.js';
import { AdminError } from '../domain/admin-error.js';
import type { BrainView, GrantView, ServiceAccountView, UserView } from '../domain/views.js';
import type { BrainHealthReport } from '../../health/index.js';
import type { AdminBrainHealth, AdminClock, AdminStore, AdminTokens, BrainDirectories, BrainRuntime } from './ports.js';

export interface AdminServiceDeps {
  store: AdminStore;
  dirs: BrainDirectories;
  clock: AdminClock;
  /** The running gateway's registry; without it (CLI) an archived brain's child stops when idle. */
  runtime?: BrainRuntime;
  /** Personal access tokens of service accounts (#7); without it those operations are refused. */
  tokens?: AdminTokens;
  /** Brain health reports (#18); without it (CLI) they are refused. */
  health?: AdminBrainHealth;
  /**
   * A refused (`denied`) attempt is recorded once per login and action in
   * this window, so a signed-in non-admin cannot flood the audit log; every
   * attempt is still refused. Default one minute.
   */
  deniedAuditIntervalMs?: number;
}

/** A brain's health: its report, or why there is none yet. */
export type BrainHealthResult =
  | { ok: true; report: BrainHealthReport & { brain: string } }
  | { ok: false; reason: 'no_data' | 'busy'; message: string };

/** An audit page request as a caller sends it; `queryAudit` validates every field. */
export type AuditQueryRequest = Partial<Omit<AuditQuery, 'outcome'>> & { outcome?: string };

/** A page of the audit log, newest first; `nextBefore` asks for the next (older) page, null on the last. */
export interface AuditPage {
  rows: AuditRecord[];
  nextBefore: number | null;
}

const AUDIT_OUTCOMES: readonly string[] = ['ok', 'error', 'denied'];
const AUDIT_ACTION = /^[a-z][a-z0-9_.]{0,63}$/;
export const AUDIT_PAGE_DEFAULT = 50;
export const AUDIT_PAGE_MAX = 200;

export interface ExportOptions {
  /** Refuse an export matching more rows than this (the HTTP API sets it; the CLI does not). */
  maxRows?: number;
}

const DENIED_AUDIT_INTERVAL_MS = 60_000;
const DENIED_MEMORY = 10_000;

export interface BrainListing extends BrainView {
  /** Only from the running gateway: whether the brain's child runs, and whether it serves no request. */
  live?: boolean;
  idle?: boolean;
}

interface Operation {
  action: string;
  brain: string | null;
  target: string | null;
}

/** Slug- or login-shaped values only: whatever else an admin typed is not copied into the audit log. */
const AUDIT_KEY = /^[A-Za-z0-9][A-Za-z0-9-]{0,39}$/;
function auditKey(value: string | null): string | null {
  return value !== null && AUDIT_KEY.test(value) ? value : null;
}

function auditActor(actor: AdminActor): AuditActor {
  return actor.kind === 'user' ? { kind: 'user', login: actor.login } : { kind: 'system', id: actor.id };
}

function requireLogin(login: string): string {
  if (!isGitHubLogin(login)) throw new AdminError('invalid', `invalid GitHub login ${JSON.stringify(login)}`);
  return login;
}

/**
 * The admin use cases (#10): brains, users, grants and the audit export.
 * Both adapters (HTTP API and CLI) call these and hold no authorization
 * logic: a user actor must be an active instance admin (deny by default);
 * the CLI actor runs inside the gateway's container. Every mutation writes
 * its audit row in the same transaction; refused and denied attempts are
 * audited too (outcome `error` / `denied`). Never secrets in the log.
 */
export class AdminService {
  /** Last recorded `denied` row per login and action (in this process). */
  private readonly deniedAt = new Map<string, number>();

  constructor(private readonly deps: AdminServiceDeps) {}

  // ---- Brains ----

  listBrains(actor: AdminActor): BrainListing[] {
    this.authorize(actor, { action: 'brain.list', brain: null, target: null });
    const runtime = this.deps.runtime;
    return this.deps.store.brains().map(brain => (runtime && brain.status === 'active' ? { ...brain, ...runtime.status(brain.slug) } : brain));
  }

  /**
   * Creates `<BRAINS_ROOT>/<slug>` and the brain row; instance admins own it.
   * The running gateway serves it on the next request (the registry reads the
   * table); its OAuth protected resource is registered at the next restart.
   */
  createBrain(actor: AdminActor, slug: string): BrainView {
    const op = { action: 'brain.create', brain: slug, target: slug };
    return this.mutate(actor, op, () => {
      const check = parseBrainSlug(slug);
      if (!check.ok) throw new AdminError('invalid', `invalid brain slug ${JSON.stringify(slug)}: ${check.reason}`);
      if (this.deps.store.brain(slug)) throw new AdminError('conflict', `brain ${slug} already exists`);
      const root = this.deps.dirs.root;
      if (!root) throw new AdminError('invalid', 'BRAINS_ROOT is required to create brains');
      const dataDir = brainDataDir(root, slug);
      this.deps.dirs.prepare(dataDir);
      this.deps.store.createBrain(slug, dataDir);
      return { result: this.deps.store.brain(slug)!, meta: {} };
    });
  }

  /**
   * Archives a brain: it is no longer served (new sessions are refused, its
   * grants give no access) and its child is stopped. The row, the grants and
   * the data directory stay; nothing is deleted.
   */
  async archiveBrain(actor: AdminActor, slug: string): Promise<BrainView> {
    const op = { action: 'brain.archive', brain: slug, target: slug };
    const archived = this.mutate(actor, op, () => {
      const brain = this.deps.store.brain(slug);
      if (!brain) throw new AdminError('not_found', `unknown brain ${JSON.stringify(slug)}`);
      if (slug === DEFAULT_BRAIN) throw new AdminError('invalid', 'the default brain cannot be archived');
      if (brain.status === 'archived') throw new AdminError('conflict', `brain ${slug} is already archived`);
      this.deps.store.archiveBrain(slug);
      return { result: this.deps.store.brain(slug)!, meta: {} };
    });
    await this.deps.runtime?.stop(slug);
    return archived;
  }

  /**
   * A brain's health report (#18), read now. Audited as `admin.brain_health`
   * like the admin health endpoint: `ok` with a report, `error` without one.
   */
  brainHealth(actor: AdminActor, slug: string): BrainHealthResult {
    const op = { action: 'admin.brain_health', brain: slug, target: null };
    this.authorize(actor, op);
    const health = this.deps.health;
    if (!health) throw new AdminError('invalid', 'brain health reports are not available here');
    const startedAtMs = this.deps.clock.nowMs();
    const lookup = health.report(slug);
    this.record(actor, op, lookup.ok ? 'ok' : 'error', startedAtMs, lookup.ok ? {} : { errorKind: lookup.reason });
    if (lookup.ok) return lookup;
    if (lookup.reason === 'unknown_brain') throw new AdminError('not_found', lookup.message);
    if (lookup.reason === 'invalid_arguments') throw new AdminError('invalid', lookup.message);
    return { ok: false, reason: lookup.reason, message: lookup.message };
  }

  // ---- Users ----

  listUsers(actor: AdminActor): UserView[] {
    this.authorize(actor, { action: 'user.list', brain: null, target: null });
    return this.deps.store.users();
  }

  /** An invite is a user row with status `invited`; the first successful sign-in activates it. */
  inviteUser(actor: AdminActor, login: string): UserView {
    return this.mutate(actor, { action: 'user.invite', brain: null, target: login }, () => {
      requireLogin(login);
      if (this.deps.store.user(login)) throw new AdminError('conflict', `user ${login} already exists`);
      this.deps.store.insertUser(login, 'invited');
      return { result: this.deps.store.user(login)!, meta: {} };
    });
  }

  /** A disabled user gets no role and cannot sign in; their tokens stop working on the next request. */
  disableUser(actor: AdminActor, login: string): UserView {
    return this.mutate(actor, { action: 'user.disable', brain: null, target: login }, () => {
      const user = this.existingUser(login);
      if (user.isAdmin) throw new AdminError('conflict', `${user.login} is an instance admin (ALLOWED_GITHUB_LOGINS); remove the login there instead`);
      if (user.status === 'disabled') throw new AdminError('conflict', `user ${user.login} is already disabled`);
      this.deps.store.setUserStatus(login, 'disabled');
      return { result: this.deps.store.user(login)!, meta: {} };
    });
  }

  enableUser(actor: AdminActor, login: string): UserView {
    return this.mutate(actor, { action: 'user.enable', brain: null, target: login }, () => {
      const user = this.existingUser(login);
      if (user.status !== 'disabled') throw new AdminError('conflict', `user ${user.login} is not disabled`);
      if (user.kind === 'service') {
        const owner = this.deps.store.serviceAccounts().find(account => account.login.toLowerCase() === user.login.toLowerCase())?.owner ?? null;
        if (owner === null || !this.deps.store.isAdmin(owner)) {
          throw new AdminError('conflict', `${user.login} stays disabled: its owner ${owner ?? '(none)'} is no longer an instance admin (create a new service account)`);
        }
      }
      this.deps.store.setUserStatus(login, 'active');
      return { result: this.deps.store.user(login)!, meta: {} };
    });
  }

  // ---- Service accounts (#7) ----

  listServiceAccounts(actor: AdminActor): ServiceAccountView[] {
    this.authorize(actor, { action: 'service_account.list', brain: null, target: null });
    return this.deps.store.serviceAccounts();
  }

  /**
   * Creates an active service account owned by the acting admin (the CLI
   * names one: `owner`). It never signs in; an admin gives it API grants and
   * personal access tokens, and disables it like any user.
   */
  createServiceAccount(actor: AdminActor, login: string, owner?: string): ServiceAccountView {
    return this.mutate(actor, { action: 'service_account.create', brain: null, target: login }, () => {
      requireLogin(login);
      const ownerLogin = actor.kind === 'user' ? actor.login : owner;
      if (ownerLogin === undefined) throw new AdminError('invalid', 'a service account needs an owner: the instance admin responsible for it (--owner)');
      if (!this.deps.store.isAdmin(ownerLogin)) throw new AdminError('invalid', `the owner ${JSON.stringify(ownerLogin)} must be an active instance admin`);
      if (this.deps.store.user(login)) throw new AdminError('conflict', `user ${login} already exists`);
      this.deps.store.insertServiceAccount(login, ownerLogin);
      return { result: this.deps.store.serviceAccounts().find(account => account.login.toLowerCase() === login.toLowerCase())!, meta: {} };
    });
  }

  listServiceAccountTokens(actor: AdminActor, login: string): object[] {
    return this.withTokens(actor, 'service_account.token.list', login, tokens => tokens.list(login));
  }

  /** The secret is in the result, and nowhere else. The tokens module audits the creation. */
  createServiceAccountToken(actor: AdminActor, login: string, request: { name: unknown; brains: unknown; scope: unknown; expiresInDays: unknown }): { token: string; id: number } {
    return this.withTokens(actor, 'service_account.token.create', login, tokens => tokens.create(actor, login, request));
  }

  revokeServiceAccountToken(actor: AdminActor, login: string, id: number): object {
    return this.withTokens(actor, 'service_account.token.revoke', login, tokens => tokens.revoke(actor, login, id));
  }

  private withTokens<T>(actor: AdminActor, action: string, login: string, work: (tokens: AdminTokens) => T): T {
    this.authorize(actor, { action, brain: null, target: login });
    const tokens = this.deps.tokens;
    if (!tokens) throw new AdminError('invalid', 'personal access tokens are not available here');
    requireLogin(login);
    if (this.deps.store.user(login)?.kind !== 'service') throw new AdminError('not_found', `unknown service account ${JSON.stringify(login)}`);
    try {
      return work(tokens);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === 'invalid' || code === 'not_found' || code === 'conflict') throw new AdminError(code, (error as Error).message);
      throw error;
    }
  }

  // ---- Grants ----

  listGrants(actor: AdminActor, filter: { brain?: string; login?: string } = {}): GrantView[] {
    this.authorize(actor, { action: 'grant.list', brain: filter.brain ?? null, target: filter.login ?? null });
    return this.deps.store.grants(filter);
  }

  /** Grants or changes `login`'s role on `brain`. API grants survive restarts; configuration grants are not managed here. */
  setGrant(actor: AdminActor, login: string, brain: string, role: string): GrantView {
    return this.mutate(actor, { action: 'grant.set', brain, target: login }, () => {
      if (!isRole(role)) throw new AdminError('invalid', `invalid role ${JSON.stringify(role)} (one of ${ROLES.join(', ')})`);
      const user = this.existingUser(login);
      this.activeBrain(brain);
      if (user.isAdmin) throw new AdminError('conflict', `${user.login} is an instance admin and already owns every brain`);
      const previous = this.deps.store.grant(login, brain);
      if (previous?.source === 'config') throw new AdminError('conflict', `the grant of ${user.login} on ${brain} comes from BRAIN_GRANTS; change it there`);
      this.deps.store.putGrant(login, brain, role, 'api');
      const meta: AuditMeta = { role };
      if (previous) meta.previousRole = previous.role;
      return { result: this.deps.store.grant(login, brain)!, meta };
    });
  }

  revokeGrant(actor: AdminActor, login: string, brain: string): void {
    this.mutate(actor, { action: 'grant.revoke', brain, target: login }, () => {
      const user = this.existingUser(login);
      if (!this.deps.store.brain(brain)) throw new AdminError('not_found', `unknown brain ${JSON.stringify(brain)}`);
      const grant = this.deps.store.grant(login, brain);
      if (!grant) throw new AdminError('not_found', `${user.login} has no grant on ${brain}`);
      if (grant.source === 'config') throw new AdminError('conflict', `the grant of ${user.login} on ${brain} comes from ${user.isAdmin ? 'ALLOWED_GITHUB_LOGINS' : 'BRAIN_GRANTS'}; change it there`);
      this.deps.store.deleteGrant(login, brain);
      return { result: undefined, meta: { role: grant.role } };
    });
  }

  // ---- Audit ----

  /**
   * A page of the audit log for the panel (#17), newest first. Reading it is
   * not audited (like the other lists); a refused reader is, as `denied`.
   */
  queryAudit(actor: AdminActor, request: AuditQueryRequest): AuditPage {
    this.authorize(actor, { action: 'audit.list', brain: null, target: null });
    const { outcome, action, actor: login, limit = AUDIT_PAGE_DEFAULT, before } = request;
    if (outcome !== undefined && !AUDIT_OUTCOMES.includes(outcome)) throw new AdminError('invalid', `outcome must be one of ${AUDIT_OUTCOMES.join(', ')}`);
    if (action !== undefined && !AUDIT_ACTION.test(action)) throw new AdminError('invalid', `invalid action ${JSON.stringify(action)}`);
    if (login !== undefined) requireLogin(login);
    if (!Number.isSafeInteger(limit) || limit < 1) throw new AdminError('invalid', 'limit must be a positive integer');
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) throw new AdminError('invalid', 'before must be a positive integer');
    for (const [name, ms] of [['from', request.fromMs], ['to', request.toMs]] as const) {
      if (ms !== undefined && !Number.isFinite(ms)) throw new AdminError('invalid', `${name} must be a date`);
    }
    const size = Math.min(limit, AUDIT_PAGE_MAX);
    const query: AuditQuery = { limit: size + 1 };
    if (request.brain !== undefined) query.brain = request.brain;
    if (action !== undefined) query.action = action;
    if (login !== undefined) query.actor = login;
    if (outcome !== undefined) query.outcome = outcome as AuditOutcome;
    if (request.fromMs !== undefined) query.fromMs = request.fromMs;
    if (request.toMs !== undefined) query.toMs = request.toMs;
    if (before !== undefined) query.before = before;
    const rows = this.deps.store.queryAudit(query);
    const more = rows.length > size;
    const page = more ? rows.slice(0, size) : rows;
    return { rows: page, nextBefore: more ? page[page.length - 1]!.id : null };
  }

  /** The audit log as CSV lines (header first), streamed; the export itself is audited. */
  exportAudit(actor: AdminActor, filter: AuditFilter = {}, options: ExportOptions = {}): Iterable<string> {
    const meta: AuditMeta = {};
    if (filter.fromMs !== undefined) meta.fromMs = filter.fromMs;
    if (filter.toMs !== undefined) meta.toMs = filter.toMs;
    const { maxRows } = options;
    this.mutate(actor, { action: 'audit.export', brain: filter.brain ?? null, target: null }, () => {
      if (maxRows !== undefined && this.deps.store.countAudit(filter, maxRows + 1) > maxRows) {
        throw new AdminError('invalid', `the export matches more than ${maxRows} rows: narrow it with from and to (or brain), or use the CLI`);
      }
      return { result: undefined, meta };
    });
    return auditCsvLines(this.deps.store.readAudit(filter));
  }

  // ---- Helpers ----

  private existingUser(login: string): UserView {
    requireLogin(login);
    const user = this.deps.store.user(login);
    if (!user) throw new AdminError('not_found', `unknown user ${JSON.stringify(login)} (invite them first)`);
    return user;
  }

  private activeBrain(slug: string): BrainView {
    const brain = this.deps.store.brain(slug);
    if (!brain) throw new AdminError('not_found', `unknown brain ${JSON.stringify(slug)}`);
    if (brain.status !== 'active') throw new AdminError('conflict', `brain ${slug} is archived`);
    return brain;
  }

  /** Deny by default: only an active instance admin (or the CLI) passes; a refused user is audited as `denied`. */
  private authorize(actor: AdminActor, op: Operation): void {
    if (actor.kind === 'system' || this.deps.store.isAdmin(actor.login)) return;
    if (this.shouldRecordDenied(actor.login, op.action)) this.record(actor, op, 'denied', this.deps.clock.nowMs(), {});
    throw new AdminError('forbidden', 'the instance admin role is required');
  }

  private shouldRecordDenied(login: string, action: string): boolean {
    const now = this.deps.clock.nowMs();
    const interval = this.deps.deniedAuditIntervalMs ?? DENIED_AUDIT_INTERVAL_MS;
    const key = `${login.toLowerCase()}\n${action}`;
    const last = this.deniedAt.get(key);
    if (last !== undefined && now - last < interval) return false;
    if (this.deniedAt.size >= DENIED_MEMORY) {
      for (const [k, at] of this.deniedAt) if (now - at >= interval) this.deniedAt.delete(k);
      // Still full of recent keys (many logins at once): forget the oldest rather than grow.
      if (this.deniedAt.size >= DENIED_MEMORY) this.deniedAt.delete(this.deniedAt.keys().next().value!);
    }
    this.deniedAt.delete(key);
    this.deniedAt.set(key, now);
    return true;
  }

  /** Runs one mutation and its audit row in one transaction; a refused one leaves an `error` row. */
  private mutate<T>(actor: AdminActor, op: Operation, work: () => { result: T; meta: AuditMeta }): T {
    this.authorize(actor, op);
    const startedAtMs = this.deps.clock.nowMs();
    try {
      return this.deps.store.transaction(() => {
        const { result, meta } = work();
        this.deps.store.audit(this.event(actor, op, 'ok', startedAtMs, meta));
        return result;
      });
    } catch (error) {
      const reason = error instanceof AdminError ? error.code : 'internal';
      this.record(actor, op, 'error', startedAtMs, { errorKind: reason });
      throw error;
    }
  }

  private record(actor: AdminActor, op: Operation, outcome: AuditOutcome, startedAtMs: number, meta: AuditMeta): void {
    this.deps.store.transaction(() => this.deps.store.audit(this.event(actor, op, outcome, startedAtMs, meta)));
  }

  private event(actor: AdminActor, op: Operation, outcome: AuditOutcome, startedAtMs: number, meta: AuditMeta) {
    return {
      atMs: startedAtMs,
      actor: auditActor(actor),
      brain: auditKey(op.brain),
      action: op.action,
      target: auditKey(op.target),
      outcome,
      durationMs: Math.max(0, Math.round(this.deps.clock.nowMs() - startedAtMs)),
      meta
    };
  }
}
