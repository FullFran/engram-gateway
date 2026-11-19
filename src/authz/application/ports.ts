import type { BrainGrant } from '../domain/brain-grant.js';
import type { Role } from '../domain/role.js';

/** Reads access from the gateway database on every call: no cache, so a revocation applies to the next request. */
export interface GrantReader {
  /** The active user's role on `brain`; undefined without a grant (or when the user is not active). */
  roleOf(login: string, brain: string): Role | undefined;
  /** An active user who is an instance admin or holds at least one grant. */
  hasAccess(login: string): boolean;
  isAdmin(login: string): boolean;
}

/** What startup writes: the instance admins and every grant, replacing the previous ones. */
export interface AccessSnapshot {
  admins: readonly string[];
  grants: readonly BrainGrant[];
}

export interface GrantStore extends GrantReader {
  /** Every brain slug in the `brains` table. */
  brainSlugs(): string[];
  /**
   * In one transaction: `admins` become the only instance admins and `grants`
   * the only rows of `grants`. Users are created when missing, never deleted.
   */
  replaceAll(snapshot: AccessSnapshot): void;
  transaction<T>(work: () => T): T;
}
