import type { ConnectionAcceptance, ConnectionAnswer, ConnectionConsent, ConnectionOffer, ConsentClient } from '../../auth/index.js';
import type { GrantReader } from '../../authz/application/ports.js';
import { isRole } from '../../authz/domain/role.js';
import type { Role } from '../../authz/domain/role.js';
import { checkChoice, describeProblem, rolesUpTo } from '../domain/connection.js';
import type { ConnectionBrain } from '../domain/connection.js';
import { ConnectionNameTakenError } from './ports.js';
import type { ConnectionStore } from './ports.js';

/** The answer's value for a brain left out of the connection. */
export const NO_ROLE = 'none';

/**
 * The consent screen's connection step (#27), for grants on the bare MCP
 * endpoint (`resource`, the one that serves several brains). Grants on
 * `/mcp/<slug>` stay single-brain tokens without a connection.
 *
 * Offer: every brain the person holds a grant on, with the roles up to
 * theirs. Preselected: the existing connection of this client when there is
 * one, else `preferredBrain` (or the first granted brain) as reader: least
 * privilege by default, since an owner connection can attach more brains by
 * itself (connection_attach). The person raises the role on the form.
 */
export class ConnectionConsentService implements ConnectionConsent {
  constructor(
    private readonly grants: GrantReader,
    private readonly connections: ConnectionStore,
    private readonly multiBrainResource: string,
    private readonly preferredBrain: string
  ) {}

  offer(login: string, resource: string, client: ConsentClient): ConnectionOffer | undefined {
    if (resource !== this.multiBrainResource) return undefined;
    const owned = this.grants.grantsOf(login);
    const existing = this.connections.findOAuth(login, client.clientId);
    const fallback = owned.find(grant => grant.brain === this.preferredBrain) ?? owned[0];
    const selected = existing
      ? new Map(existing.brains.map(({ brain, role }) => [brain, role]))
      : new Map<string, Role>(fallback ? [[fallback.brain, 'reader']] : []);
    const defaultBrain = existing ? existing.defaultBrain : fallback?.brain;
    return {
      name: existing?.name ?? defaultName(client, login),
      ...(defaultBrain ? { defaultBrain } : {}),
      brains: owned.map(({ brain, role }) => {
        const pick = selected.get(brain);
        // Preselect at most what the person holds now.
        const capped = pick && rolesUpTo(role).includes(pick) ? pick : pick ? role : undefined;
        return { brain, roles: rolesUpTo(role), ...(capped ? { selected: capped } : {}) };
      })
    };
  }

  accept(login: string, resource: string, client: ConsentClient, answer: ConnectionAnswer): ConnectionAcceptance {
    if (resource !== this.multiBrainResource) return { ok: false, message: 'This resource does not take a connection.' };
    const brains: ConnectionBrain[] = [];
    for (const [brain, role] of Object.entries(answer.roles)) {
      if (role === NO_ROLE) continue;
      if (!isRole(role)) return { ok: false, message: `Unknown role for brain ${brain}.` };
      brains.push({ brain, role });
    }
    const owned = new Map<string, Role>(this.grants.grantsOf(login).map(({ brain, role }) => [brain, role]));
    const checked = checkChoice({ name: (answer.name ?? '').trim(), defaultBrain: answer.defaultBrain ?? '', brains }, owned);
    if (!checked.ok) return { ok: false, message: describeProblem(checked) };
    try {
      return { ok: true, connectionId: this.connections.saveOAuth(login, client.clientId, checked.choice) };
    } catch (error) {
      if (error instanceof ConnectionNameTakenError) return { ok: false, message: `You already have a connection named ${error.connectionName}; choose another name.` };
      throw error;
    }
  }
}

/** `<client name> <login>`, with the characters a connection name cannot hold removed. */
function defaultName(client: ConsentClient, login: string): string {
  const base = (client.clientName ?? '').replace(/[^A-Za-z0-9 ._:@/-]/g, '').replace(/^[^A-Za-z0-9]+/, '').trim() || 'oauth-client';
  return `${base.slice(0, 63 - login.length).trim()} ${login}`;
}
