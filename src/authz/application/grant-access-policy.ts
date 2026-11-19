import type { AccessPolicy } from '../../auth/index.js';
import { brainOfResource } from '../domain/resource.js';
import type { GrantReader } from './ports.js';

/**
 * The OAuth server's access policy backed by grants (#6):
 * - sign-in: an active user who is an admin or holds any grant;
 * - a token (issue, consent, refresh) for a brain's resource: a grant on that brain.
 * A token already issued is checked per request by the MCP endpoint, which
 * answers 403 once the grant is gone.
 */
export class GrantAccessPolicy implements AccessPolicy {
  private readonly base: string;

  /** `resources`: the configured protected resources; the first is `/mcp` (the default brain). */
  constructor(private readonly grants: GrantReader, private readonly resources: readonly string[]) {
    if (resources.length === 0) throw new Error('GrantAccessPolicy needs the configured resources');
    this.base = resources[0]!;
  }

  maySignIn(login: string): boolean {
    return this.grants.hasAccess(login);
  }

  describeResource(resource: string): { name: string } | undefined {
    return this.resources.includes(resource) ? { name: 'Engram memory' } : undefined;
  }

  mayUse(login: string, resource: string): boolean {
    if (!this.resources.includes(resource)) return false;
    const brain = brainOfResource(resource, this.base);
    return brain !== undefined && this.grants.roleOf(login, brain) !== undefined;
  }
}
