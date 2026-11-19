import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { openGatewayDatabase } from '../../dist/shared/gateway-database.js';
import {
  BrainCapacityError, BrainRegistry, DEFAULT_BRAIN, SqliteBrainRepository, bootstrapBrains, brainDataDir, buildChildEnv,
  cloudSyncWarning, parseBrainSlug, resolveBrainsConfig
} from '../../dist/brains/index.js';
import { createEngramBridge } from '../../dist/bridge/index.js';

const scratchRoot = mkdtempSync(join(tmpdir(), 'brains-test-'));
const scratch = name => mkdtempSync(join(scratchRoot, `${name}-`));
after(() => rmSync(scratchRoot, { recursive: true, force: true }));
const quiet = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(l => [l, () => {}]));

// ---- slug ----

test('slugs: lowercase letters, digits and dashes, 1-40 chars, not starting with a dash', () => {
  for (const good of ['a', 'default', 'work-notes', '0', 'a'.repeat(40), 'x-1-y']) assert.deepEqual(parseBrainSlug(good), { ok: true, slug: good });
  for (const bad of ['', 'A', 'Work', '-a', 'a_b', 'a.b', '../x', 'a/b', ' a', 'a'.repeat(41), 'ñ']) assert.equal(parseBrainSlug(bad).ok, false, bad);
});

test('slugs: reserved words are rejected', () => {
  for (const reserved of ['admin', 'api', 'health', 'mcp', 'oauth', 'well-known']) assert.equal(parseBrainSlug(reserved).ok, false, reserved);
});

test('data dir stays under the brains root', () => {
  assert.equal(brainDataDir('/data/brains', 'work'), '/data/brains/work');
  assert.throws(() => brainDataDir('/data/brains', '..'), /invalid brain slug/);
});

// ---- config ----

test('config: defaults and parsing', () => {
  const config = resolveBrainsConfig({ HOME: '/home/u' });
  assert.deepEqual(config, { brainsRoot: undefined, defaultDataDir: '/home/u/.engram', seed: [], cloud: [], idleTimeoutMs: 600_000, maxLiveBrains: 10 });
  const full = resolveBrainsConfig({ HOME: '/h', BRAINS_ROOT: ' /data/brains ', BRAINS: ' work, notes ,work', ENGRAM_CLOUD_BRAINS: 'default', BRAIN_IDLE_TIMEOUT: '30', MAX_LIVE_BRAINS: '2' });
  assert.deepEqual(full, { brainsRoot: '/data/brains', defaultDataDir: '/data/brains/default', seed: ['work', 'notes'], cloud: ['default'], idleTimeoutMs: 30_000, maxLiveBrains: 2 });
  assert.equal(resolveBrainsConfig({ HOME: '/h', BRAINS_ROOT: '/r', ENGRAM_DATA_DIR: '/legacy/engram' }).defaultDataDir, '/legacy/engram');
});

test('config: invalid values fail loudly', () => {
  assert.throws(() => resolveBrainsConfig({ HOME: '/h', BRAINS_ROOT: '/r', BRAINS: 'Work' }), /BRAINS.*"Work"/);
  assert.throws(() => resolveBrainsConfig({ HOME: '/h', BRAINS_ROOT: '/r', BRAINS: 'admin' }), /reserved/);
  assert.throws(() => resolveBrainsConfig({ HOME: '/h', BRAINS: 'work' }), /BRAINS_ROOT/);
  assert.throws(() => resolveBrainsConfig({ HOME: '/h', BRAINS_ROOT: 'relative' }), /BRAINS_ROOT.*absolute/);
  assert.throws(() => resolveBrainsConfig({ HOME: '/h', BRAIN_IDLE_TIMEOUT: '0' }), /BRAIN_IDLE_TIMEOUT/);
  assert.throws(() => resolveBrainsConfig({ HOME: '/h', MAX_LIVE_BRAINS: 'many' }), /MAX_LIVE_BRAINS/);
  assert.throws(() => resolveBrainsConfig({ HOME: '/h', ENGRAM_CLOUD_BRAINS: 'BAD' }), /ENGRAM_CLOUD_BRAINS/);
});

test('config: a startup warning when ENGRAM_CLOUD_* is set but no brain opted in', () => {
  const env = { HOME: '/h', ENGRAM_CLOUD_TOKEN: 't', ENGRAM_CLOUD_SERVER: 'https://cloud.example' };
  const warning = cloudSyncWarning(env, resolveBrainsConfig(env));
  assert.match(warning, /ENGRAM_CLOUD_SERVER, ENGRAM_CLOUD_TOKEN/);
  assert.match(warning, /ENGRAM_CLOUD_BRAINS/);
  assert.match(warning, /ENGRAM_CLOUD_BRAINS=default/);
  assert.equal(warning.includes('https://cloud.example') || warning.includes("'t'"), false, 'never prints values');
  assert.equal(cloudSyncWarning({ HOME: '/h' }, resolveBrainsConfig({ HOME: '/h' })), undefined, 'no cloud vars, no warning');
  assert.equal(cloudSyncWarning({ HOME: '/h', ENGRAM_CLOUD_TOKEN: '' }, resolveBrainsConfig({ HOME: '/h' })), undefined, 'empty values (compose defaults) do not count');
  const optedIn = { ...env, ENGRAM_CLOUD_BRAINS: 'default' };
  assert.equal(cloudSyncWarning(optedIn, resolveBrainsConfig(optedIn)), undefined, 'opted in, no warning');
});

// ---- bootstrap against the gateway database ----

function repo() {
  const db = openGatewayDatabase(join(scratch('db'), 'gateway.db'));
  return { db, repo: new SqliteBrainRepository(db) };
}

test('bootstrap creates default and seeded brains in the brains table', () => {
  const { db, repo: brains } = repo();
  const config = resolveBrainsConfig({ HOME: '/h', BRAINS_ROOT: '/data/brains', BRAINS: 'work' });
  const result = bootstrapBrains(brains, config, quiet);
  assert.deepEqual(result.map(b => [b.slug, b.dataDir, b.cloudSync]), [['default', '/data/brains/default', false], ['work', '/data/brains/work', false]]);
  const rows = db.prepare('SELECT slug, data_dir, cloud_sync FROM brains ORDER BY slug').all();
  assert.deepEqual(rows.map(r => ({ ...r })), [{ slug: 'default', data_dir: '/data/brains/default', cloud_sync: 0 }, { slug: 'work', data_dir: '/data/brains/work', cloud_sync: 0 }]);
  db.close();
});

test('bootstrap never deletes a brain and never changes an existing data dir', () => {
  const { db, repo: brains } = repo();
  bootstrapBrains(brains, resolveBrainsConfig({ HOME: '/h', BRAINS_ROOT: '/old', BRAINS: 'work,notes' }), quiet);
  const warnings = [];
  const logger = { ...quiet, warn: (m, f) => warnings.push({ m, f }) };
  const again = bootstrapBrains(brains, resolveBrainsConfig({ HOME: '/h', BRAINS_ROOT: '/new', BRAINS: 'work' }), logger);
  assert.deepEqual(again.map(b => [b.slug, b.dataDir]), [['default', '/old/default'], ['notes', '/old/notes'], ['work', '/old/work']]);
  assert.ok(warnings.some(w => /data directory/.test(w.m) && w.f.brain === 'default'), 'a changed data dir is reported, not applied');
  db.close();
});

test('bootstrap: ENGRAM_CLOUD_BRAINS is the only source of the cloud flag (on for listed, off for the rest)', () => {
  const { db, repo: brains } = repo();
  let result = bootstrapBrains(brains, resolveBrainsConfig({ HOME: '/h', BRAINS_ROOT: '/r', BRAINS: 'work', ENGRAM_CLOUD_BRAINS: 'default' }), quiet);
  assert.deepEqual(result.map(b => [b.slug, b.cloudSync]), [['default', true], ['work', false]]);
  result = bootstrapBrains(brains, resolveBrainsConfig({ HOME: '/h', BRAINS_ROOT: '/r' }), quiet);
  assert.deepEqual(result.map(b => [b.slug, b.cloudSync]), [['default', false], ['work', false]]);
  assert.throws(() => bootstrapBrains(brains, resolveBrainsConfig({ HOME: '/h', BRAINS_ROOT: '/r', ENGRAM_CLOUD_BRAINS: 'ghost' }), quiet), /ENGRAM_CLOUD_BRAINS.*ghost/);
  db.close();
});

test('bootstrap rejects a stored row with an invalid slug', () => {
  const { db, repo: brains } = repo();
  db.prepare("INSERT INTO brains (slug, data_dir) VALUES ('../evil', '/tmp/evil')").run();
  assert.throws(() => bootstrapBrains(brains, resolveBrainsConfig({ HOME: '/h' }), quiet), /invalid brain slug.*\.\.\/evil/);
  db.close();
});

// ---- child environment ----

const POISONED = {
  PATH: '/usr/bin:/bin', HOME: '/home/gw', ENGRAM_PROJECT: 'proj', ENGRAM_DATA_DIR: '/gateway/own/dir',
  ENGRAM_CLOUD_SERVER: 'https://cloud.example', ENGRAM_CLOUD_TOKEN: 'cloud-secret', ENGRAM_CLOUD_AUTOSYNC: '1',
  GITHUB_CLIENT_SECRET: 'gh-secret', AUTH_SECRET: 'auth-secret', FOO: 'bar', NODE_OPTIONS: '--require /tmp/x.js'
};

test('child env: allowlist only, cloud vars only for an opted-in brain', () => {
  const brain = { slug: 'work', dataDir: '/data/brains/work', cloudSync: false };
  assert.deepEqual(buildChildEnv(brain, POISONED), { ENGRAM_DATA_DIR: '/data/brains/work', HOME: '/home/gw', PATH: '/usr/bin:/bin', ENGRAM_PROJECT: 'proj' });
  assert.deepEqual(buildChildEnv({ ...brain, cloudSync: true }, POISONED), {
    ENGRAM_DATA_DIR: '/data/brains/work', HOME: '/home/gw', PATH: '/usr/bin:/bin', ENGRAM_PROJECT: 'proj',
    ENGRAM_CLOUD_SERVER: 'https://cloud.example', ENGRAM_CLOUD_TOKEN: 'cloud-secret', ENGRAM_CLOUD_AUTOSYNC: '1'
  });
  assert.deepEqual(buildChildEnv(brain, {}), { ENGRAM_DATA_DIR: '/data/brains/work' });
});

const DUMP_ENV = fileURLToPath(new URL('../fixtures/fake-mcp-server.mjs', import.meta.url));

test('a spawned child sees only the allowlisted env, even with a poisoned gateway env', async () => {
  const dir = scratch('env');
  const dump = join(dir, 'env.json');
  const brain = { slug: 'work', dataDir: dir, cloudSync: false };
  const saved = { ...process.env };
  Object.assign(process.env, POISONED, { PATH: process.env.PATH });
  let env;
  try {
    env = buildChildEnv(brain, process.env);
  } finally {
    for (const key of Object.keys(POISONED)) delete process.env[key];
    Object.assign(process.env, saved);
  }
  const bridge = createEngramBridge({ command: process.execPath, args: [DUMP_ENV], env: { ...env, FAKE_ENV_FILE: dump }, logger: quiet });
  await bridge.start();
  await bridge.close();
  const seen = JSON.parse(readFileSync(dump, 'utf8'));
  // The MCP SDK always adds its fixed set of non-secret identity variables when present.
  const SDK_DEFAULTS = ['LOGNAME', 'SHELL', 'TERM', 'USER'];
  const allowed = new Set(['ENGRAM_DATA_DIR', 'HOME', 'PATH', 'ENGRAM_PROJECT', 'FAKE_ENV_FILE', ...SDK_DEFAULTS]);
  for (const key of Object.keys(seen)) assert.ok(allowed.has(key), `child saw ${key}`);
  assert.equal(seen.ENGRAM_DATA_DIR, dir);
  assert.equal(seen.ENGRAM_PROJECT, 'proj');
  for (const leaked of ['ENGRAM_CLOUD_TOKEN', 'ENGRAM_CLOUD_SERVER', 'GITHUB_CLIENT_SECRET', 'AUTH_SECRET', 'FOO', 'NODE_OPTIONS']) assert.equal(seen[leaked], undefined, leaked);
});

// ---- registry ----

function fakeClock(start = 1_000) {
  let now = start;
  return { now: () => now, advance: ms => { now += ms; } };
}

/** Fake processes; with `manualClose`, close() only finishes when the test calls `finishClose()`. */
function fakeProcesses({ manualClose = false } = {}) {
  const made = [];
  const create = brain => {
    let finish;
    const proc = {
      brain, closed: false, closeStarted: false,
      live: () => !proc.closed,
      close: () => {
        proc.closeStarted = true;
        if (!manualClose) { proc.closed = true; return Promise.resolve(); }
        return new Promise(resolve => { finish = () => { proc.closed = true; resolve(); }; });
      },
      finishClose: () => finish()
    };
    made.push(proc);
    return proc;
  };
  return { made, create };
}

const brainsByslug = slugs => new Map(slugs.map(slug => [slug, { slug, dataDir: `/b/${slug}`, cloudSync: false }]));
const tick = () => new Promise(resolve => setImmediate(resolve));

function newRegistry({ slugs = ['default', 'a', 'b', 'c'], max = 2, idle = 1000, manualClose = false } = {}) {
  const clock = fakeClock();
  const procs = fakeProcesses({ manualClose });
  const registry = new BrainRegistry({ brains: brainsByslug(slugs), createProcess: procs.create, clock, idleTimeoutMs: idle, maxLiveBrains: max, logger: quiet });
  return { clock, procs, registry };
}

test('registry: one process per brain, created on first acquire and reused', async () => {
  const { procs, registry } = newRegistry();
  assert.equal(registry.has('a'), true);
  assert.equal(registry.has('zzz'), false);
  assert.deepEqual(registry.stats(), { live: 0, idle: 0 });
  const first = await registry.acquire('a');
  const second = await registry.acquire('a');
  assert.equal(first.process, second.process);
  assert.equal(procs.made.length, 1);
  assert.deepEqual(registry.stats(), { live: 1, idle: 0 });
  first.release();
  second.release();
  second.release(); // idempotent
  assert.deepEqual(registry.stats(), { live: 1, idle: 1 });
  await assert.rejects(registry.acquire('zzz'), /unknown brain/);
});

test('registry: N concurrent first requests create exactly one process', async () => {
  const { procs, registry } = newRegistry();
  const leases = await Promise.all(Array.from({ length: 20 }, () => registry.acquire('a')));
  assert.equal(procs.made.length, 1);
  assert.ok(leases.every(lease => lease.process === procs.made[0]));
});

test('registry: idle processes are reaped after the timeout, busy ones never', async () => {
  const { clock, procs, registry } = newRegistry();
  (await registry.acquire('a')).release();
  const b = await registry.acquire('b');
  clock.advance(999);
  await registry.reap();
  assert.equal(procs.made[0].closed, false);
  clock.advance(1);
  await registry.reap();
  assert.equal(procs.made[0].closed, true, 'idle brain a reaped');
  assert.equal(procs.made[1].closed, false, 'busy brain b kept');
  assert.deepEqual(registry.stats(), { live: 1, idle: 0 });
  b.release();
  // A new acquire after reaping creates a fresh process.
  (await registry.acquire('a')).release();
  assert.equal(procs.made.length, 3);
});

test('registry: a brain being stopped is only started again once its old child has closed', async () => {
  const { clock, procs, registry } = newRegistry({ manualClose: true });
  (await registry.acquire('a')).release();
  clock.advance(1000);
  void registry.reap();
  assert.equal(procs.made[0].closeStarted, true);
  let acquired = false;
  const again = registry.acquire('a').then(lease => { acquired = true; return lease; });
  await tick();
  assert.equal(acquired, false, 'waits for the closing child');
  assert.equal(procs.made.length, 1, 'no second process on the same data dir while the first is closing');
  assert.deepEqual(registry.stats(), { live: 1, idle: 1 }, 'the closing child still counts as live');
  procs.made[0].finishClose();
  const lease = await again;
  assert.equal(procs.made.length, 2);
  assert.equal(lease.process, procs.made[1]);
});

test('registry: MAX_LIVE_BRAINS evicts the least recently used idle brain', async () => {
  const { clock, procs, registry } = newRegistry({ max: 2 });
  (await registry.acquire('a')).release();
  clock.advance(10);
  (await registry.acquire('b')).release();
  clock.advance(10);
  (await registry.acquire('a')).release(); // a is now the most recent
  clock.advance(10);
  (await registry.acquire('c')).release();
  assert.deepEqual(procs.made.map(p => [p.brain.slug, p.closed]), [['a', false], ['b', true], ['c', false]]);
});

test('registry: closing children count against MAX_LIVE_BRAINS', async () => {
  const { procs, registry } = newRegistry({ max: 2, manualClose: true });
  (await registry.acquire('a')).release();
  (await registry.acquire('b')).release();
  let started = false;
  const c = registry.acquire('c').then(lease => { started = true; return lease; });
  await tick();
  assert.equal(procs.made[0].closeStarted, true, 'the LRU idle brain a is being stopped');
  assert.equal(started, false, 'c waits until a has really exited');
  assert.equal(procs.made.length, 2);
  procs.made[0].finishClose();
  await c;
  assert.equal(procs.made.length, 3);
});

test('registry: at capacity with every brain busy, a new brain is refused', async () => {
  const { registry } = newRegistry({ max: 2 });
  await registry.acquire('a');
  await registry.acquire('b');
  await assert.rejects(registry.acquire('c'), BrainCapacityError);
  // An already-live brain is still served.
  (await registry.acquire('a')).release();
});

test('registry: stopAll closes every process and refuses new work', async () => {
  const { procs, registry } = newRegistry({ max: 3 });
  await registry.acquire('a');
  (await registry.acquire('b')).release();
  await registry.stopAll();
  assert.ok(procs.made.every(p => p.closed));
  assert.deepEqual(registry.stats(), { live: 0, idle: 0 });
  await assert.rejects(registry.acquire('a'), /stopped/);
});

test('registry: a process whose child died does not count as live', async () => {
  const { procs, registry } = newRegistry();
  (await registry.acquire('a')).release();
  procs.made[0].closed = true;
  assert.deepEqual(registry.stats(), { live: 0, idle: 0 });
});

test('registry + bridge: N concurrent first requests spawn exactly one engram child', async () => {
  const dir = scratch('spawns');
  const spawnLog = join(dir, 'spawns');
  const registry = new BrainRegistry({
    brains: brainsByslug(['a']),
    createProcess: () => createEngramBridge({ command: process.execPath, args: [DUMP_ENV], env: { FAKE_SPAWN_LOG: spawnLog }, logger: quiet }),
    clock: fakeClock(), idleTimeoutMs: 60_000, maxLiveBrains: 2, logger: quiet
  });
  try {
    const leases = await Promise.all(Array.from({ length: 10 }, () => registry.acquire('a')));
    await Promise.all(leases.map(lease => lease.process.factory({})));
    assert.equal(readFileSync(spawnLog, 'utf8').length, 1, 'one spawn');
    for (const lease of leases) lease.release();
  } finally {
    await registry.stopAll();
  }
});

test('DEFAULT_BRAIN is "default"', () => {
  assert.equal(DEFAULT_BRAIN, 'default');
});
