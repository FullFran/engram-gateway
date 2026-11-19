import { CONNECTION_TOOL_KINDS } from '../../authz/domain/tool-roles.js';
import { parseBrainSlug } from '../../brains/domain/brain.js';
import { atLeast, weakerRole } from '../../authz/domain/role.js';
import type { Role } from '../../authz/domain/role.js';
import type { Connection, ConnectionKind } from '../domain/connection.js';
import { parseConnectionTool } from '../domain/connection-tools.js';
import type { ConnectionStore } from './ports.js';

/** The owner's grants, as the connection tools read them (src/authz `GrantReader`). */
export interface OwnerGrants {
  roleOf(login: string, brain: string): Role | undefined;
  grantsOf(login: string): { brain: string; role: Role }[];
}

/**
 * Whether a connection may make a connection tool call, decided before the
 * call runs. `brain` is the brain the call acts on (audited), `null` for a
 * call on the whole connection or when the argument is not a valid brain
 * name. `role` is the role an attach asks for (audited).
 */
export type ConnectionToolCheck =
  | { kind: 'invalid'; message: string }
  | { kind: 'denied'; brain: string | null; role?: Role; reason: 'connection_kind' | 'no_grant' | 'insufficient_role' }
  | { kind: 'allowed'; brain: string | null; role?: Role };

/** The access side of the connection tools, as the connection server uses it. */
export interface ConnectionToolAccess {
  /** Is `tool` listed for a connection of this kind? */
  visible(kind: ConnectionKind, tool: string): boolean;
  check(connection: Connection, tool: string, args: unknown): ConnectionToolCheck;
}

export interface ConnectionView {
  connection: string;
  defaultBrain: string | null;
  /**
   * The brains the connection can use now. `effectiveRole`: the weaker of the
   * owner's grant and the connection's role. A brain whose grant the owner
   * lost (or that was archived) is left out, and so is such a default brain.
   */
  brains: { brain: string; role: Role; effectiveRole: Role }[];
}

export interface AttachableBrain {
  brain: string;
  /** The highest role the connection may get there: the owner's grant. */
  maxRole: Role;
  /** The connection's role there, when attached. */
  attached?: Role;
}

export type AttachOutcome = { ok: true } | { ok: false; message: string };

/**
 * The connection tools' use cases (#27): read a connection, list what its
 * owner could attach, and attach or detach a brain. A connection never
 * exceeds its owner: attach is capped by the owner's grant, checked when the
 * call is authorized and again when it is written. Attach and detach also
 * need the owner role on the connection: `owner` on at least one of its
 * brains, which the owner still holds there (a connection consented with
 * reader or writer only cannot widen or reshape itself).
 */
export class ConnectionAdmin implements ConnectionToolAccess {
  constructor(private readonly grants: OwnerGrants, private readonly store: ConnectionStore) {}

  visible(kind: ConnectionKind, tool: string): boolean {
    return Object.hasOwn(CONNECTION_TOOL_KINDS, tool) && CONNECTION_TOOL_KINDS[tool]!.includes(kind);
  }

  check(connection: Connection, tool: string, args: unknown): ConnectionToolCheck {
    const parsed = parseConnectionTool(tool, args);
    if (!parsed.ok) return { kind: 'invalid', message: parsed.message };
    const call = parsed.args;
    // Audited as given only when it is a valid brain name: free text never reaches the log.
    const brain = 'brain' in call && parseBrainSlug(call.brain).ok ? call.brain : null;
    const role = call.tool === 'connection_attach' ? { role: call.role } : {};
    if (!this.visible(connection.kind, tool)) return { kind: 'denied', brain, ...role, reason: 'connection_kind' };
    if (call.tool === 'connection_attach' || call.tool === 'connection_detach') {
      if (!this.managesItself(connection)) return { kind: 'denied', brain, ...role, reason: 'insufficient_role' };
    }
    if (call.tool === 'connection_attach') {
      const max = this.grants.roleOf(connection.login, call.brain);
      if (!max) return { kind: 'denied', brain, ...role, reason: 'no_grant' };
      if (!atLeast(max, call.role)) return { kind: 'denied', brain, ...role, reason: 'insufficient_role' };
    }
    return { kind: 'allowed', brain, ...role };
  }

  /** The owner role on the connection: `owner` on one of its brains, still granted to its owner. */
  private managesItself(connection: Connection): boolean {
    return connection.brains.some(({ brain, role }) => role === 'owner' && this.grants.roleOf(connection.login, brain) === 'owner');
  }

  describe(connectionId: number): ConnectionView | undefined {
    const connection = this.store.get(connectionId);
    if (!connection) return undefined;
    const brains = connection.brains.flatMap(({ brain, role }) => {
      const grant = this.grants.roleOf(connection.login, brain);
      return grant ? [{ brain, role, effectiveRole: weakerRole(grant, role) }] : [];
    });
    const defaultBrain = brains.some(b => b.brain === connection.defaultBrain) ? connection.defaultBrain! : null;
    return { connection: connection.name, defaultBrain, brains };
  }

  attachable(connectionId: number): AttachableBrain[] | undefined {
    const connection = this.store.get(connectionId);
    if (!connection) return undefined;
    const attached = new Map(connection.brains.map(b => [b.brain, b.role]));
    return this.grants.grantsOf(connection.login)
      .map(({ brain, role }) => ({ brain, maxRole: role, ...(attached.has(brain) ? { attached: attached.get(brain)! } : {}) }))
      .sort((a, b) => a.brain.localeCompare(b.brain));
  }

  attach(connectionId: number, brain: string, role: Role, makeDefault: boolean): AttachOutcome {
    const connection = this.store.get(connectionId);
    if (!connection) return { ok: false, message: 'This connection no longer exists.' };
    const verdict = this.check(connection, 'connection_attach', { brain, role, default: makeDefault });
    if (verdict.kind !== 'allowed') return { ok: false, message: `Cannot attach brain ${brain} as ${role}.` };
    this.store.attach(connectionId, brain, role, makeDefault);
    return { ok: true };
  }

  detach(connectionId: number, brain: string): AttachOutcome {
    return this.store.detach(connectionId, brain) ? { ok: true } : { ok: false, message: `Brain ${brain} is not attached to this connection.` };
  }
}
