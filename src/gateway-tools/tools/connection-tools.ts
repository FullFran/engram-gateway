import type { AttachOutcome, AttachableBrain, ConnectionView } from '../../connections/index.js';
import type { Role } from '../../authz/index.js';
import { toolError } from '../domain/gateway-tool.js';
import type { GatewayTool, GatewayToolContext, GatewayToolResult } from '../domain/gateway-tool.js';

/** What the connection tools need (src/connections `ConnectionAdmin`). */
export interface ConnectionAdminPort {
  describe(connectionId: number): ConnectionView | undefined;
  attachable(connectionId: number): AttachableBrain[] | undefined;
  attach(connectionId: number, brain: string, role: Role, makeDefault: boolean): AttachOutcome;
  detach(connectionId: number, brain: string): AttachOutcome;
}

export const CONNECTION_TOOL_NAMES = ['brain_list', 'connection_brains', 'connection_attach', 'connection_detach'] as const;

const json = (value: unknown): GatewayToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const done = (outcome: AttachOutcome, message: string): GatewayToolResult => outcome.ok ? json({ ok: true, message }) : toolError(outcome.message);

/** The connection the call came through; only the connection server sets it. */
function connectionOf(ctx: GatewayToolContext): number | undefined {
  return ctx.caller?.connectionId;
}

const NO_CONNECTION = 'This tool only works on a connection (the bare /mcp endpoint).';

/**
 * The connection tools (#27), served on the bare `/mcp` next to the brain
 * tools. They act on the caller's own connection (from the call context,
 * never from an argument), and the connection server authorizes them before
 * they run (src/connections `ConnectionAdmin.check`): attach and detach are
 * for `oauth` connections, and attach never exceeds the owner's grant.
 */
export function createConnectionTools(admin: ConnectionAdminPort): GatewayTool[] {
  const brain = { type: 'string', description: 'The brain slug.' };
  return [
    {
      definition: {
        name: 'brain_list',
        description: 'List the brains this connection can use: the connection\'s role on each, the effective role (never above your own grant) and the default brain.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true }
      },
      async call(_args, ctx) {
        const id = connectionOf(ctx);
        const view = id === undefined ? undefined : admin.describe(id);
        return view ? json(view) : toolError(NO_CONNECTION);
      }
    },
    {
      definition: {
        name: 'connection_brains',
        description: 'List the brains you have access to, with the highest role this connection could get on each and its current role when attached.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true }
      },
      async call(_args, ctx) {
        const id = connectionOf(ctx);
        const brains = id === undefined ? undefined : admin.attachable(id);
        return brains ? json({ brains }) : toolError(NO_CONNECTION);
      }
    },
    {
      definition: {
        name: 'connection_attach',
        description: 'Attach a brain to this connection with a role (at most your own role there), or change the role of an attached brain. Applies to the next request.',
        inputSchema: {
          type: 'object',
          properties: {
            brain,
            role: { type: 'string', enum: ['reader', 'writer', 'owner'], description: 'The connection\'s role on the brain.' },
            default: { type: 'boolean', description: 'Also make it the default brain (calls that name no brain go there).' }
          },
          required: ['brain', 'role'],
          additionalProperties: false
        },
        annotations: { destructiveHint: false, idempotentHint: true }
      },
      async call(args, ctx) {
        const id = connectionOf(ctx);
        if (id === undefined) return toolError(NO_CONNECTION);
        const { brain: slug, role, default: makeDefault } = args as { brain: string; role: Role; default?: boolean };
        return done(admin.attach(id, slug, role, makeDefault === true), `Brain ${slug} attached as ${role}.`);
      }
    },
    {
      definition: {
        name: 'connection_detach',
        description: 'Detach a brain from this connection. Applies to the next request; detaching the default brain leaves the connection without one.',
        inputSchema: { type: 'object', properties: { brain }, required: ['brain'], additionalProperties: false },
        annotations: { destructiveHint: true, idempotentHint: true }
      },
      async call(args, ctx) {
        const id = connectionOf(ctx);
        if (id === undefined) return toolError(NO_CONNECTION);
        const { brain: slug } = args as { brain: string };
        return done(admin.detach(id, slug), `Brain ${slug} detached.`);
      }
    }
  ];
}
