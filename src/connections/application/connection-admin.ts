import { CONNECTION_TOOL_KINDS } from '../../authz/domain/tool-roles.js';
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
 * call on the whole connection.
 */
export type ConnectionToolCheck =
  | { kind: 'invalid'; message: string }
  | { kind: 'denied'; brain: string | null; reason: 'connection_kind' | 'no_grant' | 'insufficient_role' }
  | { kind: 'allowed'; brain: string | null };

/** The access side of the connection tools, as the connection server uses it. */
export interface ConnectionToolAccess {
  /** Is `tool` listed for a connection of this kind? */
  visible(kind: ConnectionKind, tool: string): boolean;
  check(connection: Connection, tool: string, args: unknown): ConnectionToolCheck;
}

export interface ConnectionView {
  connection: string;
  defaultBrain: string | null;
  /** `effectiveRole`: the weaker of the owner's grant and the connection's role; `null` once the owner lost the grant. */
  brains: { brain: string; role: Role; effectiveRole: Role | null }[];
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
 * call is authorized and again when it is written.
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
    const brain = 'brain' in call ? call.brain : null;
    if (!this.visible(connection.kind, tool)) return { kind: 'denied', brain, reason: 'connection_kind' };
    if (call.tool === 'connection_attach') {
      const max = this.grants.roleOf(connection.login, call.brain);
      if (!max) return { kind: 'denied', brain, reason: 'no_grant' };
      if (!atLeast(max, call.role)) return { kind: 'denied', brain, reason: 'insufficient_role' };
    }
    return { kind: 'allowed', brain };
  }

  describe(connectionId: number): ConnectionView | undefined {
    const connection = this.store.get(connectionId);
    if (!connection) return undefined;
    return {
      connection: connection.name,
      defaultBrain: connection.defaultBrain ?? null,
      brains: connection.brains.map(({ brain, role }) => {
        const grant = this.grants.roleOf(connection.login, brain);
        return { brain, role, effectiveRole: grant ? weakerRole(grant, role) : null };
      })
    };
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
