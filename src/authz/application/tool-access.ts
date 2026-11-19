import { decideTool } from '../domain/decision.js';
import type { DenyReason } from '../domain/decision.js';
import type { GrantReader } from './ports.js';

export type AccessCheck = { allowed: true } | { allowed: false; reason: DenyReason | 'no_caller' };

/** Who is calling, as the tool-call pipeline knows it. */
export interface Caller {
  login?: string;
}

export interface ToolAccess {
  /** May `caller` call `tool` on `brain`? Reads the grant on every call. */
  check(caller: Caller | undefined, brain: string | null | undefined, tool: string): AccessCheck;
}

/**
 * Tool access backed by the grants table. The decision itself is the pure
 * `decideTool`; the connection layer (#27) is not modelled yet, so a call has
 * exactly its user's role.
 */
export function createToolAccess(grants: GrantReader): ToolAccess {
  return {
    check(caller, brain, tool) {
      if (!caller?.login || !brain) return { allowed: false, reason: 'no_caller' };
      const user = grants.roleOf(caller.login, brain);
      const decision = decideTool(user ? { user } : {}, tool);
      return decision.allowed ? { allowed: true } : { allowed: false, reason: decision.reason };
    }
  };
}
