import { parseBrainSlug } from '../../brains/index.js';
import { isGitHubLogin } from '../domain/brain-grant.js';
import type { BrainGrant } from '../domain/brain-grant.js';
import { ROLES, isRole } from '../domain/role.js';

/**
 * `BRAIN_GRANTS`: comma-separated `login:brain:role` entries, e.g.
 * `alice:work:reader,bob:default:writer`. Roles: reader, writer, owner.
 * A login may appear once per brain. Unset or empty: no grants.
 */
export function parseBrainGrants(raw: string | undefined): BrainGrant[] {
  const grants: BrainGrant[] = [];
  const seen = new Set<string>();
  for (const item of (raw ?? '').split(',')) {
    const entry = item.trim();
    if (!entry) continue;
    const parts = entry.split(':').map(part => part.trim());
    if (parts.length !== 3) throw new Error(`BRAIN_GRANTS: ${JSON.stringify(entry)} is not login:brain:role`);
    const [login, brain, role] = parts as [string, string, string];
    if (!isGitHubLogin(login)) throw new Error(`BRAIN_GRANTS: invalid GitHub login ${JSON.stringify(login)}`);
    const slug = parseBrainSlug(brain);
    if (!slug.ok) throw new Error(`BRAIN_GRANTS: invalid brain slug ${JSON.stringify(brain)} (${slug.reason})`);
    if (!isRole(role)) throw new Error(`BRAIN_GRANTS: invalid role ${JSON.stringify(role)} (one of ${ROLES.join(', ')})`);
    const key = `${login.toLowerCase()}:${brain}`;
    if (seen.has(key)) throw new Error(`BRAIN_GRANTS: ${login} is listed twice for brain ${brain}`);
    seen.add(key);
    grants.push({ login, brain, role });
  }
  return grants;
}

/**
 * `ALLOWED_GITHUB_LOGINS` as the instance admin list (the auth config has
 * already validated it), case preserved, duplicates (case-insensitive) dropped.
 */
export function parseAdminLogins(raw: string | undefined): string[] {
  const seen = new Set<string>();
  const admins: string[] = [];
  for (const item of (raw ?? '').split(',')) {
    const login = item.trim();
    if (!login || seen.has(login.toLowerCase())) continue;
    seen.add(login.toLowerCase());
    admins.push(login);
  }
  return admins;
}
