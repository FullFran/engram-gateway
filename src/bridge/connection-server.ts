import { ProtocolError, ProtocolErrorCode, Server } from '@modelcontextprotocol/server';
import { BrainCapacityError } from '../brains/index.js';
import type { McpServerFactory } from '@modelcontextprotocol/server';
import type { Connection, ConnectionReader, ConnectionToolAccess } from '../connections/index.js';
import { mergeFanOut, resolveTarget, withBrainArgument } from '../connections/index.js';
import type { BrainOutcome } from '../connections/index.js';
import type { Logger } from '../shared/logger.js';
import { ToolCallDeniedError, runToolCall } from '../pipeline/index.js';
import type { RequestStage, ToolCaller, ToolCallPipeline, ToolCallRequest, ToolCallResult } from '../pipeline/index.js';
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
  /**
   * The connection tools (brain_list, connection_*): they act on the
   * connection, take no `brain` routing argument, and are authorized by
   * `access` (connection kind, owner's grant) instead of a brain role.
   */
  connectionTools?: { tools: GatewayToolSet; access: ConnectionToolAccess };
  /** Upper bound for a whole `brain: "*"` call; a brain still running when it ends is reported as timed out (and its call cancelled). */
  fanOutTimeoutMs?: number;
  /**
   * Fan-outs one login may run at once (default 2). Each holds a brain at a
   * time, so a user cannot occupy every live-brain slot (and evict other
   * users' brains) by firing many `brain: "*"` calls.
   */
  maxFanOutsPerLogin?: number;
}

const GATEWAY_NAME = 'engram-gateway';
export const DEFAULT_FAN_OUT_TIMEOUT_MS = 20_000;
export const DEFAULT_MAX_FAN_OUTS_PER_LOGIN = 2;

/** A fan-out brain the deadline cut short; its call was cancelled. */
class FanOutTimeout extends Error {}

/** A fan-out brain's failure as a fixed word for the merged result: never upstream text. */
function fanOutError(error: unknown, timeoutMs: number): string {
  if (error instanceof ToolCallDeniedError) return 'access denied';
  if (error instanceof FanOutTimeout) return `timed out after ${timeoutMs} ms`;
  if (error instanceof BrainCapacityError || error instanceof BrainUnavailableError) return 'brain unavailable';
  return 'call failed';
}

/** A brain cooling down after a failed start: the call is not tried. */
class BrainUnavailableError extends Error {}

const invalid = (message: string): ProtocolError => new ProtocolError(ProtocolErrorCode.InvalidParams, message);

/**
 * The MCP server for a connection token on the bare endpoint (#27): every
 * brain of the caller's connection behind one server. The connection is read
 * from the gateway database on every request, so a detach (or a revoked
 * grant) applies to the next call. Each call runs the full pipeline on the
 * brain it targets, with a lease on that brain held only for the call.
 */
export function createConnectionServer(opts: ConnectionServerOptions): McpServerFactory {
  const { brains, connections, pipeline, gatewayTools, connectionTools, logger } = opts;
  const fanOutTimeoutMs = opts.fanOutTimeoutMs ?? DEFAULT_FAN_OUT_TIMEOUT_MS;
  const maxFanOutsPerLogin = opts.maxFanOutsPerLogin ?? DEFAULT_MAX_FAN_OUTS_PER_LOGIN;
  /** Fan-outs running now, per lowercased login. */
  const fanOutsRunning = new Map<string, number>();
  /**
   * Engram's version and instructions: the same for every brain (one binary),
   * so read once from the first brain a connection names, then reused. Not
   * cached when the read failed.
   */
  let serverInfo: { version: string; instructions?: string } | undefined;

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
      if (cooling > 0) throw new BrainUnavailableError(`brain ${slug} is unavailable; retry in ${Math.ceil(cooling / 1000)} s`);
      await lease.process.ready();
      return await work(lease.process);
    } finally {
      lease.release();
    }
  }

  /**
   * One brain, through the whole pipeline. An unknown brain is refused by the
   * authorize stage like a brain outside the connection (same text, audited
   * as denied), so a client cannot tell them apart; no lease is taken.
   * `signal` cancels the forwarded call (fan-out deadline).
   */
  async function callOn(caller: ToolCaller, brain: string, request: ToolCallRequest, signal?: AbortSignal): Promise<ToolCallResult> {
    return runToolCall(pipeline, request, (call, ctx) => gatewayTools?.has(call.name)
      ? gatewayTools.call(call.name, call.arguments, gatewayToolContext(ctx))
      : withBrain(brain, process => process.callTool(call, signal ? { signal } : undefined)), { caller, brain });
  }

  /**
   * A connection tool, through the same pipeline: only the authorize stage is
   * replaced by the connection tool check, so a refusal is audited as denied
   * (on the brain the call acts on) and an allowed call is audited and wrapped.
   */
  async function callConnectionTool(caller: ToolCaller, connection: Connection, tools: GatewayToolSet, access: ConnectionToolAccess, request: ToolCallRequest): Promise<ToolCallResult> {
    const verdict = access.check(connection, request.name, request.arguments);
    if (verdict.kind === 'invalid') throw invalid(verdict.message);
    const authorize: RequestStage = ctx => {
      if (verdict.role) ctx.meta.role = verdict.role;
      if (verdict.kind === 'denied') {
        ctx.meta.denyReason = verdict.reason;
        throw new ToolCallDeniedError(request.name, verdict.reason);
      }
      return ctx;
    };
    return runToolCall({ ...pipeline, authorize }, request, (call, ctx) => tools.call(call.name, call.arguments, gatewayToolContext(ctx)), { caller, brain: verdict.brain });
  }

  async function fanOut(caller: ToolCaller, targets: string[], request: ToolCallRequest): Promise<ToolCallResult> {
    const login = (caller.login ?? '').toLowerCase();
    const running = fanOutsRunning.get(login) ?? 0;
    if (running >= maxFanOutsPerLogin) {
      return { content: [{ type: 'text', text: `Too many "*" calls running for this user (at most ${maxFanOutsPerLogin}); retry when one ends.` }], isError: true };
    }
    fanOutsRunning.set(login, running + 1);
    try {
      return await fanOutBrains(caller, targets, request);
    } finally {
      const left = (fanOutsRunning.get(login) ?? 1) - 1;
      if (left > 0) fanOutsRunning.set(login, left);
      else fanOutsRunning.delete(login);
    }
  }

  async function fanOutBrains(caller: ToolCaller, targets: string[], request: ToolCallRequest): Promise<ToolCallResult> {
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
      // At the deadline the call is cancelled (its lease is released once it
      // rejects) and the brain is reported as timed out.
      const controller = new AbortController();
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new FanOutTimeout());
        }, left);
      });
      const call = callOn(caller, brain, request, controller.signal);
      call.catch(() => undefined);
      try {
        outcomes.push({ brain, result: await Promise.race([call, timeout]) });
      } catch (error) {
        if (!(error instanceof ToolCallDeniedError)) {
          logger.warn('Fan-out call failed on a brain', { brain, tool: request.name, reason: String((error as Error)?.message ?? error).slice(0, 200) });
        }
        outcomes.push({ brain, error: fanOutError(error, fanOutTimeoutMs) });
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
    if (!serverInfo) {
      const first = caller?.connectionId !== undefined ? connections.get(caller.connectionId) : undefined;
      const source = first?.defaultBrain ?? first?.brains[0]?.brain;
      if (source) serverInfo = await withBrain(source, process => process.serverInfo()).catch(() => undefined);
    }
    const info = serverInfo ?? { version: '0.0.0' };
    const server = new Server(
      { name: GATEWAY_NAME, version: info.version },
      { capabilities: { tools: {} }, ...(info.instructions !== undefined ? { instructions: info.instructions } : {}) }
    );

    server.setRequestHandler('tools/list', async () => {
      const connection = connectionOf(caller);
      const slugs = connection.brains.map(b => b.brain);
      const source = connection.defaultBrain ?? slugs[0];
      const own = connectionTools
        ? connectionTools.tools.definitions().filter(tool => connectionTools.access.visible(connection.kind, tool.name))
        : [];
      if (!source || !caller) return { tools: own } as never;
      // Every brain runs the same Engram, so one brain's list is the list.
      const engram = await withBrain(source, process => process.listTools());
      const merged = gatewayTools ? mergeToolLists(engram, gatewayTools.definitions() as typeof engram) : engram;
      // A connection tool (brain_resolve) is listed once, as a connection tool: calls go there first.
      const tools = merged.filter(tool => !connectionTools?.tools.has(tool.name));
      const allowed = new Set(slugs.flatMap(brain => pipeline.listTools({ caller, brain }, tools).map(tool => tool.name)));
      const brainTools = tools.filter(tool => allowed.has(tool.name)).map(tool => withBrainArgument(tool, slugs, connection.defaultBrain));
      return { tools: [...brainTools, ...own] } as never;
    });

    server.setRequestHandler('tools/call', async request => {
      const connection = connectionOf(caller);
      const { name, arguments: args } = request.params;
      if (connectionTools?.tools.has(name)) {
        try {
          return (await callConnectionTool(caller!, connection, connectionTools.tools, connectionTools.access, { name, arguments: args })) as never;
        } catch (error) {
          if (error instanceof ToolCallDeniedError) throw invalid(error.message);
          throw error;
        }
      }
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
