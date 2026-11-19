// My connections (#17 page, #27 connections): a signed-in user lists their
// own OAuth connections and attaches or detaches brains, never above their
// own grant. The use case is OwnConnections; the page only translates HTTP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OwnConnections } from '../../dist/connections/index.js';
import { uiApp, uiSetup } from './ui-fixture.mjs';

const choice = (name, brains, defaultBrain = brains[0]?.brain) => ({ name, defaultBrain, brains });

/** dev: writer on alpha, reader on beta. One OAuth connection of dev (alpha reader), one of other, and dev's PAT. */
function world(t) {
  const s = uiSetup(t);
  const mine = s.connections.saveOAuth('dev', 'client-a', choice('Claude', [{ brain: 'alpha', role: 'reader' }]));
  const theirs = s.connections.saveOAuth('other', 'client-b', choice('Theirs', [{ brain: 'alpha', role: 'owner' }]));
  s.pats.create({ kind: 'user', login: 'dev' }, 'dev', { name: 'ci-token', brains: ['alpha'], scope: 'read', expiresInDays: 30 });
  const own = new OwnConnections({ store: s.connections, grants: s.grants, clock: s.clock });
  return { s, own, mine, theirs };
}

const user = login => ({ kind: 'user', login });

test('list: only my own OAuth connections (no other user\'s, no PAT), with effective roles and what I could attach', t => {
  const { own, mine } = world(t);
  assert.deepEqual(own.list('dev'), [{
    id: mine, name: 'Claude', clientId: 'client-a', defaultBrain: 'alpha',
    brains: [{ brain: 'alpha', role: 'reader', effectiveRole: 'reader' }],
    attachable: [{ brain: 'alpha', maxRole: 'writer', attached: 'reader' }, { brain: 'beta', maxRole: 'reader' }]
  }]);
  assert.deepEqual(own.list('nobody'), []);
});

test('attach: up to my own grant, audited in the same write; as default on request', t => {
  const { s, own, mine } = world(t);
  own.attach(user('dev'), mine, 'beta', 'reader', true);
  own.attach(user('dev'), mine, 'alpha', 'writer', false);
  const [view] = own.list('dev');
  assert.equal(view.defaultBrain, 'beta');
  assert.deepEqual(view.brains.map(b => [b.brain, b.role]), [['alpha', 'writer'], ['beta', 'reader']]);
  assert.deepEqual(s.audit().map(row => [row.actor, row.action, row.target, row.outcome]), [
    ['dev', 'pat.create', s.audit()[0].target, 'ok'],
    ['dev', 'connection.attach', `connection-${mine}`, 'ok'],
    ['dev', 'connection.attach', `connection-${mine}`, 'ok']
  ]);
});

test('attach refusals: above my grant, no grant, bad role, someone else\'s or a PAT connection; nothing changes and nothing is audited', t => {
  const { s, own, mine, theirs } = world(t);
  const patConnection = s.connections.listOwned('dev').find(connection => connection.kind === 'token');
  assert.ok(patConnection, 'the PAT is a token connection of dev');
  const before = JSON.stringify(own.list('dev'));
  const audited = s.audit().length;
  const refusals = [
    [() => own.attach(user('dev'), mine, 'beta', 'writer', false), 'invalid'],
    [() => own.attach(user('dev'), mine, 'default', 'reader', false), 'invalid'],
    [() => own.attach(user('dev'), mine, 'alpha', 'admin', false), 'invalid'],
    [() => own.attach(user('dev'), theirs, 'alpha', 'reader', false), 'not_found'],
    [() => own.attach(user('dev'), patConnection.id, 'alpha', 'reader', false), 'not_found'],
    [() => own.attach(user('dev'), 99_999, 'alpha', 'reader', false), 'not_found']
  ];
  for (const [attempt, code] of refusals) assert.throws(attempt, error => error.code === code, String(attempt));
  assert.equal(JSON.stringify(own.list('dev')), before);
  assert.equal(s.audit().length, audited);
  assert.equal(s.connections.get(theirs).brains.length, 1, 'the other user\'s connection is untouched');
});

test('detach: my own brain is removed (and the default with it) and audited; not attached or not mine is refused', t => {
  const { s, own, mine, theirs } = world(t);
  own.attach(user('dev'), mine, 'beta', 'reader', false);
  own.detach(user('dev'), mine, 'alpha');
  const [view] = own.list('dev');
  assert.deepEqual(view.brains.map(b => b.brain), ['beta']);
  assert.equal(view.defaultBrain, null);
  assert.deepEqual(s.audit().filter(row => row.action === 'connection.detach').map(row => [row.actor, row.target]), [['dev', `connection-${mine}`]]);
  assert.throws(() => own.detach(user('dev'), mine, 'alpha'), error => error.code === 'not_found');
  assert.throws(() => own.detach(user('dev'), theirs, 'alpha'), error => error.code === 'not_found');
  assert.equal(s.connections.get(theirs).brains.length, 1);
});

test('page: lists my connections and attaches and detaches through forms with the CSRF token', async t => {
  const { s, mine, theirs } = world(t);
  const { call, csrfOf } = await uiApp(t, s);
  const page = await call('/ui/connections', { as: 'dev' });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Claude/);
  assert.doesNotMatch(html, /Theirs|ci-token/);
  const csrf = await csrfOf('dev', '/ui/connections');
  const attached = await call(`/ui/connections/${mine}/attach`, { as: 'dev', method: 'POST', form: { csrf, brain: 'beta', role: 'reader', default: 'on' } });
  assert.equal(attached.status, 303);
  assert.equal(attached.headers.get('location'), '/ui/connections');
  assert.equal(s.connections.get(mine).defaultBrain, 'beta');
  const refused = await call(`/ui/connections/${mine}/attach`, { as: 'dev', method: 'POST', form: { csrf, brain: 'beta', role: 'owner' } });
  assert.equal(refused.status, 400);
  assert.match(await refused.text(), /role="alert"/);
  const detached = await call(`/ui/connections/${mine}/detach`, { as: 'dev', method: 'POST', form: { csrf, brain: 'alpha' } });
  assert.equal(detached.status, 303);
  assert.deepEqual(s.connections.get(mine).brains.map(b => b.brain), ['beta']);
  const notMine = await call(`/ui/connections/${theirs}/detach`, { as: 'dev', method: 'POST', form: { csrf, brain: 'alpha' } });
  assert.equal(notMine.status, 404);
  assert.equal((await call(`/ui/connections/${mine}/detach`, { as: 'dev', method: 'POST', form: { brain: 'beta' } })).status, 403, 'CSRF still applies');
  assert.deepEqual(s.connections.get(mine).brains.map(b => b.brain), ['beta']);
});

test('page: with no connection it says how one is made', async t => {
  const s = uiSetup(t);
  const { call } = await uiApp(t, s);
  assert.match(await (await call('/ui/connections', { as: 'dev' })).text(), /You have no connections/);
});
