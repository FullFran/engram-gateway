import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  BRAIN_LOCK_FILE, BackupService, callBackupControl, createBackupCipher, expiredSnapshots, integrityCheck, nextRunAt, openBrainLock,
  parseBackupKey, parseSnapshotId, resolveBackupConfig, serveBackupControl, snapshotDatabase, sqliteSnapshotter
} from '../../dist/backup/index.js';
import { BrainRegistry } from '../../dist/brains/index.js';
import { runCli } from '../../dist/cli/backup-commands.js';

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

function newService({ brains, backupDir = scratch('backups'), retention = 14, gatewayDbPath, quiesce, clock = steppingClock(), cipher, fs } = {}) {
  return new BackupService({
    backupDir,
    retention,
    cipher: cipher ?? createBackupCipher({ key: KEY, previousKeys: [] }),
    brains: () => brains,
    ...(gatewayDbPath ? { gatewayDbPath } : {}),
    quiesce: quiesce ?? ((_slug, work) => work()),
    clock,
    logger: quiet,
    snapshotter: sqliteSnapshotter,
    ...(fs ? { fs } : {})
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
      assert.equal(await integrityCheck(out), 'ok');
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

test('restore round trip: save, back up, delete, restore, memory is back (old WAL files moved aside, not replayed)', async () => {
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
  const [pre] = readdirSync(a.dataDir).filter(f => f.startsWith('.pre-restore-'));
  assert.ok(pre, 'the previous files are kept aside');
  assert.deepEqual(readdirSync(join(a.dataDir, pre)).sort(), ['engram.db-shm', 'engram.db-wal']);
  assert.equal(readFileSync(join(a.dataDir, pre, 'engram.db-wal'), 'utf8'), 'stale wal from the old file');
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


// ---- review follow-ups ----

/** A separate process holding the gateway's shared lock on `dataDir` until killed. */
async function gatewayHoldingLock(dataDir) {
  const holder = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', `
    const { openBrainLock } = await import(${JSON.stringify(new URL('../../dist/backup/index.js', import.meta.url).href)});
    openBrainLock(${JSON.stringify(dataDir)});
    process.stdout.write('held\\n');
    setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(resolve => holder.stdout.once('data', resolve));
  return holder;
}

function cliEnv(dataDir, backupDir) {
  const keyFile = join(scratch('clikey'), 'key');
  writeFileSync(keyFile, KEY.toString('base64'));
  return { HOME: scratch('home'), ENGRAM_DATA_DIR: dataDir, BACKUP_DIR: backupDir, BACKUP_KEY_FILE: keyFile };
}

test('F1 CLI: with no control socket, restore refuses unless --offline; backup and list still run offline', async () => {
  const a = brainWithNotes('cli', ['v1']);
  a.db.close();
  const backupDir = scratch('backups');
  const env = cliEnv(a.dataDir, backupDir);
  const out = [];
  assert.equal(await runCli(['backup', 'now'], env, t => out.push(t)), 0);
  const [id] = JSON.parse(await (async () => { const o = []; await runCli(['backup', 'list'], env, t => o.push(t)); return o.join(''); })())['brains/default'];
  const db = new DatabaseSync(join(a.dataDir, 'engram.db'));
  db.exec("UPDATE notes SET body = 'v2'");
  db.close();
  await assert.rejects(runCli(['restore', 'default', id], env, () => {}), /no running gateway.*--offline/s);
  assert.deepEqual(rows(join(a.dataDir, 'engram.db'), 'SELECT body FROM notes').map(r => r.body), ['v2'], 'brain untouched');
  assert.equal(await runCli(['restore', 'default', id, '--offline'], env, () => {}), 0);
  assert.deepEqual(rows(join(a.dataDir, 'engram.db'), 'SELECT body FROM notes').map(r => r.body), ['v1']);
});

test('F1 CLI: restore --offline refuses while a gateway process holds the brain', async () => {
  const a = brainWithNotes('cli-live', ['v1']);
  a.db.close();
  const backupDir = scratch('backups');
  const env = cliEnv(a.dataDir, backupDir);
  await runCli(['backup', 'now'], env, () => {});
  const [id] = readdirSync(join(backupDir, 'brains', 'default'));
  const holder = await gatewayHoldingLock(a.dataDir);
  try {
    await assert.rejects(runCli(['restore', 'default', id, '--offline'], env, () => {}), /gateway is running/);
    assert.deepEqual(readdirSync(a.dataDir).filter(f => f.startsWith('.pre-restore-')), [], 'nothing moved');
  } finally {
    holder.kill();
  }
});

test('F1 lock: the gateway takes the exclusive lock for a restore only when no other gateway holds the brain', async () => {
  const dir = scratch('lock');
  const lock = openBrainLock(dir);
  assert.ok(existsSync(join(dir, BRAIN_LOCK_FILE)));
  assert.equal(await lock.withExclusive(async () => 'alone'), 'alone');
  const other = await gatewayHoldingLock(dir);
  try {
    await assert.rejects(lock.withExclusive(async () => 'never'), /another gateway/);
  } finally {
    other.kill();
    await new Promise(resolve => other.once('exit', resolve));
  }
  assert.equal(await lock.withExclusive(async () => 'again'), 'again', 'shared lock was taken back after the refusal');
  lock.close();
});

test('F1 socket: a second gateway takes the socket over without unlinking blindly; closing the old one keeps the new socket', async () => {
  const dir = scratch('sock2');
  const socketPath = join(dir, 'control.sock');
  const handlers = name => ({ runAll: async () => name, listAll: () => name, restoreBrain: async () => {} });
  const first = await serveBackupControl(socketPath, handlers('first'), quiet);
  const second = await serveBackupControl(socketPath, handlers('second'), quiet);
  assert.equal(await callBackupControl(socketPath, { op: 'list' }), 'second');
  await first.close();
  assert.equal(await callBackupControl(socketPath, { op: 'list' }), 'second', 'the old instance did not delete the live socket');
  await second.close();
  assert.equal(existsSync(socketPath), false, 'the owner removes its own socket');
});

test('F2 restore: an injected failure midway leaves the old brain intact', async () => {
  const dataDir = scratch('atomic');
  for (const [file, body] of [['engram.db', 'old engram'], ['wiki.db', 'old wiki']]) {
    sqliteFile(join(dataDir, file), d => { d.exec('CREATE TABLE t (v TEXT)'); d.prepare('INSERT INTO t VALUES (?)').run(body); }).close();
  }
  const brains = [{ slug: 'a', dataDir, cloudSync: false }];
  const backupDir = scratch('backups');
  const { id } = (await newService({ brains, backupDir }).runAll()).taken[0];
  for (const file of ['engram.db', 'wiki.db']) {
    const d = new DatabaseSync(join(dataDir, file));
    d.exec("UPDATE t SET v = 'current'");
    d.close();
  }
  writeFileSync(join(dataDir, 'vectors.db'), 'not in the snapshot');
  let placed = 0;
  const { rename } = await import('node:fs/promises');
  const fs = {
    rename: async (from, to) => {
      if (from.includes('.restore-') && ++placed === 2) throw new Error('injected failure');
      return rename(from, to);
    }
  };
  await assert.rejects(newService({ brains, backupDir, fs }).restoreBrain('a', id), /injected failure/);
  for (const file of ['engram.db', 'wiki.db']) assert.deepEqual(rows(join(dataDir, file), 'SELECT v FROM t').map(r => r.v), ['current'], file);
  assert.equal(readFileSync(join(dataDir, 'vectors.db'), 'utf8'), 'not in the snapshot');
  assert.deepEqual(readdirSync(dataDir).filter(f => f.startsWith('.')), [], 'no staging or empty pre-restore dir left');
});

test('F2 restore: files absent from the snapshot are moved aside too', async () => {
  const a = brainWithNotes('absent', ['n']);
  a.db.close();
  const brains = [{ slug: 'a', dataDir: a.dataDir, cloudSync: false }];
  const service = newService({ brains });
  const { id } = (await service.runAll()).taken[0];
  writeFileSync(join(a.dataDir, 'vectors.db'), 'index built after the snapshot');
  await service.restoreBrain('a', id);
  assert.equal(existsSync(join(a.dataDir, 'vectors.db')), false);
  const [pre] = readdirSync(a.dataDir).filter(f => f.startsWith('.pre-restore-'));
  const aside = readdirSync(join(a.dataDir, pre));
  for (const file of ['engram.db', 'vectors.db']) assert.ok(aside.includes(file), `${file} moved aside: ${aside}`);
});

test('F3 snapshot: the event loop keeps running while a multi-MB database is copied', async () => {
  const dir = scratch('big');
  const path = join(dir, 'engram.db');
  sqliteFile(path, d => {
    d.exec('CREATE TABLE blobs (b BLOB)');
    const ins = d.prepare('INSERT INTO blobs VALUES (?)');
    d.exec('BEGIN');
    for (let i = 0; i < 1500; i++) ins.run(randomBytes(32 * 1024));
    d.exec('COMMIT');
  }).close();
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 2);
  const started = Date.now();
  try {
    await snapshotDatabase(path, join(dir, 'copy.db'));
    assert.equal(await integrityCheck(join(dir, 'copy.db')), 'ok');
  } finally {
    clearInterval(timer);
  }
  const elapsed = Date.now() - started;
  assert.ok(ticks >= Math.min(5, Math.floor(elapsed / 10)), `event loop ticked ${ticks} times in ${elapsed} ms`);
  assert.ok(ticks >= 3, `event loop ticked ${ticks} times in ${elapsed} ms`);
});

test('F5 socket: oversized requests and idle connections are dropped; the server keeps serving', async () => {
  const dir = scratch('sock5');
  const socketPath = join(dir, 'control.sock');
  const server = await serveBackupControl(socketPath, { runAll: async () => 1, listAll: () => 'ok', restoreBrain: async () => {} }, quiet, { idleTimeoutMs: 100 });
  const { connect } = await import('node:net');
  try {
    const oversize = await new Promise(resolve => {
      const s = connect(socketPath);
      let got = '';
      s.on('data', c => { got += c; });
      s.on('close', () => resolve(got));
      s.on('error', () => {});
      s.on('connect', () => s.write('x'.repeat(10_000)));
    });
    assert.equal(oversize, '', 'no answer to an oversized request');
    const idleClosed = await new Promise(resolve => {
      const s = connect(socketPath);
      const t = setTimeout(() => resolve(false), 2000);
      s.on('close', () => { clearTimeout(t); resolve(true); });
      s.on('error', () => {});
    });
    assert.equal(idleClosed, true, 'an idle connection is closed');
    assert.equal(await callBackupControl(socketPath, { op: 'list' }), 'ok');
  } finally {
    await server.close();
  }
});

test('F5 socket: a path longer than the Unix socket limit fails with a clear error', async () => {
  const long = join(scratch('long'), 'x'.repeat(120), 'control.sock');
  await assert.rejects(serveBackupControl(long, { runAll: async () => 1, listAll: () => 1, restoreBrain: async () => {} }, quiet), /socket path is too long/);
  await assert.rejects(callBackupControl(long, { op: 'list' }), error => error.code === 'ENAMETOOLONG' && /too long/.test(error.message));
});

test('F6 startup: stale partial snapshots (plaintext) are removed in every unit', async () => {
  const backupDir = scratch('backups');
  for (const unit of ['brains/a', 'gateway']) {
    mkdirSync(join(backupDir, unit, '20200101T000000000Z.partial'), { recursive: true });
    writeFileSync(join(backupDir, unit, '20200101T000000000Z.partial', 'engram.db.plain'), 'plaintext');
    mkdirSync(join(backupDir, unit, '20200101T000000000Z'), { recursive: true });
  }
  const service = newService({ brains: [{ slug: 'a', dataDir: scratch('a'), cloudSync: false }], backupDir });
  assert.deepEqual((await service.removeStalePartials()).sort(), ['brains/a/20200101T000000000Z.partial', 'gateway/20200101T000000000Z.partial']);
  assert.deepEqual(readdirSync(join(backupDir, 'brains', 'a')), ['20200101T000000000Z']);
  assert.deepEqual(readdirSync(join(backupDir, 'gateway')), ['20200101T000000000Z']);
});

test('F7 cipher: a destination that already exists is refused and left untouched', async () => {
  const dir = scratch('f7');
  writeFileSync(join(dir, 'plain'), 'p');
  writeFileSync(join(dir, 'existing'), 'precious');
  const cipher = createBackupCipher({ key: KEY, previousKeys: [] });
  await assert.rejects(cipher.encryptFile(join(dir, 'plain'), join(dir, 'existing'), 'gateway/gateway.db'), /EEXIST/);
  assert.equal(readFileSync(join(dir, 'existing'), 'utf8'), 'precious');
  await cipher.encryptFile(join(dir, 'plain'), join(dir, 'enc'), 'gateway/gateway.db');
  await assert.rejects(cipher.decryptFile(join(dir, 'enc'), join(dir, 'existing'), 'gateway/gateway.db'), /EEXIST/);
  assert.equal(readFileSync(join(dir, 'existing'), 'utf8'), 'precious');
});

test('F8 retention: ids are parsed to timestamps; expiry keeps the newest by time', () => {
  assert.equal(parseSnapshotId('20261119T030000123Z'), Date.UTC(2026, 10, 19, 3, 0, 0, 123));
  assert.equal(parseSnapshotId('20261319T030000123Z'), undefined, 'month 13');
  assert.equal(parseSnapshotId('nope'), undefined);
  assert.deepEqual(expiredSnapshots(['20261119T030000000Z', '20251119T030000000Z', '20261118T030000000Z'], 2), ['20251119T030000000Z']);
});
