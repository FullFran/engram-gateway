import type { GatewayTool, GatewayToolContext, GatewayToolDefinition, GatewayToolResult } from '../domain/gateway-tool.js';

/** The gateway tools one bridge serves, looked up by name. */
export interface GatewayToolSet {
  definitions(): GatewayToolDefinition[];
  has(name: string): boolean;
  call(name: string, args: Record<string, unknown> | undefined, ctx: GatewayToolContext): Promise<GatewayToolResult>;
}

export function createGatewayToolSet(tools: readonly GatewayTool[]): GatewayToolSet {
  const byName = new Map<string, GatewayTool>();
  for (const tool of tools) {
    if (byName.has(tool.definition.name)) throw new Error(`duplicate gateway tool ${tool.definition.name}`);
    byName.set(tool.definition.name, tool);
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
 * Engram's tools in their order, then the gateway's. A gateway tool shadows an
 * engram tool of the same name, so the list matches where calls are routed.
 */
export function mergeToolLists<E extends { name: string }, G extends { name: string }>(engram: readonly E[], gateway: readonly G[]): Array<E | G> {
  const local = new Set(gateway.map(tool => tool.name));
  return [...engram.filter(tool => !local.has(tool.name)), ...gateway];
}
