// Service accounts in the web panel (#17, #7): instance admins create them and
// manage their tokens; every decision is the admin service's (#10).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uiApp, uiSetup } from './ui-fixture.mjs';

const admin = { kind: 'user', login: 'boss' };
const actions = (s, prefix) => s.audit().filter(row => row.action.startsWith(prefix)).map(row => [row.actor, row.action, row.outcome]);

test('service accounts: an admin creates one (owned by them, audited) and sees it listed; a duplicate is 409; a non-admin gets 403', async t => {
  const s = uiSetup(t);
  const { call, csrfOf } = await uiApp(t, s);
  const csrf = await csrfOf('boss', '/ui/service-accounts');
  const created = await call('/ui/service-accounts', { as: 'boss', method: 'POST', form: { csrf, login: 'ci-bot' } });
  assert.equal(created.status, 303);
  assert.equal(created.headers.get('location'), '/ui/service-accounts/ci-bot');
  const html = await (await call('/ui/service-accounts', { as: 'boss' })).text();
  assert.match(html, /<a href="\/ui\/service-accounts\/ci-bot"><code>ci-bot<\/code><\/a><\/th><td>active<\/td><td><code>boss<\/code><\/td>/);
  assert.match(html, /<a href="\/ui\/service-accounts" aria-current="page">Service accounts<\/a>/);
  const duplicate = await call('/ui/service-accounts', { as: 'boss', method: 'POST', form: { csrf, login: 'dev' } });
  assert.equal(duplicate.status, 409);
  assert.match(await duplicate.text(), /role="alert">user dev already exists/);
  assert.equal((await call('/ui/service-accounts', { as: 'dev' })).status, 403);
  assert.deepEqual(actions(s, 'service_account.create'), [['boss', 'service_account.create', 'ok'], ['boss', 'service_account.create', 'error']]);
});

test('a service account\'s tokens: created with the secret shown once, revoked; only its own grants are offered; a refusal is shown', async t => {
  const s = uiSetup(t);
  s.admin.createServiceAccount(admin, 'ci-bot');
  s.admin.setGrant(admin, 'ci-bot', 'alpha', 'writer');
  const { call, csrfOf } = await uiApp(t, s);
  const csrf = await csrfOf('boss', '/ui/service-accounts/ci-bot');
  let html = await (await call('/ui/service-accounts/ci-bot', { as: 'boss' })).text();
  assert.match(html, /<h1>Service account <code>ci-bot<\/code><\/h1>/);
  assert.match(html, /name="brains" value="alpha"/);
  assert.doesNotMatch(html, /name="brains" value="beta"/);
  assert.match(html, /<a href="\/ui\/users\/ci-bot">/, 'grants are managed on the user page');
  const created = await call('/ui/service-accounts/ci-bot/tokens', { as: 'boss', method: 'POST', form: { csrf, name: 'deploy', brains: 'alpha', scope: 'read+write', expires: '30' } });
  assert.equal(created.status, 201);
  html = await created.text();
  const secret = html.match(/<code[^>]*id="new-token">([^<]+)<\/code>/)?.[1];
  assert.ok(secret, 'the secret is shown');
  const [token] = s.pats.list('ci-bot');
  assert.equal(token.name, 'deploy');
  assert.ok(!(await (await call('/ui/service-accounts/ci-bot', { as: 'boss' })).text()).includes(secret), 'never shown again');
  const refused = await call('/ui/service-accounts/ci-bot/tokens', { as: 'boss', method: 'POST', form: { csrf, name: 'x', brains: 'beta', scope: 'read', expires: '30' } });
  assert.equal(refused.status, 400);
  assert.match(await refused.text(), /role="alert"/);
  const revoked = await call(`/ui/service-accounts/ci-bot/tokens/${token.id}/revoke`, { as: 'boss', method: 'POST', form: { csrf } });
  assert.equal(revoked.status, 303);
  assert.equal(revoked.headers.get('location'), '/ui/service-accounts/ci-bot');
  assert.notEqual(s.pats.list('ci-bot')[0].revokedAt, null);
  const devCsrf = await csrfOf('dev');
  assert.equal((await call('/ui/service-accounts/ci-bot/tokens', { as: 'dev', method: 'POST', form: { csrf: devCsrf, name: 'y', brains: 'alpha', scope: 'read', expires: '30' } })).status, 403);
  assert.equal(s.pats.list('ci-bot').length, 1);
});

test('a service account page: unknown or a person\'s login is 404, a non-admin is 403', async t => {
  const s = uiSetup(t);
  s.admin.createServiceAccount(admin, 'ci-bot');
  const { call } = await uiApp(t, s);
  assert.equal((await call('/ui/service-accounts/nope', { as: 'boss' })).status, 404);
  assert.equal((await call('/ui/service-accounts/dev', { as: 'boss' })).status, 404);
  assert.equal((await call('/ui/service-accounts/ci-bot', { as: 'dev' })).status, 403);
});
