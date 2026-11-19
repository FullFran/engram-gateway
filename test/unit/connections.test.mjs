// Connections (#27), first slice: the tables, the consent step that turns a
// grant on the bare `/mcp` resource into a connection (brains, roles capped
// by the owner's grants, default brain), the connection id carried by codes,
// tokens and refreshes, the connection layer of tool access, and the audit
// row's connection id. Real SQLite, real auth services.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuthorizationCodes } from '../../dist/auth/application/authorization-codes.js';
import { AuthorizationService } from '../../dist/auth/application/authorize.js';
import { ClientRegistry } from '../../dist/auth/application/clients.js';
import { SessionService } from '../../dist/auth/application/sessions.js';
import { TokenService } from '../../dist/auth/application/tokens.js';
import { AccessTokenVerifier } from '../../dist/auth/application/access-tokens.js';
import { SqliteTokenStore } from '../../dist/auth/infrastructure/sqlite-token-store.js';
import { GrantAccessPolicy, SqliteGrantRepository, createToolAccess } from '../../dist/authz/index.js';
import { SqliteBrainRepository } from '../../dist/brains/index.js';
import { ConnectionConsentService, SqliteConnectionStore, checkChoice } from '../../dist/connections/index.js';
import { SqliteAuditLog, toolCallRecorder } from '../../dist/audit/index.js';
import { SqliteAuthorshipRepository, createAttributor } from '../../dist/attribution/index.js';
import { openGatewayDatabase, GATEWAY_SCHEMA_VERSION } from '../../dist/shared/gateway-database.js';
import { loadMigrations, migrate } from '../../dist/shared/sqlite-database.js';
import { DatabaseSync } from 'node:sqlite';
import { sendConsentPage } from '../../dist/auth/presentation/http/pages.js';
import { formDefaults } from '../../scripts/lib/harness.mjs';
import { fakeClock, fakeRandom, hasher, scriptedMetadata, settings, signer, silentLogger } from './fakes.mjs';

const ISSUER = 'https://memory.example';
const BASE = `${ISSUER}/mcp`;
const CIMD_ID = 'https://app.example/client.json';
const REDIRECT = 'http://127.0.0.1:5555/cb';
const VERIFIER = 'a'.repeat(50);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

function scratchDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'engram-gateway-connections-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A gateway database with brains default/alpha/beta, `owner-o` owner on default+alpha and reader on beta. */
function world(t) {
  const db = openGatewayDatabase(join(scratchDir(t), 'gateway.db'));
  t.after(() => db.close());
  const brains = new SqliteBrainRepository(db);
  for (const slug of ['default', 'alpha', 'beta', 'gamma']) brains.ensure(slug, `/data/brains/${slug}`);
  const grants = new SqliteGrantRepository(db);
  grants.replaceConfigured({
    admins: [],
    grants: [
      { login: 'owner-o', brain: 'default', role: 'owner' },
      { login: 'owner-o', brain: 'alpha', role: 'owner' },
      { login: 'owner-o', brain: 'beta', role: 'reader' }
    ]
  });
  const clock = fakeClock();
  const random = fakeRandom();
  const s = settings({ resources: [BASE, `${BASE}/default`, `${BASE}/alpha`, `${BASE}/beta`, `${BASE}/gamma`] });
  const policy = new GrantAccessPolicy(grants, s.resources);
  const store = new SqliteTokenStore(db, clock, random);
  const connections = new SqliteConnectionStore(db);
  const consent = new ConnectionConsentService(grants, connections, BASE, 'default');
  const metadata = scriptedMetadata({ [CIMD_ID]: { client_id: CIMD_ID, client_name: 'Chat <App>', redirect_uris: [REDIRECT] } });
  const clients = new ClientRegistry(store, metadata, hasher, random, clock);
  const sign = signer(clock);
  const sessions = new SessionService(s, sign, random, policy);
  const codes = new AuthorizationCodes(store, hasher, random);
  const authorization = new AuthorizationService(s, clients, sessions, codes, sign, random, clock, store, policy, consent);
  const tokens = new TokenService(s, store, clients, codes, hasher, random, clock, silentLogger, policy);
  const verifier = new AccessTokenVerifier(s, store, hasher, policy);
  return { db, grants, connections, consent, authorization, tokens, verifier, sessions, store };
}

const query = (overrides = {}) => ({
  clientId: CIMD_ID, redirectUri: REDIRECT, responseType: 'code', codeChallenge: CHALLENGE,
  codeChallengeMethod: 'S256', scope: undefined, resource: undefined, state: 'st', ...overrides
});
const creds = { clientId: CIMD_ID, clientSecret: undefined, usedBasic: false };
const exchange = (w, code) => w.tokens.exchange(creds, {
  grantType: 'authorization_code', code, redirectUri: REDIRECT, codeVerifier: VERIFIER, refreshToken: undefined, scope: undefined, resource: undefined
});
const refresh = (w, refreshToken) => w.tokens.exchange(creds, {
  grantType: 'refresh_token', code: undefined, redirectUri: undefined, codeVerifier: undefined, refreshToken, scope: undefined, resource: undefined
});
const rowCount = (db, table) => Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n);

test('migration 7 adds connections and connection_brains, and a connection id column on codes and tokens', t => {
  const w = world(t);
  assert.ok(GATEWAY_SCHEMA_VERSION >= 7);
  for (const table of ['connections', 'connection_brains']) assert.equal(rowCount(w.db, table), 0, table);
  for (const table of ['auth_codes', 'access_tokens', 'refresh_tokens']) {
    const columns = w.db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    assert.ok(columns.includes('connection_id'), `${table}.connection_id`);
  }
});

test('migration 6 keeps tokens issued before it: they stay single-brain (no connection id) and valid', t => {
  const path = join(scratchDir(t), 'gateway.db');
  const old = new DatabaseSync(path);
  const all = loadMigrations(fileURLToPath(new URL('../../dist/shared/gateway-migrations/', import.meta.url)));
  migrate(old, all.slice(0, 5));
  const exp = Math.floor(Date.now() / 1000) + 3600;
  old.prepare('INSERT INTO token_families (id, expires_at) VALUES (?, ?)').run('fam-old', exp);
  old.prepare('INSERT INTO access_tokens (hash, client_id, login, scope, resource, expires_at, family_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(hasher.sha256Hex('old-token'), CIMD_ID, 'owner-o', 'memory', BASE, exp, 'fam-old');
  old.close();
  const db = openGatewayDatabase(path);
  t.after(() => db.close());
  const record = new SqliteTokenStore(db).getAccessToken(hasher.sha256Hex('old-token'));
  assert.deepEqual(record, { clientId: CIMD_ID, login: 'owner-o', scope: 'memory', resource: BASE, expiresAt: exp, familyId: 'fam-old' });
});

test('consent on the bare /mcp resource offers every granted brain with roles up to the owner\'s; default brain preselected at the owner\'s role', async t => {
  const w = world(t);
  const session = w.sessions.issue('owner-o').value;
  const begin = await w.authorization.begin(query(), session);
  assert.equal(begin.kind, 'consent');
  assert.deepEqual(begin.view.connection, {
    name: 'Chat App owner-o',
    defaultBrain: 'default',
    brains: [
      { brain: 'alpha', roles: ['reader', 'writer', 'owner'] },
      { brain: 'beta', roles: ['reader'] },
      { brain: 'default', roles: ['reader', 'writer', 'owner'], selected: 'owner' }
    ]
  });
});

test('approving saves the connection; its id reaches the code, the access token and every refreshed token', async t => {
  const w = world(t);
  const session = w.sessions.issue('owner-o').value;
  const begin = await w.authorization.begin(query(), session);
  const decided = await w.authorization.decide(begin.view.ticket, 'approve', session, {
    name: 'chatgpt-fran', defaultBrain: 'alpha', roles: { alpha: 'writer', beta: 'reader', default: 'none' }
  });
  assert.equal(decided.kind, 'redirect', JSON.stringify(decided));
  const [connection] = w.db.prepare('SELECT id FROM connections').all();
  const id = Number(connection.id);
  assert.deepEqual(w.connections.get(id), {
    id, login: 'owner-o', name: 'chatgpt-fran', kind: 'oauth', clientId: CIMD_ID, defaultBrain: 'alpha',
    brains: [{ brain: 'alpha', role: 'writer' }, { brain: 'beta', role: 'reader' }]
  });
  const issued = await exchange(w, decided.params.code);
  assert.equal(issued.ok, true);
  const verified = w.verifier.verify(issued.body.access_token, BASE);
  assert.equal(verified.ok, true);
  assert.equal(verified.record.connectionId, id);
  const refreshed = await refresh(w, issued.body.refresh_token);
  assert.equal(refreshed.ok, true);
  assert.equal(w.verifier.verify(refreshed.body.access_token, BASE).record.connectionId, id, 'a refresh keeps the connection');
});

test('a connection cannot get a brain its owner has no grant on, nor a role above the owner\'s: refused, nothing saved, no code', async t => {
  const w = world(t);
  const session = w.sessions.issue('owner-o').value;
  const cases = [
    [{ gamma: 'reader' }, 'gamma', /no access to brain gamma/],
    [{ beta: 'writer' }, 'beta', /reader on brain beta; a connection cannot get writer/],
    [{ alpha: 'admin' }, 'alpha', /Unknown role/],
    [{ alpha: 'reader' }, 'beta', /default brain beta must be one of/],
    [{ alpha: 'none' }, 'alpha', /at least one brain/]
  ];
  for (const [roles, defaultBrain, message] of cases) {
    const begin = await w.authorization.begin(query(), session);
    const decided = await w.authorization.decide(begin.view.ticket, 'approve', session, { name: 'c1', defaultBrain, roles });
    assert.equal(decided.kind, 'error_page', JSON.stringify(roles));
    assert.match(decided.message, message);
  }
  const bad = await w.authorization.begin(query(), session);
  const badName = await w.authorization.decide(bad.view.ticket, 'approve', session, { name: '<b>', defaultBrain: 'alpha', roles: { alpha: 'reader' } });
  assert.match(badName.message, /connection name/);
  assert.equal(rowCount(w.db, 'connections'), 0);
  assert.equal(rowCount(w.db, 'connection_brains'), 0);
  assert.equal(rowCount(w.db, 'auth_codes'), 0);
});

test('consent checks the owner\'s grants at approval time, not as the page showed them', async t => {
  const w = world(t);
  const session = w.sessions.issue('owner-o').value;
  const begin = await w.authorization.begin(query(), session);
  w.db.prepare("UPDATE grants SET role = 'reader' WHERE brain_id = (SELECT id FROM brains WHERE slug = 'alpha')").run();
  const decided = await w.authorization.decide(begin.view.ticket, 'approve', session, { name: 'c1', defaultBrain: 'alpha', roles: { alpha: 'owner' } });
  assert.equal(decided.kind, 'error_page');
  assert.equal(rowCount(w.db, 'connections'), 0);
});

test('consenting again from the same client updates its one connection, and the page is prefilled with it', async t => {
  const w = world(t);
  const session = w.sessions.issue('owner-o').value;
  const first = await w.authorization.begin(query(), session);
  await w.authorization.decide(first.view.ticket, 'approve', session, { name: 'chatgpt', defaultBrain: 'alpha', roles: { alpha: 'reader' } });
  const second = await w.authorization.begin(query(), session);
  assert.equal(second.view.connection.name, 'chatgpt');
  assert.equal(second.view.connection.defaultBrain, 'alpha');
  assert.deepEqual(second.view.connection.brains.map(b => [b.brain, b.selected ?? 'none']), [['alpha', 'reader'], ['beta', 'none'], ['default', 'none']]);
  await w.authorization.decide(second.view.ticket, 'approve', session, { name: 'chatgpt', defaultBrain: 'beta', roles: { alpha: 'writer', beta: 'reader' } });
  assert.equal(rowCount(w.db, 'connections'), 1);
  const [{ id }] = w.db.prepare('SELECT id FROM connections').all();
  assert.deepEqual(w.connections.get(Number(id)).brains, [{ brain: 'alpha', role: 'writer' }, { brain: 'beta', role: 'reader' }]);
});

test('a connection name is unique per user: another client cannot take it', async t => {
  const w = world(t);
  w.connections.createToken('owner-o', { name: 'repo:hagalink/crm', defaultBrain: 'alpha', brains: [{ brain: 'alpha', role: 'reader' }] });
  const session = w.sessions.issue('owner-o').value;
  const begin = await w.authorization.begin(query(), session);
  const decided = await w.authorization.decide(begin.view.ticket, 'approve', session, { name: 'repo:hagalink/crm', defaultBrain: 'alpha', roles: { alpha: 'reader' } });
  assert.equal(decided.kind, 'error_page');
  assert.match(decided.message, /already have a connection named repo:hagalink\/crm/);
  assert.equal(rowCount(w.db, 'connections'), 1);
});

test('grants on /mcp/<slug> stay single-brain tokens: no picker, no connection, no connection id (before and after a refresh)', async t => {
  const w = world(t);
  const session = w.sessions.issue('owner-o').value;
  const begin = await w.authorization.begin(query({ resource: `${BASE}/alpha` }), session);
  assert.equal(begin.view.connection, undefined);
  const decided = await w.authorization.decide(begin.view.ticket, 'approve', session);
  const issued = await exchange(w, decided.params.code);
  assert.equal(w.verifier.verify(issued.body.access_token, `${BASE}/alpha`).record.connectionId, undefined);
  const refreshed = await refresh(w, issued.body.refresh_token);
  assert.equal(w.verifier.verify(refreshed.body.access_token, `${BASE}/alpha`).record.connectionId, undefined);
  assert.equal(rowCount(w.db, 'connections'), 0);
});

test('tool access: the effective role is the weaker of the owner\'s grant and the connection\'s role (#27)', t => {
  const w = world(t);
  const id = w.connections.createToken('owner-o', { name: 'p', defaultBrain: 'alpha', brains: [{ brain: 'alpha', role: 'reader' }, { brain: 'beta', role: 'reader' }] });
  const access = createToolAccess(w.grants, w.connections);
  const via = { login: 'owner-o', connectionId: id };
  // Owner on alpha, but the connection is a reader there: it cannot write.
  assert.deepEqual(access.check(via, 'alpha', 'mem_save'), { allowed: false, reason: 'insufficient_role' });
  assert.deepEqual(access.check(via, 'alpha', 'mem_search'), { allowed: true, role: 'reader' }, 'the effective role is the connection\'s');
  // Owner on default, but the connection does not have it.
  assert.deepEqual(access.check(via, 'default', 'mem_search'), { allowed: false, reason: 'no_grant' });
  // Without a connection the call has the user's role (pins #6).
  assert.deepEqual(access.check({ login: 'owner-o' }, 'alpha', 'mem_delete'), { allowed: true, role: 'owner' });
  // A connection that no longer exists has no access at all.
  w.db.prepare('DELETE FROM connections WHERE id = ?').run(id);
  assert.deepEqual(access.check(via, 'alpha', 'mem_search'), { allowed: false, reason: 'no_grant' });
});

test('tool access: losing the owner\'s grant removes the connection\'s access on the next check', t => {
  const w = world(t);
  const id = w.connections.createToken('owner-o', { name: 'p', defaultBrain: 'alpha', brains: [{ brain: 'alpha', role: 'writer' }] });
  const access = createToolAccess(w.grants, w.connections);
  assert.deepEqual(access.check({ login: 'owner-o', connectionId: id }, 'alpha', 'mem_save'), { allowed: true, role: 'writer' });
  w.db.prepare("DELETE FROM grants WHERE brain_id = (SELECT id FROM brains WHERE slug = 'alpha')").run();
  assert.deepEqual(access.check({ login: 'owner-o', connectionId: id }, 'alpha', 'mem_save'), { allowed: false, reason: 'no_grant' });
});

test('a default brain the connection no longer has is reported as no default (fail closed)', t => {
  const w = world(t);
  const id = w.connections.createToken('owner-o', { name: 'p', defaultBrain: 'alpha', brains: [{ brain: 'alpha', role: 'reader' }, { brain: 'beta', role: 'reader' }] });
  w.db.prepare("DELETE FROM connection_brains WHERE connection_id = ? AND brain_id = (SELECT id FROM brains WHERE slug = 'alpha')").run(id);
  const connection = w.connections.get(id);
  assert.equal(connection.defaultBrain, undefined);
  assert.deepEqual(connection.brains, [{ brain: 'beta', role: 'reader' }]);
});

test('checkChoice is pure and caps every brain at the owner\'s role', () => {
  const owner = new Map([['alpha', 'writer']]);
  assert.deepEqual(checkChoice({ name: 'x', defaultBrain: 'alpha', brains: [{ brain: 'alpha', role: 'writer' }] }, owner),
    { ok: true, choice: { name: 'x', defaultBrain: 'alpha', brains: [{ brain: 'alpha', role: 'writer' }] } });
  assert.deepEqual(checkChoice({ name: 'x', defaultBrain: 'alpha', brains: [{ brain: 'alpha', role: 'owner' }] }, owner),
    { ok: false, problem: 'role_above_grant', brain: 'alpha', role: 'owner', max: 'writer' });
  assert.deepEqual(checkChoice({ name: 'x', defaultBrain: 'alpha', brains: [{ brain: 'alpha', role: 'reader' }, { brain: 'alpha', role: 'reader' }] }, owner),
    { ok: false, problem: 'duplicate_brain', brain: 'alpha' });
});

test('the audit row of a call through a connection keeps the connection id', t => {
  const w = world(t);
  const log = new SqliteAuditLog(w.db);
  const record = toolCallRecorder(log, { nowMs: () => 1000 });
  record({ caller: { login: 'owner-o', clientId: CIMD_ID, connectionId: 7 }, brain: 'alpha', tool: 'mem_save', startedAtMs: 1000, outcome: 'denied', meta: {} });
  record({ caller: { login: 'owner-o' }, brain: 'alpha', tool: 'mem_search', startedAtMs: 1000, outcome: 'ok', meta: {} });
  const metas = w.db.prepare('SELECT meta_json FROM audit_log ORDER BY id').all().map(row => JSON.parse(row.meta_json));
  assert.equal(metas[0].connectionId, 7);
  assert.equal(metas[1].connectionId, undefined);
});

test('authorship keeps the connection a write came through: first write and last write (#21)', t => {
  const w = world(t);
  const id = w.connections.createToken('owner-o', { name: 'p', defaultBrain: 'alpha', brains: [{ brain: 'alpha', role: 'writer' }] });
  const attribute = createAttributor({ authors: new SqliteAuthorshipRepository(w.db), clock: { nowMs: () => 1000 } });
  const saved = { content: [{ type: 'text', text: JSON.stringify({ id: 41 }) }] };
  const updated = { content: [{ type: 'text', text: JSON.stringify({ result: 'Memory updated: #41' }) }] };
  attribute({ caller: { login: 'owner-o', connectionId: id }, brain: 'alpha', request: { name: 'mem_save' }, result: saved });
  const row = () => ({ ...w.db.prepare('SELECT connection_id, last_connection_id FROM observation_authors WHERE observation_id = 41').get() });
  assert.deepEqual(row(), { connection_id: id, last_connection_id: id });
  attribute({ caller: { login: 'owner-o' }, brain: 'alpha', request: { name: 'mem_update' }, result: updated });
  assert.deepEqual(row(), { connection_id: id, last_connection_id: null }, 'a single-brain token write has no connection');
  w.db.prepare('DELETE FROM connections WHERE id = ?').run(id);
  assert.deepEqual(row(), { connection_id: null, last_connection_id: null }, 'deleting a connection keeps the authorship row');
});

test('the consent page escapes the connection name and brain slugs, and a browser submits the preselection', () => {
  let html = '';
  const res = { setHeader() {}, status() { return res; }, type() { return res; }, send(body) { html = body; } };
  sendConsentPage(res, {
    clientName: 'App', clientId: 'c', clientKind: 'dcr', redirectUri: REDIRECT, scope: 'memory', login: 'owner-o', resourceName: 'Memory', ticket: 't&1',
    connection: { name: '"><script>x()</script>', defaultBrain: 'a"b', brains: [{ brain: 'a"b', roles: ['reader', 'writer'], selected: 'writer' }, { brain: '<i>', roles: ['reader'] }] }
  });
  assert.doesNotMatch(html, /<script>|<i>|name="role:a"b"/);
  assert.deepEqual(formDefaults(html), {
    ticket: 't&1', connection_name: '"><script>x()</script>', default_brain: 'a"b', 'role:a"b': 'writer', 'role:<i>': 'none'
  });
});

test('an archived brain (#10) is neither offered on consent nor accepted, and gives a connection no access', async t => {
  const w = world(t);
  const session = w.sessions.issue('owner-o').value;
  const first = await w.authorization.begin(query(), session);
  await w.authorization.decide(first.view.ticket, 'approve', session, { name: 'chatgpt', defaultBrain: 'alpha', roles: { alpha: 'reader', beta: 'reader' } });
  w.db.prepare("UPDATE brains SET status = 'archived' WHERE slug = 'beta'").run();
  assert.deepEqual(w.grants.grantsOf('owner-o').map(g => g.brain), ['alpha', 'default']);
  const again = await w.authorization.begin(query(), session);
  assert.deepEqual(again.view.connection.brains.map(b => b.brain), ['alpha', 'default']);
  const refused = await w.authorization.decide(again.view.ticket, 'approve', session, { name: 'chatgpt', defaultBrain: 'beta', roles: { beta: 'reader' } });
  assert.ok(!refused.redirect?.includes('code='), 'an archived brain cannot be chosen');
  const id = w.connections.findOAuth('owner-o', CIMD_ID).id;
  const access = createToolAccess(w.grants, w.connections);
  assert.equal(access.check({ login: 'owner-o', connectionId: id }, 'beta', 'mem_search').allowed, false);
  assert.equal(access.check({ login: 'owner-o', connectionId: id }, 'alpha', 'mem_search').allowed, true);
});

test('a disabled user (#10) has no grants to offer and its connection has no access', async t => {
  const w = world(t);
  const id = w.connections.saveOAuth('owner-o', CIMD_ID, { name: 'c', defaultBrain: 'alpha', brains: [{ brain: 'alpha', role: 'reader' }] });
  w.db.prepare("UPDATE users SET status = 'disabled' WHERE github_login = 'owner-o'").run();
  assert.deepEqual(w.grants.grantsOf('owner-o'), []);
  assert.equal(createToolAccess(w.grants, w.connections).check({ login: 'owner-o', connectionId: id }, 'alpha', 'mem_search').allowed, false);
});
