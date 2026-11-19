import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  BackupService, callBackupControl, createBackupCipher, integrityCheck, nextRunAt, parseBackupKey, resolveBackupConfig,
  serveBackupControl, snapshotDatabase, sqliteSnapshotter
} from '../../dist/backup/index.js';
import { BrainRegistry } from '../../dist/brains/index.js';

const scratchRoot = mkdtempSync(join(tmpdir(), 'backup-test-'));
const scratch = name => mkdtempSync(join(scratchRoot, `${name}-`));
const quiet = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(l => [l, () => {}]));
const KEY = randomBytes(32);
const OTHER_KEY = randomBytes(32);

function sqliteFile(path, setup) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  setup?.(db);
  return db;
}

function rows(path, sql) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

/** A brain data directory holding an engram.db with one `notes` table. */
function brainWithNotes(name, notes) {
  const dataDir = scratch(name);
  const db = sqliteFile(join(dataDir, 'engram.db'), d => {
    d.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
    for (const body of notes) d.prepare('INSERT INTO notes (body) VALUES (?)').run(body);
  });
  return { dataDir, db };
}

function steppingClock(start = Date.UTC(2026, 10, 19, 3, 0, 0)) {
  let now = start;
  return { now: () => (now += 1000) };
}

function newService({ brains, backupDir = scratch('backups'), retention = 14, gatewayDbPath, quiesce, clock = steppingClock(), cipher } = {}) {
  return new BackupService({
    backupDir,
    retention,
    cipher: cipher ?? createBackupCipher({ key: KEY, previousKeys: [] }),
    brains: () => brains,
    ...(gatewayDbPath ? { gatewayDbPath } : {}),
    quiesce: quiesce ?? ((_slug, work) => work()),
    clock,
    logger: quiet,
    snapshotter: sqliteSnapshotter
  });
}

// ---- key and cipher ----

test('key: 32 bytes as base64 or hex; anything else fails without echoing the key', () => {
  const b64 = KEY.toString('base64');
  assert.deepEqual(parseBackupKey(`${b64}\n`, 'k'), KEY);
  assert.deepEqual(parseBackupKey(KEY.toString('hex'), 'k'), KEY);
  const short = randomBytes(16).toString('base64');
  assert.throws(() => parseBackupKey(short, '/run/secrets/k'), error => {
    assert.match(error.message, /\/run\/secrets\/k/);
    assert.match(error.message, /32-byte key/);
    assert.equal(error.message.includes(short), false, 'never echoes the key');
    return true;
  });
  assert.throws(() => parseBackupKey('', 'k'), /32-byte key/);
});

test('cipher: round trip, ciphertext hides the plaintext, any flipped byte fails authentication', async () => {
  const dir = scratch('cipher');
  const plain = join(dir, 'plain');
  const marker = 'very-secret-memory-text';
  writeFileSync(plain, `${marker}\n`.repeat(1000));
  const cipher = createBackupCipher({ key: KEY, previousKeys: [] });
  await cipher.encryptFile(plain, join(dir, 'enc'), 'brains/a/engram.db');
  assert.equal(readFileSync(join(dir, 'enc')).includes(marker), false);
  assert.equal(statSync(join(dir, 'enc')).mode & 0o777, 0o600);
  await cipher.decryptFile(join(dir, 'enc'), join(dir, 'out'), 'brains/a/engram.db');
  assert.deepEqual(readFileSync(join(dir, 'out')), readFileSync(plain));

  for (const offset of [0, 20, 200, statSync(join(dir, 'enc')).size - 1]) {
    const bytes = readFileSync(join(dir, 'enc'));
    bytes[offset] ^= 0x01;
    writeFileSync(join(dir, 'bad'), bytes);
    await assert.rejects(cipher.decryptFile(join(dir, 'bad'), join(dir, 'bad-out'), 'brains/a/engram.db'), /backup file|authenticate|key/, `offset ${offset}`);
    assert.equal(existsSync(join(dir, 'bad-out')), false, 'no partial output is left behind');
  }
});

test('cipher: a file encrypted for one brain does not decrypt as another', async () => {
  const dir = scratch('context');
  writeFileSync(join(dir, 'plain'), 'x');
  const cipher = createBackupCipher({ key: KEY, previousKeys: [] });
  await cipher.encryptFile(join(dir, 'plain'), join(dir, 'enc'), 'brains/a/engram.db');
  await assert.rejects(cipher.decryptFile(join(dir, 'enc'), join(dir, 'out'), 'brains/b/engram.db'), /brains\/a\/engram\.db/);
});

test('cipher: key rotation, old snapshots decrypt with a previous key, unknown keys fail', async () => {
  const dir = scratch('rotation');
  writeFileSync(join(dir, 'plain'), 'memory');
  await createBackupCipher({ key: OTHER_KEY, previousKeys: [] }).encryptFile(join(dir, 'plain'), join(dir, 'old'), 'gateway/gateway.db');
  await assert.rejects(createBackupCipher({ key: KEY, previousKeys: [] }).decryptFile(join(dir, 'old'), join(dir, 'out'), 'gateway/gateway.db'), /key/);
  await createBackupCipher({ key: KEY, previousKeys: [OTHER_KEY] }).decryptFile(join(dir, 'old'), join(dir, 'out'), 'gateway/gateway.db');
  assert.equal(readFileSync(join(dir, 'out'), 'utf8'), 'memory');
});

// ---- config ----

test('config: backups are off without BACKUP_DIR and need no key', () => {
  assert.deepEqual(resolveBackupConfig({}), { enabled: false });
});

test('config: enabled without a key fails loudly; defaults otherwise', () => {
  assert.throws(() => resolveBackupConfig({ BACKUP_DIR: '/b' }), /BACKUP_KEY_FILE/);
  const dir = scratch('config');
  const keyFile = join(dir, 'key');
  writeFileSync(keyFile, KEY.toString('base64'));
  assert.throws(() => resolveBackupConfig({ BACKUP_DIR: '/b', BACKUP_KEY_FILE: join(dir, 'missing') }), /BACKUP_KEY_FILE.*missing/);
  assert.throws(() => resolveBackupConfig({ BACKUP_DIR: 'relative', BACKUP_KEY_FILE: keyFile }), /BACKUP_DIR.*absolute/);
  const config = resolveBackupConfig({ BACKUP_DIR: '/b', BACKUP_KEY_FILE: keyFile });
  assert.deepEqual({ ...config, key: undefined }, {
    enabled: true, dir: '/b', retention: 14, schedule: { hour: 3, minute: 0 }, jitterMs: 300_000, key: undefined, previousKeys: []
  });
  assert.deepEqual(config.key, KEY);
});

test('config: schedule, retention, jitter and previous keys are parsed; bad values fail', () => {
  const dir = scratch('config2');
  const keyFile = join(dir, 'key');
  const oldKey = join(dir, 'old');
  writeFileSync(keyFile, KEY.toString('hex'));
  writeFileSync(oldKey, OTHER_KEY.toString('base64'));
  const base = { BACKUP_DIR: '/b', BACKUP_KEY_FILE: keyFile };
  const config = resolveBackupConfig({ ...base, BACKUP_SCHEDULE: '23:45', BACKUP_RETENTION: '3', BACKUP_JITTER: '0', BACKUP_PREVIOUS_KEY_FILES: ` ${oldKey} ` });
  assert.deepEqual(config.schedule, { hour: 23, minute: 45 });
  assert.equal(config.retention, 3);
  assert.equal(config.jitterMs, 0);
  assert.deepEqual(config.previousKeys, [OTHER_KEY]);
  assert.equal(resolveBackupConfig({ ...base, BACKUP_SCHEDULE: 'off' }).schedule, 'off');
  assert.throws(() => resolveBackupConfig({ ...base, BACKUP_SCHEDULE: '25:00' }), /BACKUP_SCHEDULE/);
  assert.throws(() => resolveBackupConfig({ ...base, BACKUP_RETENTION: '0' }), /BACKUP_RETENTION/);
  assert.throws(() => resolveBackupConfig({ ...base, BACKUP_JITTER: '-1' }), /BACKUP_JITTER/);
});

test('schedule: next run is the next HH:MM UTC, plus jitter', () => {
  const at = (h, m, s = 0) => Date.UTC(2026, 10, 19, h, m, s);
  assert.equal(nextRunAt(at(1, 0), { hour: 3, minute: 0 }, 0), at(3, 0));
  assert.equal(nextRunAt(at(3, 0), { hour: 3, minute: 0 }, 0), at(3, 0) + 86_400_000, 'exactly now runs tomorrow');
  assert.equal(nextRunAt(at(4, 0), { hour: 3, minute: 0 }, 0), at(3, 0) + 86_400_000);
  assert.equal(nextRunAt(at(1, 0), { hour: 3, minute: 0 }, 60_000, () => 0.5), at(3, 0) + 30_000);
});

// ---- backup ----

test('snapshot: consistent while another process writes the database (integrity_check ok, invariant holds)', async () => {
  const dir = scratch('busy');
  const path = join(dir, 'engram.db');
  sqliteFile(path, db => {
    db.exec('CREATE TABLE ledger (id INTEGER PRIMARY KEY, amount INTEGER NOT NULL); CREATE TABLE total (n INTEGER NOT NULL); INSERT INTO total VALUES (0);');
  }).close();
  // Another process inserts into `ledger` and bumps `total` in one transaction, as fast as it can.
  const writer = spawn(process.execPath, ['--no-warnings', '-e', `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(${JSON.stringify(path)});
    db.exec('PRAGMA busy_timeout = 5000');
    const ins = db.prepare('INSERT INTO ledger (amount) VALUES (?)');
    const bump = db.prepare('UPDATE total SET n = n + ?');
    process.stdout.write('ready\\n');
    for (;;) { db.exec('BEGIN IMMEDIATE'); for (let i = 0; i < 50; i++) { ins.run(i); bump.run(i); } db.exec('COMMIT'); }
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise(resolve => writer.stdout.once('data', resolve));
    const counts = [];
    for (let i = 0; i < 5; i++) {
      await new Promise(resolve => setTimeout(resolve, 30));
      const out = join(dir, `snap-${i}.db`);
      await snapshotDatabase(path, out);
      assert.equal(integrityCheck(out), 'ok');
      const [{ sum, n, count }] = rows(out, 'SELECT (SELECT COALESCE(SUM(amount), 0) FROM ledger) AS sum, (SELECT n FROM total) AS n, (SELECT COUNT(*) FROM ledger) AS count');
      assert.equal(sum, n, 'snapshot sees whole transactions only');
      counts.push(count);
    }
    assert.ok(counts.at(-1) > 0, 'the writer was writing during the snapshots');
  } finally {
    writer.kill();
  }
});

test('backup: one encrypted snapshot per brain and one of the gateway database, none for a brain with no database yet', async () => {
  const a = brainWithNotes('a', ['first memory']);
  const empty = scratch('empty');
  const gatewayDir = scratch('gateway');
  const gatewayDbPath = join(gatewayDir, 'gateway.db');
  sqliteFile(gatewayDbPath, db => db.exec('CREATE TABLE brains (slug TEXT)')).close();
  const backupDir = scratch('backups');
  const service = newService({ brains: [{ slug: 'a', dataDir: a.dataDir, cloudSync: false }, { slug: 'fresh', dataDir: empty, cloudSync: false }], backupDir, gatewayDbPath });
  const report = await service.runAll();
  assert.deepEqual(report.taken.map(t => t.unit).sort(), ['brains/a', 'gateway']);
  assert.deepEqual(report.skipped, [{ unit: 'brains/fresh', reason: 'no database yet' }]);
  assert.deepEqual(report.failed, []);
  assert.equal(existsSync(join(empty, 'engram.db')), false, 'backup never creates a brain database');
  const [id] = service.list('brains/a');
  assert.match(id, /^\d{8}T\d{9}Z$/);
  assert.deepEqual(readdirSync(join(backupDir, 'brains', 'a', id)), ['engram.db.enc']);
  assert.equal(readFileSync(join(backupDir, 'brains', 'a', id, 'engram.db.enc')).includes('first memory'), false, 'encrypted at rest');
  assert.deepEqual(readdirSync(join(backupDir, 'gateway', service.list('gateway')[0])), ['gateway.db.enc']);
  assert.equal(statSync(backupDir).mode & 0o777, 0o700);
  a.db.close();
});

test('retention: exactly N snapshots are kept per unit, the newest ones; stale partial snapshots are removed', async () => {
  const a = brainWithNotes('ret', ['m']);
  const backupDir = scratch('backups');
  mkdirSync(join(backupDir, 'brains', 'a', '20200101T000000000Z.partial'), { recursive: true });
  const service = newService({ brains: [{ slug: 'a', dataDir: a.dataDir, cloudSync: false }], backupDir, retention: 3 });
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push((await service.runAll()).taken[0].id);
  assert.deepEqual(service.list('brains/a'), ids.slice(2));
  assert.deepEqual(readdirSync(join(backupDir, 'brains', 'a')).sort(), ids.slice(2));
  a.db.close();
});

// ---- restore ----

test('restore round trip: save, back up, delete, restore, memory is back (stale WAL files removed)', async () => {
  const a = brainWithNotes('rt', ['remember the milk']);
  a.db.close();
  const brain = { slug: 'a', dataDir: a.dataDir, cloudSync: false };
  const service = newService({ brains: [brain] });
  const { id } = (await service.runAll()).taken[0];
  rmSync(join(a.dataDir, 'engram.db'));
  writeFileSync(join(a.dataDir, 'engram.db-wal'), 'stale wal from the old file');
  writeFileSync(join(a.dataDir, 'engram.db-shm'), 'stale shm');
  await service.restoreBrain('a', id);
  assert.deepEqual(rows(join(a.dataDir, 'engram.db'), 'SELECT body FROM notes').map(r => r.body), ['remember the milk']);
  assert.equal(existsSync(join(a.dataDir, 'engram.db-wal')), false);
  assert.equal(existsSync(join(a.dataDir, 'engram.db-shm')), false);
  assert.deepEqual(readdirSync(a.dataDir).filter(f => f.startsWith('.restore-')), [], 'staging cleaned up');
});

test('restore: the file is swapped only while the brain is quiesced', async () => {
  const a = brainWithNotes('q', ['old']);
  a.db.close();
  const brain = { slug: 'a', dataDir: a.dataDir, cloudSync: false };
  const events = [];
  const service = newService({
    brains: [brain],
    quiesce: async (slug, work) => {
      events.push(`quiesce ${slug}: ${rows(join(a.dataDir, 'engram.db'), 'SELECT body FROM notes')[0].body}`);
      await work();
      events.push(`resume ${slug}: ${rows(join(a.dataDir, 'engram.db'), 'SELECT body FROM notes')[0].body}`);
    }
  });
  const { id } = (await service.runAll()).taken[0];
  const db = new DatabaseSync(join(a.dataDir, 'engram.db'));
  db.exec("UPDATE notes SET body = 'new'");
  db.close();
  await service.restoreBrain('a', id);
  assert.deepEqual(events, ['quiesce a: new', 'resume a: old']);
});

test('restore: unknown brain, unknown or malformed snapshot and a corrupt snapshot are refused, the brain untouched', async () => {
  const a = brainWithNotes('refuse', ['keep me']);
  a.db.close();
  const backupDir = scratch('backups');
  let quiesced = 0;
  const service = newService({ brains: [{ slug: 'a', dataDir: a.dataDir, cloudSync: false }], backupDir, quiesce: (_s, work) => { quiesced += 1; return work(); } });
  const { id } = (await service.runAll()).taken[0];
  await assert.rejects(service.restoreBrain('nope', id), /unknown brain/);
  await assert.rejects(service.restoreBrain('a', '../../gateway'), /snapshot/);
  await assert.rejects(service.restoreBrain('a', '20990101T000000000Z'), /no snapshot/);
  const enc = join(backupDir, 'brains', 'a', id, 'engram.db.enc');
  const bytes = readFileSync(enc);
  bytes[bytes.length - 40] ^= 0xff;
  writeFileSync(enc, bytes);
  await assert.rejects(service.restoreBrain('a', id), /authenticate/);
  assert.equal(quiesced, 0, 'the brain was never stopped');
  assert.deepEqual(rows(join(a.dataDir, 'engram.db'), 'SELECT body FROM notes').map(r => r.body), ['keep me']);
});

test('restore with a key that was rotated out fails; with BACKUP_PREVIOUS_KEY_FILES it works', async () => {
  const a = brainWithNotes('rot', ['rotated']);
  a.db.close();
  const backupDir = scratch('backups');
  const brains = [{ slug: 'a', dataDir: a.dataDir, cloudSync: false }];
  const { id } = (await newService({ brains, backupDir, cipher: createBackupCipher({ key: OTHER_KEY, previousKeys: [] }) }).runAll()).taken[0];
  await assert.rejects(newService({ brains, backupDir }).restoreBrain('a', id), /key/);
  await newService({ brains, backupDir, cipher: createBackupCipher({ key: KEY, previousKeys: [OTHER_KEY] }) }).restoreBrain('a', id);
});

// ---- registry quiesce hook ----

function fakeProcesses() {
  const made = [];
  return {
    made,
    create: brain => {
      const proc = { brain: brain.slug, closed: false, live: () => !proc.closed, close: async () => { proc.closed = true; } };
      made.push(proc);
      return proc;
    }
  };
}

test('registry.quiesce: stops the child, holds new requests until the work is done, then respawns lazily', async () => {
  const procs = fakeProcesses();
  const registry = new BrainRegistry({
    brains: new Map([['a', { slug: 'a', dataDir: '/x', cloudSync: false }]]), createProcess: procs.create,
    clock: { now: () => 0 }, idleTimeoutMs: 60_000, maxLiveBrains: 2, logger: quiet
  });
  (await registry.acquire('a')).release();
  let finish;
  let waiterGot;
  const running = registry.quiesce('a', () => new Promise(resolve => { finish = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(procs.made[0].closed, true, 'child stopped before the work runs');
  const waiter = registry.acquire('a').then(lease => { waiterGot = lease; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(waiterGot, undefined, 'requests wait while quiesced');
  assert.equal(procs.made.length, 1, 'no child spawned while quiesced');
  finish('done');
  assert.equal(await running, 'done');
  await waiter;
  assert.equal(procs.made.length, 2, 'next request starts a new child');
  waiterGot.release();
  await registry.stopAll();
});

test('registry.quiesce: a failing work still releases the brain', async () => {
  const procs = fakeProcesses();
  const registry = new BrainRegistry({
    brains: new Map([['a', { slug: 'a', dataDir: '/x', cloudSync: false }]]), createProcess: procs.create,
    clock: { now: () => 0 }, idleTimeoutMs: 60_000, maxLiveBrains: 2, logger: quiet
  });
  await assert.rejects(registry.quiesce('a', async () => { throw new Error('boom'); }), /boom/);
  (await registry.acquire('a')).release();
  assert.equal(procs.made.length, 1);
  await registry.stopAll();
});

// ---- control socket ----

test('control socket: the CLI reaches the running gateway; errors come back as errors; socket is private', async () => {
  const dir = scratch('sock');
  const socketPath = join(dir, 'control.sock');
  const calls = [];
  const server = await serveBackupControl(socketPath, {
    runAll: async () => { calls.push('runAll'); return { taken: [], skipped: [], failed: [] }; },
    listAll: () => ({ 'brains/a': ['20261119T030000000Z'] }),
    restoreBrain: async (slug, id) => { calls.push(`restore ${slug} ${id}`); if (slug === 'bad') throw new Error('unknown brain: bad'); }
  }, quiet);
  try {
    assert.equal(statSync(socketPath).mode & 0o777, 0o600);
    assert.deepEqual(await callBackupControl(socketPath, { op: 'list' }), { 'brains/a': ['20261119T030000000Z'] });
    assert.deepEqual(await callBackupControl(socketPath, { op: 'backup' }), { taken: [], skipped: [], failed: [] });
    await callBackupControl(socketPath, { op: 'restore', brain: 'a', snapshot: 's' });
    await assert.rejects(callBackupControl(socketPath, { op: 'restore', brain: 'bad', snapshot: 's' }), /unknown brain: bad/);
    await assert.rejects(callBackupControl(socketPath, { op: 'nope' }), /unknown/);
    assert.deepEqual(calls, ['runAll', 'restore a s', 'restore bad s']);
  } finally {
    await server.close();
  }
  assert.equal(await callBackupControl(socketPath, { op: 'list' }).catch(error => error.code), 'ENOENT', 'no gateway: the CLI can tell');
});

// ---- pinned: the gateway database location rule moved from main.ts to config.ts, unchanged ----

test('gateway db path: GATEWAY_DB_PATH, else $GATEWAY_DATA_DIR/gateway.db, else in memory', async () => {
  const { resolveGatewayDbPath } = await import('../../dist/config.js');
  assert.equal(resolveGatewayDbPath({ GATEWAY_DB_PATH: ' /x/state.db ', GATEWAY_DATA_DIR: '/d' }), '/x/state.db');
  assert.equal(resolveGatewayDbPath({ GATEWAY_DATA_DIR: '/d/' }), '/d/gateway.db');
  assert.equal(resolveGatewayDbPath({}), ':memory:');
});
