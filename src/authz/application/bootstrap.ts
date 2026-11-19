import type { BrainGrant } from '../domain/brain-grant.js';
import type { GrantStore } from './ports.js';

export interface AccessConfig {
  /** `ALLOWED_GITHUB_LOGINS`: the instance admins. */
  admins: readonly string[];
  /** `BRAIN_GRANTS`: everyone else's grants. */
  grants: readonly BrainGrant[];
  /** Every brain that exists after the brains bootstrap. */
  brains: readonly string[];
}

/**
 * Makes the configuration-owned part of users and grants match the startup
 * configuration:
 * - every login in `ALLOWED_GITHUB_LOGINS` is an instance admin and `owner`
 *   of every brain (so an existing single-tenant deployment keeps working);
 * - every `BRAIN_GRANTS` entry is a grant;
 * - an admin or configured grant removed from the configuration is revoked
 *   on the next start. Grants created through the admin API (#10) are not
 *   configuration and survive restarts; a `BRAIN_GRANTS` entry for the same
 *   login and brain replaces one. Users rows are kept (the audit log points at them).
 * - a service account (#7) whose owner is no longer an instance admin is
 *   disabled (returned, for the caller to log and audit).
 * Fails loudly, changing nothing, on an unknown brain or a grant for an admin.
 */
export function bootstrapAccess(store: GrantStore, config: AccessConfig): { disabledServiceAccounts: string[] } {
  const admins = new Map(config.admins.map(login => [login.toLowerCase(), login]));
  const known = new Set(config.brains);
  for (const grant of config.grants) {
    if (!known.has(grant.brain)) throw new Error(`BRAIN_GRANTS names an unknown brain: ${JSON.stringify(grant.brain)}`);
    if (admins.has(grant.login.toLowerCase())) {
      throw new Error(`BRAIN_GRANTS: ${grant.login} is an admin (ALLOWED_GITHUB_LOGINS) and already owns every brain; remove the entry`);
    }
  }
  const owners: BrainGrant[] = [...admins.values()].flatMap(login => config.brains.map(brain => ({ login, brain, role: 'owner' as const })));
  return store.transaction(() => store.replaceConfigured({ admins: [...admins.values()], grants: [...owners, ...config.grants] }));
}
