import { atLeast, weakerRole } from './role.js';
import type { Role } from './role.js';
import { requiredRole } from './tool-roles.js';

/**
 * What a call may do on one brain, from two layers:
 * - `user`: the signed-in user's grant on the brain (absent: no grant).
 * - `connection`: the client connection's role on the brain (#27). `undefined`
 *   means the connection layer does not apply yet and the connection is the
 *   user; `null` means the connection has no access to the brain.
 */
export interface AccessGrants {
  user?: Role;
  connection?: Role | null;
}

export type DenyReason = 'no_grant' | 'unknown_tool' | 'insufficient_role';

export type ToolDecision =
  | { allowed: true; role: Role }
  | { allowed: false; reason: 'no_grant' }
  | { allowed: false; reason: 'unknown_tool'; role: Role }
  | { allowed: false; reason: 'insufficient_role'; role: Role; required: Role };

/** The effective role: the weaker of the two layers; a connection never exceeds its user. */
export function effectiveRole(grants: AccessGrants): Role | undefined {
  if (!grants.user || grants.connection === null) return undefined;
  return grants.connection === undefined ? grants.user : weakerRole(grants.user, grants.connection);
}

/** May a caller with these grants call `tool`? Pure: no I/O, no clock. */
export function decideTool(grants: AccessGrants, tool: string): ToolDecision {
  const role = effectiveRole(grants);
  if (!role) return { allowed: false, reason: 'no_grant' };
  const required = requiredRole(tool);
  if (!required) return { allowed: false, reason: 'unknown_tool', role };
  if (!atLeast(role, required)) return { allowed: false, reason: 'insufficient_role', role, required };
  return { allowed: true, role };
}
