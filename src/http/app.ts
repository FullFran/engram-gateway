import express from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { IncomingMessage } from 'node:http';
import type { AuthInfo } from '@modelcontextprotocol/server';
import type { Logger } from '../shared/logger.js';
import type { HttpRequestAuthenticator } from '../auth/index.js';
import { MCP_AUTH_INFO_LOCAL, MCP_HTTP_PATH, createMcpHttpRouter } from './mcp-route.js';
import type { McpServerFactory } from './mcp-route.js';

/** Service name reported on `/health`. */
export const GATEWAY_SERVICE = 'engram-gateway';

export interface GatewayAuth {
  /** OAuth metadata, `/oauth/*` and every auth provider's own endpoints. */
  router: express.Router;
  authenticator: HttpRequestAuthenticator;
  /** Protected resource (audience) of `/mcp`. */
  resource: string;
}

export interface GatewayAppOptions {
  bindHost: string;
  publicBaseUrl?: string;
  trustProxy: boolean | number | string;
  /** Undefined: authentication is off (loopback bind only, see `resolveAuthConfig`). */
  auth?: GatewayAuth;
  /** The bridge's MCP server factory. */
  mcpFactory: McpServerFactory;
  logger: Logger;
}

function single(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function credentialHeaders(req: IncomingMessage) {
  return { authorization: single(req.headers.authorization), cookie: single(req.headers.cookie) };
}

/**
 * The gateway: the auth endpoints, a minimal `/health` and the MCP endpoint
 * (`/mcp`) backed by the Engram bridge. With auth off (loopback) `/mcp` is open.
 */
export function createGatewayApp(options: GatewayAppOptions): express.Express {
  const { auth, logger } = options;
  const app = express();
  app.disable('x-powered-by');
  // Off unless TRUST_PROXY says otherwise: X-Forwarded-* is only honoured
  // behind a reverse proxy the operator controls.
  app.set('trust proxy', options.trustProxy);

  app.get('/health', (_req, res) => {
    // Unauthenticated: identify the service, reveal nothing else.
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ status: 'healthy', service: GATEWAY_SERVICE });
  });

  if (auth) app.use(auth.router);

  const mcpAuth: RequestHandler = async (req, res, next) => {
    if (!auth) return next();
    try {
      await auth.authenticator.prepare(credentialHeaders(req));
    } catch (error) {
      return next(error);
    }
    const result = auth.authenticator.authenticate(credentialHeaders(req), { resource: [auth.resource], acceptSession: false });
    if (!result.ok) {
      res.setHeader('WWW-Authenticate', result.challenge);
      res.status(result.status).json({ error: result.error });
      return;
    }
    const principal = result.principal;
    const authInfo: AuthInfo = {
      token: principal.token ?? '',
      clientId: principal.clientId ?? '',
      scopes: principal.scopes,
      ...(principal.expiresAt !== undefined ? { expiresAt: principal.expiresAt } : {}),
      ...(principal.resource ? { resource: new URL(principal.resource) } : {}),
      extra: { login: principal.login, ...(principal.provider ? { provider: principal.provider } : {}) }
    };
    res.locals[MCP_AUTH_INFO_LOCAL] = authInfo;
    next();
  };
  // Mounted before any body parser: the SDK reads the raw body itself.
  const { router: mcpRouter } = createMcpHttpRouter({
    factory: options.mcpFactory,
    logger,
    bindHost: options.bindHost,
    ...(options.publicBaseUrl ? { publicBaseUrl: options.publicBaseUrl } : {}),
    authMiddleware: [mcpAuth]
  });
  app.use(MCP_HTTP_PATH, mcpRouter);

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found' });
  });

  app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    // Client errors raised by middleware on the OAuth endpoints (413 body too
    // large, 400 malformed body) are the client's problem, not a failure.
    const status = (err as { status?: unknown; statusCode?: unknown }).status ?? (err as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      logger.warn('Rejected request', { status, method: req.method, path: req.path, type: (err as { type?: unknown }).type });
      if (res.headersSent) return next(err);
      res.status(status).json({ error: status === 413 ? 'Request body too large' : 'Bad request' });
      return;
    }
    logger.error('Unhandled error', { message: err.message, stack: err.stack });
    if (res.headersSent) return next(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
