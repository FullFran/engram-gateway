import type { BrainGrant } from '../domain/brain-grant.js';
import type { Role } from '../domain/role.js';

/** Reads access from the gateway database on every call: no cache, so a revocation applies to the next request. */
export interface GrantReader {
  /** The active user's role on `brain`; undefined without a grant (or when the user is not active). */
  roleOf(login: string, brain: string): Role | undefined;
  /** An active user who is an instance admin or holds at least one grant. */
  hasAccess(login: string): boolean;
  isAdmin(login: string): boolean;
  /**
   * The sign-in gate: `hasAccess`, except that an invited user (#10) with
   * access is let in and becomes active (the first successful sign-in
   * activates an invite). A disabled user is refused.
   */
  admitSignIn(login: string): boolean;
  /** A service account (#7): a non-human principal that never signs in. */
  isServiceAccount(login: string): boolean;
  /** Every grant of the active user on a brain that is not archived, sorted by brain; empty for an unknown or inactive user. */
  grantsOf(login: string): { brain: string; role: Role }[];
}

/** What startup writes: the instance admins and the configured grants, replacing the previous configured ones. */
export interface AccessSnapshot {
  admins: readonly string[];
  grants: readonly BrainGrant[];
}

export interface GrantStore extends GrantReader {
  /** Every brain slug in the `brains` table. */
  brainSlugs(): string[];
  /**
   * `admins` become the only instance admins and `grants` the only
   * configuration grants (`source = 'config'`); grants created through the
   * admin API (`source = 'api'`) are kept unless a configured grant names the
   * same user and brain. Users are created when missing, never deleted.
   * Service accounts (#7) whose owner is no longer an active instance admin
   * are disabled; their logins are returned. Callers run it inside `transaction`.
   */
  replaceConfigured(snapshot: AccessSnapshot): { disabledServiceAccounts: string[] };
  transaction<T>(work: () => T): T;
}
