// The gateway SQLite database: versioned migrations, pragmas, the schema later issues extend,
// and the one-time, non-destructive import of the JSON auth store (auth-store.json).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../dist/shared/sqlite-database.js';
import { GATEWAY_SCHEMA_VERSION, openGatewayDatabase } from '../../dist/shared/gateway-database.js';
import { importJsonTokenStore } from '../../dist/auth/infrastructure/json-store-import.js';
import { SqliteTokenStore } from '../../dist/auth/infrastructure/sqlite-token-store.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/auth-store-v1.json', import.meta.url));
const clock = { nowMs: () => 1_800_000_000_000 };
const ACCESS = '6f1ed002ab5595859014ebf0951522d9e48c7a3e0c4c8b6c7b5c7b2b4b8f0a11';
const REFRESH = 'aa11bb22cc33dd44ee55ff6600112233445566778899aabbccddeeff00112233';
const USED_REFRESH = 'bb11bb22cc33dd44ee55ff6600112233445566778899aabbccddeeff00112233';

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'engram-gateway-db-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const pragma = (db, name) => Object.values(db.prepare(`PRAGMA ${name}`).get())[0];
const tables = db => db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all().map(row => row.name);

test('opening creates the schema at the latest version with WAL, foreign keys and a busy timeout', t => {
  const db = openGatewayDatabase(join(scratch(t), 'nested', 'gateway.db'));
  t.after(() => db.close());
  assert.equal(pragma(db, 'user_version'), GATEWAY_SCHEMA_VERSION);
  assert.ok(GATEWAY_SCHEMA_VERSION >= 1);
  assert.equal(pragma(db, 'journal_mode'), 'wal');
  assert.equal(pragma(db, 'foreign_keys'), 1);
  assert.equal(pragma(db, 'busy_timeout'), 5000);
  for (const table of ['clients', 'token_families', 'access_tokens', 'refresh_tokens', 'auth_codes', 'used_once', 'device_logins', 'users', 'brains', 'grants', 'gateway_meta']) {
    assert.ok(tables(db).includes(table), `table ${table} exists`);
  }
});

test('reopening an up-to-date database changes nothing (migrations are idempotent)', t => {
  const path = join(scratch(t), 'gateway.db');
  const first = openGatewayDatabase(path);
  first.prepare("INSERT INTO users (github_login, display_name) VALUES ('FullFran', 'Fran')").run();
  const schema = first.prepare('SELECT sql FROM sqlite_schema ORDER BY name').all();
  first.close();
  const second = openGatewayDatabase(path);
  t.after(() => second.close());
  assert.equal(pragma(second, 'user_version'), GATEWAY_SCHEMA_VERSION);
  assert.deepEqual(second.prepare('SELECT sql FROM sqlite_schema ORDER BY name').all(), schema);
  assert.equal(second.prepare('SELECT count(*) AS n FROM users').get().n, 1);
});

test('users, brains and grants: unique logins and slugs, grants tied to both by foreign keys', t => {
  const db = openGatewayDatabase(join(scratch(t), 'gateway.db'));
  t.after(() => db.close());
  const user = db.prepare("INSERT INTO users (github_login) VALUES ('FullFran')").run().lastInsertRowid;
  assert.throws(() => db.prepare("INSERT INTO users (github_login) VALUES ('fullfran')").run(), /UNIQUE/, 'logins are case-insensitive');
  const brain = db.prepare("INSERT INTO brains (slug, data_dir) VALUES ('personal', '/data/brains/personal')").run().lastInsertRowid;
  assert.throws(() => db.prepare("INSERT INTO brains (slug, data_dir) VALUES ('personal', '/x')").run(), /UNIQUE/);
  const row = db.prepare('SELECT users.status, semantic_search_enabled, brains.status AS brain_status FROM users, brains').get();
  assert.deepEqual({ ...row }, { status: 'active', semantic_search_enabled: 0, brain_status: 'active' });
  db.prepare("INSERT INTO grants (user_id, brain_id, role) VALUES (?, ?, 'owner')").run(user, brain);
  assert.equal(db.prepare('SELECT source FROM grants').get().source, 'config', 'grants default to configuration-owned (#10)');
  assert.throws(() => db.prepare("UPDATE grants SET source = 'other'").run(), /CHECK/);
  assert.throws(() => db.prepare("UPDATE brains SET status = 'deleted'").run(), /CHECK/);
  assert.throws(() => db.prepare("INSERT INTO grants (user_id, brain_id, role) VALUES (?, 999, 'reader')").run(user), /FOREIGN KEY/);
  db.prepare('DELETE FROM brains WHERE id = ?').run(brain);
  assert.equal(db.prepare('SELECT count(*) AS n FROM grants').get().n, 0, 'grants go with their brain');
});

test('migrate: each migration runs once, in order, in its own transaction', t => {
  const db = new DatabaseSync(join(scratch(t), 'm.db'));
  t.after(() => db.close());
  const migrations = [
    { version: 1, name: 'one', sql: 'CREATE TABLE a (x INTEGER);' },
    { version: 2, name: 'two', sql: 'CREATE TABLE b (x INTEGER);' }
  ];
  assert.equal(migrate(db, migrations.slice(0, 1)), 1);
  assert.equal(migrate(db, migrations), 2);
  assert.equal(migrate(db, migrations), 2, 'nothing left to apply');
  assert.deepEqual(tables(db), ['a', 'b']);
  const broken = [...migrations, { version: 3, name: 'broken', sql: 'CREATE TABLE c (x INTEGER); INSERT INTO nope VALUES (1);' }];
  assert.throws(() => migrate(db, broken), /broken/);
  assert.equal(pragma(db, 'user_version'), 2, 'a failed migration leaves the version unchanged');
  assert.deepEqual(tables(db), ['a', 'b'], 'and none of its changes');
});

test('migrate refuses a database newer than the code and a gap in the versions', t => {
  const db = new DatabaseSync(join(scratch(t), 'm.db'));
  t.after(() => db.close());
  db.exec('PRAGMA user_version = 5');
  assert.throws(() => migrate(db, [{ version: 1, name: 'one', sql: 'SELECT 1;' }]), /version 5.*newer/);
  const fresh = new DatabaseSync(':memory:');
  assert.throws(() => migrate(fresh, [{ version: 2, name: 'two', sql: 'SELECT 1;' }]), /expected migration 1/);
});

function upgrade(t) {
  const dir = scratch(t);
  const json = join(dir, 'auth-store.json');
  copyFileSync(FIXTURE, json);
  const db = openGatewayDatabase(join(dir, 'gateway.db'));
  t.after(() => db.close());
  return { dir, json, db };
}

test('upgrade from the JSON store: existing tokens, clients, codes, tickets and device logins keep working', t => {
  const { json, db } = upgrade(t);
  const original = readFileSync(json, 'utf8');
  const result = importJsonTokenStore(db, json);
  assert.equal(result.status, 'imported');
  assert.deepEqual(result.counts, { clients: 1, families: 2, accessTokens: 1, refreshTokens: 2, codes: 1, usedOnce: 1, deviceLogins: 1 });
  assert.equal(existsSync(json), false, 'the JSON file is moved aside');
  assert.equal(result.renamedTo, `${json}.imported`);
  assert.equal(readFileSync(`${json}.imported`, 'utf8'), original, 'never deleted nor changed');

  const store = new SqliteTokenStore(db, clock);
  assert.equal(store.getAccessToken(ACCESS)?.login, 'FullFran');
  assert.equal(store.isFamilyActive('fam-live'), true);
  assert.equal(store.isFamilyActive('fam-revoked'), false);
  assert.equal(store.getRefreshToken(REFRESH)?.usedAt, undefined);
  assert.equal(store.getRefreshToken(USED_REFRESH)?.usedAt, 1800000100);
  assert.equal(store.markRefreshTokenUsed(REFRESH), true, 'a live refresh token still rotates once');
  assert.equal(store.markRefreshTokenUsed(USED_REFRESH), false, 'a used one stays used');
  assert.deepEqual(store.getClient('client-1')?.redirectUris, ['http://127.0.0.1:33418/callback']);
  assert.equal(store.useCode('c0de', 'client-1')?.used, true, 'a burnt code stays burnt');
  assert.equal(store.claimOnce('ticket-1', 4102444800), false, 'a claimed ticket stays claimed');
  assert.equal(store.getDeviceLogin('nonce-1')?.userCode, 'ABCD-1234');
});

test('the import runs once: a second start neither re-imports nor touches the moved file', t => {
  const { json, db } = upgrade(t);
  importJsonTokenStore(db, json);
  const store = new SqliteTokenStore(db, clock);
  store.revokeFamily('fam-live');
  // An old gateway still running during a deploy may write a fresh auth-store.json.
  writeFileSync(json, readFileSync(`${json}.imported`));
  const again = importJsonTokenStore(db, json);
  assert.equal(again.status, 'already-imported');
  assert.equal(store.isFamilyActive('fam-live'), false, 'state written after the import is not overwritten');
  assert.ok(existsSync(json), 'a JSON file written after the import is left in place');
});

test('a failure between the import and the rename: the next start only renames', { skip: process.getuid?.() === 0 ? 'root ignores directory permissions' : false }, t => {
  const dir = scratch(t);
  const jsonDir = join(dir, 'legacy');
  mkdirSync(jsonDir);
  const json = join(jsonDir, 'auth-store.json');
  copyFileSync(FIXTURE, json);
  const db = openGatewayDatabase(join(dir, 'gateway.db'));
  t.after(() => db.close());
  chmodSync(jsonDir, 0o500); // the rename fails after the import committed
  try {
    assert.throws(() => importJsonTokenStore(db, json), /EACCES|EPERM/);
  } finally {
    chmodSync(jsonDir, 0o700);
  }
  assert.equal(new SqliteTokenStore(db, clock).getAccessToken(ACCESS)?.login, 'FullFran', 'the import itself committed');
  const again = importJsonTokenStore(db, json);
  assert.deepEqual(again, { status: 'already-imported', renamedTo: `${json}.imported` });
  assert.equal(existsSync(json), false);
  assert.equal(importJsonTokenStore(db, json).status, 'absent');
});

test('an existing .imported file is never overwritten', t => {
  const { json, db } = upgrade(t);
  writeFileSync(`${json}.imported`, 'older backup');
  const result = importJsonTokenStore(db, json);
  assert.equal(readFileSync(`${json}.imported`, 'utf8'), 'older backup');
  assert.notEqual(result.renamedTo, `${json}.imported`);
  assert.ok(existsSync(result.renamedTo));
});

test('no JSON store: nothing to import', t => {
  const { dir, db } = upgrade(t);
  assert.equal(importJsonTokenStore(db, join(dir, 'missing.json')).status, 'absent');
});

test('a database already in use is never overwritten by a JSON store, and the file is left alone', t => {
  const { json, db } = upgrade(t);
  new SqliteTokenStore(db, clock).claimOnce('newer', 4102444800);
  const result = importJsonTokenStore(db, json);
  assert.equal(result.status, 'skipped-not-empty');
  assert.ok(existsSync(json));
  assert.equal(new SqliteTokenStore(db, clock).getAccessToken(ACCESS), undefined);
});

test('an unsupported JSON store version aborts the import and changes nothing', t => {
  const { json, db } = upgrade(t);
  writeFileSync(json, JSON.stringify({ version: 2, clients: {} }));
  assert.throws(() => importJsonTokenStore(db, json), /Unsupported auth store version/);
  assert.ok(existsSync(json));
  assert.equal(db.prepare('SELECT count(*) AS n FROM gateway_meta').get().n, 0);
});
