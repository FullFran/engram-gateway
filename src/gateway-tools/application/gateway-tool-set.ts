import type { GatewayTool, GatewayToolContext, GatewayToolDefinition, GatewayToolResult } from '../domain/gateway-tool.js';

/** The gateway tools one bridge serves, looked up by name. */
export interface GatewayToolSet {
  definitions(): GatewayToolDefinition[];
  has(name: string): boolean;
  call(name: string, args: Record<string, unknown> | undefined, ctx: GatewayToolContext): Promise<GatewayToolResult>;
}

/** The role tables a tool set is checked against at startup (src/authz `TOOL_ROLES`, `GATEWAY_TOOL_ROLES`). */
export interface ToolRoleTables {
  engram: Readonly<Record<string, unknown>>;
  gateway: Readonly<Record<string, unknown>>;
}

/**
 * Builds the set and fails startup when a tool is unsafe to serve:
 * - its name is an engram tool: it would shadow it and take over its role;
 * - it has no role in GATEWAY_TOOL_ROLES: with auth on it would be denied to
 *   everyone, and with auth off (allow-all pipeline) it would run unchecked.
 */
export function createGatewayToolSet(tools: readonly GatewayTool[], roles: ToolRoleTables): GatewayToolSet {
  const byName = new Map<string, GatewayTool>();
  for (const tool of tools) {
    const name = tool.definition.name;
    if (byName.has(name)) throw new Error(`duplicate gateway tool ${name}`);
    if (Object.hasOwn(roles.engram, name)) throw new Error(`gateway tool ${name} shadows an engram tool; pick another name`);
    if (!Object.hasOwn(roles.gateway, name)) throw new Error(`gateway tool ${name} has no role in GATEWAY_TOOL_ROLES`);
    byName.set(name, tool);
  }
  return {
    definitions: () => [...byName.values()].map(tool => tool.definition),
    has: name => byName.has(name),
    async call(name, args, ctx) {
      const tool = byName.get(name);
      if (!tool) throw new Error(`${name} is not a gateway tool`);
      return tool.call(args, ctx);
    }
  };
}

/**
 * Engram's tools in their order, then the gateway's. Names never collide in a
 * checked set; if engram ever adds a tool with a gateway tool's name, the
 * gateway's entry wins so the list matches where calls are routed.
 */
export function mergeToolLists<E extends { name: string }, G extends { name: string }>(engram: readonly E[], gateway: readonly G[]): Array<E | G> {
  const local = new Set(gateway.map(tool => tool.name));
  return [...engram.filter(tool => !local.has(tool.name)), ...gateway];
}
