// Admin API and CLI (#10): brains, users and grants through one application
// layer, every operation audited (#8), configuration grants kept apart from
// API grants (#6 review), archive never deletes data, and the HTTP adapter
// accepts admin browser sessions only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { AdminError, AdminService, CLI_ACTOR, SqliteAdminStore, fsBrainDirectories } from '../../dist/admin/index.js';
import { SqliteAuditLog } from '../../dist/audit/index.js';
import { GrantAccessPolicy, SqliteGrantRepository, bootstrapAccess } from '../../dist/authz/index.js';
import { BrainRegistry, SqliteBrainRepository } from '../../dist/brains/index.js';
import { runAdminCli } from '../../dist/cli/admin-commands.js';
import { createGatewayApp } from '../../dist/http/app.js';
import { openGatewayDatabase } from '../../dist/shared/gateway-database.js';

const quiet = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level, () => {}]));
const ADMIN = { kind: 'user', login: 'FullFran' };
const ALICE = { kind: 'user', login: 'alice' };

/** Scratch gateway state outside the worktree, kept for inspection (paths printed with --test-reporter=spec). */
function scratch(t, seed = ['default', 'team']) {
  const dir = mkdtempSync(join(tmpdir(), 'engram-gateway-admin-'));
  const root = join(dir, 'brains');
  mkdirSync(root);
  const dbPath = join(dir, 'gateway.db');
  const db = openGatewayDatabase(dbPath);
  t.after(() => { try { db.close(); } catch {} });
  const brains = new SqliteBrainRepository(db);
  for (const slug of seed) brains.ensure(slug, join(root, slug));
  const grants = new SqliteGrantRepository(db);
  const configure = (config = {}) => bootstrapAccess(grants, {
    admins: ['FullFran'], grants: [{ login: 'alice', brain: 'team', role: 'reader' }], brains: brains.list().map(brain => brain.slug), ...config
  });
  configure();
  const stopped = [];
  const runtime = { stop: async slug => { stopped.push(slug); }, status: () => ({ live: false, idle: false }) };
  const service = new AdminService({ store: new SqliteAdminStore(db), dirs: fsBrainDirectories(root), clock: { nowMs: () => Date.now() }, runtime });
  const audit = () => [...new SqliteAuditLog(db).read()].map(row => ({
    actor: row.actorLogin ?? `${row.actorKind}:${row.actorId}`, brain: row.brain, action: row.action, target: row.target, outcome: row.outcome, meta: row.meta
  }));
  return { dir, root, dbPath, db, brains, grants, configure, service, stopped, audit };
}

const rejectsWith = (code, pattern) => error => error instanceof AdminError && error.code === code && (!pattern || pattern.test(error.message));

// ---- Authorization: deny by default ----

test('a signed-in user who is not an instance admin is denied every operation, audited as denied, nothing changes', async t => {
  const s = scratch(t);
  const attempts = [
    () => s.service.listBrains(ALICE),
    () => s.service.createBrain(ALICE, 'evil'),
    () => s.service.archiveBrain(ALICE, 'team'),
    () => s.service.listUsers(ALICE),
    () => s.service.inviteUser(ALICE, 'mallory'),
    () => s.service.disableUser(ALICE, 'alice'),
    () => s.service.listGrants(ALICE),
    () => s.service.setGrant(ALICE, 'alice', 'team', 'owner'),
    () => s.service.revokeGrant(ALICE, 'alice', 'team'),
    () => s.service.exportAudit(ALICE)
  ];
  for (const attempt of attempts) await assert.rejects(async () => attempt(), rejectsWith('forbidden'));
  // An owner of a brain is not an instance admin either.
  s.db.prepare("UPDATE grants SET role = 'owner'").run();
  assert.throws(() => s.service.inviteUser(ALICE, 'mallory'), rejectsWith('forbidden'));
  // Nor is someone the gateway never saw.
  assert.throws(() => s.service.listUsers({ kind: 'user', login: 'ghost' }), rejectsWith('forbidden'));

  assert.equal(s.brains.exists('evil'), false);
  assert.equal(existsSync(join(s.root, 'evil')), false);
  assert.equal(s.brains.findActive('team')?.slug, 'team');
  assert.equal(s.grants.roleOf('alice', 'team'), 'owner');
  assert.equal(s.db.prepare("SELECT count(*) AS n FROM users WHERE github_login = 'mallory'").get().n, 0);
  const rows = s.audit();
  assert.equal(rows.length, attempts.length + 2);
  assert.ok(rows.every(row => row.outcome === 'denied'));
  assert.deepEqual(rows.slice(0, 3).map(row => [row.actor, row.action, row.brain, row.target]), [
    ['alice', 'brain.list', null, null], ['alice', 'brain.create', 'evil', 'evil'], ['alice', 'brain.archive', 'team', 'team']
  ]);
  assert.equal(rows.at(-1).actor, 'ghost');
  assert.deepEqual(s.stopped, []);
});

// ---- Brains ----

test('creating a brain makes its data directory and row, admins own it, the registry serves it without a restart, audited', async t => {
  const s = scratch(t);
  const registry = new BrainRegistry({
    brains: { get: slug => s.brains.findActive(slug) }, createProcess: () => ({ live: () => true, close: async () => {} }),
    clock: { now: () => Date.now() }, idleTimeoutMs: 60_000, maxLiveBrains: 4, logger: quiet
  });
  assert.equal(registry.has('research'), false);

  const brain = s.service.createBrain(ADMIN, 'research');
  assert.deepEqual(brain, { slug: 'research', dataDir: join(s.root, 'research'), cloudSync: false, status: 'active' });
  assert.ok(statSync(brain.dataDir).isDirectory());
  assert.equal(statSync(brain.dataDir).mode & 0o777, 0o700);
  assert.equal(registry.has('research'), true, 'the registry reads the brains table on every request');
  assert.equal(s.grants.roleOf('FullFran', 'research'), 'owner', 'instance admins own every brain, new ones included');
  assert.equal(s.grants.roleOf('alice', 'research'), undefined);
  assert.deepEqual(s.audit(), [{ actor: 'FullFran', brain: 'research', action: 'brain.create', target: 'research', outcome: 'ok', meta: {} }]);

  // The next start keeps it and its owners.
  s.configure();
  assert.equal(s.grants.roleOf('FullFran', 'research'), 'owner');
});

test('creating a brain refuses bad, reserved, duplicate slugs, a missing BRAINS_ROOT and a non-empty directory; each refusal is audited', t => {
  const s = scratch(t);
  assert.throws(() => s.service.createBrain(ADMIN, 'Bad_Slug'), rejectsWith('invalid', /invalid brain slug/));
  assert.throws(() => s.service.createBrain(ADMIN, 'admin'), rejectsWith('invalid', /reserved/));
  assert.throws(() => s.service.createBrain(ADMIN, 'team'), rejectsWith('conflict', /already exists/));
  mkdirSync(join(s.root, 'old'));
  writeFileSync(join(s.root, 'old', 'engram.db'), 'someone else\'s memory');
  assert.throws(() => s.service.createBrain(ADMIN, 'old'), rejectsWith('conflict', /must be empty/));
  assert.equal(readFileSync(join(s.root, 'old', 'engram.db'), 'utf8'), 'someone else\'s memory', 'an existing directory is left untouched');
  const noRoot = new AdminService({ store: new SqliteAdminStore(s.db), dirs: fsBrainDirectories(undefined), clock: { nowMs: () => 0 } });
  assert.throws(() => noRoot.createBrain(ADMIN, 'fresh'), rejectsWith('invalid', /BRAINS_ROOT/));

  assert.equal(s.brains.exists('old'), false);
  assert.equal(s.brains.exists('fresh'), false);
  const rows = s.audit();
  assert.deepEqual(rows.map(row => [row.action, row.target, row.outcome, row.meta.errorKind]), [
    ['brain.create', null, 'error', 'invalid'], // not slug-shaped: not copied into the log
    ['brain.create', 'admin', 'error', 'invalid'],
    ['brain.create', 'team', 'error', 'conflict'],
    ['brain.create', 'old', 'error', 'conflict'],
    ['brain.create', 'fresh', 'error', 'invalid']
  ]);
});

test('archiving a brain stops its child, refuses new sessions and access, and keeps its data on disk', async t => {
  const s = scratch(t);
  mkdirSync(join(s.root, 'team'), { recursive: true });
  writeFileSync(join(s.root, 'team', 'engram.db'), 'memories');
  const policy = new GrantAccessPolicy(s.grants, ['http://x/mcp', 'http://x/mcp/team']);
  assert.equal(policy.mayUse('alice', 'http://x/mcp/team'), true);

  const archived = await s.service.archiveBrain(ADMIN, 'team');
  assert.equal(archived.status, 'archived');
  assert.deepEqual(s.stopped, ['team'], 'the running child is stopped through the registry');
  assert.equal(s.brains.findActive('team'), undefined, 'the registry no longer serves it');
  assert.equal(s.grants.roleOf('alice', 'team'), undefined, 'grants on an archived brain give nothing');
  assert.equal(s.grants.roleOf('FullFran', 'team'), undefined);
  assert.equal(policy.mayUse('alice', 'http://x/mcp/team'), false, 'no new token for it');
  assert.equal(s.grants.hasAccess('alice'), false, 'alice held only that grant');
  assert.equal(readFileSync(join(s.root, 'team', 'engram.db'), 'utf8'), 'memories', 'data stays on disk');
  assert.equal(s.db.prepare("SELECT count(*) AS n FROM grants g JOIN brains b ON b.id = g.brain_id WHERE b.slug = 'team'").get().n, 2, 'grant rows are kept');

  await assert.rejects(s.service.archiveBrain(ADMIN, 'team'), rejectsWith('conflict', /already archived/));
  await assert.rejects(s.service.archiveBrain(ADMIN, 'default'), rejectsWith('invalid', /default brain/));
  await assert.rejects(s.service.archiveBrain(ADMIN, 'ghost'), rejectsWith('not_found'));
  assert.throws(() => s.service.setGrant(ADMIN, 'alice', 'team', 'writer'), rejectsWith('conflict', /archived/));
  assert.deepEqual(s.stopped, ['team']);
  assert.deepEqual(s.audit().map(row => [row.action, row.target, row.outcome]), [
    ['brain.archive', 'team', 'ok'], ['brain.archive', 'team', 'error'], ['brain.archive', 'default', 'error'],
    ['brain.archive', 'ghost', 'error'], ['grant.set', 'alice', 'error']
  ]);

  // A restart (BRAINS still naming it) does not bring it back.
  s.brains.ensure('team', join(s.root, 'team'));
  s.configure();
  assert.equal(s.brains.findActive('team'), undefined);
});

test('listing brains shows status and, from the running gateway, live/idle', t => {
  const s = scratch(t);
  const service = new AdminService({
    store: new SqliteAdminStore(s.db), dirs: fsBrainDirectories(s.root), clock: { nowMs: () => 0 },
    runtime: { stop: async () => {}, status: slug => (slug === 'team' ? { live: true, idle: false } : { live: false, idle: false }) }
  });
  assert.deepEqual(service.listBrains(ADMIN).map(({ slug, status, live, idle }) => ({ slug, status, live, idle })), [
    { slug: 'default', status: 'active', live: false, idle: false },
    { slug: 'team', status: 'active', live: true, idle: false }
  ]);
});

// ---- Users ----

test('an invite is activated by the first successful sign-in once the user holds a grant; disable and enable', t => {
  const s = scratch(t);
  const policy = new GrantAccessPolicy(s.grants, ['http://x/mcp', 'http://x/mcp/team']);
  assert.deepEqual(s.service.inviteUser(ADMIN, 'Erin'), { login: 'Erin', status: 'invited', isAdmin: false });
  assert.throws(() => s.service.inviteUser(ADMIN, 'erin'), rejectsWith('conflict'), 'logins are case-insensitive');
  assert.throws(() => s.service.inviteUser(ADMIN, 'not a login'), rejectsWith('invalid'));

  assert.equal(policy.maySignIn('erin'), false, 'an invite without any grant gives no access');
  assert.equal(s.service.listUsers(ADMIN).find(user => user.login === 'Erin').status, 'invited');
  s.service.setGrant(ADMIN, 'erin', 'team', 'writer');
  assert.equal(s.grants.roleOf('erin', 'team'), undefined, 'no role before the invite is accepted');
  assert.equal(policy.maySignIn('erin'), true, 'the first sign-in is let in');
  assert.equal(s.service.listUsers(ADMIN).find(user => user.login === 'Erin').status, 'active', '... and activates the invite');
  assert.equal(s.grants.roleOf('erin', 'team'), 'writer');

  s.service.disableUser(ADMIN, 'erin');
  assert.equal(policy.maySignIn('erin'), false, 'a disabled user cannot sign in (sessions and tokens re-check this)');
  assert.equal(s.grants.roleOf('erin', 'team'), undefined, 'and has no role on the next request');
  assert.throws(() => s.service.disableUser(ADMIN, 'erin'), rejectsWith('conflict'));
  s.service.enableUser(ADMIN, 'erin');
  assert.equal(s.grants.roleOf('erin', 'team'), 'writer');
  assert.throws(() => s.service.enableUser(ADMIN, 'erin'), rejectsWith('conflict'));

  assert.throws(() => s.service.disableUser(ADMIN, 'fullfran'), rejectsWith('conflict', /ALLOWED_GITHUB_LOGINS/), 'admins come from the configuration');
  assert.throws(() => s.service.disableUser(ADMIN, 'ghost'), rejectsWith('not_found'));
  assert.equal(s.grants.isAdmin('FullFran'), true);
  assert.deepEqual(s.audit().map(row => [row.action, row.target, row.outcome]), [
    ['user.invite', 'Erin', 'ok'], ['user.invite', 'erin', 'error'], ['user.invite', null, 'error'],
    ['grant.set', 'erin', 'ok'], ['user.disable', 'erin', 'ok'], ['user.disable', 'erin', 'error'],
    ['user.enable', 'erin', 'ok'], ['user.enable', 'erin', 'error'], ['user.disable', 'fullfran', 'error'], ['user.disable', 'ghost', 'error']
  ]);
});

// ---- Grants ----

test('grant, change and revoke a role; each audited with the role; the next request sees it', t => {
  const s = scratch(t);
  s.service.inviteUser(ADMIN, 'erin');
  s.db.prepare("UPDATE users SET status = 'active' WHERE github_login = 'erin'").run();

  assert.deepEqual(s.service.setGrant(ADMIN, 'erin', 'team', 'reader'), { login: 'erin', brain: 'team', role: 'reader', source: 'api' });
  assert.equal(s.grants.roleOf('erin', 'team'), 'reader');
  s.service.setGrant(ADMIN, 'erin', 'team', 'owner');
  assert.equal(s.grants.roleOf('erin', 'team'), 'owner');
  assert.deepEqual(s.service.listGrants(ADMIN, { brain: 'team' }).map(grant => `${grant.login}:${grant.role}:${grant.source}`),
    ['alice:reader:config', 'erin:owner:api', 'FullFran:owner:config']);
  s.service.revokeGrant(ADMIN, 'erin', 'team');
  assert.equal(s.grants.roleOf('erin', 'team'), undefined, 'revocation applies to the next request');

  assert.throws(() => s.service.setGrant(ADMIN, 'erin', 'team', 'god'), rejectsWith('invalid', /reader, writer, owner/));
  assert.throws(() => s.service.setGrant(ADMIN, 'ghost', 'team', 'reader'), rejectsWith('not_found', /invite them first/));
  assert.throws(() => s.service.setGrant(ADMIN, 'erin', 'nowhere', 'reader'), rejectsWith('not_found'));
  assert.throws(() => s.service.setGrant(ADMIN, 'FullFran', 'team', 'reader'), rejectsWith('conflict', /instance admin/));
  assert.throws(() => s.service.setGrant(ADMIN, 'alice', 'team', 'owner'), rejectsWith('conflict', /BRAIN_GRANTS/), 'configuration grants are not managed here');
  assert.throws(() => s.service.revokeGrant(ADMIN, 'alice', 'team'), rejectsWith('conflict', /BRAIN_GRANTS/));
  assert.throws(() => s.service.revokeGrant(ADMIN, 'erin', 'team'), rejectsWith('not_found'));
  assert.equal(s.grants.roleOf('alice', 'team'), 'reader');

  const rows = s.audit().filter(row => row.action.startsWith('grant.'));
  assert.deepEqual(rows.slice(0, 3), [
    { actor: 'FullFran', brain: 'team', action: 'grant.set', target: 'erin', outcome: 'ok', meta: { role: 'reader' } },
    { actor: 'FullFran', brain: 'team', action: 'grant.set', target: 'erin', outcome: 'ok', meta: { role: 'owner', previousRole: 'reader' } },
    { actor: 'FullFran', brain: 'team', action: 'grant.revoke', target: 'erin', outcome: 'ok', meta: { role: 'owner' } }
  ]);
  assert.equal(rows.length, 10);
  assert.ok(rows.slice(3).every(row => row.outcome === 'error'));
});

test('an API-created grant survives a restart; configuration grants still follow BRAIN_GRANTS', t => {
  const s = scratch(t);
  s.service.inviteUser(ADMIN, 'erin');
  s.service.setGrant(ADMIN, 'erin', 'team', 'writer');
  s.db.prepare("UPDATE users SET status = 'active' WHERE github_login = 'erin'").run();

  s.configure({ grants: [] }); // restart: alice left BRAIN_GRANTS
  assert.equal(s.grants.roleOf('erin', 'team'), 'writer', 'the API grant survives');
  assert.equal(s.grants.roleOf('alice', 'team'), undefined, 'the removed configuration grant is revoked');
  assert.equal(s.grants.roleOf('FullFran', 'team'), 'owner');
});

// ---- Audit export ----

test('the audit CSV export streams the log, filters by brain, and is itself audited', t => {
  const s = scratch(t);
  s.service.createBrain(ADMIN, 'research');
  s.service.inviteUser(ADMIN, 'erin');
  const all = [...s.service.exportAudit(ADMIN)].join('');
  const lines = all.trimEnd().split('\r\n');
  assert.equal(lines[0], 'id,at,actor_kind,actor_id,actor_login,brain,action,target,outcome,duration_ms,meta');
  assert.match(lines[1], /,FullFran,research,brain\.create,research,ok,/);
  assert.match(lines[2], /,FullFran,,user\.invite,erin,ok,/);
  assert.match(lines[3], /,FullFran,,audit\.export,,ok,/, 'the export records itself');
  const research = [...s.service.exportAudit(ADMIN, { brain: 'research' })].join('').trimEnd().split('\r\n');
  assert.equal(research.length, 3, 'header, brain.create and the filtered export row');
  assert.deepEqual(s.audit().at(-1), { actor: 'FullFran', brain: 'research', action: 'audit.export', target: null, outcome: 'ok', meta: {} });
});

// ---- HTTP adapter ----

async function adminServer(t, s, registry) {
  const authenticator = {
    prepare: async () => {},
    // A fake provider: `sid=<login>` is a browser session; any bearer token is valid for its own audience.
    authenticate: (headers, options) => {
      if (headers.authorization) return { ok: true, principal: { login: 'FullFran', scopes: ['memory'], token: 'tok' } };
      const login = options.acceptSession ? /(?:^|;\s*)sid=([^;]+)/.exec(headers.cookie ?? '')?.[1] : undefined;
      return login ? { ok: true, principal: { login, scopes: ['memory'] } } : { ok: false, status: 401, error: 'unauthorized', challenge: 'Bearer' };
    }
  };
  const service = new AdminService({ store: new SqliteAdminStore(s.db), dirs: fsBrainDirectories(s.root), clock: { nowMs: () => Date.now() }, runtime: registry });
  const { createAdminRouter } = await import('../../dist/admin/index.js');
  const app = createGatewayApp({
    bindHost: '127.0.0.1', trustProxy: false, logger: quiet, brains: registry,
    auth: { router: express.Router(), authenticator, resource: 'http://127.0.0.1/mcp' },
    brainAccess: { mayOpen: (login, brain) => s.grants.roleOf(login, brain) !== undefined },
    adminApi: identify => createAdminRouter({ service, identify, logger: quiet })
  });
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return (path, { as, method = 'GET', body, headers = {} } = {}) => fetch(`${base}${path}`, {
    method,
    headers: { ...(as ? { cookie: `sid=${as}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
}

test('over HTTP: admin sessions only, CSRF guards, and the full brain/user/grant/audit cycle', async t => {
  const s = scratch(t);
  const closed = [];
  const registry = new BrainRegistry({
    brains: { get: slug => s.brains.findActive(slug) },
    createProcess: brain => ({ live: () => true, close: async () => { closed.push(brain.slug); }, retryAfterMs: () => 0 }),
    clock: { now: () => Date.now() }, idleTimeoutMs: 60_000, maxLiveBrains: 4, logger: quiet
  });
  t.after(() => registry.stopAll());
  const call = await adminServer(t, s, registry);

  // Who may call.
  assert.equal((await call('/admin/api/brains')).status, 401, 'no session');
  assert.equal((await call('/admin/api/brains', { headers: { authorization: 'Bearer an-mcp-token' } })).status, 401, 'a bearer token is never accepted');
  const denied = await call('/admin/api/brains', { as: 'alice' });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error, 'forbidden');
  assert.equal((await call('/admin/api/users', { as: 'alice', method: 'POST', body: { login: 'mallory' } })).status, 403);
  assert.equal(s.db.prepare("SELECT count(*) AS n FROM users WHERE github_login = 'mallory'").get().n, 0);

  // CSRF: mutations need JSON and are refused when the browser says cross-site.
  const form = await call('/admin/api/brains', { as: 'FullFran', method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(form.status, 415);
  assert.equal((await call('/admin/api/brains', { as: 'FullFran', method: 'POST', body: { slug: 'csrf' }, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal(s.brains.exists('csrf'), false);

  // Brains.
  const created = await call('/admin/api/brains', { as: 'FullFran', method: 'POST', body: { slug: 'research' } });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('cache-control'), 'no-store');
  assert.equal((await created.json()).brain.slug, 'research');
  assert.equal(registry.has('research'), true);
  assert.equal((await call('/admin/api/brains', { as: 'FullFran', method: 'POST', body: { slug: 'research' } })).status, 409);
  assert.equal((await call('/admin/api/brains', { as: 'FullFran', method: 'POST', body: {} })).status, 400);

  const lease = await registry.acquire('research');
  lease.release();
  const listed = await (await call('/admin/api/brains', { as: 'FullFran' })).json();
  assert.deepEqual(listed.brains.find(brain => brain.slug === 'research'), { slug: 'research', dataDir: join(s.root, 'research'), cloudSync: false, status: 'active', live: true, idle: true });

  // Users and grants.
  assert.equal((await call('/admin/api/users', { as: 'FullFran', method: 'POST', body: { login: 'erin' } })).status, 201);
  const granted = await call('/admin/api/brains/research/grants/erin', { as: 'FullFran', method: 'PUT', body: { role: 'reader' } });
  assert.deepEqual(await granted.json(), { grant: { login: 'erin', brain: 'research', role: 'reader', source: 'api' } });
  assert.deepEqual((await (await call('/admin/api/grants?login=erin', { as: 'FullFran' })).json()).grants.map(grant => grant.brain), ['research']);
  assert.equal((await call('/admin/api/brains/research/grants/erin', { as: 'FullFran', method: 'DELETE', headers: { 'content-type': 'application/json' } })).status, 204);
  assert.equal((await call('/admin/api/brains/research/grants/erin', { as: 'FullFran', method: 'DELETE' })).status, 415, 'DELETE needs the JSON content type too');
  assert.equal((await call('/admin/api/users/erin/disable', { as: 'FullFran', method: 'POST', body: {} })).status, 200);
  assert.equal((await (await call('/admin/api/users', { as: 'FullFran' })).json()).users.find(user => user.login === 'erin').status, 'disabled');

  // Archive: the child stops, the MCP endpoint refuses the brain, data stays.
  writeFileSync(join(s.root, 'research', 'engram.db'), 'memories');
  const archived = await call('/admin/api/brains/research/archive', { as: 'FullFran', method: 'POST', body: {} });
  assert.equal(archived.status, 200);
  assert.deepEqual(closed, ['research']);
  assert.equal((await call('/mcp/research', { method: 'POST', body: {} })).status, 404, 'no new session on an archived brain');
  assert.equal(readFileSync(join(s.root, 'research', 'engram.db'), 'utf8'), 'memories');

  // Audit CSV, admin only.
  assert.equal((await call('/admin/api/audit.csv', { as: 'alice' })).status, 403);
  assert.equal((await call('/admin/api/audit.csv?from=yesterday', { as: 'FullFran' })).status, 400);
  const csv = await call('/admin/api/audit.csv?brain=research', { as: 'FullFran' });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /^text\/csv/);
  assert.match(csv.headers.get('content-disposition'), /attachment/);
  const actions = (await csv.text()).trimEnd().split('\r\n').slice(1).map(line => line.split(',').slice(6, 9).join(' '));
  assert.deepEqual(actions, [
    'brain.create research ok', 'brain.create research error', 'grant.set erin ok', 'grant.revoke erin ok', 'brain.archive research ok', 'audit.export  ok'
  ]);
  assert.equal((await call('/admin/api/nothing', { as: 'FullFran' })).status, 404);
});

test('over HTTP: with auth off the admin API does not exist', async t => {
  const s = scratch(t);
  const registry = new BrainRegistry({ brains: new Map(), createProcess: () => ({ live: () => false, close: async () => {} }), clock: { now: () => 0 }, idleTimeoutMs: 1000, maxLiveBrains: 1, logger: quiet });
  const app = createGatewayApp({ bindHost: '127.0.0.1', trustProxy: false, logger: quiet, brains: registry, adminApi: () => { throw new Error('not mounted'); } });
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/admin/api/brains`);
  assert.equal(response.status, 404);
  assert.equal(s.audit().length, 0);
});

// ---- CLI adapter ----

function cli(env) {
  const out = [];
  const err = [];
  const io = { print: text => out.push(text), write: chunk => out.push(chunk), error: text => err.push(text) };
  return { run: argv => runAdminCli(argv, env, io), out, err };
}

test('CLI: the same use cases against the gateway database, audited as the cli actor', async t => {
  const s = scratch(t);
  s.db.close();
  const env = { GATEWAY_DB_PATH: s.dbPath, BRAINS_ROOT: s.root };
  const c = cli(env);

  assert.equal(await c.run(['brains', 'create', 'ops']), 0);
  assert.match(c.out.at(-1), /created brain ops/);
  assert.ok(statSync(join(s.root, 'ops')).isDirectory());
  assert.equal(await c.run(['users', 'invite', 'erin']), 0);
  assert.equal(await c.run(['grants', 'set', 'erin', 'ops', 'writer']), 0);
  assert.equal(c.out.at(-1), 'erin is writer on ops');
  c.out.length = 0;
  assert.equal(await c.run(['grants', 'list', '--brain', 'ops']), 0);
  assert.deepEqual(c.out, ['ops\terin\twriter\tapi', 'ops\tFullFran\towner\tconfig']);
  c.out.length = 0;
  assert.equal(await c.run(['users', 'list']), 0);
  assert.deepEqual(c.out, ['alice\tactive', 'erin\tinvited', 'FullFran\tactive\tadmin']);
  assert.equal(await c.run(['brains', 'archive', 'ops']), 0);
  assert.equal(readFileSync(join(s.dir, 'gateway.db')).length > 0, true);

  // Refusals exit 1 with the reason on stderr; usage errors exit 2.
  assert.equal(await c.run(['brains', 'archive', 'default']), 1);
  assert.match(c.err.at(-1), /^error: the default brain cannot be archived/);
  assert.equal(await c.run(['grants', 'set', 'erin', 'ops']), 2);
  assert.equal(await c.run(['brains', 'delete', 'ops']), 2, 'there is no delete');
  assert.equal(await c.run(['audit', 'export', '--from']), 2);
  assert.equal(await cli({ BRAINS_ROOT: s.root }).run(['users', 'list']), 1, 'no database configured');

  const out = join(s.dir, 'audit.csv');
  assert.equal(await c.run(['audit', 'export', '--brain', 'ops', '--out', out]), 0);
  assert.equal(statSync(out).mode & 0o777, 0o600);
  const rows = readFileSync(out, 'utf8').trimEnd().split('\r\n').slice(1).map(line => line.split(','));
  assert.deepEqual(rows.map(row => [row[2], row[3], row[6], row[7], row[8]]), [
    ['system', 'cli', 'brain.create', 'ops', 'ok'], ['system', 'cli', 'grant.set', 'erin', 'ok'],
    ['system', 'cli', 'brain.archive', 'ops', 'ok'], ['system', 'cli', 'audit.export', '', 'ok']
  ]);
  assert.equal(await c.run(['audit', 'export', '--out', out]), 1, 'never overwrites an existing file');
  c.out.length = 0;
  assert.equal(await c.run(['audit', 'export']), 0);
  assert.match(c.out[0], /^id,at,actor_kind/);

  // The gateway's next start keeps what the CLI created.
  const db = openGatewayDatabase(s.dbPath);
  t.after(() => db.close());
  const grants = new SqliteGrantRepository(db);
  bootstrapAccess(grants, { admins: ['FullFran'], grants: [], brains: new SqliteBrainRepository(db).list().map(brain => brain.slug) });
  assert.equal(db.prepare("SELECT g.role FROM grants g JOIN users u ON u.id = g.user_id JOIN brains b ON b.id = g.brain_id WHERE u.github_login = 'erin' AND b.slug = 'ops'").get().role, 'writer');
  assert.equal(CLI_ACTOR.id, 'cli');
});
