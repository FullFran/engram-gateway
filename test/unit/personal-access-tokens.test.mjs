// Personal access tokens (#7): a PAT is a `token` connection (#27) with a
// hashed secret. Real SQLite gateway database, the real request
// authenticator and app; the e2e against a real engram is scripts/check-pats.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { SqliteAuditLog } from '../../dist/audit/index.js';
import { HttpRequestAuthenticator } from '../../dist/auth/index.js';
import { SqliteGrantRepository, bootstrapAccess } from '../../dist/authz/index.js';
import { SqliteBrainRepository } from '../../dist/brains/index.js';
import {
  PersonalAccessTokens, SqliteConnectionStore, SqlitePatStore, createAccountRouter, nodePatSecrets, patIdentityProvider
} from '../../dist/connections/index.js';
import { runAdminCli } from '../../dist/cli/admin-commands.js';
import { createGatewayApp } from '../../dist/http/app.js';
import { GATEWAY_SCHEMA_VERSION, openGatewayDatabase } from '../../dist/shared/gateway-database.js';

const quiet = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level, () => {}]));
const DAY_MS = 86_400_000;
const sha256 = value => createHash('sha256').update(value).digest('hex');

/** `dev` is writer on alpha, reader on beta; `boss` is the instance admin (owner everywhere). */
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'engram-gateway-pats-'));
  const path = join(dir, 'gateway.db');
  const db = openGatewayDatabase(path);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const repo = new SqliteBrainRepository(db);
  for (const slug of ['default', 'alpha', 'beta', 'gamma']) repo.ensure(slug, `/data/brains/${slug}`);
  const grants = new SqliteGrantRepository(db);
  bootstrapAccess(grants, {
    admins: ['boss'],
    grants: [{ login: 'dev', brain: 'alpha', role: 'writer' }, { login: 'dev', brain: 'beta', role: 'reader' }, { login: 'other', brain: 'alpha', role: 'owner' }],
    brains: ['default', 'alpha', 'beta', 'gamma']
  });
  const clock = { ms: Date.UTC(2026, 10, 19), nowMs() { return this.ms; } };
  const connections = new SqliteConnectionStore(db);
  const auditLog = new SqliteAuditLog(db);
  const pats = new PersonalAccessTokens({ store: new SqlitePatStore(db, connections), grants, secrets: nodePatSecrets, clock, audit: auditLog });
  const audit = () => [...auditLog.read()].map(row => ({ actor: row.actorLogin ?? row.actorId, action: row.action, target: row.target, outcome: row.outcome, meta: row.meta }));
  const create = (owner, body) => pats.create({ kind: 'user', login: owner }, owner, { name: 'ci', brains: ['alpha'], scope: 'read', expiresInDays: 30, ...body });
  return { db, path, dir, grants, clock, connections, pats, audit, create };
}

/** Every text value of every table, to look for a secret. */
function everyValue(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name);
  return tables.flatMap(table => db.prepare(`SELECT * FROM "${table}"`).all().flatMap(row => Object.values(row).map(String)));
}

test('migration 8 adds personal_access_tokens on top of connections: one row per token connection, keyed by hash, gone with its connection', t => {
  const s = setup(t);
  assert.ok(GATEWAY_SCHEMA_VERSION >= 8);
  const { token, pat } = s.create('dev');
  const connectionId = s.pats.authenticate(token).connectionId;
  assert.throws(() => s.db.prepare("UPDATE personal_access_tokens SET scope = 'write' WHERE id = ?").run(pat.id), /CHECK constraint/);
  s.db.prepare('DELETE FROM connections WHERE id = ?').run(connectionId);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM personal_access_tokens').get().n, 0);
});

test('create: an egw_pat_ secret shown once; a token connection with the scope\'s role on each brain; the first brain is the default', t => {
  const s = setup(t);
  const { token, pat } = s.create('dev', { name: 'repo:crm', brains: ['beta', 'alpha'], scope: 'read', expiresInDays: 90 });
  assert.match(token, /^egw_pat_[A-Za-z0-9_-]{43}$/);
  const nowS = s.clock.ms / 1000;
  assert.deepEqual(pat, { id: pat.id, name: 'repo:crm', brains: ['alpha', 'beta'], scope: 'read', createdAt: nowS, expiresAt: nowS + 90 * 86_400, lastUsedAt: null, revokedAt: null });
  const auth = s.pats.authenticate(token);
  assert.equal(auth.kind, 'ok');
  const connection = s.connections.get(auth.connectionId);
  assert.deepEqual({ kind: connection.kind, login: connection.login, defaultBrain: connection.defaultBrain, brains: connection.brains },
    { kind: 'token', login: 'dev', defaultBrain: 'beta', brains: [{ brain: 'alpha', role: 'reader' }, { brain: 'beta', role: 'reader' }] });
  const writer = s.create('dev', { name: 'ci-writer', scope: 'read+write' });
  assert.deepEqual(s.connections.get(s.pats.authenticate(writer.token).connectionId).brains, [{ brain: 'alpha', role: 'writer' }]);
  assert.deepEqual(s.pats.list('dev').map(p => p.name), ['ci-writer', 'repo:crm'], 'newest first');
  assert.deepEqual(s.pats.list('other'), []);
});

test('tokens are stored as hashes only: no column of any table holds the secret; the row keeps its SHA-256', t => {
  const s = setup(t);
  const { token } = s.create('dev');
  s.pats.authenticate(token);
  s.pats.revoke({ kind: 'user', login: 'dev' }, 'dev', s.pats.list('dev')[0].id);
  s.pats.authenticate(token);
  const values = everyValue(s.db);
  assert.equal(values.filter(value => value.includes(token)).length, 0, 'the secret is nowhere');
  assert.equal(values.filter(value => value.includes(token.slice(8))).length, 0, 'not even without its prefix');
  assert.deepEqual(s.db.prepare('SELECT hash FROM personal_access_tokens').all().map(row => row.hash), [sha256(token)]);
  assert.equal(values.filter(value => value.includes(sha256(token))).length, 1, 'the hash is only in the token row (never in the audit log)');
});

test('create refuses, writing nothing: bad scope or lifetime, no brains, a brain without a grant, a role above the grant, a taken name', t => {
  const s = setup(t);
  s.create('dev', { name: 'taken' });
  const count = () => s.db.prepare('SELECT (SELECT count(*) FROM connections) + (SELECT count(*) FROM personal_access_tokens) + (SELECT count(*) FROM audit_log) AS n').get().n;
  const before = count();
  const refused = (body, code, message) => assert.throws(() => s.create('dev', body), error => error.name === 'PatError' && error.code === code && message.test(error.message));
  refused({ scope: 'write' }, 'invalid', /scope must be "read" or "read\+write"/);
  refused({ scope: 'admin' }, 'invalid', /scope/);
  refused({ expiresInDays: 7 }, 'invalid', /30, 90 or 365/);
  refused({ expiresInDays: '30' }, 'invalid', /30, 90 or 365/);
  refused({ brains: [] }, 'invalid', /at least one brain for this token/);
  refused({ brains: 'alpha' }, 'invalid', /list of brain names/);
  refused({ brains: ['gamma'] }, 'invalid', /no access to brain gamma/);
  refused({ brains: ['beta'], scope: 'read+write' }, 'invalid', /reader on brain beta; a token cannot get writer/);
  refused({ name: '' }, 'invalid', /token name/);
  refused({ name: 'taken' }, 'conflict', /named "taken" already exists/);
  assert.equal(count(), before);
});

test('a revoked or expired token frees its name: the old one is renamed "<name> (revoked|expired <id>)", a new token may take the name', t => {
  const s = setup(t);
  const first = s.create('dev', { name: 'deploy' });
  s.pats.revoke({ kind: 'user', login: 'dev' }, 'dev', first.pat.id);
  assert.equal(s.pats.list('dev')[0].name, `deploy (revoked ${first.pat.id})`);
  const second = s.create('dev', { name: 'deploy', expiresInDays: 30 });
  assert.equal(second.pat.name, 'deploy');
  // An active token still holds its name.
  assert.throws(() => s.create('dev', { name: 'deploy' }), error => error.code === 'conflict');
  // Expired: freed by the next creation that wants the name.
  s.clock.ms += 31 * DAY_MS;
  const third = s.create('dev', { name: 'deploy', expiresInDays: 90 });
  assert.equal(third.pat.name, 'deploy');
  assert.deepEqual(s.pats.list('dev').map(pat => pat.name),
    ['deploy', `deploy (expired ${second.pat.id})`, `deploy (revoked ${first.pat.id})`]);
  // The old secrets stay refused; another user's name is untouched.
  assert.deepEqual(s.pats.authenticate(first.token), { kind: 'invalid', reason: 'revoked' });
  assert.deepEqual(s.pats.authenticate(second.token), { kind: 'invalid', reason: 'expired' });
  s.create('other', { name: 'deploy', expiresInDays: 30 });
  assert.equal(s.pats.list('other')[0].name, 'deploy');
});

test('authenticate: not a PAT is none; an unknown PAT is invalid (not audited); last_used is written at most once a minute', t => {
  const s = setup(t);
  assert.deepEqual(s.pats.authenticate('gho_abc'), { kind: 'none' });
  assert.deepEqual(s.pats.authenticate(`egw_pat_${'x'.repeat(43)}`), { kind: 'invalid', reason: 'unknown' });
  const { token, pat } = s.create('dev');
  const lastUsed = () => s.pats.list('dev')[0].lastUsedAt;
  const start = s.clock.ms / 1000;
  assert.equal(s.pats.authenticate(token).kind, 'ok');
  assert.equal(lastUsed(), start);
  s.clock.ms += 59_000;
  s.pats.authenticate(token);
  assert.equal(lastUsed(), start, 'not again within the minute');
  s.clock.ms += 1_000;
  s.pats.authenticate(token);
  assert.equal(lastUsed(), start + 60);
  assert.deepEqual(s.audit().map(row => row.action), ['pat.create'], 'uses that pass are not audited here (tool calls are)');
  assert.equal(pat.id, s.pats.authenticate(token).patId);
});

test('expired, revoked and disabled-owner tokens are refused; each refusal is audited (once a minute per token) without token material', t => {
  const s = setup(t);
  const expiring = s.create('dev', { name: 'short' });
  const revoked = s.create('dev', { name: 'gone', expiresInDays: 90 });
  const disabled = s.create('other', { name: 'theirs', expiresInDays: 90 });
  s.pats.revoke({ kind: 'user', login: 'dev' }, 'dev', revoked.pat.id);
  s.db.prepare("UPDATE users SET status = 'disabled' WHERE github_login = 'other'").run();
  s.clock.ms += 30 * DAY_MS;
  assert.deepEqual(s.pats.authenticate(expiring.token), { kind: 'invalid', reason: 'expired' });
  assert.deepEqual(s.pats.authenticate(revoked.token), { kind: 'invalid', reason: 'revoked' });
  assert.deepEqual(s.pats.authenticate(disabled.token), { kind: 'invalid', reason: 'owner_disabled' });
  s.clock.ms += 30_000;
  s.pats.authenticate(expiring.token);
  const denied = s.audit().filter(row => row.action === 'pat.use');
  assert.deepEqual(denied, [
    { actor: 'dev', action: 'pat.use', target: `pat-${expiring.pat.id}`, outcome: 'denied', meta: { patId: expiring.pat.id, errorKind: 'expired' } },
    { actor: 'dev', action: 'pat.use', target: `pat-${revoked.pat.id}`, outcome: 'denied', meta: { patId: revoked.pat.id, errorKind: 'revoked' } },
    { actor: 'other', action: 'pat.use', target: `pat-${disabled.pat.id}`, outcome: 'denied', meta: { patId: disabled.pat.id, errorKind: 'owner_disabled' } }
  ]);
  s.clock.ms += 30_000;
  s.pats.authenticate(expiring.token);
  assert.equal(s.audit().filter(row => row.action === 'pat.use').length, 4, 'audited again after a minute');
});

test('revoke: audited; only the owner\'s own token; twice is a conflict', t => {
  const s = setup(t);
  const { pat } = s.create('dev');
  const theirs = s.create('other', { name: 'theirs' });
  assert.throws(() => s.pats.revoke({ kind: 'user', login: 'dev' }, 'dev', theirs.pat.id), error => error.code === 'not_found');
  assert.throws(() => s.pats.revoke({ kind: 'user', login: 'dev' }, 'dev', 999), error => error.code === 'not_found');
  const revoked = s.pats.revoke({ kind: 'user', login: 'dev' }, 'dev', pat.id);
  assert.equal(revoked.revokedAt, s.clock.ms / 1000);
  assert.throws(() => s.pats.revoke({ kind: 'user', login: 'dev' }, 'dev', pat.id), error => error.code === 'conflict');
  assert.deepEqual(s.audit().map(({ actor, action, target, outcome, meta }) => [actor, action, target, outcome, meta]), [
    ['dev', 'pat.create', `pat-${pat.id}`, 'ok', { patId: pat.id, brains: 1, expiresInDays: 30, write: false }],
    ['other', 'pat.create', `pat-${theirs.pat.id}`, 'ok', { patId: theirs.pat.id, brains: 1, expiresInDays: 30, write: false }],
    ['dev', 'pat.revoke', `pat-${pat.id}`, 'ok', { patId: pat.id }]
  ]);
  assert.equal(s.pats.list('other')[0].revokedAt, null, 'the other user\'s token is untouched');
});

// ---- HTTP: /mcp with a PAT, and the account API ----

async function app(t, s) {
  // A fake session provider (`sid=<login>`) next to the real PAT provider.
  const sessions = { id: 'test', session: cookies => (cookies.get('sid') ? { kind: 'ok', identity: { provider: 'test', subject: cookies.get('sid'), via: 'session', scopes: [] } } : { kind: 'none' }) };
  const challenge = (resource, error) => `Bearer resource_metadata="${resource}", scope="memory"${error ? `, error="${error}"` : ''}`;
  const authenticator = new HttpRequestAuthenticator([sessions, patIdentityProvider(s.pats)], 'http://127.0.0.1', challenge);
  const acquired = [];
  const brains = {
    has: slug => ['default', 'alpha', 'beta', 'gamma'].includes(slug),
    acquire: async slug => { acquired.push(slug); throw new Error('not served in this test'); },
    stats: () => ({ live: 0, idle: 0 })
  };
  const gateway = createGatewayApp({
    bindHost: '127.0.0.1', trustProxy: false, logger: quiet, brains,
    auth: { router: express.Router(), authenticator, resource: 'http://127.0.0.1/mcp' },
    brainAccess: {
      mayOpen: (login, brain, connectionId) => s.grants.roleOf(login, brain) !== undefined && (connectionId === undefined || typeof s.connections.roleOn(connectionId, brain) === 'string')
    },
    admin: { isAdmin: login => s.grants.isAdmin(login), brainHealth: () => ({ ok: true, report: { healthy: true } }) },
    accountApi: identify => createAccountRouter({ tokens: s.pats, identify, clock: s.clock })
  });
  const server = createServer(gateway);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, { as, bearer, method = 'GET', body, headers = {} } = {}) => fetch(`${base}${path}`, {
    method,
    headers: {
      ...(as ? { cookie: `sid=${as}` } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers
    },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {})
  });
  return { call, acquired };
}

const mcp = (call, path, bearer) => call(path, { bearer, method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers: { accept: 'application/json, text/event-stream' } });

test('on /mcp: expired and revoked PATs get 401 with the standard challenge; /mcp/<slug> outside the token\'s brains is 403', async t => {
  const s = setup(t);
  const { call, acquired } = await app(t, s);
  const live = s.create('dev', { name: 'live', brains: ['alpha'], expiresInDays: 365 });
  const expiring = s.create('dev', { name: 'short' });
  const revoked = s.create('dev', { name: 'gone', expiresInDays: 365 });
  s.pats.revoke({ kind: 'user', login: 'dev' }, 'dev', revoked.pat.id);
  s.clock.ms += 30 * DAY_MS - 1000;
  assert.equal((await mcp(call, '/mcp/alpha', expiring.token)).status, 503, 'still valid a second before expiry (reaches the brain)');
  s.clock.ms += 1000;
  for (const token of [expiring.token, revoked.token, `egw_pat_${'y'.repeat(43)}`]) {
    const response = await mcp(call, '/mcp', token);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'invalid_token' });
    assert.equal(response.headers.get('www-authenticate'), 'Bearer resource_metadata="http://127.0.0.1/mcp", scope="memory", error="invalid_token"');
  }
  // dev holds a grant on beta, but the token is for alpha only.
  const outside = await mcp(call, '/mcp/beta', live.token);
  assert.equal(outside.status, 403);
  assert.equal((await mcp(call, '/mcp/gamma', live.token)).status, 403, 'no grant either');
  acquired.length = 0;
  assert.equal((await mcp(call, '/mcp/alpha', live.token)).status, 503, 'its own brain gets through to the brain');
  assert.deepEqual(acquired, ['alpha']);
  // Revoking the owner's grant blocks the token on the next request.
  s.db.prepare("DELETE FROM grants WHERE user_id = (SELECT id FROM users WHERE github_login = 'dev') AND brain_id = (SELECT id FROM brains WHERE slug = 'alpha')").run();
  assert.equal((await mcp(call, '/mcp/alpha', live.token)).status, 403);
  // Disabling the owner: 401 on the next request.
  s.db.prepare("UPDATE users SET status = 'disabled' WHERE github_login = 'dev'").run();
  assert.equal((await mcp(call, '/mcp', live.token)).status, 401);
});

test('a PAT is never an admin credential: the brain health endpoint refuses an admin\'s PAT (a session still works)', async t => {
  const s = setup(t);
  const { call } = await app(t, s);
  const { token } = s.create('boss', { brains: ['alpha'] });
  assert.equal((await call('/admin/brains/alpha/health', { bearer: token })).status, 403);
  assert.equal((await call('/admin/brains/alpha/health', { as: 'boss' })).status, 200);
  assert.equal((await call('/admin/api/brains', { bearer: token })).status, 404, 'no admin API mounted here; the account API ignores bearers too:');
  assert.equal((await call('/account/api/tokens', { bearer: token })).status, 401);
});

test('account API: session only, cross-site refused, JSON-only mutations; create shows the secret once, list never, revoke the own token', async t => {
  const s = setup(t);
  const { call } = await app(t, s);
  assert.equal((await call('/account/api/tokens')).status, 401);
  assert.equal((await call('/account/api/tokens', { as: 'dev', headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  const form = await call('/account/api/tokens', { as: 'dev', method: 'POST', body: 'name=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(form.status, 415);
  assert.equal(s.pats.list('dev').length, 0);

  const created = await call('/account/api/tokens', { as: 'dev', method: 'POST', body: { name: 'ci', brains: ['alpha', 'beta'], scope: 'read', expiresInDays: 365 } });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('cache-control'), 'no-store');
  const body = await created.json();
  assert.match(body.token, /^egw_pat_/);
  assert.deepEqual({ ...body, token: undefined, id: undefined }, {
    token: undefined, id: undefined, name: 'ci', brains: ['alpha', 'beta'], scope: 'read', status: 'active',
    createdAt: '2026-11-19T00:00:00.000Z', expiresAt: '2027-11-19T00:00:00.000Z', lastUsedAt: null, revokedAt: null
  });
  const listed = await (await call('/account/api/tokens', { as: 'dev' })).text();
  assert.ok(!listed.includes(body.token) && !listed.includes(body.token.slice(8)), 'the list never holds the secret');
  assert.equal(JSON.parse(listed).tokens.length, 1);

  const refused = await call('/account/api/tokens', { as: 'dev', method: 'POST', body: { name: 'w', brains: ['beta'], scope: 'read+write', expiresInDays: 30 } });
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).message, /reader on brain beta/);
  assert.equal((await call('/account/api/tokens', { as: 'dev', method: 'POST', body: { name: 'ci', brains: ['alpha'], scope: 'read', expiresInDays: 30 } })).status, 409);

  assert.equal((await call(`/account/api/tokens/${body.id}`, { as: 'other', method: 'DELETE', headers: { 'content-type': 'application/json' } })).status, 404, 'not someone else\'s');
  assert.equal((await call(`/account/api/tokens/${body.id}`, { as: 'dev', method: 'DELETE' })).status, 415, 'DELETE needs the JSON content type too');
  const revoked = await call(`/account/api/tokens/${body.id}`, { as: 'dev', method: 'DELETE', headers: { 'content-type': 'application/json' } });
  assert.equal(revoked.status, 200);
  assert.equal((await revoked.json()).status, 'revoked');
  assert.equal((await mcp(call, '/mcp/alpha', body.token)).status, 401, 'revoked: 401 on the next request');
});

test('admin CLI: tokens create prints the secret once, list shows status and no secret, revoke; refusals exit 1', async t => {
  const s = setup(t);
  const out = [];
  const err = [];
  const io = { print: line => out.push(line), write: chunk => out.push(chunk), error: line => err.push(line) };
  const run = argv => runAdminCli(argv, { GATEWAY_DB_PATH: s.path }, io);
  assert.equal(await run(['tokens', 'create', 'dev', '--name', 'ci', '--brains', 'alpha,beta', '--scope', 'read', '--expires', '90']), 0);
  const token = out.at(-1);
  assert.match(token, /^egw_pat_[A-Za-z0-9_-]{43}$/);
  assert.match(out.at(-2), /^created token \d+ \(ci\) for dev, expires .*; shown once/);
  out.length = 0;
  assert.equal(await run(['tokens', 'list', 'dev']), 0);
  assert.equal(out.length, 1);
  assert.match(out[0], /^\d+\tci\talpha,beta\tread\tactive\t/);
  assert.ok(!out[0].includes(token));
  const id = out[0].split('\t')[0];
  assert.equal(await run(['tokens', 'create', 'dev', '--name', 'w', '--brains', 'beta', '--scope', 'read+write', '--expires', '30']), 1);
  assert.match(err.at(-1), /reader on brain beta/);
  assert.equal(await run(['tokens', 'create', 'dev', '--name', 'w', '--brains', 'alpha', '--scope', 'read', '--expires', '45']), 1);
  assert.equal(await run(['tokens', 'revoke', 'dev', id]), 0);
  assert.match(out.at(-1), new RegExp(`^revoked token ${id} of dev; its name is now "ci \\(revoked ${id}\\)"$`));
  assert.equal(await run(['tokens', 'revoke', 'dev', id]), 1);
  assert.equal(await run(['tokens', 'revoke', 'dev', 'abc']), 1);
  const rows = [...new SqliteAuditLog(s.db).read()].filter(row => row.action.startsWith('pat.'));
  assert.deepEqual(rows.map(row => [row.actorKind, row.actorId, row.action, row.outcome]), [['system', 'cli', 'pat.create', 'ok'], ['system', 'cli', 'pat.revoke', 'ok']]);
});
