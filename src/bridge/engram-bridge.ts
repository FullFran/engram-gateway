import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { ProtocolError, ProtocolErrorCode, Server } from '@modelcontextprotocol/server';
import type { McpServerFactory } from '@modelcontextprotocol/server';
import type { Logger } from '../shared/logger.js';
import { ToolCallDeniedError, createToolCallPipeline, runToolCall } from '../pipeline/index.js';
import type { ToolCallContext, ToolCaller, ToolCallPipeline, ToolCallResult } from '../pipeline/index.js';
import { mergeToolLists } from '../gateway-tools/index.js';
import type { GatewayToolContext, GatewayToolSet } from '../gateway-tools/index.js';

export interface EngramBridgeOptions {
  /** Executable to spawn, normally `engram`. */
  command: string;
  /** Arguments, normally `['mcp']`. */
  args: string[];
  /**
   * The child's whole environment (build it with `buildChildEnv`). Nothing
   * else from the gateway's environment is passed, except the fixed set of
   * non-secret variables the MCP SDK always adds when present (HOME, LOGNAME,
   * PATH, SHELL, TERM, USER).
   */
  env?: Record<string, string>;
  logger: Logger;
  /**
   * Stages every `tools/call` runs through (authorize -> redact -> forward ->
   * audit -> wrap); `tools/list` is narrowed by its `listTools` stage.
   * Defaults to `createToolCallPipeline()`: secret redaction on, every tool allowed.
   */
  pipeline?: ToolCallPipeline;
  /**
   * Tools the gateway serves itself (e.g. `brain_health`): listed after
   * engram's tools and handled locally instead of being forwarded, through the
   * same pipeline. Default: none.
   */
  gatewayTools?: GatewayToolSet;
  /** The brain this child serves (its slug), for logs and the per-call context. */
  brain?: string;
  /** Clock for the restart cooldown; defaults to `Date.now`. */
  nowMs?: () => number;
}

export interface EngramBridge {
  /** Builds a per-request low-level server forwarding to the shared upstream client. */
  factory: McpServerFactory;
  /** Spawns the child and connects; rejects if it cannot start. */
  start(): Promise<void>;
  /** Closes stdin so the child can flush and exit; escalates to a kill after a timeout. */
  close(): Promise<void>;
  /** Resolves once a child is connected, starting one if needed; rejects during a cooldown. */
  ready(): Promise<void>;
  /** A child is connected or being started. */
  live(): boolean;
  /** Milliseconds until a new child may be started after a failure; 0 when none is pending. */
  retryAfterMs(): number;
}

const GATEWAY_NAME = 'engram-gateway';
const FALLBACK_VERSION = '0.0.0';
/** Restart cooldown after a failed start or an unexpected exit: 1 s, doubling, at most 30 s. */
const COOLDOWN_BASE_MS = 1000;
const COOLDOWN_MAX_MS = 30_000;
/** A child that ran this long before exiting was healthy: its exit starts the backoff afresh. */
const STABLE_UPTIME_MS = 60_000;

/** The caller of one HTTP request, from the validated token's auth info (login in `extra.login`). */
function callerOf(authInfo: { clientId?: string; extra?: Record<string, unknown> } | undefined): ToolCaller | undefined {
  if (!authInfo) return undefined;
  const login = authInfo.extra?.login;
  const connectionId = authInfo.extra?.connectionId;
  return {
    ...(typeof login === 'string' ? { login } : {}),
    ...(authInfo.clientId ? { clientId: authInfo.clientId } : {}),
    ...(typeof connectionId === 'number' ? { connectionId } : {})
  };
}

/** The pipeline's view of the call, as a gateway tool sees it: brain, caller and the role authorize decided. */
function gatewayToolContext(ctx: ToolCallContext): GatewayToolContext {
  if (!ctx.caller) return { brain: ctx.brain };
  return { brain: ctx.brain, caller: { ...ctx.caller, ...(ctx.role !== undefined ? { role: ctx.role } : {}) } };
}

export function createEngramBridge(opts: EngramBridgeOptions): EngramBridge {
  const { logger } = opts;
  const pipeline = opts.pipeline ?? createToolCallPipeline();
  const gatewayTools = opts.gatewayTools;
  const now = opts.nowMs ?? Date.now;
  const fields = opts.brain !== undefined ? { brain: opts.brain } : {};
  let current: Client | undefined;
  let connecting: Promise<Client> | undefined;
  let closed = false;
  let failures = 0;
  let coolUntil = 0;

  function fail(reason: string): void {
    failures += 1;
    const delay = Math.min(COOLDOWN_MAX_MS, COOLDOWN_BASE_MS * 2 ** (failures - 1));
    coolUntil = now() + delay;
    logger.warn(`Engram child ${reason}; no restart for ${Math.ceil(delay / 1000)} s`, fields);
  }

  async function connect(): Promise<Client> {
    const client = new Client({ name: GATEWAY_NAME, version: FALLBACK_VERSION });
    const transport = new StdioClientTransport({
      command: opts.command,
      args: opts.args,
      env: { ...(opts.env ?? {}) },
      stderr: 'inherit'
    });
    let connectedAt = 0;
    client.onclose = () => {
      if (current === client) {
        current = undefined;
        if (closed) return;
        if (now() - connectedAt >= STABLE_UPTIME_MS) failures = 0;
        fail('exited unexpectedly; it is restarted on the next request after the cooldown');
      }
    };
    client.onerror = error => {
      logger.warn('Engram client error', { ...fields, error: error.message });
    };
    try {
      await client.connect(transport);
    } catch (error) {
      await client.close().catch(() => undefined);
      if (!closed) fail(`failed to start (${(error as Error).message})`);
      throw error;
    }
    if (closed) {
      await client.close().catch(() => undefined);
      throw new Error('Engram bridge is closed');
    }
    connectedAt = now();
    current = client;
    logger.info('Connected to Engram', { ...fields, server: client.getServerVersion()?.version });
    return client;
  }

  /** The live client, or one reconnect attempt shared by concurrent requests. */
  function upstream(): Promise<Client> {
    if (closed) return Promise.reject(new Error('Engram bridge is closed'));
    if (current) return Promise.resolve(current);
    if (!connecting) {
      const wait = coolUntil - now();
      if (wait > 0) return Promise.reject(new Error(`Engram child is cooling down after a failure; retry in ${Math.ceil(wait / 1000)} s`));
      logger.info('Starting Engram child', { ...fields, command: opts.command });
      connecting = connect().finally(() => {
        connecting = undefined;
      });
    }
    return connecting;
  }

  const factory: McpServerFactory = async context => {
    const caller = callerOf(context?.authInfo);
    const client = await upstream();
    const version = client.getServerVersion()?.version ?? FALLBACK_VERSION;
    const instructions = client.getInstructions();
    const server = new Server(
      { name: GATEWAY_NAME, version },
      { capabilities: { tools: {} }, ...(instructions !== undefined ? { instructions } : {}) }
    );
    const brain = opts.brain ?? null;
    server.setRequestHandler('tools/list', async request => {
      const listed = await (await upstream()).listTools(request.params);
      const tools = gatewayTools ? mergeToolLists(listed.tools, gatewayTools.definitions() as typeof listed.tools) : listed.tools;
      return { ...listed, tools: pipeline.listTools({ ...(caller ? { caller } : {}), brain }, tools) };
    });
    server.setRequestHandler('tools/call', async request => {
      const { name, arguments: args } = request.params;
      try {
        // Gateway tools are handled here; everything else is forwarded to engram.
        const forward = async (call: { name: string; arguments?: Record<string, unknown> }, ctx: ToolCallContext): Promise<ToolCallResult> =>
          gatewayTools?.has(call.name)
            ? gatewayTools.call(call.name, call.arguments, gatewayToolContext(ctx))
            : ((await (await upstream()).callTool(call)) as ToolCallResult);
        const result = await runToolCall(pipeline, { name, ...(args !== undefined ? { arguments: args } : {}) }, forward,
        { ...(caller ? { caller } : {}), brain });
        return result as Awaited<ReturnType<Client['callTool']>>;
      } catch (error) {
        // A refused call is a protocol error, like an unknown tool: the client gets no tool result.
        if (error instanceof ToolCallDeniedError) throw new ProtocolError(ProtocolErrorCode.InvalidParams, error.message);
        throw error;
      }
    });
    return server;
  };

  return {
    factory,
    async start() {
      closed = false;
      await upstream();
    },
    async close() {
      closed = true;
      const client = current ?? (await connecting?.catch(() => undefined));
      current = undefined;
      // StdioClientTransport.close(): ends stdin, waits 2s, SIGTERM, waits 2s, SIGKILL.
      await client?.close();
    },
    async ready() {
      await upstream();
    },
    live() {
      return current !== undefined || connecting !== undefined;
    },
    retryAfterMs() {
      return Math.max(0, coolUntil - now());
    }
  };
}
