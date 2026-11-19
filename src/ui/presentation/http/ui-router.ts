import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { AdminError } from '../../../admin/index.js';
import type { AdminActor, AdminService, AuditQueryRequest } from '../../../admin/index.js';
import { isSameOrigin } from '../../../auth/index.js';
import type { Role } from '../../../authz/index.js';
import { OwnConnectionError, PatError, patJson } from '../../../connections/index.js';
import type { OwnConnections, PersonalAccessTokens } from '../../../connections/index.js';
import type { Logger } from '../../../shared/logger.js';
import { CsrfTokens } from './csrf.js';
import { alertBox, renderBarePage, renderPage, securityHeaders } from './layout.js';
import { auditContent } from './views/audit.js';
import type { AuditFilterForm } from './views/audit.js';
import { brainHealthContent, brainsContent } from './views/brains.js';
import { connectionsContent } from './views/connections.js';
import { serviceAccountsContent } from './views/service-accounts.js';
import { userGrantsContent, usersContent } from './views/users.js';
import { tokensContent } from './views/tokens.js';
import type { TokenRow, TokensView } from './views/tokens.js';

/** Where the panel is mounted. */
export const UI_PATH = '/ui';

/** The signed-in user of a request, from the browser session only. */
export interface UiSession {
  login: string;
  /**
   * What the session's CSRF token is bound to: the session cookie itself.
   * Null when the sign-in names no session cookie: the panel is refused then,
   * never bound to something stable such as the login.
   */
  binding: string | null;
}

export type UiIdentify = (req: Request) => Promise<UiSession | undefined>;

export interface UiRouterOptions {
  identify: UiIdentify;
  /** The gateway's public origin (the OAuth issuer): a form POST must come from it. */
  origin: string;
  isAdmin(login: string): boolean;
  tokens: PersonalAccessTokens;
  connections: OwnConnections;
  /** The admin use cases (#10): they authorize (instance admins only) and audit every admin page. */
  admin: AdminService;
  /** The user's grants: the brains a token of theirs may use. */
  brainsOf(login: string): { brain: string; role: Role }[];
  clock: { nowMs(): number };
  logger: Logger;
  /** Defaults to a random key per process. */
  csrf?: CsrfTokens;
}

const STATUS = { invalid: 400, not_found: 404, conflict: 409 } as const;
const ADMIN_STATUS = { forbidden: 403, ...STATUS } as const;

interface Context {
  session: { login: string; binding: string };
  csrf: string;
  isAdmin: boolean;
}

const CONTEXT = 'uiContext';

function list(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * The web admin panel (#17): server-rendered pages, no script. Browser
 * session only (an Authorization header is never read). Every form POST must
 * come from the gateway's own origin and carry the session's CSRF token; it
 * is refused before any service is called. Each page calls the same
 * application services as the JSON APIs, which make every decision
 * (authorization, validation, audit): handlers only translate HTTP.
 */
export function createUiRouter(options: UiRouterOptions): express.Router {
  const { tokens, logger } = options;
  const csrfTokens = options.csrf ?? new CsrfTokens();
  const nowS = () => Math.floor(options.clock.nowMs() / 1000);
  const router = express.Router();

  router.use((_req, res, next) => {
    securityHeaders(res);
    next();
  });

  router.use(async (req, res, next) => {
    let session: UiSession | undefined;
    try {
      session = await options.identify(req);
    } catch (error) {
      return next(error);
    }
    if (!session) {
      if (req.method === 'GET' || req.method === 'HEAD') {
        res.redirect(303, `/oauth/login?return_to=${encodeURIComponent(req.originalUrl)}`);
        return;
      }
      res.status(401).type('html').send(renderBarePage('Signed out', 'Your session has ended. Sign in again, then repeat the action.', { href: '/oauth/login?return_to=%2Fui', label: 'Sign in' }));
      return;
    }
    if (session.binding === null) {
      logger.warn('Panel refused: the sign-in names no session cookie', { login: session.login });
      res.status(403).type('html').send(renderBarePage('Panel unavailable', 'The panel cannot be used with this sign-in: it has no browser session to bind its forms to.'));
      return;
    }
    const bound = { login: session.login, binding: session.binding };
    const context: Context = { session: bound, csrf: csrfTokens.issue(bound.binding), isAdmin: options.isAdmin(bound.login) };
    res.locals[CONTEXT] = context;
    next();
  });

  // Every POST: same origin, then the session's CSRF token, before the body reaches a handler.
  const refuse = (res: Response) => {
    res.status(403).type('html').send(renderBarePage('Form refused', 'This form was not sent from this page or has expired. Reload the page and try again.', { href: '/ui', label: 'Back to the panel' }));
  };
  const urlencoded = express.urlencoded({ extended: false, limit: '16kb' });
  router.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    const site = req.get('sec-fetch-site');
    if ((site !== undefined && site !== 'same-origin') || !isSameOrigin(req.headers, options.origin)) return refuse(res);
    next();
  }, (req, res, next) => (req.method === 'GET' || req.method === 'HEAD' ? next() : urlencoded(req, res, next)), (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    const context = res.locals[CONTEXT] as Context;
    if (!csrfTokens.verify(context.session.binding, (req.body as Record<string, unknown> | undefined)?.csrf)) {
      logger.warn('Panel form refused: CSRF token', { login: context.session.login, path: req.path });
      return refuse(res);
    }
    next();
  });

  const ctx = (res: Response): Context => res.locals[CONTEXT] as Context;
  const send = (res: Response, status: number, title: string, current: string, content: string) => {
    const { session, isAdmin } = ctx(res);
    res.status(status).type('html').send(renderPage({ title, login: session.login, isAdmin, current }, content));
  };

  router.get('/', (_req, res) => {
    res.redirect(303, '/ui/tokens');
  });

  // ---- My tokens (#7) ----
  const tokensView = (res: Response, extra: Partial<TokensView> = {}): TokensView => {
    const login = ctx(res).session.login;
    return {
      csrf: ctx(res).csrf,
      tokens: tokens.list(login).map(pat => patJson(pat, nowS())),
      brains: options.brainsOf(login),
      ...extra
    };
  };
  const sendTokens = (res: Response, status: number, extra: Partial<TokensView> = {}) =>
    send(res, status, 'My tokens', '/ui/tokens', tokensContent(tokensView(res, extra)));

  router.get('/tokens', (_req, res) => sendTokens(res, 200));

  router.post('/tokens', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const form = { name: text(body.name), brains: list(body.brains), scope: text(body.scope), expires: text(body.expires) };
    const login = ctx(res).session.login;
    try {
      const created = tokens.create({ kind: 'user', login }, login, {
        name: form.name, brains: form.brains, scope: form.scope, expiresInDays: /^\d{1,4}$/.test(form.expires) ? Number(form.expires) : form.expires
      });
      // The only time the secret leaves the gateway: in this response, never in a URL.
      sendTokens(res, 201, { created: { name: created.pat.name, token: created.token } });
    } catch (error) {
      if (!(error instanceof PatError)) throw error;
      sendTokens(res, STATUS[error.code], { error: error.message, form });
    }
  });

  router.post('/tokens/:id/revoke', (req, res) => {
    const login = ctx(res).session.login;
    try {
      const id = /^\d{1,15}$/.test(req.params.id ?? '') ? Number(req.params.id) : NaN;
      if (!Number.isSafeInteger(id)) throw new PatError('not_found', 'no such token');
      tokens.revoke({ kind: 'user', login }, login, id);
      res.redirect(303, '/ui/tokens');
    } catch (error) {
      if (!(error instanceof PatError)) throw error;
      sendTokens(res, STATUS[error.code], { error: error.message });
    }
  });

  // ---- My connections (#27) ----
  const sendConnections = (res: Response, status: number, error?: string) => {
    const { session, csrf } = ctx(res);
    send(res, status, 'My connections', '/ui/connections', connectionsContent({ csrf, connections: options.connections.list(session.login), ...(error ? { error } : {}) }));
  };
  const connectionChange = (change: (actor: { kind: 'user'; login: string }, id: number, body: Record<string, unknown>) => void) =>
    (req: Request, res: Response) => {
      const id = /^\d{1,15}$/.test(req.params.id ?? '') ? Number(req.params.id) : NaN;
      try {
        change({ kind: 'user', login: ctx(res).session.login }, id, (req.body ?? {}) as Record<string, unknown>);
        res.redirect(303, '/ui/connections');
      } catch (error) {
        if (!(error instanceof OwnConnectionError)) throw error;
        sendConnections(res, STATUS[error.code], error.message);
      }
    };

  router.get('/connections', (_req, res) => sendConnections(res, 200));
  router.post('/connections/:id/attach', connectionChange((actor, id, body) =>
    options.connections.attach(actor, id, text(body.brain), body.role, body.default === 'on')));
  router.post('/connections/:id/detach', connectionChange((actor, id, body) =>
    options.connections.detach(actor, id, text(body.brain))));

  // ---- Administration (#10): the admin service decides who may, and audits ----
  const actor = (res: Response): AdminActor => ({ kind: 'user', login: ctx(res).session.login });
  /** Renders an admin page; a refusal of the service is shown on it with the service's status. */
  const adminPage = (res: Response, title: string, current: string, render: () => string, status = 200) => {
    try {
      send(res, status, title, current, render());
    } catch (error) {
      if (!(error instanceof AdminError)) throw error;
      send(res, ADMIN_STATUS[error.code], title, current, `<h1>${title}</h1>${alertBox(error.message)}`);
    }
  };
  const sendBrains = (res: Response, status: number, extra: { error?: string; slug?: string } = {}) =>
    adminPage(res, 'Brains', '/ui/brains', () => brainsContent({ csrf: ctx(res).csrf, brains: options.admin.listBrains(actor(res)), ...extra }), status);
  /** Runs an admin change, then back to `back`; a refusal re-renders the page with the message. */
  const adminChange = async (res: Response, back: string, change: () => unknown, rerender: (status: number, error: string) => void) => {
    try {
      await change();
      res.redirect(303, back);
    } catch (error) {
      if (!(error instanceof AdminError)) throw error;
      rerender(ADMIN_STATUS[error.code], error.message);
    }
  };

  router.get('/brains', (_req, res) => sendBrains(res, 200));
  router.post('/brains', (req, res, next) => {
    const slug = text((req.body as Record<string, unknown> | undefined)?.slug);
    adminChange(res, '/ui/brains', () => options.admin.createBrain(actor(res), slug), (status, error) => sendBrains(res, status, { error, slug })).catch(next);
  });
  router.post('/brains/:slug/archive', (req, res, next) => {
    adminChange(res, '/ui/brains', () => options.admin.archiveBrain(actor(res), req.params.slug ?? ''), (status, error) => sendBrains(res, status, { error })).catch(next);
  });
  router.get('/brains/:slug', (req, res) => {
    const slug = req.params.slug ?? '';
    adminPage(res, 'Brain health', '/ui/brains', () => brainHealthContent(slug, options.admin.brainHealth(actor(res), slug)));
  });

  // Users and their grants (#10)
  const sendUsers = (res: Response, status: number, extra: { error?: string; login?: string } = {}) =>
    adminPage(res, 'Users', '/ui/users', () => usersContent({ csrf: ctx(res).csrf, users: options.admin.listUsers(actor(res)), ...extra }), status);
  const userPath = (login: string) => `/ui/users/${encodeURIComponent(login)}`;
  const sendUser = (res: Response, login: string, status: number, error?: string) =>
    adminPage(res, 'User', '/ui/users', () => {
      const user = options.admin.listUsers(actor(res)).find(row => row.login.toLowerCase() === login.toLowerCase());
      if (!user) throw new AdminError('not_found', `unknown user ${JSON.stringify(login)}`);
      return userGrantsContent({
        csrf: ctx(res).csrf, user,
        grants: options.admin.listGrants(actor(res), { login: user.login }),
        brains: options.admin.listBrains(actor(res)).filter(brain => brain.status === 'active').map(brain => brain.slug),
        ...(error ? { error } : {})
      });
    }, status);
  const field = (req: Request, name: string) => text((req.body as Record<string, unknown> | undefined)?.[name]);

  router.get('/users', (_req, res) => sendUsers(res, 200));
  router.post('/users', (req, res, next) => {
    const login = field(req, 'login').trim();
    adminChange(res, '/ui/users', () => options.admin.inviteUser(actor(res), login), (status, error) => sendUsers(res, status, { error, login })).catch(next);
  });
  for (const action of ['disable', 'enable'] as const) {
    router.post(`/users/:login/${action}`, (req, res, next) => {
      const login = req.params.login ?? '';
      const change = () => (action === 'disable' ? options.admin.disableUser(actor(res), login) : options.admin.enableUser(actor(res), login));
      adminChange(res, '/ui/users', change, (status, error) => sendUsers(res, status, { error })).catch(next);
    });
  }
  router.get('/users/:login', (req, res) => sendUser(res, req.params.login ?? '', 200));
  router.post('/users/:login/grants', (req, res, next) => {
    const login = req.params.login ?? '';
    adminChange(res, userPath(login), () => options.admin.setGrant(actor(res), login, field(req, 'brain'), field(req, 'role')),
      (status, error) => sendUser(res, login, status, error)).catch(next);
  });
  router.post('/users/:login/grants/:brain/revoke', (req, res, next) => {
    const login = req.params.login ?? '';
    adminChange(res, userPath(login), () => options.admin.revokeGrant(actor(res), login, req.params.brain ?? ''),
      (status, error) => sendUser(res, login, status, error)).catch(next);
  });

  // Service accounts and their tokens (#7)
  const sendAccounts = (res: Response, status: number, extra: { error?: string; login?: string } = {}) =>
    adminPage(res, 'Service accounts', '/ui/service-accounts',
      () => serviceAccountsContent({ csrf: ctx(res).csrf, accounts: options.admin.listServiceAccounts(actor(res)), ...extra }), status);
  const accountPath = (login: string) => `/ui/service-accounts/${encodeURIComponent(login)}`;
  const sendAccount = (res: Response, login: string, status: number, extra: Partial<TokensView> = {}) =>
    adminPage(res, 'Service account', '/ui/service-accounts', () => {
      const account = options.admin.listServiceAccounts(actor(res)).find(row => row.login.toLowerCase() === login.toLowerCase());
      if (!account) throw new AdminError('not_found', `unknown service account ${JSON.stringify(login)}`);
      return tokensContent({
        csrf: ctx(res).csrf,
        account: { login: account.login, owner: account.owner, status: account.status },
        tokens: options.admin.listServiceAccountTokens(actor(res), account.login) as TokenRow[],
        brains: options.admin.listGrants(actor(res), { login: account.login }).map(grant => ({ brain: grant.brain, role: grant.role })),
        ...extra
      });
    }, status);

  router.get('/service-accounts', (_req, res) => sendAccounts(res, 200));
  router.post('/service-accounts', (req, res, next) => {
    const login = field(req, 'login').trim();
    adminChange(res, accountPath(login), () => options.admin.createServiceAccount(actor(res), login), (status, error) => sendAccounts(res, status, { error, login })).catch(next);
  });
  router.get('/service-accounts/:login', (req, res) => sendAccount(res, req.params.login ?? '', 200));
  router.post('/service-accounts/:login/tokens', (req, res) => {
    const login = req.params.login ?? '';
    const body = (req.body ?? {}) as Record<string, unknown>;
    const form = { name: text(body.name), brains: list(body.brains), scope: text(body.scope), expires: text(body.expires) };
    let created: { token: string; name?: unknown };
    try {
      created = options.admin.createServiceAccountToken(actor(res), login, {
        name: form.name, brains: form.brains, scope: form.scope, expiresInDays: /^\d{1,4}$/.test(form.expires) ? Number(form.expires) : form.expires
      });
    } catch (error) {
      if (!(error instanceof AdminError)) throw error;
      // A refusal of the token itself is shown on the account's page; a refused admin gets the 403 page.
      if (error.code === 'forbidden' || error.code === 'not_found') {
        return send(res, ADMIN_STATUS[error.code], 'Service account', '/ui/service-accounts', `<h1>Service account</h1>${alertBox(error.message)}`);
      }
      return sendAccount(res, login, ADMIN_STATUS[error.code], { error: error.message, form });
    }
    // The only time the secret leaves the gateway: in this response, never in a URL.
    sendAccount(res, login, 201, { created: { name: typeof created.name === 'string' ? created.name : form.name, token: created.token } });
  });
  router.post('/service-accounts/:login/tokens/:id/revoke', (req, res, next) => {
    const login = req.params.login ?? '';
    const id = /^\d{1,15}$/.test(req.params.id ?? '') ? Number(req.params.id) : NaN;
    adminChange(res, accountPath(login), () => options.admin.revokeServiceAccountToken(actor(res), login, id),
      (status, error) => sendAccount(res, login, status, { error })).catch(next);
  });

  // The audit log (#8): a read, so a GET form with no CSRF token
  const DAY_MS = 86_400_000;
  const dayParam = (value: string, name: string): number | undefined => {
    if (value === '') return undefined;
    const ms = /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00Z`) : NaN;
    if (!Number.isFinite(ms)) throw new AdminError('invalid', `${name} must be a date (YYYY-MM-DD)`);
    return ms;
  };
  const countParam = (value: string, name: string): number | undefined => {
    if (value === '') return undefined;
    if (!/^\d{1,15}$/.test(value)) throw new AdminError('invalid', `${name} must be a positive integer`);
    return Number(value);
  };
  router.get('/audit', (req, res) => {
    const query = (name: string) => text(req.query[name]).trim();
    const form: AuditFilterForm = { brain: query('brain'), action: query('action'), actor: query('actor'), outcome: query('outcome'), from: query('from'), to: query('to') };
    const csv = new URLSearchParams();
    let rows: ReturnType<AdminService['queryAudit']>['rows'] = [];
    let olderHref: string | null = null;
    let error: string | undefined;
    try {
      const fromMs = dayParam(form.from, 'from');
      const toDay = dayParam(form.to, 'to');
      const toMs = toDay === undefined ? undefined : toDay + DAY_MS;
      const request: AuditQueryRequest = {};
      if (form.brain) request.brain = form.brain;
      if (form.action) request.action = form.action;
      if (form.actor) request.actor = form.actor;
      if (form.outcome) request.outcome = form.outcome;
      if (fromMs !== undefined) request.fromMs = fromMs;
      if (toMs !== undefined) request.toMs = toMs;
      const limit = countParam(query('limit'), 'limit');
      const before = countParam(query('before'), 'before');
      if (limit !== undefined) request.limit = limit;
      if (before !== undefined) request.before = before;
      const page = options.admin.queryAudit(actor(res), request);
      rows = page.rows;
      if (page.nextBefore !== null) {
        const next = new URLSearchParams(Object.entries(form).filter(([, value]) => value !== ''));
        if (limit !== undefined) next.set('limit', String(limit));
        next.set('before', String(page.nextBefore));
        olderHref = `/ui/audit?${next}`;
      }
      if (form.brain) csv.set('brain', form.brain);
      if (fromMs !== undefined) csv.set('from', new Date(fromMs).toISOString());
      if (toMs !== undefined) csv.set('to', new Date(toMs).toISOString());
    } catch (caught) {
      // A bad filter is shown above the form; a refused reader gets the 403 page.
      if (!(caught instanceof AdminError)) throw caught;
      if (caught.code !== 'invalid') return send(res, ADMIN_STATUS[caught.code], 'Audit log', '/ui/audit', `<h1>Audit log</h1>${alertBox(caught.message)}`);
      error = caught.message;
    }
    const csvHref = `/admin/api/audit.csv${csv.size > 0 ? `?${csv}` : ''}`;
    send(res, error ? 400 : 200, 'Audit log', '/ui/audit', auditContent({ form, rows, olderHref, csvHref, ...(error ? { error } : {}) }));
  });

  router.use((_req, res) => {
    send(res, 404, 'Page not found', '', '<h1>Page not found</h1><p><a href="/ui">Back to the panel</a></p>');
  });

  // A form body the parser refuses (too large, too many fields, unknown charset): the client's fault, said on a page.
  const BODY_ERRORS: Record<string, { status: number; title: string; message: string }> = {
    'entity.too.large': { status: 413, title: 'Form too large', message: 'This form sent more data than the panel accepts.' },
    'parameters.too.many': { status: 413, title: 'Form too large', message: 'This form sent more fields than the panel accepts.' },
    'charset.unsupported': { status: 415, title: 'Form not readable', message: 'This form was sent in an encoding the panel does not read.' },
    'encoding.unsupported': { status: 415, title: 'Form not readable', message: 'This form was sent in an encoding the panel does not read.' },
    'entity.parse.failed': { status: 400, title: 'Form not readable', message: 'This form could not be read.' },
    'request.aborted': { status: 400, title: 'Form not readable', message: 'This form arrived incomplete.' }
  };
  router.use((error: Error & { type?: string }, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(error);
    const body = error.type !== undefined ? BODY_ERRORS[error.type] : undefined;
    if (body) {
      res.status(body.status).type('html').send(renderBarePage(body.title, `${body.message} Reload the page and try again.`, { href: '/ui', label: 'Back to the panel' }));
      return;
    }
    logger.error('Panel request failed', { path: req.path, message: error.message });
    res.status(500).type('html').send(renderBarePage('Something went wrong', 'The gateway could not complete this request. Try again later.', { href: '/ui', label: 'Back to the panel' }));
  });

  return router;
}
