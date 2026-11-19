// Users and grants in the web panel (#17): every decision is the admin
// service's (#10): instance admins only, every change audited.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uiApp, uiSetup } from './ui-fixture.mjs';

const admin = { kind: 'user', login: 'boss' };
const actions = (s, prefix) => s.audit().filter(row => row.action.startsWith(prefix)).map(row => [row.actor, row.action, row.target, row.outcome]);

test('users page: an admin sees every user with status and kind; a non-admin gets 403', async t => {
  const s = uiSetup(t);
  const { call } = await uiApp(t, s);
  const page = await call('/ui/users', { as: 'boss' });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<a href="\/ui\/users\/dev"><code>dev<\/code><\/a><\/th><td>active<\/td><td>person<\/td><td><\/td>/);
  assert.match(html, /<a href="\/ui\/users\/boss"><code>boss<\/code><\/a><\/th><td>active<\/td><td>person<\/td><td>instance admin<\/td>/);
  assert.match(html, /<a href="\/ui\/users" aria-current="page">Users<\/a>/);
  assert.doesNotMatch(html, /action="\/ui\/users\/boss\/disable"/, 'an instance admin cannot be disabled here');
  const refused = await call('/ui/users', { as: 'dev' });
  assert.equal(refused.status, 403);
  assert.deepEqual(actions(s, 'user.'), [['dev', 'user.list', null, 'denied']]);
});

test('invite: an invited user appears, audited; a duplicate or a bad login is shown with its status and escaped', async t => {
  const s = uiSetup(t);
  const { call, csrfOf } = await uiApp(t, s);
  const csrf = await csrfOf('boss', '/ui/users');
  const invited = await call('/ui/users', { as: 'boss', method: 'POST', form: { csrf, login: 'newbie' } });
  assert.equal(invited.status, 303);
  assert.equal(invited.headers.get('location'), '/ui/users');
  assert.equal(s.admin.listUsers(admin).find(user => user.login === 'newbie')?.status, 'invited');
  const duplicate = await call('/ui/users', { as: 'boss', method: 'POST', form: { csrf, login: 'newbie' } });
  assert.equal(duplicate.status, 409);
  assert.match(await duplicate.text(), /role="alert">user newbie already exists/);
  const bad = await call('/ui/users', { as: 'boss', method: 'POST', form: { csrf, login: '<b>x' } });
  assert.equal(bad.status, 400);
  const body = await bad.text();
  assert.ok(!body.includes('<b>x'), 'escaped');
  assert.match(body, /value="&lt;b&gt;x"/, 'the typed login stays in the form');
  assert.deepEqual(actions(s, 'user.invite').map(row => row[3]), ['ok', 'error', 'error']);
});

test('disable and enable: the user changes status, both audited; an instance admin cannot be disabled', async t => {
  const s = uiSetup(t);
  const { call, csrfOf } = await uiApp(t, s);
  const csrf = await csrfOf('boss', '/ui/users');
  assert.equal((await call('/ui/users/dev/disable', { as: 'boss', method: 'POST', form: { csrf } })).status, 303);
  assert.equal(s.admin.listUsers(admin).find(user => user.login === 'dev').status, 'disabled');
  const html = await (await call('/ui/users', { as: 'boss' })).text();
  assert.match(html, /action="\/ui\/users\/dev\/enable"/);
  assert.equal((await call('/ui/users/dev/enable', { as: 'boss', method: 'POST', form: { csrf } })).status, 303);
  assert.equal(s.admin.listUsers(admin).find(user => user.login === 'dev').status, 'active');
  const refused = await call('/ui/users/boss/disable', { as: 'boss', method: 'POST', form: { csrf } });
  assert.equal(refused.status, 409);
  assert.match(await refused.text(), /instance admin/);
  assert.deepEqual(actions(s, 'user.').filter(row => row[1] !== 'user.list'), [
    ['boss', 'user.disable', 'dev', 'ok'], ['boss', 'user.enable', 'dev', 'ok'], ['boss', 'user.disable', 'boss', 'error']
  ]);
});

test('a user\'s grants: listed with their source; set and change a role, revoke; a configured grant has no revoke button and is refused', async t => {
  const s = uiSetup(t);
  const { call, csrfOf } = await uiApp(t, s);
  const csrf = await csrfOf('boss', '/ui/users/dev');
  const page = await call('/ui/users/dev', { as: 'boss' });
  assert.equal(page.status, 200);
  let html = await page.text();
  assert.match(html, /<code>alpha<\/code><\/th><td>writer<\/td><td>configuration<\/td>/);
  assert.doesNotMatch(html, /action="\/ui\/users\/dev\/grants\/alpha\/revoke"/);
  const set = await call('/ui/users/dev/grants', { as: 'boss', method: 'POST', form: { csrf, brain: 'default', role: 'reader' } });
  assert.equal(set.status, 303);
  assert.equal(set.headers.get('location'), '/ui/users/dev');
  assert.equal((await call('/ui/users/dev/grants', { as: 'boss', method: 'POST', form: { csrf, brain: 'default', role: 'writer' } })).status, 303);
  html = await (await call('/ui/users/dev', { as: 'boss' })).text();
  assert.match(html, /<code>default<\/code><\/th><td>writer<\/td><td>panel or API<\/td>/);
  assert.match(html, /action="\/ui\/users\/dev\/grants\/default\/revoke"/);
  const badRole = await call('/ui/users/dev/grants', { as: 'boss', method: 'POST', form: { csrf, brain: 'default', role: 'god' } });
  assert.equal(badRole.status, 400);
  assert.equal((await call('/ui/users/dev/grants/default/revoke', { as: 'boss', method: 'POST', form: { csrf } })).status, 303);
  assert.equal(s.admin.listGrants(admin, { login: 'dev' }).some(grant => grant.brain === 'default'), false);
  const configured = await call('/ui/users/dev/grants/alpha/revoke', { as: 'boss', method: 'POST', form: { csrf } });
  assert.equal(configured.status, 409);
  assert.match(await configured.text(), /BRAIN_GRANTS/);
  assert.deepEqual(actions(s, 'grant.').filter(row => row[1] !== 'grant.list').map(row => [row[1], row[3]]), [
    ['grant.set', 'ok'], ['grant.set', 'ok'], ['grant.set', 'error'], ['grant.revoke', 'ok'], ['grant.revoke', 'error']
  ]);
});

test('a user page: an unknown login is 404, a non-admin is 403', async t => {
  const s = uiSetup(t);
  const { call } = await uiApp(t, s);
  assert.equal((await call('/ui/users/nobody-here', { as: 'boss' })).status, 404);
  assert.equal((await call('/ui/users/dev', { as: 'dev' })).status, 403);
});
