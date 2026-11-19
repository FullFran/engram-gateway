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
}

const STATUS: Record<AdminErrorCode, number> = { forbidden: 403, invalid: 400, not_found: 404, conflict: 409 };
const ACTOR = 'adminActor';

function actorOf(res: Response): AdminActor {
  return res.locals[ACTOR] as AdminActor;
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
 * accepted here. Mutations need `Content-Type: application/json` and are
 * refused when the browser reports a cross-site request (CSRF). Every
 * decision is the admin service's: these handlers only translate HTTP.
 */
export function createAdminRouter(options: AdminRouterOptions): express.Router {
  const { service, logger } = options;
  const router = express.Router();

  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
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
      if (req.get('sec-fetch-site') === 'cross-site') {
        res.status(403).json({ error: 'cross-site request refused' });
        return;
      }
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

  router.get('/audit.csv', (req, res) => {
    const brain = textParam(req.query.brain, 'brain');
    const fromMs = timeParam(req.query.from, 'from');
    const toMs = timeParam(req.query.to, 'to');
    const filter: AuditFilter = {
      ...(brain !== undefined ? { brain } : {}), ...(fromMs !== undefined ? { fromMs } : {}), ...(toMs !== undefined ? { toMs } : {})
    };
    const lines = service.exportAudit(actorOf(res), filter);
    res.status(200);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="audit.csv"');
    for (const line of lines) res.write(line);
    res.end();
  });

  router.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found' });
  });

  router.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    if (err instanceof AdminError) {
      if (err.code === 'forbidden') logger.warn('Admin API request denied', { method: req.method, path: req.path, login: res.locals[ACTOR]?.login });
      res.status(STATUS[err.code]).json({ error: err.code, message: err.message });
      return;
    }
    next(err);
  });

  return router;
}
