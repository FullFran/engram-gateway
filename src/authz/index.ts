/**
 * Authorization (#6): per-brain roles (reader < writer < owner) held as
 * grants, the instance admin flag, the tool-to-role table and the pure
 * decision the tool-call pipeline's authorize stage and the MCP endpoint use.
 */
export { ROLES, atLeast, isRole, weakerRole } from './domain/role.js';
export type { Role } from './domain/role.js';
export { GATEWAY_TOOL_ROLES, TOOL_ROLES, requiredRole } from './domain/tool-roles.js';
export { decideTool, effectiveRole } from './domain/decision.js';
export type { AccessGrants, DenyReason, ToolDecision } from './domain/decision.js';
export { isGitHubLogin } from './domain/brain-grant.js';
export type { BrainGrant } from './domain/brain-grant.js';
export { brainOfResource } from './domain/resource.js';
export type { AccessSnapshot, GrantReader, GrantStore } from './application/ports.js';
export { bootstrapAccess } from './application/bootstrap.js';
export type { AccessConfig } from './application/bootstrap.js';
export { createToolAccess } from './application/tool-access.js';
export type { AccessCheck, Caller, ToolAccess } from './application/tool-access.js';
export { GrantAccessPolicy } from './application/grant-access-policy.js';
export { parseAdminLogins, parseBrainGrants } from './infrastructure/env-config.js';
export { SqliteGrantRepository } from './infrastructure/sqlite-grant-repository.js';
