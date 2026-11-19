// Issue #33: several processes (two gateways during a deploy) opening a fresh
// gateway database at the same moment must all succeed. Before the fix the WAL
// switch and the first migration could fail with SQLITE_BUSY ("database is
// locked") instead of waiting. Each round starts N processes on a new file and
// releases them together, so they race on the very first open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { GATEWAY_SCHEMA_VERSION } from '../../dist/shared/gateway-database.js';
import { isBusyError, retryOnBusy } from '../../dist/shared/sqlite-database.js';

const MODULE = new URL('../../dist/shared/gateway-database.js', import.meta.url).href;
const ROUNDS = Number(process.env.OPEN_RACE_ROUNDS ?? 20);
const PROCESSES = 6;

const script = `
  const { openGatewayDatabase } = await import(${JSON.stringify(MODULE)});
  const [path, startAt] = process.argv.slice(1);
  while (Date.now() < Number(startAt)) { /* release every process at once */ }
  let stage = 'open';
  try {
    const db = openGatewayDatabase(path);
    stage = 'insert';
    db.prepare('INSERT INTO users (github_login) VALUES (?)').run('u' + process.pid);
    db.close();
  } catch (e) {
    // Name the step that failed, so a rare failure on a loaded machine can be told apart (#33).
    console.error('Error at ' + stage + ' (errcode ' + e.errcode + '): ' + String(e.stack).split('\\n').slice(0, 6).join(' | '));
    process.exit(1);
  }`;

function opener(path, startAt) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', script, path, String(startAt)], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', d => { err += d; });
    child.on('exit', code => resolve(code === 0 ? null : `exit ${code}: ${err.split('\n').find(line => /^Error at /.test(line)) ?? err.slice(0, 200)}`));
  });
}

test('N processes opening a fresh gateway database at once all succeed (#33)', { timeout: 300_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'engram-gateway-open-race-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const failures = [];
  for (let round = 0; round < ROUNDS; round++) {
    const path = join(dir, `round-${round}`, 'gateway.db');
    const startAt = Date.now() + 400;
    const results = await Promise.all(Array.from({ length: PROCESSES }, () => opener(path, startAt)));
    for (const failure of results) if (failure) failures.push(`round ${round}: ${failure}`);
    if (results.every(result => result === null)) {
      const db = new DatabaseSync(path, { readOnly: true });
      assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, GATEWAY_SCHEMA_VERSION);
      assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, PROCESSES);
      db.close();
    }
  }
  assert.deepEqual(failures, [], `${failures.length} of ${ROUNDS * PROCESSES} opens failed`);
});

test('a real SQLITE_BUSY from node:sqlite is recognised; other errors are not', t => {
  const dir = mkdtempSync(join(tmpdir(), 'engram-gateway-busy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'busy.db');
  const holder = new DatabaseSync(path);
  holder.exec('CREATE TABLE t (x)');
  holder.exec('BEGIN EXCLUSIVE');
  const other = new DatabaseSync(path);
  other.exec('PRAGMA busy_timeout = 0');
  const busy = (() => { try { other.exec('INSERT INTO t VALUES (1)'); } catch (error) { return error; } })();
  holder.exec('ROLLBACK');
  holder.close();
  other.close();
  assert.ok(busy, 'the write was refused');
  assert.equal(isBusyError(busy), true, `${busy.message} (errcode ${busy.errcode})`);
  assert.equal(isBusyError(new Error('database is locked')), false, 'the message alone is not trusted');
  assert.equal(isBusyError(undefined), false);
});

function busy() { return Object.assign(new Error('database is locked'), { errcode: 5 }); }

test('retryOnBusy retries SQLITE_BUSY with a bounded doubling pause, then succeeds', () => {
  let calls = 0;
  const pauses = [];
  const result = retryOnBusy(() => { calls += 1; if (calls < 5) throw busy(); return 'opened'; }, { nowMs: () => 0, sleepMs: ms => pauses.push(ms), initialDelayMs: 10, maxDelayMs: 40 });
  assert.equal(result, 'opened');
  assert.equal(calls, 5);
  assert.equal(pauses.length, 4);
  const caps = [10, 20, 40, 40];
  pauses.forEach((ms, i) => assert.ok(ms >= caps[i] / 2 && ms <= caps[i], `pause ${i} = ${ms}`));
});

test('retryOnBusy gives up after maxWaitMs and rethrows the busy error; other errors are not retried', () => {
  let clock = 0;
  let calls = 0;
  assert.throws(() => retryOnBusy(() => { calls += 1; throw busy(); }, { maxWaitMs: 100, nowMs: () => clock, sleepMs: ms => { clock += ms; } }), /database is locked/);
  assert.ok(calls > 1 && clock >= 100, `retried until the deadline (${calls} calls, ${clock} ms)`);
  calls = 0;
  assert.throws(() => retryOnBusy(() => { calls += 1; throw new Error('no such table: x'); }, { sleepMs: () => assert.fail('no pause') }), /no such table/);
  assert.equal(calls, 1);
});
