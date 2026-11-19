import { ProtocolError, ProtocolErrorCode, Server } from '@modelcontextprotocol/server';
import type { McpServerFactory } from '@modelcontextprotocol/server';
import type { ConnectionReader } from '../connections/index.js';
import { mergeFanOut, resolveTarget, withBrainArgument } from '../connections/index.js';
import type { BrainOutcome } from '../connections/index.js';
import type { Logger } from '../shared/logger.js';
import { ToolCallDeniedError, runToolCall } from '../pipeline/index.js';
import type { ToolCaller, ToolCallPipeline, ToolCallRequest, ToolCallResult } from '../pipeline/index.js';
import { mergeToolLists } from '../gateway-tools/index.js';
import type { GatewayToolSet } from '../gateway-tools/index.js';
import { callerOf, gatewayToolContext } from './engram-bridge.js';
import type { EngramBridge } from './engram-bridge.js';

type BrainUpstream = Pick<EngramBridge, 'ready' | 'retryAfterMs' | 'listTools' | 'callTool' | 'serverInfo'>;

/** The brains, as the connection server borrows them: one lease per call. */
export interface ConnectionBrains {
  has(slug: string): boolean;
  acquire(slug: string): Promise<{ process: BrainUpstream; release(): void }>;
}

export interface ConnectionServerOptions {
  brains: ConnectionBrains;
  connections: ConnectionReader;
  /** The same pipeline the per-brain bridges run: authorize -> redact -> forward -> audit -> wrap. */
  pipeline: ToolCallPipeline;
  /** Tools the gateway serves itself (e.g. `brain_health`), as on `/mcp/<brain>`: they also take `brain`. */
  gatewayTools?: GatewayToolSet;
  logger: Logger;
  /** Upper bound for a whole `brain: "*"` call; a brain still running when it ends is reported as timed out. */
  fanOutTimeoutMs?: number;
}

const GATEWAY_NAME = 'engram-gateway';
export const DEFAULT_FAN_OUT_TIMEOUT_MS = 20_000;

const invalid = (message: string): ProtocolError => new ProtocolError(ProtocolErrorCode.InvalidParams, message);

/**
 * The MCP server for a connection token on the bare endpoint (#27): every
 * brain of the caller's connection behind one server. The connection is read
 * from the gateway database on every request, so a detach (or a revoked
 * grant) applies to the next call. Each call runs the full pipeline on the
 * brain it targets, with a lease on that brain held only for the call.
 */
export function createConnectionServer(opts: ConnectionServerOptions): McpServerFactory {
  const { brains, connections, pipeline, gatewayTools, logger } = opts;
  const fanOutTimeoutMs = opts.fanOutTimeoutMs ?? DEFAULT_FAN_OUT_TIMEOUT_MS;

  /** The caller's connection now; a clear MCP error when it is gone. */
  function connectionOf(caller: ToolCaller | undefined) {
    const connection = caller?.connectionId !== undefined ? connections.get(caller.connectionId) : undefined;
    if (!connection || connection.login.toLowerCase() !== (caller?.login ?? '').toLowerCase()) {
      throw invalid('This connection no longer exists; connect the client again.');
    }
    return connection;
  }

  /** Runs `work` with a lease on `slug`, released when `work` settles (also after a fan-out timeout gave up on it). */
  async function withBrain<T>(slug: string, work: (process: BrainUpstream) => Promise<T>): Promise<T> {
    if (!brains.has(slug)) throw invalid(`Unknown brain ${slug}.`);
    const lease = await brains.acquire(slug);
    try {
      const cooling = lease.process.retryAfterMs();
      if (cooling > 0) throw new Error(`brain ${slug} is unavailable; retry in ${Math.ceil(cooling / 1000)} s`);
      await lease.process.ready();
      return await work(lease.process);
    } finally {
      lease.release();
    }
  }

  /** One brain, through the whole pipeline; an unknown brain is refused before any lease. */
  async function callOn(caller: ToolCaller, brain: string, request: ToolCallRequest): Promise<ToolCallResult> {
    if (!brains.has(brain)) throw invalid(`Unknown brain ${brain}.`);
    return runToolCall(pipeline, request, (call, ctx) => gatewayTools?.has(call.name)
      ? gatewayTools.call(call.name, call.arguments, gatewayToolContext(ctx))
      : withBrain(brain, process => process.callTool(call)), { caller, brain });
  }

  async function fanOut(caller: ToolCaller, targets: string[], request: ToolCallRequest): Promise<ToolCallResult> {
    const deadline = Date.now() + fanOutTimeoutMs;
    const outcomes: BrainOutcome[] = [];
    // Sequential: one lease at a time, so a fan-out never needs more live
    // children than a single call.
    for (const brain of targets) {
      const left = deadline - Date.now();
      if (left <= 0) {
        outcomes.push({ brain, error: `timed out (no time left of ${fanOutTimeoutMs} ms)` });
        continue;
      }
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${fanOutTimeoutMs} ms`)), left);
      });
      const call = callOn(caller, brain, request);
      call.catch(() => undefined);
      try {
        outcomes.push({ brain, result: await Promise.race([call, timeout]) });
      } catch (error) {
        const message = error instanceof ToolCallDeniedError ? 'access denied' : (error as Error).message;
        if (!(error instanceof ToolCallDeniedError)) logger.warn('Fan-out call failed on a brain', { brain, tool: request.name, reason: message });
        outcomes.push({ brain, error: message });
      } finally {
        clearTimeout(timer);
      }
    }
    return mergeFanOut(outcomes) as ToolCallResult;
  }

  return async context => {
    const caller = callerOf(context?.authInfo);
    // Engram's instructions and version, from the brain a call naming none
    // goes to. A missing connection is reported by the request handlers.
    const first = caller?.connectionId !== undefined ? connections.get(caller.connectionId) : undefined;
    const source = first?.defaultBrain ?? first?.brains[0]?.brain;
    const info: { version: string; instructions?: string } = source
      ? await withBrain(source, process => process.serverInfo()).catch(() => ({ version: '0.0.0' }))
      : { version: '0.0.0' };
    const server = new Server(
      { name: GATEWAY_NAME, version: info.version },
      { capabilities: { tools: {} }, ...(info.instructions !== undefined ? { instructions: info.instructions } : {}) }
    );

    server.setRequestHandler('tools/list', async () => {
      const connection = connectionOf(caller);
      const slugs = connection.brains.map(b => b.brain);
      const source = connection.defaultBrain ?? slugs[0];
      if (!source || !caller) return { tools: [] };
      // Every brain runs the same Engram, so one brain's list is the list.
      const engram = await withBrain(source, process => process.listTools());
      const tools = gatewayTools ? mergeToolLists(engram, gatewayTools.definitions() as typeof engram) : engram;
      const allowed = new Set(slugs.flatMap(brain => pipeline.listTools({ caller, brain }, tools).map(tool => tool.name)));
      return { tools: tools.filter(tool => allowed.has(tool.name)).map(tool => withBrainArgument(tool, slugs, connection.defaultBrain)) };
    });

    server.setRequestHandler('tools/call', async request => {
      const connection = connectionOf(caller);
      const { name, arguments: args } = request.params;
      const slugs = connection.brains.map(b => b.brain);
      const target = resolveTarget(name, args, slugs, connection.defaultBrain);
      if (target.kind === 'invalid') throw invalid(target.message);
      try {
        if (target.kind === 'all') return (await fanOut(caller!, target.brains, { name, arguments: target.arguments })) as never;
        return (await callOn(caller!, target.brain, { name, arguments: target.arguments })) as never;
      } catch (error) {
        // A refused call is a protocol error, as on /mcp/<brain>: the client gets no tool result.
        if (error instanceof ToolCallDeniedError) throw invalid(error.message);
        throw error;
      }
    });
    return server;
  };
}
