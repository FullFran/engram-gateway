// Two gateways on one /data (blue-green deploys): every piece of auth state they must share goes
// through the gateway SQLite database. Two SqliteTokenStore instances on the same file stand for
// the two containers; the process tests use real child processes for cross-process atomicity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { SqliteTokenStore } from '../../dist/auth/infrastructure/sqlite-token-store.js';

const STORE_MODULE = fileURLToPath(new URL('../../dist/auth/infrastructure/sqlite-token-store.js', import.meta.url));

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'engram-gateway-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'gateway.db');
}

const openStore = (path, clock, random) => SqliteTokenStore.open(path, clock, random);
const rows = (path, sql) => {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare(sql).all(); } finally { db.close(); }
};

const clock = { nowMs: () => 1_800_000_000_000 };
const now = Math.floor(clock.nowMs() / 1000);
const client = id => ({ clientId: id, clientName: id, redirectUris: ['http://127.0.0.1/cb'], tokenEndpointAuthMethod: 'none', registeredAt: now });
const token = (familyId, extra = {}) => ({ clientId: 'c', login: 'fran', scope: 'mcp', resource: 'https://p.example/mcp', expiresAt: now + 3600, familyId, ...extra });
const code = (extra = {}) => ({
  clientId: 'c', redirectUri: 'http://127.0.0.1/cb', codeChallenge: 'x', scope: 'mcp', resource: 'r', login: 'fran',
  expiresAt: now + 60, used: false, ...extra
});
const deviceLogin = (extra = {}) => ({
  userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device',
  expiresAt: clock.nowMs() + 600_000, intervalMs: 5000, nextPollAt: clock.nowMs() + 5000, returnTo: '/', ...extra
});

test('a client registered on one copy is known on the other', t => {
  const path = scratch(t);
  const a = openStore(path, clock);
  const b = openStore(path, clock);
  a.addClient(client('from-a'));
  assert.equal(b.getClient('from-a')?.clientId, 'from-a');
  assert.equal(b.clientCount(), 1);
});

test('writes from both copies are merged, never lost', t => {
  const path = scratch(t);
  const a = openStore(path, clock);
  const b = openStore(path, clock);
  a.addClient(client('one'));
  b.addClient(client('two'));
  a.addClient(client('three'));
  const fresh = openStore(path, clock);
  assert.deepEqual(['one', 'two', 'three'].map(id => fresh.getClient(id)?.clientId), ['one', 'two', 'three']);
});

test('tokens issued on one copy authenticate on the other, and a revocation reaches both', t => {
  const path = scratch(t);
  const a = openStore(path, clock);
  const b = openStore(path, clock);
  const family = a.createFamily(now + 7200);
  a.putTokens({ hash: 'acc', record: token(family) }, { hash: 'ref', record: token(family) });
  assert.equal(b.getAccessToken('acc')?.login, 'fran');
  assert.equal(b.isFamilyActive(family), true);
  b.revokeFamily(family);
  assert.equal(a.getAccessToken('acc'), undefined);
  assert.equal(a.isFamilyActive(family), false);
});

test('a family created on one copy survives a write from the other', t => {
  const path = scratch(t);
  const a = openStore(path, clock);
  const b = openStore(path, clock);
  const family = a.createFamily(now + 7200);
  b.addClient(client('other'));
  a.extendFamily(family, now + 9000);
  assert.equal(openStore(path, clock).isFamilyActive(family), true);
});

test('an authorization code is single use across copies', t => {
  const path = scratch(t);
  const a = openStore(path, clock);
  const b = openStore(path, clock);
  a.putCode('h1', code());
  assert.equal(b.useCode('h1', 'other-client'), undefined, 'another client neither sees nor burns the code');
  const first = b.useCode('h1', 'c');
  assert.equal(first?.used, false, 'first presentation sees an unused code');
  const second = a.useCode('h1', 'c');
  assert.equal(second?.used, true, 'second presentation, on the other copy, sees it used');
  assert.equal(second?.familyId, first.familyId, 'and knows which family to revoke');
  assert.equal(a.useCode('missing', 'c'), undefined);
});

test('a refresh token can be marked used only once across copies', t => {
  const path = scratch(t);
  const a = openStore(path, clock);
  const b = openStore(path, clock);
  const family = a.createFamily(now + 7200);
  a.putTokens({ hash: 'acc', record: token(family) }, { hash: 'ref', record: token(family) });
  assert.equal(b.markRefreshTokenUsed('ref'), true);
  assert.equal(a.markRefreshTokenUsed('ref'), false);
  assert.notEqual(a.getRefreshToken('ref')?.usedAt, undefined);
});

test('a consent ticket can be claimed only once across copies', t => {
  const path = scratch(t);
  const a = openStore(path, clock);
  const b = openStore(path, clock);
  assert.equal(a.claimOnce('ticket-1', now + 300), true);
  assert.equal(b.claimOnce('ticket-1', now + 300), false);
  assert.equal(b.claimOnce('ticket-2', now + 300), true);
});

test('a device login started on one copy is found, updated and deleted on the other', t => {
  const path = scratch(t);
  const a = openStore(path, clock);
  const b = openStore(path, clock);
  a.putDeviceLogin('n1', deviceLogin());
  assert.equal(b.deviceLoginCount(), 1);
  assert.equal(b.getDeviceLogin('n1')?.userCode, 'ABCD-1234');
  b.putDeviceLogin('n1', deviceLogin({ outcome: { kind: 'denied' } }));
  assert.deepEqual(a.getDeviceLogin('n1')?.outcome, { kind: 'denied' });
  a.deleteDeviceLogin('n1');
  assert.equal(b.getDeviceLogin('n1'), undefined);
});

test('concurrent writers in separate processes lose nothing', async t => {
  const path = scratch(t);
  const writers = 4;
  const each = 25;
  const script = `
    const { SqliteTokenStore } = await import(${JSON.stringify(STORE_MODULE)});
    const store = SqliteTokenStore.open(${JSON.stringify(path)});
    const w = process.argv[1];
    for (let i = 0; i < ${each}; i++) {
      store.addClient({ clientId: w + '-' + i, clientName: 'x', redirectUris: ['http://127.0.0.1/cb'], tokenEndpointAuthMethod: 'none', registeredAt: 1 });
    }`;
  const runs = Array.from({ length: writers }, (_, w) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', script, `w${w}`], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', d => { err += d; });
    child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`writer ${w} exited ${code}: ${err}`))));
  }));
  await Promise.all(runs);
  assert.equal(openStore(path, clock).clientCount(), writers * each);
});

test('a replay that lands between redeeming a code and issuing its tokens still revokes them', t => {
  const path = scratch(t);
  const a = openStore(path, clock);
  const b = openStore(path, clock);
  a.putCode('h', code());
  const first = a.useCode('h', 'c');
  assert.equal(first?.used, false);
  assert.ok(first?.familyId, 'the family is chosen when the code is burnt');
  const replay = b.useCode('h', 'c');
  assert.equal(replay?.familyId, first.familyId, 'the replay on the other copy knows the family');
  b.revokeFamily(replay.familyId);
  a.createFamily(now + 7200, first.familyId);
  a.putTokens({ hash: 'acc', record: token(first.familyId) }, { hash: 'ref', record: token(first.familyId) });
  assert.equal(a.isFamilyActive(first.familyId), false, 'a family revoked before it was created stays revoked');
  assert.equal(b.getAccessToken('acc'), undefined);
});

test('records read back exactly as written (optional fields absent, not undefined)', t => {
  const store = openStore(scratch(t), clock);
  const minimal = { clientId: 'm', redirectUris: ['http://127.0.0.1/cb'], authMethod: 'none', createdAt: now };
  store.addClient(minimal);
  assert.deepEqual(store.getClient('m'), minimal);
  const family = store.createFamily(now + 7200);
  store.putTokens({ hash: 'a', record: token(family) }, { hash: 'r', record: token(family) });
  assert.deepEqual(store.getAccessToken('a'), token(family));
  assert.deepEqual(store.getRefreshToken('r'), token(family));
  store.putCode('h', code());
  const burnt = store.useCode('h', 'c');
  assert.deepEqual(burnt, { ...code(), familyId: burnt.familyId });
  assert.deepEqual(store.useCode('h', 'c'), { ...code(), used: true, familyId: burnt.familyId });
  store.putDeviceLogin('n', deviceLogin({ outcome: { kind: 'success', login: 'fran' } }));
  assert.deepEqual(store.getDeviceLogin('n'), deviceLogin({ outcome: { kind: 'success', login: 'fran' } }));
});

test('expired tokens, families, codes, tickets and device logins are pruned on the next write', t => {
  const path = scratch(t);
  let ms = clock.nowMs();
  const moving = { nowMs: () => ms };
  const store = openStore(path, moving);
  const family = store.createFamily(now + 10);
  store.putTokens({ hash: 'a', record: token(family, { expiresAt: now + 10 }) }, { hash: 'r', record: token(family, { expiresAt: now + 10 }) });
  store.putCode('h', code());
  store.claimOnce('tk', now + 10);
  store.putDeviceLogin('n', deviceLogin());
  ms += 3600_000;
  assert.equal(store.claimOnce('other', now + 7200), true, 'a write triggers the prune');
  for (const table of ['access_tokens', 'refresh_tokens', 'token_families', 'auth_codes', 'device_logins']) {
    assert.equal(rows(path, `SELECT count(*) AS n FROM ${table}`)[0].n, 0, `${table} pruned`);
  }
  assert.deepEqual(rows(path, 'SELECT key FROM used_once').map(row => row.key), ['other']);
  assert.equal(store.claimOnce('tk', now + 7200), true, 'an expired ticket key may be claimed again');
});

test('a used code is kept for a grace period so a replay is still recognised', t => {
  let ms = clock.nowMs();
  const store = openStore(scratch(t), { nowMs: () => ms });
  store.putCode('h', code());
  store.useCode('h', 'c');
  ms += 120_000;
  store.claimOnce('write', now + 7200);
  assert.equal(store.useCode('h', 'c')?.used, true);
});

test('expired access and refresh tokens are not returned; a revoked family hides its access tokens', t => {
  let ms = clock.nowMs();
  const store = openStore(scratch(t), { nowMs: () => ms });
  const family = store.createFamily(now + 7200);
  store.putTokens({ hash: 'a', record: token(family, { expiresAt: now + 10 }) }, { hash: 'r', record: token(family, { expiresAt: now + 10 }) });
  ms += 20_000;
  assert.equal(store.getAccessToken('a'), undefined);
  assert.equal(store.getRefreshToken('r'), undefined);
  assert.equal(store.markRefreshTokenUsed('r'), false, 'an expired refresh token cannot be exchanged');
  const other = store.createFamily(now + 7200);
  store.putTokens({ hash: 'a2', record: token(other) }, { hash: 'r2', record: token(other) });
  store.revokeFamily(other);
  assert.equal(store.getAccessToken('a2'), undefined);
  assert.notEqual(store.getRefreshToken('r2')?.usedAt, undefined, 'revocation marks refresh tokens used');
  assert.equal(store.markRefreshTokenUsed('r2'), false);
});

test('updateDeviceLogin changes a live login atomically and ignores missing or expired ones', t => {
  let ms = clock.nowMs();
  const store = openStore(scratch(t), { nowMs: () => ms });
  store.putDeviceLogin('n', deviceLogin());
  const next = store.updateDeviceLogin('n', record => ({ ...record, nextPollAt: record.nextPollAt + 1 }));
  assert.equal(next.nextPollAt, deviceLogin().nextPollAt + 1);
  assert.equal(store.getDeviceLogin('n').nextPollAt, next.nextPollAt);
  assert.equal(store.updateDeviceLogin('n', () => undefined), undefined);
  assert.equal(store.getDeviceLogin('n').nextPollAt, next.nextPollAt, 'undefined from change changes nothing');
  assert.equal(store.updateDeviceLogin('missing', record => record), undefined);
  ms += 3600_000;
  assert.equal(store.updateDeviceLogin('n', record => record), undefined);
  assert.equal(store.deviceLoginCount(), 0);
});

test('the store holds only hashes and the database file is mode 0600', t => {
  const path = scratch(t);
  const store = openStore(path, clock);
  store.putCode('sha256-of-code', code());
  assert.deepEqual(rows(path, 'SELECT hash FROM auth_codes').map(row => row.hash), ['sha256-of-code']);
  assert.equal((statSync(path).mode & 0o777), 0o600);
});

test('racing processes: a single-use key is won by exactly one of them', async t => {
  const path = scratch(t);
  openStore(path, clock); // create and migrate once, so racers only race on the claim
  const racers = 6;
  const script = `
    const { SqliteTokenStore } = await import(${JSON.stringify(STORE_MODULE)});
    const store = SqliteTokenStore.open(${JSON.stringify(path)});
    while (Date.now() < Number(process.argv[2])) {}
    process.stdout.write(store.claimOnce(process.argv[1], 4102444800) ? 'won' : 'lost');`;
  for (let round = 0; round < 4; round++) {
    const start = Date.now() + 400;
    const results = await Promise.all(Array.from({ length: racers }, () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', script, `k${round}`, String(start)], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { err += d; });
      child.on('exit', code => (code === 0 ? resolve(out) : reject(new Error(`racer exited ${code}: ${err}`))));
    })));
    assert.equal(results.filter(r => r === 'won').length, 1, `round ${round}: ${results.join(',')}`);
  }
});
