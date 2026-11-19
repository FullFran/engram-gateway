import type { GatewayTool } from '../domain/gateway-tool.js';
import { matchRemote, normalizeRemote, type RemoteRule } from '../application/remote-mapping.js';

export const BRAIN_RESOLVE_TOOL = 'brain_resolve';

/** A connection as `brain_resolve` reads it: the same view `brain_list` shows (#27). */
export interface ResolvableConnection {
  defaultBrain: string | null;
  /** `effectiveRole` is `null` once the owner lost the grant: that brain is not usable. */
  brains: { brain: string; effectiveRole: string | null }[];
}

export interface BrainResolveDeps {
  /** The `BRAIN_REMOTES` mapping. */
  rules: readonly RemoteRule[];
  /** The caller's connection by id (`ConnectionAdmin.describe`, as `brain_list` uses). */
  connections: { describe(connectionId: number): ResolvableConnection | undefined };
}

/** `source`: `mapping` (the remote is mapped to a brain the caller can use), `default` (fallback) or `none` (no brain). */
export interface BrainResolution {
  brain: string | null;
  source: 'mapping' | 'default' | 'none';
  /** The remote's key (`host/path`, no credentials), `null` when it is not a git remote. */
  remote: string | null;
}

/**
 * `brain_resolve { remote }` (#12): which brain a repository's memory belongs
 * to, from its git remote and the `BRAIN_REMOTES` mapping. The answer is
 * always one of the brains the caller can use: on a connection (bare `/mcp`),
 * its brains still granted to the owner; else the brain the call is on.
 * Fails open: an unmapped, unusable or malformed remote gets the default
 * brain (the connection's, or the call's brain), or `null`; never a tool error.
 */
export function createBrainResolveTool(deps: BrainResolveDeps): GatewayTool {
  return {
    definition: {
      name: BRAIN_RESOLVE_TOOL,
      description:
        'Which brain to use for a git repository: pass its remote URL (`git remote get-url origin`). Returns JSON { brain, source, remote }: the brain mapped to that remote among the brains you can use, else your default brain (source "default"), or null. Never fails.',
      inputSchema: {
        type: 'object',
        properties: { remote: { type: 'string', description: 'The repository remote, e.g. git@github.com:org/repo.git or https://github.com/org/repo.' } },
        additionalProperties: false
      },
      annotations: { title: 'Resolve the brain of a repository', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async call(args, ctx) {
      const remote = normalizeRemote(args?.remote) ?? null;
      let usable: string[];
      let fallback: string | null;
      const connectionId = ctx.caller?.connectionId;
      if (connectionId !== undefined) {
        const connection = deps.connections.describe(connectionId);
        usable = connection ? connection.brains.filter(b => b.effectiveRole !== null).map(b => b.brain) : [];
        fallback = connection?.defaultBrain && usable.includes(connection.defaultBrain) ? connection.defaultBrain : null;
      } else {
        usable = ctx.brain === null ? [] : [ctx.brain];
        fallback = ctx.brain;
      }
      const mapped = remote === null ? undefined : matchRemote(deps.rules, remote);
      const resolution: BrainResolution = mapped !== undefined && usable.includes(mapped)
        ? { brain: mapped, source: 'mapping', remote }
        : { brain: fallback, source: fallback === null ? 'none' : 'default', remote };
      return { content: [{ type: 'text', text: JSON.stringify(resolution) }] };
    }
  };
}
