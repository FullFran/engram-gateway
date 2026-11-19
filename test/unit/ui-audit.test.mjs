// The audit log in the web panel (#17, #8): newest first, filtered, paged;
// reading it is the admin service's decision (#10), instance admins only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uiApp, uiSetup } from './ui-fixture.mjs';

const admin = { kind: 'user', login: 'boss' };
const dev = { kind: 'user', login: 'dev' };

/** Five rows, one minute apart: three invites, a denied list by dev, a grant on alpha. */
function history(s) {
  for (const login of ['ann', 'bob', 'cid']) {
    s.clock.ms += 60_000;
    s.admin.inviteUser(admin, login);
  }
  s.clock.ms += 60_000;
  assert.throws(() => s.admin.listUsers(dev));
  s.clock.ms += 60_000;
  s.admin.setGrant(admin, 'ann', 'alpha', 'reader');
}

test('queryAudit: newest first, filtered by action, actor, outcome, brain and time, paged by id; admins only', t => {
  const s = uiSetup(t);
  history(s);
  const all = s.admin.queryAudit(admin, {});
  assert.deepEqual(all.rows.map(row => row.action), ['grant.set', 'user.list', 'user.invite', 'user.invite', 'user.invite']);
  assert.equal(all.nextBefore, null);
  assert.deepEqual(s.admin.queryAudit(admin, { action: 'user.invite' }).rows.map(row => row.target), ['cid', 'bob', 'ann']);
  assert.deepEqual(s.admin.queryAudit(admin, { actor: 'DEV' }).rows.map(row => row.outcome), ['denied']);
  assert.deepEqual(s.admin.queryAudit(admin, { outcome: 'denied' }).rows.map(row => row.actorLogin), ['dev']);
  assert.deepEqual(s.admin.queryAudit(admin, { brain: 'alpha' }).rows.map(row => row.action), ['grant.set']);
  const start = Date.UTC(2026, 10, 19);
  assert.deepEqual(s.admin.queryAudit(admin, { fromMs: start + 120_000, toMs: start + 240_000 }).rows.map(row => row.target), ['cid', 'bob']);
  const first = s.admin.queryAudit(admin, { limit: 2 });
  assert.equal(first.rows.length, 2);
  assert.ok(first.nextBefore !== null);
  const second = s.admin.queryAudit(admin, { limit: 2, before: first.nextBefore });
  assert.deepEqual(second.rows.map(row => row.target), ['cid', 'bob']);
  assert.deepEqual([...first.rows, ...second.rows, ...s.admin.queryAudit(admin, { limit: 2, before: second.nextBefore }).rows].map(row => row.id), all.rows.map(row => row.id));
  assert.throws(() => s.admin.queryAudit(dev, {}), error => error.code === 'forbidden');
  assert.throws(() => s.admin.queryAudit(admin, { outcome: 'maybe' }), error => error.code === 'invalid');
  assert.throws(() => s.admin.queryAudit(admin, { actor: 'not a login!' }), error => error.code === 'invalid');
});

test('audit page: rows newest first, a filter form kept filled, older pages, a CSV link with the same brain and dates', async t => {
  const s = uiSetup(t);
  history(s);
  const { call } = await uiApp(t, s);
  let html = await (await call('/ui/audit', { as: 'boss' })).text();
  assert.match(html, /<a href="\/ui\/audit" aria-current="page">Audit log<\/a>/);
  const actions = [...html.matchAll(/<td><code>([a-z_.]+)<\/code><\/td>/g)].map(match => match[1]);
  assert.deepEqual(actions.slice(0, 2), ['grant.set', 'user.list']);
  assert.match(html, /<td>denied<\/td>/);
  const filtered = await call('/ui/audit?action=user.invite&brain=&from=2026-11-19&to=2026-11-19&limit=2', { as: 'boss' });
  assert.equal(filtered.status, 200);
  html = await filtered.text();
  assert.equal([...html.matchAll(/<td><code>user\.invite<\/code><\/td>/g)].length, 2);
  assert.doesNotMatch(html, /grant\.set/);
  assert.match(html, /name="action" value="user\.invite"/);
  const older = html.match(/<a href="(\/ui\/audit\?[^"]+)">Older entries<\/a>/)?.[1]?.replaceAll('&amp;', '&');
  assert.ok(older?.includes('action=user.invite') && older.includes('before='), older);
  const next = await (await call(older, { as: 'boss' })).text();
  assert.equal([...next.matchAll(/<td><code>user\.invite<\/code><\/td>/g)].length, 1);
  assert.doesNotMatch(next, />Older entries</);
  assert.match(html, /href="\/admin\/api\/audit\.csv\?from=2026-11-19T00%3A00%3A00\.000Z&amp;to=2026-11-20T00%3A00%3A00\.000Z"/);
  const bad = await call('/ui/audit?outcome=maybe', { as: 'boss' });
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /role="alert"/);
  assert.equal((await call('/ui/audit', { as: 'dev' })).status, 403);
});
