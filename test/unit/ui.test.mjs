// Web admin panel (#17): server-rendered pages at /ui behind the browser
// session. Every action calls the same application services as the JSON
// APIs; POSTs need the same origin and a CSRF token bound to the session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createGatewayApp } from '../../dist/http/app.js';
import { createUiRouter } from '../../dist/ui/index.js';
import { uiApp, uiSetup } from './ui-fixture.mjs';

test('without a session: GET redirects to the sign-in with the page as return path; POST is 401; a bearer token is never a session', async t => {
  const s = uiSetup(t);
  const { call } = await uiApp(t, s);
  const page = await call('/ui/tokens?x=1');
  assert.equal(page.status, 303);
  assert.equal(page.headers.get('location'), `/oauth/login?return_to=${encodeURIComponent('/ui/tokens?x=1')}`);
  assert.equal((await call('/ui/tokens', { method: 'POST', form: { name: 'x' } })).status, 401);
  const { token } = s.pats.create({ kind: 'user', login: 'dev' }, 'dev', { name: 'ci', brains: ['alpha'], scope: 'read', expiresInDays: 30 });
  assert.equal((await call('/ui/tokens', { bearer: token })).status, 303, 'a PAT does not open the panel');
});

test('/ui sends the signed-in user to their tokens; pages are HTML with a strict CSP, no-store and no framing', async t => {
  const s = uiSetup(t);
  const { call } = await uiApp(t, s);
  const root = await call('/ui', { as: 'dev' });
  assert.equal(root.status, 303);
  assert.equal(root.headers.get('location'), '/ui/tokens');
  const page = await call('/ui/tokens', { as: 'dev' });
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /^text\/html/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  const csp = page.headers.get('content-security-policy');
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /form-action 'self'/);
  assert.doesNotMatch(csp, /script-src/, 'the panel runs no script');
  const html = await page.text();
  assert.match(html, /Signed in as <strong>dev<\/strong>/);
  assert.match(html, /<form method="post" action="\/oauth\/logout">/, 'sign-out uses the existing endpoint');
  const missing = await call('/ui/nope', { as: 'dev' });
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /Page not found/);
});

test('my tokens: lists only my own tokens and offers only the brains I hold a grant on', async t => {
  const s = uiSetup(t);
  const { call } = await uiApp(t, s);
  s.pats.create({ kind: 'user', login: 'dev' }, 'dev', { name: 'laptop', brains: ['alpha'], scope: 'read+write', expiresInDays: 90 });
  s.pats.create({ kind: 'user', login: 'other' }, 'other', { name: 'theirs', brains: ['alpha'], scope: 'read', expiresInDays: 30 });
  const html = await (await call('/ui/tokens', { as: 'dev' })).text();
  assert.match(html, /laptop/);
  assert.doesNotMatch(html, /theirs/);
  assert.match(html, /name="brains" value="alpha"/);
  assert.match(html, /name="brains" value="beta"/);
  assert.doesNotMatch(html, /name="brains" value="default"/, 'no grant on default');
});

test('create: shows the secret once, stores and audits the token; the list never shows it again', async t => {
  const s = uiSetup(t);
  const { call, csrfOf } = await uiApp(t, s);
  const csrf = await csrfOf('dev');
  const created = await call('/ui/tokens', { as: 'dev', method: 'POST', form: { csrf, name: 'ci', brains: ['alpha', 'beta'], scope: 'read', expires: '365' } });
  assert.equal(created.status, 201);
  const html = await created.text();
  const secret = /<code[^>]*id="new-token">(egw_pat_[^<]+)<\/code>/.exec(html)?.[1];
  assert.ok(secret, 'the secret is on the page');
  const [pat] = s.pats.list('dev');
  assert.equal(pat.name, 'ci');
  assert.deepEqual([...pat.brains].sort(), ['alpha', 'beta']);
  assert.deepEqual(s.audit().map(row => [row.actor, row.action, row.outcome]), [['dev', 'pat.create', 'ok']]);
  assert.equal(s.pats.authenticate(secret).kind, 'ok', 'the shown secret is the real one');
  const later = await (await call('/ui/tokens', { as: 'dev' })).text();
  assert.ok(!later.includes(secret), 'shown once only');
});

test('create: a refusal of the service is shown on the page with its status, and nothing is stored', async t => {
  const s = uiSetup(t);
  const { call, csrfOf } = await uiApp(t, s);
  const csrf = await csrfOf('dev');
  const ungranted = await call('/ui/tokens', { as: 'dev', method: 'POST', form: { csrf, name: 'x', brains: 'default', scope: 'read', expires: '30' } });
  assert.equal(ungranted.status, 400);
  assert.match(await ungranted.text(), /role="alert"/);
  const writeOnReader = await call('/ui/tokens', { as: 'dev', method: 'POST', form: { csrf, name: 'x', brains: 'beta', scope: 'read+write', expires: '30' } });
  assert.equal(writeOnReader.status, 400);
  assert.equal(s.pats.list('dev').length, 0);
  await call('/ui/tokens', { as: 'dev', method: 'POST', form: { csrf, name: 'dup', brains: 'alpha', scope: 'read', expires: '30' } });
  const duplicate = await call('/ui/tokens', { as: 'dev', method: 'POST', form: { csrf, name: 'dup', brains: 'alpha', scope: 'read', expires: '30' } });
  assert.equal(duplicate.status, 409);
  const escaped = await call('/ui/tokens', { as: 'dev', method: 'POST', form: { csrf, name: '<b>x</b>', brains: 'nope<i>', scope: 'read', expires: '30' } });
  const body = await escaped.text();
  assert.ok(!body.includes('<i>') && !body.includes('<b>x'), 'the service message and form values are escaped');
});

test('revoke: my own token is revoked and audited; another user\'s id is a 404 and stays active', async t => {
  const s = uiSetup(t);
  const { call, csrfOf } = await uiApp(t, s);
  const mine = s.pats.create({ kind: 'user', login: 'dev' }, 'dev', { name: 'mine', brains: ['alpha'], scope: 'read', expiresInDays: 30 });
  const theirs = s.pats.create({ kind: 'user', login: 'other' }, 'other', { name: 'theirs', brains: ['alpha'], scope: 'read', expiresInDays: 30 });
  const csrf = await csrfOf('dev');
  const revoked = await call(`/ui/tokens/${mine.pat.id}/revoke`, { as: 'dev', method: 'POST', form: { csrf } });
  assert.equal(revoked.status, 303);
  assert.equal(revoked.headers.get('location'), '/ui/tokens');
  assert.notEqual(s.pats.list('dev')[0].revokedAt, null);
  const refused = await call(`/ui/tokens/${theirs.pat.id}/revoke`, { as: 'dev', method: 'POST', form: { csrf } });
  assert.equal(refused.status, 404);
  assert.equal(s.pats.list('other')[0].revokedAt, null);
  assert.deepEqual(s.audit().filter(row => row.action === 'pat.revoke').map(row => [row.actor, row.target]), [['dev', `pat-${mine.pat.id}`]]);
});

test('CSRF: a POST without the token, with another session\'s token, cross-site or from another origin is refused before any change', async t => {
  const s = uiSetup(t);
  const { call, csrfOf } = await uiApp(t, s);
  const form = { name: 'ci', brains: 'alpha', scope: 'read', expires: '30' };
  const csrf = await csrfOf('dev.1');
  const attempts = [
    { as: 'dev.1', form },
    { as: 'dev.1', form: { ...form, csrf: 'forged' } },
    { as: 'dev.2', form: { ...form, csrf }, label: 'the token of another session of the same login' },
    { as: 'other', form: { ...form, csrf } },
    { as: 'dev.1', form: { ...form, csrf }, headers: { 'sec-fetch-site': 'cross-site' } },
    { as: 'dev.1', form: { ...form, csrf }, headers: { 'sec-fetch-site': 'same-site' } },
    { as: 'dev.1', form: { ...form, csrf }, headers: { origin: 'http://evil.test' } },
    { as: 'dev.1', form: { ...form, csrf }, headers: { origin: 'null' } }
  ];
  for (const { label, ...attempt } of attempts) {
    const response = await call('/ui/tokens', { ...attempt, method: 'POST' });
    assert.equal(response.status, 403, label ?? JSON.stringify(attempt));
  }
  assert.equal(s.pats.list('dev').length + s.pats.list('other').length, 0);
  assert.deepEqual(s.audit(), []);
  const ok = await call('/ui/tokens', { as: 'dev.1', method: 'POST', form: { ...form, csrf } });
  assert.equal(ok.status, 201, 'the same request with the right token, origin and session goes through');
});

test('a non-admin sees no admin section in the navigation', async t => {
  const s = uiSetup(t);
  const { call } = await uiApp(t, s);
  const html = await (await call('/ui/tokens', { as: 'dev' })).text();
  assert.match(html, /<nav aria-label="Main">/);
  assert.doesNotMatch(html, /Administration/);
});

test('with auth off there is no session, so the panel is not mounted', async t => {
  let built = false;
  const gateway = createGatewayApp({
    bindHost: '127.0.0.1', trustProxy: false, logger: { debug() {}, info() {}, warn() {}, error() {} },
    brains: { has: () => true, acquire: async () => { throw new Error('not served'); }, stats: () => ({ live: 0, idle: 0 }) },
    ui: identify => { built = true; return createUiRouter({ identify, origin: 'http://x', isAdmin: () => true, tokens: {}, brainsOf: () => [], clock: { nowMs: () => 0 }, logger: console }); }
  });
  const server = createServer(gateway);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/ui/tokens`, { redirect: 'manual' });
  assert.equal(response.status, 404);
  assert.equal(built, false);
});

test('a provider that names no session cookie gets no panel: nothing to bind the CSRF token to, so it is refused (no fallback)', async t => {
  const s = uiSetup(t);
  const { call } = await uiApp(t, s, { sessionCookies: false });
  const page = await call('/ui/tokens', { as: 'dev' });
  assert.equal(page.status, 403);
  assert.match(await page.text(), /cannot be used with this sign-in/);
  const post = await call('/ui/tokens', { as: 'dev', method: 'POST', form: { name: 'x', brains: 'alpha', scope: 'read', expires: '30' } });
  assert.equal(post.status, 403);
  assert.deepEqual(s.pats.list('dev'), []);
});

test('an oversized or unreadable form body gets the panel\'s error page with 413 / 415, not a 500', async t => {
  const s = uiSetup(t);
  const { call, csrfOf } = await uiApp(t, s);
  const csrf = await csrfOf('dev');
  const big = await call('/ui/tokens', { as: 'dev', method: 'POST', form: { csrf, name: 'x'.repeat(20_000) } });
  assert.equal(big.status, 413);
  assert.match(big.headers.get('content-type'), /text\/html/);
  assert.match(await big.text(), /<h1>Form too large<\/h1>/);
  const charset = await call('/ui/tokens', { as: 'dev', method: 'POST', form: { csrf, name: 'x' }, headers: { 'content-type': 'application/x-www-form-urlencoded; charset=klingon' } });
  assert.equal(charset.status, 415);
  assert.match(await charset.text(), /<h1>Form not readable<\/h1>/);
  assert.deepEqual(s.pats.list('dev'), []);
});
