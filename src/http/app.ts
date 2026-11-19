import express from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { IncomingMessage } from 'node:http';
import type { AuthInfo } from '@modelcontextprotocol/server';
import type { Logger } from '../shared/logger.js';
import type { HttpRequestAuthenticator } from '../auth/index.js';
import { MCP_AUTH_INFO_LOCAL, MCP_BRAIN_LOCAL, MCP_DEFAULT_BRAIN, MCP_HTTP_PATH, createMcpHttpRouter } from './mcp-route.js';
import type { McpBrains } from './mcp-route.js';

/** Service name reported on `/health`. */
export const GATEWAY_SERVICE = 'engram-gateway';

export interface GatewayAuth {
  /** OAuth metadata, `/oauth/*` and every auth provider's own endpoints. */
  router: express.Router;
  authenticator: HttpRequestAuthenticator;
  /**
   * Protected resource (audience) of `/mcp`, e.g. `https://memory.example.com/mcp`.
   * Brain `<slug>` is its own resource, `${resource}/<slug>`; the default
   * brain accepts both `${resource}` and `${resource}/default`.
   */
  resource: string;
}

/** Per-brain access for the MCP endpoint (#6): read on every request, never cached. */
export interface BrainAccess {
  /** Does `login` hold any role on brain `brain`? */
  mayOpen(login: string, brain: string): boolean;
}

/** Admin endpoints (instance admins only when auth is on). */
export interface AdminApi {
  isAdmin(login: string): boolean;
  /** The health report (#18) of brain `slug`; `rawOptions` is the query string. */
  brainHealth(slug: string, rawOptions: unknown): { ok: true; report: unknown } | { ok: false; reason: 'unknown_brain' | 'no_data' | 'invalid_arguments'; message: string };
}

export interface GatewayAppOptions {
  bindHost: string;
  publicBaseUrl?: string;
  trustProxy: boolean | number | string;
  /** Undefined: authentication is off (loopback bind only, see `resolveAuthConfig`). */
  auth?: GatewayAuth;
  /**
   * With auth on, a signed-in caller without a grant on the brain gets 403
   * before any MCP processing. Required when `auth` is set.
   */
  brainAccess?: BrainAccess;
  /** The brains served at `/mcp/<slug>` (`/mcp`: the default brain), with live/idle counts for `/health/brains`. */
  brains: McpBrains & { stats(): { live: number; idle: number } };
  /** `GET /admin/brains/<slug>/health`; absent: no admin endpoints. */
  admin?: AdminApi;
  logger: Logger;
}

const ADMIN_LOOKUP_STATUS = { unknown_brain: [404, 'not_found'], no_data: [404, 'no_data'], invalid_arguments: [400, 'invalid_request'] } as const;

function single(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function credentialHeaders(req: IncomingMessage) {
  return { authorization: single(req.headers.authorization), cookie: single(req.headers.cookie) };
}

/**
 * The gateway: the auth endpoints, a minimal `/health` and the MCP endpoint
 * (`/mcp`, `/mcp/<brain>`), one Engram bridge per brain. With auth off (loopback) it is open.
 */
export function createGatewayApp(options: GatewayAppOptions): express.Express {
  const { auth, logger } = options;
  if (auth && !options.brainAccess) throw new Error('createGatewayApp: brainAccess is required when auth is on');
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

  app.get('/health/brains', (_req, res) => {
    // Counts only: which brains exist is never shown without authentication.
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(options.brains.stats());
  });

  if (auth) app.use(auth.router);

  /** Audiences a token may carry for this request's brain; the first is the canonical one. */
  const audiences = (base: string, slug: string, bare: boolean): string[] => {
    if (slug !== MCP_DEFAULT_BRAIN) return [`${base}/${slug}`];
    const both = [base, `${base}/${MCP_DEFAULT_BRAIN}`];
    return bare ? both : both.reverse();
  };

  const mcpAuth: RequestHandler = async (req, res, next) => {
    if (!auth) return next();
    try {
      await auth.authenticator.prepare(credentialHeaders(req));
    } catch (error) {
      return next(error);
    }
    const slug = res.locals[MCP_BRAIN_LOCAL] as string;
    const resource = audiences(auth.resource, slug, req.path === '/');
    const result = auth.authenticator.authenticate(credentialHeaders(req), { resource, acceptSession: false });
    if (!result.ok) {
      res.setHeader('WWW-Authenticate', result.challenge);
      res.status(result.status).json({ error: result.error });
      return;
    }
    const principal = result.principal;
    // The token proves who this is; the grant, read now, says whether this brain is theirs.
    if (!options.brainAccess!.mayOpen(principal.login, slug)) {
      logger.warn('MCP request without a grant on the brain', { brain: slug, login: principal.login });
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const authInfo: AuthInfo = {
      token: principal.token ?? '',
      clientId: principal.clientId ?? '',
      scopes: principal.scopes,
      ...(principal.expiresAt !== undefined ? { expiresAt: principal.expiresAt } : {}),
      ...(principal.resource ? { resource: new URL(principal.resource) } : {}),
      extra: { login: principal.login, brain: slug, ...(principal.provider ? { provider: principal.provider } : {}) }
    };
    res.locals[MCP_AUTH_INFO_LOCAL] = authInfo;
    next();
  };
  // Mounted before any body parser: the SDK reads the raw body itself.
  const { router: mcpRouter } = createMcpHttpRouter({
    brains: options.brains,
    logger,
    bindHost: options.bindHost,
    ...(options.publicBaseUrl ? { publicBaseUrl: options.publicBaseUrl } : {}),
    authMiddleware: [mcpAuth]
  });
  app.use(MCP_HTTP_PATH, mcpRouter);

  if (options.admin) {
    const admin = options.admin;
    // Admin only. With auth on, the caller proves who they are with a bearer
    // token for the brain's resource (as for /mcp/<slug>) or a session cookie,
    // then must be an instance admin. With auth off (loopback) it is open, like /mcp.
    app.get('/admin/brains/:slug/health', async (req, res, next) => {
      res.setHeader('Cache-Control', 'no-store');
      const slug = req.params.slug!;
      if (auth) {
        try {
          await auth.authenticator.prepare(credentialHeaders(req));
        } catch (error) {
          return next(error);
        }
        const result = auth.authenticator.authenticate(credentialHeaders(req), { resource: audiences(auth.resource, slug, false), acceptSession: true });
        if (!result.ok) {
          res.setHeader('WWW-Authenticate', result.challenge);
          res.status(result.status).json({ error: result.error });
          return;
        }
        if (!admin.isAdmin(result.principal.login)) {
          logger.warn('Admin request from a non-admin', { path: req.path, login: result.principal.login });
          res.status(403).json({ error: 'forbidden' });
          return;
        }
      }
      const lookup = admin.brainHealth(slug, req.query);
      if (lookup.ok) {
        res.status(200).json(lookup.report);
        return;
      }
      const [status, error] = ADMIN_LOOKUP_STATUS[lookup.reason];
      res.status(status).json({ error });
    });
  }

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
