// Brains in the web panel (#17): the list with live/idle status, create,
// archive and each brain's health report (#18). Every decision is the admin
// service's (#10): only instance admins pass, and everything is audited.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { uiApp, uiSetup } from './ui-fixture.mjs';

const admin = { kind: 'user', login: 'boss' };
const dev = { kind: 'user', login: 'dev' };

function report(live) {
  return {
    ok: true,
    report: {
      brain: 'alpha', generatedAt: '2026-11-19T00:00:00.000Z', observations: { live, deleted: 3 },
      byType: { top: [{ type: 'decision', count: 7 }, { type: 'bugfix', count: 2 }], otherTypes: 1, otherCount: 1 },
      noise: { count: 4, sampleIds: [1, 2], types: ['checkpoint'], share: 0.4 },
      duplicateTitles: { groups: 2, rows: 5, excessRows: 3, sampleIds: [9] },
      pendingRelations: { count: 6, sampleIds: [] },
      pastReviewAfter: { count: 1, sampleIds: [4] },
      wiki: { status: 'unavailable', reason: 'no wiki yet' },
      semanticIndex: { status: 'unavailable', reason: 'no index yet' }
    }
  };
}

test('brainHealth: admins only (a refusal is audited as denied); a report or its absence is audited with its outcome', t => {
  const s = uiSetup(t);
  s.reports.set('alpha', report(10));
  s.reports.set('beta', { ok: false, reason: 'no_data', message: 'brain beta has no engram.db yet (nothing saved)' });
  assert.throws(() => s.admin.brainHealth(dev, 'alpha'), error => error.code === 'forbidden');
  assert.equal(s.admin.brainHealth(admin, 'alpha').report.observations.live, 10);
  assert.deepEqual(s.admin.brainHealth(admin, 'beta'), { ok: false, reason: 'no_data', message: 'brain beta has no engram.db yet (nothing saved)' });
  assert.throws(() => s.admin.brainHealth(admin, 'nope'), error => error.code === 'not_found');
  assert.deepEqual(s.audit().map(row => [row.actor, row.action, row.outcome]), [
    ['dev', 'admin.brain_health', 'denied'],
    ['boss', 'admin.brain_health', 'ok'],
    ['boss', 'admin.brain_health', 'error'],
    ['boss', 'admin.brain_health', 'error']
  ]);
});

test('brains page: an admin sees every brain with its runtime status; a non-admin gets 403 and no admin navigation', async t => {
  const s = uiSetup(t);
  const { call } = await uiApp(t, s);
  const page = await call('/ui/brains', { as: 'boss' });
  assert.equal(page.status, 200);
  const html = await page.text();
  for (const [slug, state] of [['default', 'stopped'], ['alpha', 'live, serving'], ['beta', 'live, idle']]) {
    assert.match(html, new RegExp(`<code>${slug}</code></th><td>active</td><td>${state}</td>`), slug);
  }
  assert.match(html, /<h2>Administration<\/h2><ul><li><a href="\/ui\/brains" aria-current="page">Brains<\/a>/);
  const refused = await call('/ui/brains', { as: 'dev' });
  assert.equal(refused.status, 403);
  assert.match(await refused.text(), /instance admin role is required/);
  assert.doesNotMatch(await (await call('/ui/tokens', { as: 'dev' })).text(), /\/ui\/brains/);
  assert.deepEqual(s.audit().map(row => [row.actor, row.action, row.outcome]), [['dev', 'brain.list', 'denied']]);
});

test('create a brain: through the form, audited; a bad slug is shown; a non-admin creates nothing', async t => {
  const s = uiSetup(t);
  const { call, csrfOf } = await uiApp(t, s);
  const csrf = await csrfOf('boss', '/ui/brains');
  const created = await call('/ui/brains', { as: 'boss', method: 'POST', form: { csrf, slug: 'gamma' } });
  assert.equal(created.status, 303);
  assert.equal(created.headers.get('location'), '/ui/brains');
  assert.equal(s.admin.listBrains(admin).find(brain => brain.slug === 'gamma')?.status, 'active');
  assert.ok(existsSync(join(s.dir, 'brains', 'gamma')), 'the data directory exists');
  const bad = await call('/ui/brains', { as: 'boss', method: 'POST', form: { csrf, slug: 'Bad Slug<x>' } });
  assert.equal(bad.status, 400);
  const body = await bad.text();
  assert.match(body, /role="alert"/);
  assert.ok(!body.includes('<x>'), 'escaped');
  const devCsrf = await csrfOf('dev');
  const refused = await call('/ui/brains', { as: 'dev', method: 'POST', form: { csrf: devCsrf, slug: 'delta' } });
  assert.equal(refused.status, 403);
  assert.equal(s.admin.listBrains(admin).some(brain => brain.slug === 'delta'), false);
  assert.deepEqual(s.audit().filter(row => row.action === 'brain.create').map(row => [row.actor, row.outcome]), [['boss', 'ok'], ['boss', 'error'], ['dev', 'denied']]);
});

test('archive a brain: archived, its child stopped, audited; the default brain cannot be archived', async t => {
  const s = uiSetup(t);
  const { call, csrfOf } = await uiApp(t, s);
  const csrf = await csrfOf('boss', '/ui/brains');
  const archived = await call('/ui/brains/beta/archive', { as: 'boss', method: 'POST', form: { csrf } });
  assert.equal(archived.status, 303);
  assert.equal(s.admin.listBrains(admin).find(brain => brain.slug === 'beta').status, 'archived');
  assert.deepEqual(s.runtime.stopped, ['beta']);
  const html = await (await call('/ui/brains', { as: 'boss' })).text();
  assert.match(html, /<code>beta<\/code><\/th><td>archived<\/td>/);
  assert.doesNotMatch(html, /action="\/ui\/brains\/beta\/archive"/, 'no archive button for an archived brain');
  assert.doesNotMatch(html, /action="\/ui\/brains\/default\/archive"/, 'no archive button for the default brain');
  const refused = await call('/ui/brains/default/archive', { as: 'boss', method: 'POST', form: { csrf } });
  assert.equal(refused.status, 400);
  assert.equal(s.admin.listBrains(admin).find(brain => brain.slug === 'default').status, 'active');
});

test('health page: the report of a brain, a brain with no data yet, an unknown brain, a non-admin', async t => {
  const s = uiSetup(t);
  s.reports.set('alpha', report(10));
  s.reports.set('beta', { ok: false, reason: 'no_data', message: 'brain beta has no engram.db yet (nothing saved)' });
  const { call } = await uiApp(t, s);
  const page = await call('/ui/brains/alpha', { as: 'boss' });
  assert.equal(page.status, 200);
  const html = await page.text();
  for (const fact of ['<td>10</td>', '<td>decision</td><td>7</td>', 'checkpoint', '40%', '<td>3</td>', 'no wiki yet']) assert.ok(html.includes(fact), fact);
  const empty = await call('/ui/brains/beta', { as: 'boss' });
  assert.equal(empty.status, 200);
  assert.match(await empty.text(), /has no engram\.db yet/);
  assert.equal((await call('/ui/brains/nope', { as: 'boss' })).status, 404);
  assert.equal((await call('/ui/brains/alpha', { as: 'dev' })).status, 403);
});
