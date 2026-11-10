import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Server } from '@modelcontextprotocol/server';
import type { McpServerFactory } from '@modelcontextprotocol/server';
import type { Logger } from '../shared/logger.js';

export interface EngramBridgeOptions {
  /** Executable to spawn, normally `engram`. */
  command: string;
  /** Arguments, normally `['mcp']`. */
  args: string[];
  /**
   * Extra environment for the child. The child inherits the parent's whole
   * environment by default (so `ENGRAM_DATA_DIR`, cloud-sync settings, etc.
   * pass through); these entries are layered on top.
   */
  env?: Record<string, string>;
  logger: Logger;
}

export interface EngramBridge {
  /** Builds a per-request low-level server forwarding to the shared upstream client. */
  factory: McpServerFactory;
  /** Spawns the child and connects; rejects if it cannot start. */
  start(): Promise<void>;
  /** Closes stdin so the child can flush and exit; escalates to a kill after a timeout. */
  close(): Promise<void>;
}

const GATEWAY_NAME = 'engram-gateway';
const FALLBACK_VERSION = '0.0.0';

function childEnv(extra: Record<string, string> | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...(extra ?? {}) };
}

export function createEngramBridge(opts: EngramBridgeOptions): EngramBridge {
  const { logger } = opts;
  let current: Client | undefined;
  let connecting: Promise<Client> | undefined;
  let closed = false;

  async function connect(): Promise<Client> {
    const client = new Client({ name: GATEWAY_NAME, version: FALLBACK_VERSION });
    const transport = new StdioClientTransport({
      command: opts.command,
      args: opts.args,
      env: childEnv(opts.env),
      stderr: 'inherit'
    });
    client.onclose = () => {
      if (current === client) {
        current = undefined;
        if (!closed) logger.warn('Engram child closed; it will be restarted on the next request');
      }
    };
    client.onerror = error => {
      logger.warn('Engram client error', { error: error.message });
    };
    try {
      await client.connect(transport);
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
    if (closed) {
      await client.close().catch(() => undefined);
      throw new Error('Engram bridge is closed');
    }
    current = client;
    logger.info('Connected to Engram', { server: client.getServerVersion()?.version });
    return client;
  }

  /** The live client, or one reconnect attempt shared by concurrent requests. */
  function upstream(): Promise<Client> {
    if (closed) return Promise.reject(new Error('Engram bridge is closed'));
    if (current) return Promise.resolve(current);
    if (!connecting) {
      logger.info('Starting Engram child', { command: opts.command });
      connecting = connect().finally(() => {
        connecting = undefined;
      });
    }
    return connecting;
  }

  const factory: McpServerFactory = async () => {
    const client = await upstream();
    const version = client.getServerVersion()?.version ?? FALLBACK_VERSION;
    const instructions = client.getInstructions();
    const server = new Server(
      { name: GATEWAY_NAME, version },
      { capabilities: { tools: {} }, ...(instructions !== undefined ? { instructions } : {}) }
    );
    server.setRequestHandler('tools/list', async request => (await upstream()).listTools(request.params));
    server.setRequestHandler('tools/call', async request => {
      const { name, arguments: args } = request.params;
      return (await upstream()).callTool({ name, ...(args !== undefined ? { arguments: args } : {}) });
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
    }
  };
}
