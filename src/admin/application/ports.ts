import type { AuditEvent, AuditFilter, AuditRecord } from '../../audit/index.js';
import type { Role } from '../../authz/index.js';
import type { BrainView, GrantSource, GrantView, UserStatus, UserView } from '../domain/views.js';

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
