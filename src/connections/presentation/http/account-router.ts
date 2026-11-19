import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { PersonalAccessTokens } from '../../application/personal-access-tokens.js';
import { PatError } from '../../application/personal-access-tokens.js';
import { patStatus } from '../../domain/personal-access-token.js';
import type { PatView } from '../../domain/personal-access-token.js';

/** The signed-in login of a request (browser session only, never a bearer token), or undefined. */
export type AccountIdentify = (req: Request) => Promise<string | undefined>;

export interface AccountRouterOptions {
  tokens: PersonalAccessTokens;
  identify: AccountIdentify;
  clock: { nowMs(): number };
}

const STATUS = { invalid: 400, not_found: 404, conflict: 409 } as const;
const LOGIN = 'accountLogin';

const iso = (seconds: number | null): string | null => (seconds === null ? null : new Date(seconds * 1000).toISOString());

/** A PAT as JSON: never the secret. */
export function patJson(pat: PatView, nowS: number) {
  return {
    id: pat.id, name: pat.name, brains: pat.brains, scope: pat.scope, status: patStatus(pat, nowS),
    createdAt: iso(pat.createdAt), expiresAt: iso(pat.expiresAt), lastUsedAt: iso(pat.lastUsedAt), revokedAt: iso(pat.revokedAt)
  };
}

/**
 * The signed-in user's own API (#7): their personal access tokens. Same
 * CSRF rules as the admin API: browser sessions only, anything the browser
 * reports as cross-site is refused, and mutations need
 * `Content-Type: application/json`. A user only ever sees and revokes their
 * own tokens. The secret is in the creation response and nowhere else.
 */
export function createAccountRouter(options: AccountRouterOptions): express.Router {
  const { tokens, clock } = options;
  const nowS = () => Math.floor(clock.nowMs() / 1000);
  const router = express.Router();

  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
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
    if (req.method !== 'GET' && req.method !== 'HEAD' && (req.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase() !== 'application/json') {
      res.status(415).json({ error: 'Content-Type must be application/json' });
      return;
    }
    res.locals[LOGIN] = login;
    next();
  });
  router.use(express.json({ limit: '16kb' }));

  const login = (res: Response): string => res.locals[LOGIN] as string;

  router.get('/tokens', (_req, res) => {
    res.json({ tokens: tokens.list(login(res)).map(pat => patJson(pat, nowS())) });
  });

  router.post('/tokens', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const owner = login(res);
    const created = tokens.create({ kind: 'user', login: owner }, owner, { name: body.name, brains: body.brains, scope: body.scope, expiresInDays: body.expiresInDays });
    // The only time the secret leaves the gateway.
    res.status(201).json({ token: created.token, ...patJson(created.pat, nowS()) });
  });

  router.delete('/tokens/:id', (req, res) => {
    const id = /^\d{1,15}$/.test(req.params.id ?? '') ? Number(req.params.id) : NaN;
    if (!Number.isSafeInteger(id)) throw new PatError('not_found', 'no such token');
    const owner = login(res);
    res.json(patJson(tokens.revoke({ kind: 'user', login: owner }, owner, id), nowS()));
  });

  router.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  router.use((error: Error, _req: Request, res: Response, next: NextFunction) => {
    if (error instanceof PatError) {
      res.status(STATUS[error.code]).json({ error: error.code, message: error.message });
      return;
    }
    next(error);
  });
  return router;
}
