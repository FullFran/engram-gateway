import type { AuditEvent } from '../../audit/domain/audit-event.js';
import { atLeast, isRole } from '../../authz/domain/role.js';
import type { Role } from '../../authz/domain/role.js';
import type { Connection } from '../domain/connection.js';
import { ConnectionAdmin } from './connection-admin.js';
import type { AttachableBrain, OwnerGrants } from './connection-admin.js';
import type { ConnectionStore } from './ports.js';

export type OwnConnectionErrorCode = 'invalid' | 'not_found';

/** A refusal of a connection change; `message` is safe to show to the user. */
export class OwnConnectionError extends Error {
  constructor(readonly code: OwnConnectionErrorCode, message: string) {
    super(message);
  }
}

/** One of the user's OAuth connections, as their panel shows it. */
export interface OwnConnectionView {
  id: number;
  name: string;
  clientId: string | null;
  /** Null when the default brain was detached or its grant lost. */
  defaultBrain: string | null;
  /** The brains it can use now; `effectiveRole`: the weaker of the owner's grant and the connection's role. */
  brains: { brain: string; role: Role; effectiveRole: Role }[];
  /** Every brain the owner holds a grant on, with the connection's role there when attached. */
  attachable: AttachableBrain[];
}

/** The person acting: the signed-in owner. */
export interface OwnConnectionActor {
  kind: 'user';
  login: string;
}

export interface OwnConnectionsDeps {
  store: ConnectionStore;
  grants: OwnerGrants;
  clock: { nowMs(): number };
}

const sameLogin = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * A signed-in user managing their own OAuth connections (#27) from the web
 * panel (#17). The owner decides here as on the consent page, so a brain may
 * be attached with any role up to the owner's own grant, which is read now;
 * a connection never exceeds its owner. Token connections (PATs, #7) are
 * managed as tokens, not here. Every change is audited in the same write.
 */
export class OwnConnections {
  private readonly reader: ConnectionAdmin;

  constructor(private readonly deps: OwnConnectionsDeps) {
    this.reader = new ConnectionAdmin(deps.grants, deps.store);
  }

  list(login: string): OwnConnectionView[] {
    return this.deps.store.listOwned(login).filter(connection => connection.kind === 'oauth').map(connection => this.view(connection));
  }

  attach(actor: OwnConnectionActor, connectionId: number, brain: string, role: unknown, makeDefault: boolean): void {
    const connection = this.owned(actor, connectionId);
    if (!isRole(role)) throw new OwnConnectionError('invalid', 'role must be reader, writer or owner');
    const grant = this.deps.grants.roleOf(actor.login, brain);
    if (!grant) throw new OwnConnectionError('invalid', `you hold no grant on brain ${brain}`);
    if (!atLeast(grant, role)) throw new OwnConnectionError('invalid', `you are ${grant} on brain ${brain}: a connection cannot get more`);
    this.deps.store.attach(connection.id, brain, role, makeDefault, this.event(actor, 'connection.attach', connection.id, brain, { role, default: makeDefault }));
  }

  detach(actor: OwnConnectionActor, connectionId: number, brain: string): void {
    const connection = this.owned(actor, connectionId);
    if (!this.deps.store.detach(connection.id, brain, this.event(actor, 'connection.detach', connection.id, brain, {}))) {
      throw new OwnConnectionError('not_found', `brain ${brain} is not attached to this connection`);
    }
  }

  /** The actor's own OAuth connection, or not found (whose it is, if anyone's, is not told). */
  private owned(actor: OwnConnectionActor, connectionId: number): Connection {
    const connection = Number.isSafeInteger(connectionId) ? this.deps.store.get(connectionId) : undefined;
    if (!connection || connection.kind !== 'oauth' || !sameLogin(connection.login, actor.login)) {
      throw new OwnConnectionError('not_found', 'no such connection');
    }
    return connection;
  }

  /** Same reading as the connection tools (`connection_brains`): one rule for effective roles and attachable brains. */
  private view(connection: Connection): OwnConnectionView {
    const described = this.reader.describe(connection.id)!;
    return {
      id: connection.id,
      name: connection.name,
      clientId: connection.clientId ?? null,
      defaultBrain: described.defaultBrain,
      brains: described.brains,
      attachable: this.reader.attachable(connection.id)!
    };
  }

  private event(actor: OwnConnectionActor, action: string, connectionId: number, brain: string, meta: AuditEvent['meta']): AuditEvent {
    return {
      atMs: this.deps.clock.nowMs(), actor: { kind: 'user', login: actor.login }, brain, action,
      target: `connection-${connectionId}`, outcome: 'ok', durationMs: null, meta: { connectionId, ...meta }
    };
  }
}
