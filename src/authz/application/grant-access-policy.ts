import type { AccessPolicy } from '../../auth/index.js';
import { brainOfResource } from '../domain/resource.js';
import type { GrantReader } from './ports.js';

/**
 * The OAuth server's access policy backed by grants (#6):
 * - sign-in: an active user who is an admin or holds any grant; an invited
 *   one (#10) is let in and activated by that first successful sign-in;
 * - a token (issue, consent, refresh) for a brain's resource: a grant on that brain;
 * - for the bare `/mcp` resource: any grant. Its consent makes a connection
 *   (#27) whose brains are each checked per call; a token for it without a
 *   connection (issued before connections) is still checked against the
 *   default brain on every request by the MCP endpoint.
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
    return this.grants.admitSignIn(login);
  }

  signInRefusal(login: string): string | undefined {
    if (this.grants.isServiceAccount(login)) {
      return `${login} is a service account of this gateway: it uses personal access tokens and cannot sign in. If this is your GitHub account, ask an admin.`;
    }
    return undefined;
  }

  describeResource(resource: string): { name: string } | undefined {
    return this.resources.includes(resource) ? { name: 'Engram memory' } : undefined;
  }

  mayUse(login: string, resource: string): boolean {
    if (!this.resources.includes(resource)) return false;
    if (resource === this.base) return this.grants.grantsOf(login).length > 0;
    const brain = brainOfResource(resource, this.base);
    return brain !== undefined && this.grants.roleOf(login, brain) !== undefined;
  }
}
