import express from 'express';
import type { NextFunction, Request as ExpressRequest, RequestHandler, Response as ExpressResponse } from 'express';
import {
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  originValidationResponse
} from '@modelcontextprotocol/server';
import type { AuthInfo, McpHttpHandler } from '@modelcontextprotocol/server';
import type { Logger } from '../shared/logger.js';
import { isLoopbackBindHost } from '../shared/network.js';

/** What `createMcpHandler` accepts: builds the MCP server a request is served by. */
export type McpServerFactory = Parameters<typeof createMcpHandler>[0];

/** Path the Streamable HTTP MCP endpoint is mounted at; `/mcp/<brain>` serves one brain. */
export const MCP_HTTP_PATH = '/mcp';

/** The brain plain `/mcp` serves (single-brain deployments). */
export const MCP_DEFAULT_BRAIN = 'default';

/** Express `res.locals` key holding the slug of the brain a request is for, set before authentication. */
export const MCP_BRAIN_LOCAL = 'mcpBrain';

/**
 * What the MCP endpoint needs from the brains: which slugs exist, and a
 * lease on a brain's server factory for the duration of one request.
 */
/** One brain's Engram child as the HTTP layer sees it. */
export interface McpBrainProcess {
  factory: McpServerFactory;
  /** Resolves once the child is connected; rejects when it cannot start (yet). */
  ready?(): Promise<void>;
  /** Milliseconds until the child may be started again after a failure; 0 when it may start now. */
  retryAfterMs?(): number;
}

export interface McpBrains {
  has(slug: string): boolean;
  /** Rejects when the brain cannot be served right now (e.g. every child slot is busy). */
  acquire(slug: string): Promise<{ process: McpBrainProcess; release(): void }>;
}

/** Seconds for `Retry-After` when no better estimate is known. */
const DEFAULT_RETRY_AFTER_S = 5;

/**
 * Express `res.locals` key an authentication middleware sets to the verified
 * principal. The MCP handler forwards it to tool handlers and the server
 * factory as `authInfo`; it is never derived from request headers here.
 */
export const MCP_AUTH_INFO_LOCAL = 'mcpAuthInfo';

export interface McpHttpRouterOptions {
  /** The brains, each served by its own bridge (the tools `engram mcp` serves over stdio). */
  brains: McpBrains;
  logger: Logger;
  /** The address the gateway binds (`HOST`). Decides the DNS-rebinding guard. */
  bindHost: string;
  /** Validated `PUBLIC_BASE_URL`, when configured. Its hostname is allowed through the guard. */
  publicBaseUrl?: string;
  /**
   * Authentication seam: middlewares run after the Host/Origin guard and the
   * brain lookup (`res.locals[MCP_BRAIN_LOCAL]` holds the slug) and before
   * any MCP processing. A middleware rejects by answering the request
   * itself (e.g. 401 with `WWW-Authenticate`), or accepts by calling `next()`
   * after optionally setting `res.locals[MCP_AUTH_INFO_LOCAL]`. Empty by
   * default (auth off on a loopback bind).
   */
  authMiddleware?: RequestHandler[];
  /** Request body limit, matching the REST API's JSON limit. */
  bodyLimit?: string;
}

// Hop-by-hop headers describe the Node connection, not the request; they must
// not leak into the web-standard Request handed to the SDK.
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer'
]);

function toWebHeaders(req: ExpressRequest): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name)) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  return headers;
}

function toWebRequest(req: ExpressRequest, signal: AbortSignal): Request {
  let url: URL;
  try {
    url = new URL(req.originalUrl, `${req.protocol}://${req.get('host') ?? 'localhost'}`);
  } catch {
    url = new URL(req.originalUrl, 'http://localhost');
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && Buffer.isBuffer(req.body) && req.body.length > 0;
  return new Request(url, {
    method: req.method,
    headers: toWebHeaders(req),
    ...(hasBody ? { body: new Uint8Array(req.body as Buffer) } : {}),
    signal
  });
}

async function sendWebResponse(response: Response, res: ExpressResponse, logger: Logger): Promise<void> {
  res.status(response.status);
  response.headers.forEach((value, name) => {
    res.setHeader(name, value);
  });
  if (!response.body) {
    res.end();
    return;
  }
  // SSE answers must reach the client frame by frame, not once buffered.
  res.flushHeaders();
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  } catch (error) {
    // The client went away (abort) or the stream failed mid-flight.
    logger.debug('MCP HTTP response stream ended early', { error: (error as Error).message });
    res.destroy();
  }
}

/**
 * Host/Origin validation against DNS rebinding and cross-site requests. Active
 * when the server binds loopback — the case where a browser page could reach
 * it through a hostname it controls. The public base URL's hostname is
 * allowed so a reverse proxy on the same machine can forward with its own
 * Host header. Non-loopback binds rely on the authentication seam instead.
 */
function dnsRebindingGuard(options: McpHttpRouterOptions): RequestHandler {
  if (!isLoopbackBindHost(options.bindHost)) {
    return (_req, _res, next) => next();
  }
  const publicHost = options.publicBaseUrl ? new URL(options.publicBaseUrl).hostname : undefined;
  const allowedHosts = [...localhostAllowedHostnames(), ...(publicHost ? [publicHost] : [])];
  const allowedOrigins = [...localhostAllowedOrigins(), ...(publicHost ? [publicHost] : [])];

  return async (req, res, next) => {
    const probe = new Request('http://localhost/', { headers: toWebHeaders(req) });
    const rejected = hostHeaderValidationResponse(probe, allowedHosts) ?? originValidationResponse(probe, allowedOrigins);
    if (!rejected) {
      next();
      return;
    }
    options.logger.warn('Rejected MCP HTTP request failing Host/Origin validation', {
      host: req.headers.host,
      origin: req.headers.origin
    });
    await sendWebResponse(rejected, res, options.logger);
  };
}

/**
 * Builds the Express router serving MCP over Streamable HTTP. Both protocol
 * eras are handled by the SDK's `createMcpHandler`: 2026-07-28 requests
 * (per-request `_meta` envelope, `Mcp-Method`/`Mcp-Name` headers) on its
 * modern path, and 2025-era clients (`initialize` handshake) through its
 * stateless legacy fallback — both backed by the bridge's server factory.
 *
 * Mount it before any JSON body parser: the SDK reads the raw body itself.
 */
export function createMcpHttpRouter(options: McpHttpRouterOptions): { router: express.Router } {
  // One SDK handler per bridge factory; a brain restarted after reaping gets a new one.
  const handlers = new WeakMap<McpServerFactory, McpHttpHandler>();
  const handlerFor = (factory: McpServerFactory): McpHttpHandler => {
    let handler = handlers.get(factory);
    if (!handler) {
      handler = createMcpHandler(factory, {
        // Reporting only: rejected requests are already answered on the wire.
        onerror: error => {
          options.logger.debug('MCP HTTP request error', { name: error.name, message: error.message });
        }
      });
      handlers.set(factory, handler);
    }
    return handler;
  };

  // Unknown brains answer exactly like any unknown path, before authentication.
  // Brain names are not secret, though: a known brain answers 401 without a
  // token (and has protected-resource metadata), an unknown one 404, so anyone
  // can test whether a name exists. Accepted; see "Brains" in the README.
  const selectBrain = (fixed?: string): RequestHandler => (req, res, next) => {
    const slug = fixed ?? req.params.brain ?? '';
    if (!options.brains.has(slug)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.locals[MCP_BRAIN_LOCAL] = slug;
    next();
  };

  const unavailable = (res: ExpressResponse, slug: string, reason: string, retryAfterMs?: number): void => {
    options.logger.warn('Brain unavailable', { brain: slug, reason });
    const seconds = retryAfterMs !== undefined && retryAfterMs > 0 ? Math.ceil(retryAfterMs / 1000) : DEFAULT_RETRY_AFTER_S;
    res.setHeader('Retry-After', String(seconds));
    res.status(503).json({ error: 'brain_unavailable' });
  };

  const serve = async (req: ExpressRequest, res: ExpressResponse, next: NextFunction): Promise<void> => {
    const slug = res.locals[MCP_BRAIN_LOCAL] as string;
    let lease: Awaited<ReturnType<McpBrains['acquire']>>;
    try {
      lease = await options.brains.acquire(slug);
    } catch (error) {
      unavailable(res, slug, (error as Error).message);
      return;
    }
    const controller = new AbortController();
    // 'close' fires once the response is done or the client went away: the
    // brain counts as busy (never reaped) until then, streams included.
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
      lease.release();
    });
    const { process } = lease;
    // A child that failed to start (or crashed) is not respawned until its
    // cooldown ends; until then the brain answers 503 without touching Engram.
    const cooling = process.retryAfterMs?.() ?? 0;
    if (cooling > 0) {
      unavailable(res, slug, 'restart cooldown', cooling);
      return;
    }
    if (process.ready) {
      try {
        await process.ready();
      } catch (error) {
        unavailable(res, slug, (error as Error).message, process.retryAfterMs?.());
        return;
      }
    }
    try {
      const authInfo = res.locals[MCP_AUTH_INFO_LOCAL] as AuthInfo | undefined;
      const response = await handlerFor(process.factory).fetch(toWebRequest(req, controller.signal), authInfo ? { authInfo } : undefined);
      await sendWebResponse(response, res, options.logger);
    } catch (error) {
      next(error);
    }
  };

  const router = express.Router();
  const pipeline = (brain: RequestHandler) => [
    dnsRebindingGuard(options),
    brain,
    ...(options.authMiddleware ?? []),
    express.raw({ type: () => true, limit: options.bodyLimit ?? '10mb' }),
    serve
  ];
  // Exactly `/mcp` (and `/mcp/`) for the default brain, `/mcp/<brain>` for
  // one brain; deeper subpaths fall through to the app's 404.
  router.all('/', ...pipeline(selectBrain(MCP_DEFAULT_BRAIN)));
  router.all('/:brain', ...pipeline(selectBrain()));
  return { router };
}
