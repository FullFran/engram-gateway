/**
 * Gateway tools: MCP tools served by the gateway itself, merged into each
 * brain's tools/list and routed before forwarding to engram, through the same
 * tool-call pipeline. Roles: GATEWAY_TOOL_ROLES in src/authz.
 */
export { toolError } from './domain/gateway-tool.js';
export type { GatewayTool, GatewayToolCaller, GatewayToolContext, GatewayToolDefinition, GatewayToolResult } from './domain/gateway-tool.js';
export { createGatewayToolSet, mergeToolLists } from './application/gateway-tool-set.js';
export type { GatewayToolSet, ToolRoleTables } from './application/gateway-tool-set.js';
export { BRAIN_HEALTH_TOOL, createBrainHealthTool } from './tools/brain-health.js';
export { BRAIN_RESOLVE_TOOL, createBrainResolveTool } from './tools/brain-resolve.js';
export type { BrainResolution, BrainResolveDeps, ResolvableConnection } from './tools/brain-resolve.js';
export { matchRemote, normalizeRemote, parseRemoteMapping } from './application/remote-mapping.js';
export type { RemoteRule } from './application/remote-mapping.js';
export { CONNECTION_TOOL_NAMES, createConnectionTools } from './tools/connection-tools.js';
export type { ConnectionAdminPort } from './tools/connection-tools.js';
