import type { AccessPolicy } from '../../auth/index.js';
import { brainOfResource } from '../domain/resource.js';
import type { ActiveBrains, GrantReader } from './ports.js';

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
 * The protected resources are `/mcp` and `/mcp/<slug>` for every active
 * brain, read from the brains table on every call (#52): a brain created at
 * runtime gets tokens at once, an archived one is refused at once.
 */
export class GrantAccessPolicy implements AccessPolicy {
  /** `base`: the bare `/mcp` resource (the default brain); `/mcp/<slug>` is brain `<slug>`. */
  constructor(private readonly grants: GrantReader, private readonly base: string, private readonly brains: ActiveBrains) {
    if (!base) throw new Error('GrantAccessPolicy needs the base resource');
  }

  /** The brain a resource is for, when that brain is served right now. */
  private activeBrainOf(resource: string): string | undefined {
    const brain = brainOfResource(resource, this.base);
    return brain !== undefined && this.brains.isActive(brain) ? brain : undefined;
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
    return resource === this.base || this.activeBrainOf(resource) !== undefined ? { name: 'Engram memory' } : undefined;
  }

  mayUse(login: string, resource: string): boolean {
    if (resource === this.base) return this.grants.grantsOf(login).length > 0;
    const brain = this.activeBrainOf(resource);
    return brain !== undefined && this.grants.roleOf(login, brain) !== undefined;
  }
}
