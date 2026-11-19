#!/usr/bin/env node

// End-to-end check of encrypted backups (#11) against a real `dist/main.js`
// gateway and real `engram mcp` children:
//   - backups on without BACKUP_KEY_FILE: the gateway refuses to start
//   - save a memory, `backup now` through the CLI (control socket of the
//     running gateway), the snapshot is encrypted at rest
//   - delete the memory, `restore <brain> <snapshot>` while the gateway runs:
//     the brain's child is stopped, the file swapped, the memory is back
//   - retention keeps exactly BACKUP_RETENTION snapshots
//   - the socket deleted under a live gateway: restore refuses (with or
//     without --offline: the gateway holds the brain's lock)
//   - with the gateway stopped the CLI runs offline (list, restore --offline, decrypt)
//   - the key never appears in any output
// Scratch state lives outside the repository and is removed on success.

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { assert, assertEqual, mcpCall, repoRoot, startGateway, waitFor } from './lib/harness.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'engram-gateway-backup-'));
let passed = 0;
const ok = label => { passed += 1; console.log(`  ok - ${label}`); };

const key = randomBytes(32).toString('base64');
const keyFile = join(scratch, 'backup.key');
writeFileSync(keyFile, `${key}\n`, { mode: 0o600 });
const backupDir = join(scratch, 'backups');
const env = {
  BRAINS_ROOT: join(scratch, 'brains'), BRAINS: 'alpha', GATEWAY_DATA_DIR: join(scratch, 'gateway'),
  BACKUP_DIR: backupDir, BACKUP_KEY_FILE: keyFile, BACKUP_SCHEDULE: 'off', BACKUP_RETENTION: '2'
};
const outputs = [];

function cli(...args) {
  const childEnv = { ...process.env, HOME: join(scratch, 'home'), ...env };
  for (const name of Object.keys(childEnv)) if (name.startsWith('ENGRAM_CLOUD_')) delete childEnv[name];
  return new Promise(resolve => {
    execFile(process.execPath, [join(repoRoot, 'dist', 'cli.js'), ...args], { env: childEnv }, (error, stdout, stderr) => {
      outputs.push(stdout, stderr);
      resolve({ code: error ? error.code : 0, stdout, stderr });
    });
  });
}

const memoryText = response => JSON.stringify(response.result?.result?.content ?? response.text);

try {
  // ---- missing key fails loudly at start ----
  const noKey = await startGateway(scratch, { ...env, BACKUP_KEY_FILE: '' }, { wait: false });
  await waitFor(() => noKey.child.exitCode !== null, 10000, 'gateway without a backup key exits');
  assertEqual(noKey.child.exitCode, 1, 'exit code without BACKUP_KEY_FILE');
  assert(noKey.output().includes('BACKUP_KEY_FILE'), `startup error names BACKUP_KEY_FILE: ${noKey.output()}`);
  ok('backups on without a key: startup fails naming BACKUP_KEY_FILE');

  const gateway = await startGateway(scratch, env);
  outputs.push(gateway.output);
  const marker = `backup-e2e-${Date.now()}-${randomBytes(3).toString('hex')}`;
  const saved = await mcpCall(gateway.base, '/mcp/alpha', 'mem_save', { title: `Backup ${marker}`, content: `Remember ${marker}`, type: 'discovery' });
  const { id: obsId, project } = JSON.parse(/\{"id":.*\}/.exec(saved.result.result.content[0].text)[0]);
  const search = async () => memoryText(await mcpCall(gateway.base, '/mcp/alpha', 'mem_search', { query: marker }));
  assert((await search()).includes(`Remember ${marker}`), 'saved memory is found');
  ok('memory saved in brain alpha');

  // ---- backup through the running gateway ----
  const now = await cli('backup', 'now');
  assertEqual(now.code, 0, `backup now: ${now.stderr}`);
  const report = JSON.parse(now.stdout);
  const units = report.taken.map(t => t.unit).sort();
  assert(units.includes('brains/alpha') && units.includes('gateway') && units.includes('brains/default'), `units backed up: ${units}`);
  assert(!now.stderr.includes('offline'), 'went through the running gateway');
  const snapshot = report.taken.find(t => t.unit === 'brains/alpha').id;
  const encrypted = readFileSync(join(backupDir, 'brains', 'alpha', snapshot, 'engram.db.enc'));
  assert(!encrypted.includes(marker) && !encrypted.includes('SQLite format 3'), 'snapshot is encrypted at rest');
  ok(`backup now via the control socket: ${units.join(', ')}`);

  // ---- delete, restore while live, memory is back ----
  const deleted = await mcpCall(gateway.base, '/mcp/alpha', 'mem_delete', { id: obsId, expected_project: project, hard_delete: true });
  assert(!deleted.result?.result?.isError, `mem_delete: ${memoryText(deleted)}`);
  const afterDelete = await search();
  assert(!afterDelete.includes(`Remember ${marker}`), `memory is gone after delete: ${afterDelete.slice(0, 400)}`);
  const restored = await cli('restore', 'alpha', snapshot);
  assertEqual(restored.code, 0, `restore: ${restored.stderr}`);
  assert(!restored.stderr.includes('offline'), 'the running gateway did the restore');
  assert((await search()).includes(`Remember ${marker}`), 'memory is back after restore');
  ok('save, back up, delete, restore (gateway running), memory is back');

  // ---- retention ----
  for (let i = 0; i < 2; i++) assertEqual((await cli('backup', 'now')).code, 0, 'backup now');
  assertEqual(readdirSync(join(backupDir, 'brains', 'alpha')).length, 2, 'snapshots of alpha kept');
  const listed = JSON.parse((await cli('backup', 'list')).stdout);
  assertEqual(listed['brains/alpha'].length, 2, 'backup list shows the kept snapshots');
  ok('retention keeps exactly BACKUP_RETENTION=2 snapshots');

  // ---- a live gateway whose socket is gone: no blind offline restore ----
  rmSync(join(backupDir, 'control.sock'));
  const kept = listed['brains/alpha'].at(-1);
  const noSocket = await cli('restore', 'alpha', kept);
  assert(noSocket.code !== 0 && noSocket.stderr.includes('--offline'), `restore without socket refuses: ${noSocket.stderr}`);
  const forced = await cli('restore', 'alpha', kept, '--offline');
  assert(forced.code !== 0 && forced.stderr.includes('a gateway is running'), `--offline refuses under a live gateway: ${forced.stderr}`);
  assert((await search()).includes(`Remember ${marker}`), 'the live brain was not touched');
  ok('socket removed under a live gateway: restore refuses, --offline refuses too (brain lock)');

  await gateway.stop();

  // ---- offline CLI ----
  const offlineList = await cli('backup', 'list');
  assert(offlineList.stderr.includes('offline'), 'list runs offline with no gateway');
  assertEqual(JSON.parse(offlineList.stdout)['brains/alpha'].length, 2, 'offline list');
  const latest = listed['brains/alpha'].at(-1);
  const offlineRestore = await cli('restore', 'alpha', latest, '--offline');
  assertEqual(offlineRestore.code, 0, `offline restore: ${offlineRestore.stderr}`);
  const restoredDb = new DatabaseSync(join(env.BRAINS_ROOT, 'alpha', 'engram.db'), { readOnly: true });
  const found = restoredDb.prepare('SELECT COUNT(*) AS n FROM observations WHERE content LIKE ?').get(`%${marker}%`).n;
  restoredDb.close();
  assertEqual(found, 1, 'offline restore brings the memory back');
  const gwSnapshot = listed.gateway.at(-1);
  const out = join(scratch, 'gateway-restored.db');
  const decrypted = await cli('backup', 'decrypt', join(backupDir, 'gateway', gwSnapshot, 'gateway.db.enc'), out);
  assertEqual(decrypted.code, 0, `decrypt: ${decrypted.stderr}`);
  const gw = new DatabaseSync(out, { readOnly: true });
  assertEqual(gw.prepare('PRAGMA integrity_check').get().integrity_check, 'ok', 'decrypted gateway db integrity');
  assert(gw.prepare("SELECT slug FROM brains WHERE slug = 'alpha'").get(), 'decrypted gateway db holds the brains table');
  gw.close();
  ok('offline: list, restore and decrypt of the gateway database');

  // ---- the key never leaks ----
  const all = outputs.map(o => (typeof o === 'function' ? o() : o)).join('\n');
  assert(!all.includes(key) && !all.includes(Buffer.from(key, 'base64').toString('hex')), 'key never printed');
  ok('the key appears in no output');

  rmSync(scratch, { recursive: true, force: true });
  console.log(`check-backup: ${passed} passed`);
} catch (error) {
  console.error(`check-backup: FAILED: ${error.message}\nscratch kept: ${scratch}`);
  process.exit(1);
}
