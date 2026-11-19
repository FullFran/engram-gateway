// Backups in the web panel (#17, #9): their status, and "Run now" for
// instance admins only, audited as `backup.run` (decision D3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uiApp, uiSetup } from './ui-fixture.mjs';

const admin = { kind: 'user', login: 'boss' };
const dev = { kind: 'user', login: 'dev' };
const runs = s => s.audit().filter(row => row.action === 'backup.run').map(row => [row.actor, row.outcome]);

test('runBackup: admins only; a run is audited as backup.run, error when a unit failed; refused without backups', async t => {
  const s = uiSetup(t);
  assert.deepEqual(await s.admin.runBackup(admin), s.backups.nextReport);
  s.backups.nextReport = { taken: [], skipped: [{ unit: 'brains/beta', reason: 'busy' }], failed: [{ unit: 'gateway', error: 'disk full' }] };
  await s.admin.runBackup(admin);
  await assert.rejects(s.admin.runBackup(dev), error => error.code === 'forbidden');
  assert.equal(s.backups.runs, 2, 'a refused run does nothing');
  assert.deepEqual(runs(s), [['boss', 'ok'], ['boss', 'error'], ['dev', 'denied']]);
  const [, failed] = s.audit().filter(row => row.action === 'backup.run');
  assert.equal(failed.outcome, 'error');
  const off = uiSetup(t, { backups: false });
  await assert.rejects(off.admin.runBackup(admin), error => error.code === 'invalid' && /BACKUP_DIR/.test(error.message));
  assert.equal(off.admin.backupStatus(admin), null);
});

test('backups page: schedule, retention and snapshots by unit; Run now shows the report; a non-admin runs nothing', async t => {
  const s = uiSetup(t);
  const { call, csrfOf } = await uiApp(t, s);
  const page = await call('/ui/backups', { as: 'boss' });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<a href="\/ui\/backups" aria-current="page">Backups<\/a>/);
  assert.match(html, /daily at 03:00 UTC/);
  assert.match(html, /<td>7<\/td>/);
  assert.match(html, /<code>gateway<\/code><\/th><td>2<\/td><td><code>20261118T030000000Z<\/code><\/td>/);
  assert.match(html, /<code>brains\/alpha<\/code><\/th><td>1<\/td>/);
  const csrf = await csrfOf('boss', '/ui/backups');
  const ran = await call('/ui/backups/run', { as: 'boss', method: 'POST', form: { csrf } });
  assert.equal(ran.status, 200);
  assert.match(await ran.text(), /role="status"[^>]*>Backup finished: 1 taken, 0 skipped, 0 failed/);
  assert.equal(s.backups.runs, 1);
  s.backups.nextReport = { taken: [], skipped: [], failed: [{ unit: 'gateway', error: 'disk <full>' }] };
  const failed = await (await call('/ui/backups/run', { as: 'boss', method: 'POST', form: { csrf } })).text();
  assert.match(failed, /role="alert">Backup finished with failures: 0 taken, 0 skipped, 1 failed/);
  assert.ok(failed.includes('disk &lt;full&gt;'), 'escaped');
  const devCsrf = await csrfOf('dev');
  assert.equal((await call('/ui/backups/run', { as: 'dev', method: 'POST', form: { csrf: devCsrf } })).status, 403);
  assert.equal((await call('/ui/backups', { as: 'dev' })).status, 403);
  assert.equal(s.backups.runs, 2);
});

test('backups page without BACKUP_DIR: says so, offers no Run now, and a run is refused', async t => {
  const s = uiSetup(t, { backups: false });
  const { call, csrfOf } = await uiApp(t, s);
  const html = await (await call('/ui/backups', { as: 'boss' })).text();
  assert.match(html, /Backups are not enabled/);
  assert.doesNotMatch(html, /action="\/ui\/backups\/run"/);
  const csrf = await csrfOf('boss');
  assert.equal((await call('/ui/backups/run', { as: 'boss', method: 'POST', form: { csrf } })).status, 400);
});
