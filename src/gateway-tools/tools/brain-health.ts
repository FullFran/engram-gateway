import type { BrainHealthService } from '../../health/index.js';
import { toolError, type GatewayTool } from '../domain/gateway-tool.js';

export const BRAIN_HEALTH_TOOL = 'brain_health';

/**
 * `brain_health`: the read-only health report (#18) of the brain the call was
 * routed to. Owner only (GATEWAY_TOOL_ROLES). Returns the report as JSON text.
 */
export function createBrainHealthTool(health: BrainHealthService): GatewayTool {
  return {
    definition: {
      name: BRAIN_HEALTH_TOOL,
      description:
        'Health report of this brain, computed read-only from its engram.db: observation counts by type, share of automatic noise rows (checkpoint, passive, task-state), duplicate titles, unjudged pending relations and observations past review_after. Counts and sample observation ids only, never contents.',
      inputSchema: {
        type: 'object',
        properties: {
          sampleSize: { type: 'integer', minimum: 0, description: 'Sample ids per finding (default 5, at most 50).' },
          maxTypes: { type: 'integer', minimum: 0, description: 'Observation types listed (default 50, at most 200).' }
        },
        additionalProperties: false
      },
      annotations: { title: 'Brain health report', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async call(args, ctx) {
      if (ctx.brain === null) return toolError('brain_health needs a brain: call it on /mcp/<brain>');
      const lookup = health.report(ctx.brain, args);
      if (!lookup.ok) return toolError(lookup.message);
      return { content: [{ type: 'text', text: JSON.stringify(lookup.report) }] };
    }
  };
}
