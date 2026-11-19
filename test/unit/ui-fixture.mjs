// Shared harness of the web admin panel tests (#17): a gateway database with
// grants, and the gateway app with a fake browser session provider.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { JSDOM } from 'jsdom';
import { AdminService, SqliteAdminStore, fsBrainDirectories } from '../../dist/admin/index.js';
import { SqliteAuditLog } from '../../dist/audit/index.js';
import { HttpRequestAuthenticator } from '../../dist/auth/index.js';
import { SqliteGrantRepository, bootstrapAccess } from '../../dist/authz/index.js';
import { SqliteBrainRepository } from '../../dist/brains/index.js';
import { OwnConnections, PersonalAccessTokens, SqliteConnectionStore, SqlitePatStore, nodePatSecrets, patIdentityProvider } from '../../dist/connections/index.js';
import { createGatewayApp } from '../../dist/http/app.js';
import { createUiRouter } from '../../dist/ui/index.js';
import { openGatewayDatabase } from '../../dist/shared/gateway-database.js';

const quiet = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level, () => {}]));
const ORIGIN = 'http://gateway.test';

/** `dev`: writer on alpha, reader on beta. `boss`: instance admin. */
export function uiSetup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'engram-gateway-ui-'));
  const db = openGatewayDatabase(join(dir, 'gateway.db'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const repo = new SqliteBrainRepository(db);
  for (const slug of ['default', 'alpha', 'beta']) repo.ensure(slug, `/data/brains/${slug}`);
  const grants = new SqliteGrantRepository(db);
  bootstrapAccess(grants, {
    admins: ['boss'],
    grants: [{ login: 'dev', brain: 'alpha', role: 'writer' }, { login: 'dev', brain: 'beta', role: 'reader' }, { login: 'other', brain: 'alpha', role: 'owner' }],
    brains: ['default', 'alpha', 'beta']
  });
  const clock = { ms: Date.UTC(2026, 10, 19), nowMs() { return this.ms; } };
  const connections = new SqliteConnectionStore(db);
  const auditLog = new SqliteAuditLog(db);
  const pats = new PersonalAccessTokens({ store: new SqlitePatStore(db, connections), grants, secrets: nodePatSecrets, clock, audit: auditLog });
  const audit = () => [...auditLog.read()].map(row => ({ actor: row.actorLogin ?? row.actorId, action: row.action, brain: row.brain, target: row.target, outcome: row.outcome }));
  // The running gateway's view of brains: alpha's child runs and serves a request, beta's runs idle.
  const runtime = {
    stopped: [],
    status: slug => (slug === 'alpha' ? { live: true, idle: false } : slug === 'beta' ? { live: true, idle: true } : { live: false, idle: false }),
    async stop(slug) { this.stopped.push(slug); }
  };
  /** Health reports by brain; a brain missing here is unknown. */
  const reports = new Map();
  const health = {
    report: brain => {
      if (!reports.has(brain)) return { ok: false, reason: 'unknown_brain', message: `unknown brain ${JSON.stringify(brain)}` };
      return reports.get(brain);
    }
  };
  const admin = new AdminService({
    store: new SqliteAdminStore(db), dirs: fsBrainDirectories(join(dir, 'brains')), clock, runtime, health
  });
  return { db, dir, grants, clock, connections, pats, audit, runtime, reports, admin };
}

/**
 * The gateway with a fake session provider: cookie `sid=<login>.<n>` is a
 * session of `<login>` (`n` tells two sessions of one login apart), and the
 * provider names `sid` as its session cookie, like the GitHub provider.
 */
/** `sessionCookies: false`: a provider that names no session cookie (the panel cannot bind its CSRF token). */
export async function uiApp(t, s, { sessionCookies = true } = {}) {
  const sessions = {
    id: 'test',
    session: cookies => (cookies.get('sid') ? { kind: 'ok', identity: { provider: 'test', subject: cookies.get('sid').split('.')[0], via: 'session', scopes: [] } } : { kind: 'none' }),
    sessionCookieNames: cookies => (sessionCookies && cookies.has('sid') ? ['sid'] : [])
  };
  const challenge = () => 'Bearer realm="test"';
  const authenticator = new HttpRequestAuthenticator([sessions, patIdentityProvider(s.pats)], ORIGIN, challenge);
  const gateway = createGatewayApp({
    bindHost: '127.0.0.1', trustProxy: false, logger: quiet,
    brains: { has: () => true, acquire: async () => { throw new Error('not served'); }, stats: () => ({ live: 0, idle: 0 }) },
    auth: { router: express.Router(), authenticator, resource: `${ORIGIN}/mcp` },
    brainAccess: { mayOpen: () => false },
    ui: identify => createUiRouter({
      identify, origin: ORIGIN, logger: quiet, clock: s.clock,
      isAdmin: login => s.grants.isAdmin(login),
      tokens: s.pats,
      admin: s.admin,
      connections: new OwnConnections({ store: s.connections, grants: s.grants, clock: s.clock }),
      brainsOf: login => s.grants.grantsOf(login)
    })
  });
  const server = createServer(gateway);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  /** `as`: the session cookie value; `form`: an urlencoded body (array values repeat the field). */
  const call = (path, { as, bearer, method = 'GET', form, headers = {} } = {}) => {
    let body;
    if (form) {
      const params = new URLSearchParams();
      for (const [name, value] of Object.entries(form)) for (const item of [value].flat()) params.append(name, String(item));
      body = params.toString();
    }
    return fetch(`${base}${path}`, {
      method, redirect: 'manual',
      headers: {
        ...(as ? { cookie: `sid=${as}` } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN, 'sec-fetch-site': 'same-origin' } : {}), ...headers
      },
      ...(body !== undefined ? { body } : {})
    });
  };
  /** The CSRF token the page at `path` renders for session `as`. */
  const csrfOf = async (as, path = '/ui/tokens') => {
    const html = await (await call(path, { as })).text();
    const match = /name="csrf" value="([^"]+)"/.exec(html);
    assert.ok(match, 'the page carries a CSRF token');
    return match[1];
  };
  return { call, csrfOf };
}

const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

/**
 * axe-core's WCAG A/AA violations of one HTML document, run in jsdom. jsdom
 * has no layout, so `color-contrast` cannot be judged here and is off.
 */
export async function axeViolations(html) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  try {
    dom.window.eval(axeSource);
    const result = await dom.window.axe.run(dom.window.document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] },
      rules: { 'color-contrast': { enabled: false } }
    });
    // Copied into this realm: arrays from the jsdom window fail deepStrictEqual against [].
    return Array.from(result.violations, violation => `${violation.id}: ${Array.from(violation.nodes, node => Array.from(node.target).join(' ')).join(' | ')}`);
  } finally {
    dom.window.close();
  }
}
