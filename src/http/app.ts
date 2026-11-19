import express from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { IncomingMessage } from 'node:http';
import type { AuthInfo } from '@modelcontextprotocol/server';
import type { Logger } from '../shared/logger.js';
import { parseCookies } from '../auth/index.js';
import type { HttpRequestAuthenticator } from '../auth/index.js';
import { ADMIN_API_PATH } from '../admin/index.js';
import type { AdminIdentify } from '../admin/index.js';
import { PAT_PROVIDER } from '../connections/index.js';
import { UI_PATH } from '../ui/index.js';
import type { UiIdentify } from '../ui/index.js';
import { MCP_AUTH_INFO_LOCAL, MCP_BRAIN_LOCAL, MCP_CONNECTION_LOCAL, MCP_DEFAULT_BRAIN, MCP_HTTP_PATH, createMcpHttpRouter } from './mcp-route.js';
import type { McpBrains, McpServerFactory } from './mcp-route.js';

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
  /**
   * Does `login` hold any role on brain `brain`, and, for a request through
   * a connection (#27; a PAT is one, #7), is the brain one of its brains?
   */
  mayOpen(login: string, brain: string, connectionId?: number): boolean;
}

/** Where the signed-in user's own API (personal access tokens, #7) is mounted. */
export const ACCOUNT_API_PATH = '/account/api';

/** Admin endpoints (instance admins only when auth is on). */
export interface AdminApi {
  isAdmin(login: string): boolean;
  /** The health report (#18) of brain `slug`; `rawOptions` is the query string. */
  /** Records an authenticated admin read (the audit log); `login` is null with auth off. */
  recordAccess?(access: { login: string | null; brain: string; outcome: 'ok' | 'error' | 'denied' }): void;
  brainHealth(slug: string, rawOptions: unknown): { ok: true; report: unknown } | { ok: false; reason: 'unknown_brain' | 'no_data' | 'invalid_arguments' | 'busy'; message: string };
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
  /**
   * Builds the admin API router (#10) from the request's identity (signed-in
   * browser session only). Mounted at `/admin/api` when auth is on; with auth
   * off there is no identity, so the admin API does not exist (use the CLI).
   * Separate from `admin` (#28, the read-only brain health endpoint, which is
   * open on loopback with auth off).
   */
  adminApi?: (identify: AdminIdentify) => express.Router;
  /**
   * Builds the signed-in user's own API (#7: personal access tokens) from
   * the request's identity, browser session only, like the admin API.
   * Mounted at `/account/api` when auth is on.
   */
  accountApi?: (identify: AdminIdentify) => express.Router;
  /**
   * Builds the web admin panel (#17) from the request's browser session.
   * Mounted at `/ui` when auth is on.
   */
  ui?: (identify: UiIdentify) => express.Router;
  /** The brains served at `/mcp/<slug>` (`/mcp`: the default brain), with live/idle counts for `/health/brains`. */
  brains: McpBrains & { stats(): { live: number; idle: number } };
  /** `GET /admin/brains/<slug>/health`; absent: no admin endpoints. */
  admin?: AdminApi;
  /**
   * Serves a connection token on the bare `/mcp` (#27): every brain of the
   * connection, chosen per call. Without it a connection token on `/mcp` is
   * served by the default brain like any other token.
   */
  connectionServer?: McpServerFactory;
  logger: Logger;
}

const ADMIN_LOOKUP_STATUS = { unknown_brain: [404, 'not_found'], no_data: [404, 'no_data'], invalid_arguments: [400, 'invalid_request'], busy: [503, 'busy'] } as const;

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

  // Session cookie only: the Authorization header is dropped, so an MCP
  // access token or a PAT can never act on the admin or account API.
  const identify: AdminIdentify = async req => {
    const headers = { authorization: undefined, cookie: single(req.headers.cookie) };
    await auth!.authenticator.prepare(headers);
    const result = auth!.authenticator.authenticate(headers, { resource: auth!.resource, acceptSession: true });
    return result.ok ? result.principal.login : undefined;
  };
  if (auth && options.adminApi) app.use(ADMIN_API_PATH, options.adminApi(identify));
  if (auth && options.accountApi) app.use(ACCOUNT_API_PATH, options.accountApi(identify));
  // The panel's CSRF tokens are bound to the session cookie itself (it holds
  // a random session id), so they die with the session. A provider that
  // names no session cookie binds them to the login.
  const identifySession: UiIdentify = async req => {
    const login = await identify(req);
    if (!login) return undefined;
    const cookies = parseCookies(single(req.headers.cookie));
    const names = auth!.authenticator.sessionCookieNames(single(req.headers.cookie)).sort();
    const binding = names.map(name => `${name}=${cookies.get(name) ?? ''}`).join(';');
    // No session cookie to bind to (a provider that names none): no binding, and the panel refuses.
    return { login, binding: binding === '' ? null : binding };
  };
  if (auth && options.ui) app.use(UI_PATH, options.ui(identifySession));

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
    // A connection token on the bare endpoint picks a brain per call; each
    // call checks the grant and the connection's role on its brain.
    const connectionMode = principal.connectionId !== undefined && req.path === '/' && options.connectionServer !== undefined;
    if (connectionMode) res.locals[MCP_CONNECTION_LOCAL] = true;
    // The token proves who this is; the grant (and the connection's brains),
    // read now, say whether this brain is theirs.
    else if (!options.brainAccess!.mayOpen(principal.login, slug, principal.connectionId)) {
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
      extra: {
        login: principal.login, brain: slug,
        ...(principal.provider ? { provider: principal.provider } : {}),
        ...(principal.connectionId !== undefined ? { connectionId: principal.connectionId } : {})
      }
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
    authMiddleware: [mcpAuth],
    ...(options.connectionServer ? { connectionServer: options.connectionServer } : {})
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
      let login: string | null = null;
      const record = (outcome: 'ok' | 'error' | 'denied') => {
        try {
          admin.recordAccess?.({ login, brain: slug, outcome });
        } catch (error) {
          logger.error('Audit log write failed for an admin read', { path: req.path, reason: (error as Error).message });
        }
      };
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
        login = result.principal.login;
        // A PAT (#7) is a credential for the MCP endpoint only, whoever owns it.
        if (!admin.isAdmin(login) || result.principal.provider === PAT_PROVIDER) {
          record('denied');
          logger.warn('Admin request from a non-admin', { path: req.path, login });
          res.status(403).json({ error: 'forbidden' });
          return;
        }
      }
      const lookup = admin.brainHealth(slug, req.query);
      record(lookup.ok ? 'ok' : 'error');
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
