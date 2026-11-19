import { once } from 'node:events';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { AuditFilter } from '../../../audit/index.js';
import type { Logger } from '../../../shared/logger.js';
import type { AdminService } from '../../application/admin-service.js';
import type { AdminActor } from '../../domain/admin-actor.js';
import { AdminError } from '../../domain/admin-error.js';
import type { AdminErrorCode } from '../../domain/admin-error.js';

/** Where the admin API is mounted. */
export const ADMIN_API_PATH = '/admin/api';

/** The signed-in GitHub login of a request (browser session only, never a bearer token), or undefined. */
export type AdminIdentify = (req: Request) => Promise<string | undefined>;

export interface AdminRouterOptions {
  service: AdminService;
  identify: AdminIdentify;
  logger: Logger;
  /** The most audit rows one CSV download may hold (default 100 000); a larger range is a 400 asking to narrow it. */
  maxExportRows?: number;
}

const DEFAULT_MAX_EXPORT_ROWS = 100_000;
/** CSV lines written between two yields to the event loop. */
const EXPORT_BATCH = 500;

const STATUS: Record<AdminErrorCode, number> = { forbidden: 403, invalid: 400, not_found: 404, conflict: 409 };
const ACTOR = 'adminActor';

function actorOf(res: Response): AdminActor {
  return res.locals[ACTOR] as AdminActor;
}

/** Resolves once the response can take more data or is closed; leaves no listener behind. */
async function drainOrClose(res: Response): Promise<void> {
  const done = new AbortController();
  try {
    await Promise.race([once(res, 'drain', { signal: done.signal }), once(res, 'close', { signal: done.signal })]);
  } finally {
    done.abort();
  }
}

/** `from` / `to` as epoch milliseconds or an ISO 8601 date; undefined when absent. */
function timeParam(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '') throw new AdminError('invalid', `${name} must be a date`);
  const ms = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  if (!Number.isFinite(ms)) throw new AdminError('invalid', `${name} must be epoch milliseconds or an ISO 8601 date`);
  return ms;
}

function textParam(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new AdminError('invalid', `${name} must be a single value`);
  return value;
}

function bodyText(req: Request, name: string): string {
  const value = (req.body as Record<string, unknown> | undefined)?.[name];
  if (typeof value !== 'string') throw new AdminError('invalid', `the JSON body needs a string "${name}"`);
  return value;
}

/**
 * The admin HTTP API (#10), for the admin UI (#17). Signed-in browser
 * sessions only: bearer tokens are issued for the MCP resources and never
 * accepted here. Any request the browser reports as cross-site is refused
 * (the session cookie is SameSite=Lax, so a cross-site navigation would
 * carry it), and mutations need `Content-Type: application/json` (CSRF).
 * Errors are JSON, never a stack. Every decision is the admin service's:
 * these handlers only translate HTTP.
 */
export function createAdminRouter(options: AdminRouterOptions): express.Router {
  const { service, logger } = options;
  const router = express.Router();

  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.use((req, res, next) => {
    // Before identifying the caller: a refused request does no work and writes no audit row.
    if (req.get('sec-fetch-site') === 'cross-site') {
      res.status(403).json({ error: 'forbidden', message: 'cross-site request refused' });
      return;
    }
    next();
  });

  router.use(async (req, res, next) => {
    let login: string | undefined;
    try {
      login = await options.identify(req);
    } catch (error) {
      return next(error);
    }
    if (!login) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // The header itself, body or not (a DELETE has none): a cross-site form cannot set it without a CORS preflight.
      if ((req.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase() !== 'application/json') {
        res.status(415).json({ error: 'Content-Type must be application/json' });
        return;
      }
    }
    res.locals[ACTOR] = { kind: 'user', login } satisfies AdminActor;
    next();
  });
  router.use(express.json({ limit: '16kb' }));

  router.get('/brains', (_req, res) => {
    res.json({ brains: service.listBrains(actorOf(res)) });
  });
  router.post('/brains', (req, res) => {
    res.status(201).json({ brain: service.createBrain(actorOf(res), bodyText(req, 'slug')) });
  });
  router.post('/brains/:slug/archive', async (req, res, next) => {
    try {
      res.json({ brain: await service.archiveBrain(actorOf(res), req.params.slug!) });
    } catch (error) {
      next(error);
    }
  });

  router.get('/users', (_req, res) => {
    res.json({ users: service.listUsers(actorOf(res)) });
  });
  router.post('/users', (req, res) => {
    res.status(201).json({ user: service.inviteUser(actorOf(res), bodyText(req, 'login')) });
  });
  router.post('/users/:login/disable', (req, res) => {
    res.json({ user: service.disableUser(actorOf(res), req.params.login!) });
  });
  router.post('/users/:login/enable', (req, res) => {
    res.json({ user: service.enableUser(actorOf(res), req.params.login!) });
  });

  router.get('/grants', (req, res) => {
    const brain = textParam(req.query.brain, 'brain');
    const login = textParam(req.query.login, 'login');
    res.json({ grants: service.listGrants(actorOf(res), { ...(brain !== undefined ? { brain } : {}), ...(login !== undefined ? { login } : {}) }) });
  });
  router.put('/brains/:slug/grants/:login', (req, res) => {
    res.json({ grant: service.setGrant(actorOf(res), req.params.login!, req.params.slug!, bodyText(req, 'role')) });
  });
  router.delete('/brains/:slug/grants/:login', (req, res) => {
    service.revokeGrant(actorOf(res), req.params.login!, req.params.slug!);
    res.status(204).end();
  });

  router.get('/audit.csv', async (req, res, next) => {
    let lines: Iterable<string>;
    try {
      const brain = textParam(req.query.brain, 'brain');
      const fromMs = timeParam(req.query.from, 'from');
      const toMs = timeParam(req.query.to, 'to');
      const filter: AuditFilter = {
        ...(brain !== undefined ? { brain } : {}), ...(fromMs !== undefined ? { fromMs } : {}), ...(toMs !== undefined ? { toMs } : {})
      };
      lines = service.exportAudit(actorOf(res), filter, { maxRows: options.maxExportRows ?? DEFAULT_MAX_EXPORT_ROWS });
    } catch (error) {
      return next(error);
    }
    res.status(200);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="audit.csv"');
    try {
      let batch = 0;
      for (const line of lines) {
        if (res.destroyed) return;
        // Respect backpressure: wait for the socket to drain, or stop if the client left.
        if (!res.write(line)) await drainOrClose(res);
        if (++batch === EXPORT_BATCH) {
          batch = 0;
          await yieldToEventLoop();
        }
      }
      res.end();
    } catch (error) {
      logger.error('Audit export failed mid-stream', { reason: (error as Error).message });
      res.destroy();
    }
  });

  router.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found' });
  });

  // Every error is JSON and carries no stack or internal message.
  router.use((err: Error & { type?: unknown; status?: unknown }, req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (err instanceof AdminError) {
      if (err.code === 'forbidden') logger.warn('Admin API request denied', { method: req.method, path: req.path, login: res.locals[ACTOR]?.login });
      res.status(STATUS[err.code]).json({ error: err.code, message: err.message });
      return;
    }
    // body-parser errors: a client mistake with its own 4xx status.
    if (typeof err.type === 'string' && typeof err.status === 'number' && err.status >= 400 && err.status < 500) {
      if (err.type === 'entity.parse.failed') res.status(400).json({ error: 'invalid', message: 'the body is not valid JSON' });
      else if (err.status === 413) res.status(413).json({ error: 'too_large', message: 'the body is too large' });
      else res.status(err.status).json({ error: 'invalid', message: 'the request body was refused' });
      return;
    }
    logger.error('Admin API request failed', { method: req.method, path: req.path, reason: err.message });
    res.status(500).json({ error: 'internal' });
  });

  return router;
}
