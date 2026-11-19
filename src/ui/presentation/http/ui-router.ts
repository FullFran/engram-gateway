import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { isSameOrigin } from '../../../auth/index.js';
import type { Role } from '../../../authz/index.js';
import { PatError, patJson } from '../../../connections/index.js';
import type { PersonalAccessTokens } from '../../../connections/index.js';
import type { Logger } from '../../../shared/logger.js';
import { CsrfTokens } from './csrf.js';
import { renderBarePage, renderPage, securityHeaders } from './layout.js';
import { tokensContent } from './views/tokens.js';
import type { TokensView } from './views/tokens.js';

/** Where the panel is mounted. */
export const UI_PATH = '/ui';

/** The signed-in user of a request, from the browser session only. */
export interface UiSession {
  login: string;
  /** What the session's CSRF token is bound to: the session cookie itself. */
  binding: string;
}

export type UiIdentify = (req: Request) => Promise<UiSession | undefined>;

export interface UiRouterOptions {
  identify: UiIdentify;
  /** The gateway's public origin (the OAuth issuer): a form POST must come from it. */
  origin: string;
  isAdmin(login: string): boolean;
  tokens: PersonalAccessTokens;
  /** The user's grants: the brains a token of theirs may use. */
  brainsOf(login: string): { brain: string; role: Role }[];
  clock: { nowMs(): number };
  logger: Logger;
  /** Defaults to a random key per process. */
  csrf?: CsrfTokens;
}

const STATUS = { invalid: 400, not_found: 404, conflict: 409 } as const;

interface Context {
  session: UiSession;
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
    const context: Context = { session, csrf: csrfTokens.issue(session.binding), isAdmin: options.isAdmin(session.login) };
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

  router.use((_req, res) => {
    send(res, 404, 'Page not found', '', '<h1>Page not found</h1><p><a href="/ui">Back to the panel</a></p>');
  });

  router.use((error: Error, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(error);
    logger.error('Panel request failed', { path: req.path, message: error.message });
    res.status(500).type('html').send(renderBarePage('Something went wrong', 'The gateway could not complete this request. Try again later.', { href: '/ui', label: 'Back to the panel' }));
  });

  return router;
}
