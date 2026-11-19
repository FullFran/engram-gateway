/**
 * Gateway tools: MCP tools the gateway serves itself (brain_health, later
 * brain_list, brain_resolve, connection_*), next to the tools of the brain's
 * `engram mcp` child. They are listed with engram's tools and run through the
 * same tool-call pipeline (authorize -> drop host paths -> redact -> handler -> audit -> wrap);
 * only the forward step differs. Each needs a role in GATEWAY_TOOL_ROLES
 * (src/authz), or it is denied like any unknown tool.
 */

/** A tool as `tools/list` shows it. */
export interface GatewayToolDefinition {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties?: Record<string, unknown>; additionalProperties?: boolean; [key: string]: unknown };
  annotations?: Record<string, unknown>;
}

/** Who made the call, as the pipeline established it; absent when auth is off. */
export interface GatewayToolCaller {
  login?: string;
  clientId?: string;
  /** The connection (#27) the call came through, on the bare `/mcp`. */
  connectionId?: number;
  /** The effective role the authorize stage decided on this brain. */
  role?: string;
}

/** What a gateway tool knows about the call: the brain it was routed to and the caller. */
export interface GatewayToolContext {
  brain: string | null;
  caller?: GatewayToolCaller;
}

/** A `tools/call` result; a tool error is `isError: true`, not a thrown error. */
export interface GatewayToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

export interface GatewayTool {
  definition: GatewayToolDefinition;
  call(args: Record<string, unknown> | undefined, ctx: GatewayToolContext): Promise<GatewayToolResult>;
}

/** A tool error result with one text item. */
export function toolError(message: string): GatewayToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}
