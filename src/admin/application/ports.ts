import type { BrainHealthLookup } from '../../health/index.js';
import type { AuditEvent, AuditFilter, AuditRecord } from '../../audit/index.js';
import type { Role } from '../../authz/index.js';
import type { AdminActor } from '../domain/admin-actor.js';
import type { BrainView, GrantSource, GrantView, ServiceAccountView, UserStatus, UserView } from '../domain/views.js';

/**
 * The gateway database as the admin use cases see it. Every mutation of one
 * use case and its audit row run inside one `transaction` (#8).
 */
export interface AdminStore {
  transaction<T>(work: () => T): T;
  /** An active instance admin (ALLOWED_GITHUB_LOGINS). */
  isAdmin(login: string): boolean;

  brain(slug: string): BrainView | undefined;
  brains(): BrainView[];
  /** Inserts an active brain and makes every instance admin its owner (a configuration grant, as at startup). */
  createBrain(slug: string, dataDir: string): void;
  archiveBrain(slug: string): void;

  user(login: string): UserView | undefined;
  users(): UserView[];
  insertUser(login: string, status: UserStatus): void;
  setUserStatus(login: string, status: UserStatus): void;
  /** Inserts an active service account owned by `owner` (#7). */
  insertServiceAccount(login: string, owner: string): void;
  serviceAccounts(): ServiceAccountView[];

  grant(login: string, brain: string): GrantView | undefined;
  grants(filter: { brain?: string; login?: string }): GrantView[];
  putGrant(login: string, brain: string, role: Role, source: GrantSource): void;
  deleteGrant(login: string, brain: string): void;

  /** Appends one audit row inside the open transaction. */
  audit(event: AuditEvent): void;
  /** Reads audit rows oldest first, lazily. */
  readAudit(filter: AuditFilter): Iterable<AuditRecord>;
  /** How many audit rows match, counting no further than `upTo`. */
  countAudit(filter: AuditFilter, upTo: number): number;
}

/** Brain data directories on disk. */
export interface BrainDirectories {
  /** `BRAINS_ROOT`, the directory holding `<slug>/`; undefined when not configured. */
  root: string | undefined;
  /** Creates `dir` (owner-only), refusing one that already exists and is not empty. */
  prepare(dir: string): void;
}

/** The running gateway's brain registry; absent in the CLI. */
export interface BrainRuntime {
  /** Stops the brain's child (if any); settles once it has exited. */
  stop(slug: string): Promise<void>;
  status(slug: string): { live: boolean; idle: boolean };
}

export interface AdminClock {
  nowMs(): number;
}

/**
 * Personal access tokens (#7) as the admin use cases see them, for service
 * accounts. Results are JSON-ready and never hold a secret, except the
 * `token` of a creation. Refusals throw an error whose `code` is `invalid`,
 * `not_found` or `conflict`. The tokens module audits these operations itself.
 */
export interface AdminTokens {
  list(owner: string): object[];
  create(actor: AdminActor, owner: string, request: { name: unknown; brains: unknown; scope: unknown; expiresInDays: unknown }): { token: string; id: number };
  revoke(actor: AdminActor, owner: string, id: number): object;
}

/** A brain's health report (#18): the admin layer authorizes and audits reading it. */
export interface AdminBrainHealth {
  report(brain: string): BrainHealthLookup;
}
