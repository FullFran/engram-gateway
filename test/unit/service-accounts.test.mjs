// Service accounts (#7): non-human principals owned by an instance admin,
// with their own API grants and personal access tokens. They never sign in.
// Real SQLite gateway database, the admin use cases, the admin HTTP adapter
// and the CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { AdminError, AdminService, CLI_ACTOR, SqliteAdminStore, createAdminRouter, fsBrainDirectories } from '../../dist/admin/index.js';
import { SqliteAuditLog } from '../../dist/audit/index.js';
import { GrantAccessPolicy, SqliteGrantRepository, bootstrapAccess } from '../../dist/authz/index.js';
import { SqliteBrainRepository } from '../../dist/brains/index.js';
import { PersonalAccessTokens, SqliteConnectionStore, SqlitePatStore, adminPatPort, nodePatSecrets } from '../../dist/connections/index.js';
import { runAdminCli } from '../../dist/cli/admin-commands.js';
import { createGatewayApp } from '../../dist/http/app.js';
import { GATEWAY_SCHEMA_VERSION, openGatewayDatabase } from '../../dist/shared/gateway-database.js';

const quiet = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level, () => {}]));
const ADMIN = { kind: 'user', login: 'boss' };
const DEV = { kind: 'user', login: 'dev' };

/** `boss` is the instance admin; `dev` a reader on alpha. */
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'engram-gateway-svc-'));
  const path = join(dir, 'gateway.db');
  const db = openGatewayDatabase(path);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const repo = new SqliteBrainRepository(db);
  for (const slug of ['default', 'alpha', 'beta']) repo.ensure(slug, join(dir, slug));
  const grants = new SqliteGrantRepository(db);
  const configure = (config = {}) => bootstrapAccess(grants, { admins: ['boss'], grants: [{ login: 'dev', brain: 'alpha', role: 'reader' }], brains: ['default', 'alpha', 'beta'], ...config });
  configure();
  const clock = { nowMs: () => Date.now() };
  const auditLog = new SqliteAuditLog(db);
  const pats = new PersonalAccessTokens({ store: new SqlitePatStore(db, new SqliteConnectionStore(db)), grants, secrets: nodePatSecrets, clock, audit: auditLog });
  const service = new AdminService({ store: new SqliteAdminStore(db), dirs: fsBrainDirectories(dir), clock, tokens: adminPatPort(pats, clock) });
  const audit = () => [...auditLog.read()].map(row => ({ actor: row.actorLogin ?? `${row.actorKind}:${row.actorId}`, action: row.action, target: row.target, outcome: row.outcome, meta: row.meta }));
  return { dir, path, db, grants, configure, pats, service, audit };
}

const rejectsWith = (code, pattern) => error => error instanceof AdminError && error.code === code && (!pattern || pattern.test(error.message));
const tokenRequest = body => ({ name: 'ci', brains: ['alpha'], scope: 'read+write', expiresInDays: 30, ...body });

test('migration 9: users have a kind (human by default) and service accounts an owner', t => {
  const s = setup(t);
  assert.equal(GATEWAY_SCHEMA_VERSION, 9);
  assert.deepEqual({ ...s.db.prepare("SELECT kind, owner_user_id FROM users WHERE github_login = 'dev'").get() }, { kind: 'human', owner_user_id: null });
  assert.throws(() => s.db.prepare("UPDATE users SET kind = 'robot' WHERE github_login = 'dev'").run(), /CHECK constraint/);
});

test('an admin creates a service account it owns; refusals are audited; non-admins are denied', t => {
  const s = setup(t);
  assert.deepEqual(s.service.createServiceAccount(ADMIN, 'ci-bot'), { login: 'ci-bot', status: 'active', owner: 'boss' });
  assert.deepEqual(s.service.listServiceAccounts(ADMIN), [{ login: 'ci-bot', status: 'active', owner: 'boss' }]);
  assert.deepEqual(s.service.listUsers(ADMIN).find(user => user.login === 'ci-bot'), { login: 'ci-bot', status: 'active', isAdmin: false, kind: 'service' });
  assert.equal(s.service.listUsers(ADMIN).find(user => user.login === 'dev').kind, 'human');
  assert.throws(() => s.service.createServiceAccount(ADMIN, 'dev'), rejectsWith('conflict'));
  assert.throws(() => s.service.createServiceAccount(ADMIN, 'not a login'), rejectsWith('invalid'));
  assert.throws(() => s.service.createServiceAccount(DEV, 'evil-bot'), rejectsWith('forbidden'));
  assert.throws(() => s.service.listServiceAccounts(DEV), rejectsWith('forbidden'));
  // The CLI names the owning admin; it must be an active instance admin.
  assert.throws(() => s.service.createServiceAccount(CLI_ACTOR, 'cli-bot'), rejectsWith('invalid', /owner/));
  assert.throws(() => s.service.createServiceAccount(CLI_ACTOR, 'cli-bot', 'dev'), rejectsWith('invalid', /instance admin/));
  assert.equal(s.service.createServiceAccount(CLI_ACTOR, 'cli-bot', 'boss').owner, 'boss');
  assert.equal(s.db.prepare("SELECT count(*) AS n FROM users WHERE github_login IN ('evil-bot')").get().n, 0);
  assert.deepEqual(s.audit().filter(row => row.action === 'service_account.create').map(row => `${row.actor} ${row.target} ${row.outcome}`), [
    'boss ci-bot ok', 'boss dev error', 'boss null error', 'dev evil-bot denied', 'system:cli cli-bot error', 'system:cli cli-bot error', 'system:cli cli-bot ok'
  ]);
});

test('a service account can never sign in, even with a grant; it is never an instance admin', t => {
  const s = setup(t);
  s.service.createServiceAccount(ADMIN, 'ci-bot');
  s.service.setGrant(ADMIN, 'ci-bot', 'alpha', 'writer');
  const policy = new GrantAccessPolicy(s.grants, ['http://gw/mcp']);
  assert.equal(policy.maySignIn('ci-bot'), false, 'a GitHub user with that login is refused');
  assert.equal(policy.maySignIn('dev'), true);
  assert.equal(s.grants.roleOf('ci-bot', 'alpha'), 'writer', 'its grant still counts for its tokens');
  // ALLOWED_GITHUB_LOGINS naming a service account fails the start, before any grant changes.
  assert.throws(() => s.configure({ admins: ['boss', 'ci-bot'] }), /ci-bot is a service account/);
  assert.equal(s.grants.isAdmin('ci-bot'), false);
  assert.equal(s.grants.roleOf('ci-bot', 'beta'), undefined);
  assert.equal(s.grants.roleOf('dev', 'alpha'), 'reader', 'configuration kept as it was');
});

test('sign-in refused because the login is a service account: the policy gives a clear reason; a person refused otherwise gets none', t => {
  const s = setup(t);
  s.service.createServiceAccount(ADMIN, 'ci-bot');
  const policy = new GrantAccessPolicy(s.grants, ['http://gw/mcp']);
  assert.match(policy.signInRefusal('ci-bot'), /ci-bot is a service account of this gateway: it uses personal access tokens and cannot sign in/);
  assert.equal(policy.signInRefusal('stranger'), undefined);
  assert.equal(policy.signInRefusal('dev'), undefined);
});

test('BRAIN_GRANTS may grant a service account a role (a configuration grant); it still never signs in', t => {
  const s = setup(t);
  s.service.createServiceAccount(ADMIN, 'ci-bot');
  s.configure({ grants: [{ login: 'dev', brain: 'alpha', role: 'reader' }, { login: 'ci-bot', brain: 'beta', role: 'reader' }] });
  assert.equal(s.grants.roleOf('ci-bot', 'beta'), 'reader');
  assert.equal(new GrantAccessPolicy(s.grants, ['http://gw/mcp']).maySignIn('ci-bot'), false);
  assert.equal(s.db.prepare("SELECT kind FROM users WHERE github_login = 'ci-bot'").get().kind, 'service', 'the configuration does not turn it into a person');
});

test('a service account whose owner is no longer an instance admin is disabled at startup; its PATs get 401 and it cannot be enabled', t => {
  const s = setup(t);
  s.configure({ admins: ['boss', 'boss2'] });
  s.service.createServiceAccount({ kind: 'user', login: 'boss2' }, 'orphan-bot');
  s.service.createServiceAccount(ADMIN, 'kept-bot');
  for (const login of ['orphan-bot', 'kept-bot']) s.service.setGrant(ADMIN, login, 'alpha', 'reader');
  const orphanPat = s.service.createServiceAccountToken(ADMIN, 'orphan-bot', tokenRequest({ scope: 'read' }));
  const keptPat = s.service.createServiceAccountToken(ADMIN, 'kept-bot', tokenRequest({ scope: 'read' }));
  assert.deepEqual(s.configure({ admins: ['boss'] }), { disabledServiceAccounts: ['orphan-bot'] });
  assert.deepEqual(s.service.listServiceAccounts(ADMIN), [
    { login: 'kept-bot', status: 'active', owner: 'boss' }, { login: 'orphan-bot', status: 'disabled', owner: 'boss2' }
  ]);
  assert.deepEqual(s.pats.authenticate(orphanPat.token), { kind: 'invalid', reason: 'owner_disabled' });
  assert.equal(s.pats.authenticate(keptPat.token).kind, 'ok');
  assert.throws(() => s.service.enableUser(ADMIN, 'orphan-bot'), rejectsWith('conflict', /its owner boss2 is no longer an instance admin/));
  assert.deepEqual(s.configure({ admins: ['boss'] }), { disabledServiceAccounts: [] }, 'already disabled: reported once');
  // The owner back as an admin: it may be enabled again.
  s.configure({ admins: ['boss', 'boss2'] });
  assert.equal(s.service.enableUser(ADMIN, 'orphan-bot').status, 'active');
});

test('a service account\'s PATs: created by an admin within its grants, used like any PAT, blocked by disable and by grant revoke', t => {
  const s = setup(t);
  s.service.createServiceAccount(ADMIN, 'ci-bot');
  assert.throws(() => s.service.createServiceAccountToken(ADMIN, 'ci-bot', tokenRequest()), rejectsWith('invalid', /alpha/), 'no grant yet');
  s.service.setGrant(ADMIN, 'ci-bot', 'alpha', 'writer');
  const created = s.service.createServiceAccountToken(ADMIN, 'ci-bot', tokenRequest());
  assert.match(created.token, /^egw_pat_/);
  assert.deepEqual({ name: created.name, brains: created.brains, scope: created.scope, status: created.status }, { name: 'ci', brains: ['alpha'], scope: 'read+write', status: 'active' });
  assert.equal(s.pats.authenticate(created.token).kind, 'ok');
  assert.deepEqual(s.service.listServiceAccountTokens(ADMIN, 'ci-bot').map(pat => [pat.id, pat.status, 'token' in pat]), [[created.id, 'active', false]]);
  // Only service accounts, only admins.
  assert.throws(() => s.service.createServiceAccountToken(ADMIN, 'dev', tokenRequest()), rejectsWith('not_found', /service account/));
  assert.throws(() => s.service.listServiceAccountTokens(ADMIN, 'dev'), rejectsWith('not_found', /service account/));
  assert.throws(() => s.service.createServiceAccountToken(DEV, 'ci-bot', tokenRequest()), rejectsWith('forbidden'));
  // Grant revoked: the token is still valid but opens nothing.
  s.service.revokeGrant(ADMIN, 'ci-bot', 'alpha');
  assert.deepEqual(s.grants.grantsOf('ci-bot'), []);
  s.service.setGrant(ADMIN, 'ci-bot', 'alpha', 'writer');
  // Disabled: 401 on the next request (owner_disabled); enabled again: usable.
  s.service.disableUser(ADMIN, 'ci-bot');
  assert.deepEqual(s.pats.authenticate(created.token), { kind: 'invalid', reason: 'owner_disabled' });
  s.service.enableUser(ADMIN, 'ci-bot');
  assert.equal(s.pats.authenticate(created.token).kind, 'ok');
  // Revoke.
  assert.equal(s.service.revokeServiceAccountToken(ADMIN, 'ci-bot', created.id).status, 'revoked');
  assert.throws(() => s.service.revokeServiceAccountToken(ADMIN, 'ci-bot', created.id), rejectsWith('conflict'));
  assert.throws(() => s.service.revokeServiceAccountToken(ADMIN, 'ci-bot', 999), rejectsWith('not_found'));
  assert.deepEqual(s.audit().filter(row => row.action.startsWith('pat.')).map(row => `${row.actor} ${row.action} ${row.outcome}`), [
    'boss pat.create ok', 'ci-bot pat.use denied', 'boss pat.revoke ok'
  ]);
});

async function adminServer(t, s) {
  const authenticator = {
    prepare: async () => {},
    authenticate: (headers, options) => {
      const login = options.acceptSession ? /(?:^|;\s*)sid=([^;]+)/.exec(headers.cookie ?? '')?.[1] : undefined;
      return login ? { ok: true, principal: { login, scopes: ['memory'] } } : { ok: false, status: 401, error: 'unauthorized', challenge: 'Bearer' };
    }
  };
  const app = createGatewayApp({
    bindHost: '127.0.0.1', trustProxy: false, logger: quiet, brains: { acquire: async () => { throw new Error('no brains here'); } },
    auth: { router: express.Router(), authenticator, resource: 'http://127.0.0.1/mcp' },
    brainAccess: { mayOpen: () => false },
    adminApi: identify => createAdminRouter({ service: s.service, identify, logger: quiet })
  });
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return (path, { as = 'boss', method = 'GET', body, headers = {} } = {}) => fetch(`${base}/admin/api${path}`, {
    method,
    headers: { cookie: `sid=${as}`, ...(method !== 'GET' ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
}

test('over HTTP: service accounts and their tokens under /admin/api, admins only, same CSRF rules', async t => {
  const s = setup(t);
  const call = await adminServer(t, s);
  assert.equal((await call('/service-accounts', { as: 'dev' })).status, 403);
  assert.equal((await call('/service-accounts', { method: 'POST', body: { login: 'ci-bot' }, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await call('/service-accounts', { method: 'POST', body: { login: 'ci-bot' }, headers: { 'content-type': 'text/plain' } })).status, 415);
  const created = await call('/service-accounts', { method: 'POST', body: { login: 'ci-bot' } });
  assert.equal(created.status, 201);
  assert.deepEqual(await created.json(), { serviceAccount: { login: 'ci-bot', status: 'active', owner: 'boss' } });
  assert.deepEqual(await (await call('/service-accounts')).json(), { serviceAccounts: [{ login: 'ci-bot', status: 'active', owner: 'boss' }] });
  assert.equal((await call('/service-accounts', { method: 'POST', body: { login: 'ci-bot' } })).status, 409);

  assert.equal((await call('/brains/alpha/grants/ci-bot', { method: 'PUT', body: { role: 'reader' } })).status, 200);
  const token = await call('/service-accounts/ci-bot/tokens', { method: 'POST', body: tokenRequest({ scope: 'read' }) });
  assert.equal(token.status, 201);
  const pat = await token.json();
  assert.match(pat.token, /^egw_pat_/);
  assert.equal((await call('/service-accounts/ci-bot/tokens', { method: 'POST', body: tokenRequest({ scope: 'read+write' }) })).status, 400, 'above its grant');
  const listed = await (await call('/service-accounts/ci-bot/tokens')).text();
  assert.ok(listed.includes('"status":"active"') && !listed.includes(pat.token), 'listed without the secret');
  assert.equal((await call('/service-accounts/dev/tokens')).status, 404, 'a human is not a service account');
  assert.equal((await call('/service-accounts/ci-bot/tokens', { as: 'dev' })).status, 403);
  assert.equal((await call(`/service-accounts/ci-bot/tokens/${pat.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await call(`/service-accounts/ci-bot/tokens/${pat.id}`, { method: 'DELETE' })).status, 409);
  assert.equal((await call('/service-accounts/ci-bot/tokens/abc', { method: 'DELETE' })).status, 404);
  assert.equal(s.pats.authenticate(pat.token).kind, 'invalid');
  assert.equal((await call('/users/ci-bot/disable', { method: 'POST', body: {} })).status, 200, 'disabled like any user');
});

test('CLI: service-accounts create/list, audited as the cli actor; tokens of a service account', async t => {
  const s = setup(t);
  const out = [];
  const err = [];
  const io = { print: line => out.push(line), write: chunk => out.push(chunk), error: line => err.push(line) };
  const env = { GATEWAY_DB_PATH: s.path };
  assert.equal(await runAdminCli(['service-accounts', 'create', 'ci-bot'], env, io), 1);
  assert.match(err.pop(), /--owner/);
  assert.equal(await runAdminCli(['service-accounts', 'create', 'ci-bot', '--owner', 'boss'], env, io), 0);
  assert.match(out.pop(), /created service account ci-bot \(owner boss\)/);
  assert.equal(await runAdminCli(['service-accounts', 'list'], env, io), 0);
  assert.deepEqual(out.splice(0), ['ci-bot\tactive\towner boss']);
  assert.equal(await runAdminCli(['grants', 'set', 'ci-bot', 'alpha', 'writer'], env, io), 0);
  assert.equal(await runAdminCli(['tokens', 'create', 'ci-bot', '--name', 'deploy', '--brains', 'alpha', '--scope', 'read', '--expires', '90'], env, io), 0);
  assert.match(out.pop(), /^egw_pat_/);
  assert.equal(await runAdminCli(['users', 'list'], env, io), 0);
  assert.ok(out.includes('ci-bot\tactive\tservice'), out.join('|'));
  assert.ok(s.audit().some(row => row.action === 'service_account.create' && row.actor === 'system:cli' && row.outcome === 'ok'));
});
