// Append-only audit log (#8): the audit_log table, the SQLite adapter behind
// the AuditLog/AuditReader ports, the tool-call recorder and the CSV export.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMigrations, openSqliteDatabase } from '../../dist/shared/sqlite-database.js';
import { GATEWAY_SCHEMA_VERSION, openGatewayDatabase } from '../../dist/shared/gateway-database.js';
import { SqliteAuditLog, auditCsvLines, insertAuditEvent, recordToolCall, toAuditMeta } from '../../dist/audit/index.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../dist/shared/gateway-migrations/', import.meta.url));
const T0 = 1_800_000_000_000;

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'engram-gateway-audit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function openLog(t) {
  const db = openGatewayDatabase(join(scratch(t), 'gateway.db'));
  t.after(() => db.close());
  return { db, log: new SqliteAuditLog(db) };
}

const clockAt = ms => ({ nowMs: () => ms });
const rows = db => db.prepare('SELECT * FROM audit_log ORDER BY id').all();
const user = (login = 'octocat', clientId = 'client-1') => ({ kind: 'user', login, clientId });

function event(overrides = {}) {
  return {
    atMs: T0, actor: user(), brain: 'team', action: 'tool_call', target: 'mem_search',
    outcome: 'ok', durationMs: 5, meta: {}, ...overrides
  };
}

test('UPDATE and DELETE on audit_log fail and leave the row unchanged', t => {
  const { db, log } = openLog(t);
  const id = log.append(event());
  const before = rows(db);
  assert.throws(() => db.prepare("UPDATE audit_log SET outcome = 'error' WHERE id = ?").run(id), /audit_log is append-only/);
  assert.throws(() => db.prepare('DELETE FROM audit_log WHERE id = ?').run(id), /audit_log is append-only/);
  assert.throws(() => db.exec('DELETE FROM audit_log'), /audit_log is append-only/);
  assert.deepEqual(rows(db), before);
});

test('a mem_save tool call produces exactly one row with user, brain, tool, outcome and timing', t => {
  const { db, log } = openLog(t);
  const id = recordToolCall(log, clockAt(T0 + 42), {
    actor: user('octocat', 'client-1'), brain: 'team', tool: 'mem_save', startedAtMs: T0, outcome: 'ok',
    meta: { redactions: { github: 2, aws: 1 }, observationId: 17 }
  });
  const all = rows(db);
  assert.equal(all.length, 1);
  const [row] = all;
  const userId = db.prepare('SELECT id FROM users WHERE github_login = ?').get('octocat').id;
  assert.equal(row.id, id);
  assert.equal(row.at_ms, T0);
  assert.equal(row.actor_kind, 'user');
  assert.equal(row.actor_id, String(userId), 'actor id is the opaque users.id, not the login');
  assert.equal(row.brain_id, 'team');
  assert.equal(row.action, 'tool_call');
  assert.equal(row.target, 'mem_save');
  assert.equal(row.outcome, 'ok');
  assert.equal(row.duration_ms, 42);
  assert.deepEqual(JSON.parse(row.meta_json), { redactions: { github: 2, aws: 1 }, observationId: 17, clientId: 'client-1' });
});

test('a forward failure is recorded as an error with a fixed kind and no message or argument values', t => {
  const { db, log } = openLog(t);
  recordToolCall(log, clockAt(T0 + 7), {
    actor: user(), brain: 'team', tool: 'mem_save', startedAtMs: T0, outcome: 'error', errorKind: 'forward_failed',
    meta: { content: 'my secret note', error: 'spawn failed for my secret note', title: 'x', redactions: { github: 1 } }
  });
  const [row] = rows(db);
  assert.equal(row.outcome, 'error');
  assert.deepEqual(JSON.parse(row.meta_json), { redactions: { github: 1 }, errorKind: 'forward_failed', clientId: 'client-1' });
  assert.ok(!JSON.stringify(row).includes('secret note'), 'no argument value or message is stored');
});

test('meta keeps counts, booleans and id-shaped ids only', () => {
  assert.deepEqual(toAuditMeta({
    redactions: { github: 2 }, truncated: true, observationId: 'obs-12', sessionId: 'abc:1',
    content: 'free text', observationId2: 'x', nested: { a: 'b' }, mixed: { a: 1, b: 'two' },
    nan: Number.NaN, list: [1, 2], 'bad key': 1, clientId: 'has spaces and = signs'
  }), { redactions: { github: 2 }, truncated: true, observationId: 'obs-12', sessionId: 'abc:1' });
});

test('meta keeps denyReason only as one of the closed deny reasons', () => {
  for (const reason of ['no_grant', 'unknown_tool', 'insufficient_role', 'no_caller']) {
    assert.deepEqual(toAuditMeta({ denyReason: reason }), { denyReason: reason }, reason);
  }
  for (const reason of ['bogus', 'No_Grant', 'no grant', '', 3, { a: 1 }]) {
    assert.deepEqual(toAuditMeta({ denyReason: reason }), {}, String(reason));
  }
});

test('brain is nullable and any opaque string', t => {
  const { db, log } = openLog(t);
  log.append(event({ brain: null }));
  log.append(event({ brain: 'acme/brain-1' }));
  assert.deepEqual(rows(db).map(row => row.brain_id), [null, 'acme/brain-1']);
});

test('one user row per login (case-insensitive); system actors keep their id', t => {
  const { db, log } = openLog(t);
  log.append(event({ actor: user('OctoCat') }));
  log.append(event({ actor: user('octocat') }));
  log.append(event({ actor: { kind: 'system', id: 'gateway' } }));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  const all = rows(db);
  assert.equal(all[0].actor_id, all[1].actor_id);
  assert.deepEqual([all[2].actor_kind, all[2].actor_id], ['system', 'gateway']);
});

test('read filters by brain and half-open time range, oldest first, with the login from users', t => {
  const { log } = openLog(t);
  log.append(event({ atMs: T0, brain: 'a', target: 't1' }));
  log.append(event({ atMs: T0 + 10, brain: 'b', target: 't2' }));
  log.append(event({ atMs: T0 + 20, brain: 'a', target: 't3' }));
  log.append(event({ atMs: T0 + 30, brain: 'a', target: 't4' }));
  assert.deepEqual([...log.read()].map(r => r.target), ['t1', 't2', 't3', 't4']);
  assert.deepEqual([...log.read({ brain: 'a' })].map(r => r.target), ['t1', 't3', 't4']);
  assert.deepEqual([...log.read({ brain: 'a', fromMs: T0 + 10, toMs: T0 + 30 })].map(r => r.target), ['t3']);
  const [first] = log.read({ brain: 'b' });
  assert.equal(first.actorLogin, 'octocat');
  assert.equal(first.atMs, T0 + 10);
  assert.deepEqual(first.meta, {});
});

test('anonymising a user is an edit of users; the log rows stay and the export shows the new name', t => {
  const { db, log } = openLog(t);
  log.append(event());
  db.prepare("UPDATE users SET github_login = 'deleted-user-1' WHERE github_login = 'octocat'").run();
  assert.equal([...log.read()][0].actorLogin, 'deleted-user-1');
  assert.equal(rows(db).length, 1);
});

test('insertAuditEvent joins the caller transaction; read pages through a large log lazily and in order', t => {
  const { db, log } = openLog(t);
  db.exec('BEGIN IMMEDIATE');
  for (let i = 0; i < 1203; i++) insertAuditEvent(db, event({ atMs: T0 + i, target: `t${i}` }));
  db.exec('ROLLBACK');
  assert.equal(rows(db).length, 0, 'rows written inside a rolled-back transaction are gone');
  db.exec('BEGIN IMMEDIATE');
  for (let i = 0; i < 1203; i++) insertAuditEvent(db, event({ atMs: T0 + i, target: `t${i}` }));
  db.exec('COMMIT');
  const iterator = log.read()[Symbol.iterator]();
  assert.equal(iterator.next().value.target, 't0', 'first row arrives before the rest is read');
  let count = 1;
  let last;
  for (let next = iterator.next(); !next.done; next = iterator.next()) { last = next.value; count++; }
  assert.equal(count, 1203);
  assert.equal(last.target, 't1202');
});

test('CSV export: header, quoting, and formula-injection prefix', t => {
  const { log } = openLog(t);
  log.append(event({ actor: user('=cmd'), brain: '+brain', target: 'mem,"save"\nx', meta: { redactions: { github: 1 } } }));
  log.append(event({ actor: { kind: 'system', id: '@sys' }, brain: null, target: '-1', outcome: 'error', durationMs: null }));
  const lines = [...auditCsvLines(log.read())];
  assert.equal(lines.length, 3);
  assert.ok(lines.every(line => line.endsWith('\r\n')));
  assert.equal(lines[0], 'id,at,actor_kind,actor_id,actor_login,brain,action,target,outcome,duration_ms,meta\r\n');
  const actorId = [...log.read()][0].actorId;
  assert.equal(lines[1],
    `1,2027-01-15T08:00:00.000Z,user,${actorId},'=cmd,'+brain,tool_call,"mem,""save""\nx",ok,5,"{""redactions"":{""github"":1}}"\r\n`);
  assert.equal(lines[2], "2,2027-01-15T08:00:00.000Z,system,'@sys,,,tool_call,'-1,error,,{}\r\n");
});

test('CSV export is lazy: it reads records only as lines are pulled', () => {
  let pulled = 0;
  function* records() {
    for (let i = 1; i <= 3; i++) {
      pulled++;
      yield { id: i, atMs: T0, actorKind: 'system', actorId: 'gw', actorLogin: null, brain: null, action: 'a', target: null, outcome: 'ok', durationMs: 1, meta: {} };
    }
  }
  const lines = auditCsvLines(records());
  lines.next();
  lines.next();
  assert.equal(pulled, 1);
});

test('a version 1 database with data upgrades to the audit schema and keeps its rows', t => {
  const path = join(scratch(t), 'gateway.db');
  const v1 = openSqliteDatabase(path, loadMigrations(MIGRATIONS_DIR).slice(0, 1));
  v1.prepare("INSERT INTO users (github_login) VALUES ('octocat')").run();
  v1.close();
  const db = openGatewayDatabase(path);
  t.after(() => db.close());
  assert.equal(Object.values(db.prepare('PRAGMA user_version').get())[0], GATEWAY_SCHEMA_VERSION);
  assert.equal(db.prepare('SELECT github_login FROM users').get().github_login, 'octocat');
  new SqliteAuditLog(db).append(event());
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1, 'the existing user is reused');
  assert.equal(rows(db).length, 1);
});
