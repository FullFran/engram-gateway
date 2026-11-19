import { decideTool } from '../domain/decision.js';
import type { DenyReason } from '../domain/decision.js';
import type { Role } from '../domain/role.js';
import type { GrantReader } from './ports.js';

export type AccessCheck = { allowed: true; role: Role } | { allowed: false; reason: DenyReason | 'no_caller' };

/** Who is calling, as the tool-call pipeline knows it. */
export interface Caller {
  login?: string;
  /** The connection (#27) the call came through; absent for a single-brain token. */
  connectionId?: number;
}

/** The connection layer (#27): a connection's role on a brain, `null` when not attached, `undefined` when there is no such connection. */
export interface ConnectionRoles {
  roleOn(connectionId: number, brain: string): Role | null | undefined;
}

export interface ToolAccess {
  /** May `caller` call `tool` on `brain`? Reads the grants on every call. */
  check(caller: Caller | undefined, brain: string | null | undefined, tool: string): AccessCheck;
}

/**
 * Tool access backed by the grants table and, for a call through a
 * connection (#27), the connection's role on the brain. The decision itself
 * is the pure `decideTool`: the effective role is the weaker of the two
 * layers. A call without a connection has exactly its user's role. A
 * connection that no longer exists has no access (fail closed).
 */
export function createToolAccess(grants: GrantReader, connections?: ConnectionRoles): ToolAccess {
  return {
    check(caller, brain, tool) {
      if (!caller?.login || !brain) return { allowed: false, reason: 'no_caller' };
      const user = grants.roleOf(caller.login, brain);
      const connection = caller.connectionId === undefined ? undefined : connections?.roleOn(caller.connectionId, brain) ?? null;
      const decision = decideTool({ ...(user ? { user } : {}), ...(connection !== undefined ? { connection } : {}) }, tool);
      return decision.allowed ? { allowed: true, role: decision.role } : { allowed: false, reason: decision.reason };
    }
  };
}
