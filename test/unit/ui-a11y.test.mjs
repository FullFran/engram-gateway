// Accessibility check of the web admin panel (#17): every page the panel
// renders, in each of its states, has no axe-core violation (WCAG 2.1 A/AA
// and best practices; colour contrast needs a real browser and is not checked).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { axeViolations, uiApp, uiSetup } from './ui-fixture.mjs';

test('axe: every panel page and state has no violation', async t => {
  const s = uiSetup(t);
  const { call, csrfOf } = await uiApp(t, s);
  const pages = {};
  pages['my tokens, empty'] = await call('/ui/tokens', { as: 'dev' });
  pages['my tokens, no grant'] = await call('/ui/tokens', { as: 'nobody' });
  const csrf = await csrfOf('dev');
  pages['my tokens, created'] = await call('/ui/tokens', { as: 'dev', method: 'POST', form: { csrf, name: 'ci', brains: 'alpha', scope: 'read', expires: '30' } });
  pages['my tokens, refused'] = await call('/ui/tokens', { as: 'dev', method: 'POST', form: { csrf, name: 'x', brains: 'beta', scope: 'read+write', expires: '30' } });
  pages['my tokens, as an admin'] = await call('/ui/tokens', { as: 'boss' });
  pages['my connections, none'] = await call('/ui/connections', { as: 'dev' });
  const mine = s.connections.saveOAuth('dev', 'client-a', { name: 'Claude', defaultBrain: 'alpha', brains: [{ brain: 'alpha', role: 'reader' }] });
  s.connections.saveOAuth('dev', 'client-b', { name: 'Empty', defaultBrain: 'alpha', brains: [{ brain: 'alpha', role: 'reader' }] });
  s.connections.detach(s.connections.findOAuth('dev', 'client-b').id, 'alpha');
  pages['my connections, two'] = await call('/ui/connections', { as: 'dev' });
  pages['my connections, refused'] = await call(`/ui/connections/${mine}/attach`, { as: 'dev', method: 'POST', form: { csrf, brain: 'beta', role: 'owner' } });
  pages['form too large'] = await call('/ui/tokens', { as: 'dev', method: 'POST', form: { csrf, name: 'x'.repeat(20_000) } });
  const bossCsrf = await csrfOf('boss', '/ui/brains');
  pages['brains'] = await call('/ui/brains', { as: 'boss' });
  pages['brains, refused'] = await call('/ui/brains', { as: 'boss', method: 'POST', form: { csrf: bossCsrf, slug: 'Bad slug' } });
  pages['brains, not an admin'] = await call('/ui/brains', { as: 'dev' });
  s.reports.set('alpha', {
    ok: true,
    report: {
      brain: 'alpha', generatedAt: '2026-11-19T00:00:00.000Z', observations: { live: 3, deleted: 0 },
      byType: { top: [{ type: 'decision', count: 3 }], otherTypes: 0, otherCount: 0 },
      noise: { count: 0, sampleIds: [], types: ['checkpoint'], share: 0 },
      duplicateTitles: { groups: 0, rows: 0, excessRows: 0, sampleIds: [] },
      pendingRelations: null,
      pastReviewAfter: { count: 1, sampleIds: [2] },
      wiki: { status: 'unavailable', reason: 'no wiki yet' },
      semanticIndex: { status: 'unavailable', reason: 'no index yet' }
    }
  });
  s.reports.set('beta', { ok: false, reason: 'no_data', message: 'brain beta has no engram.db yet (nothing saved)' });
  pages['brain health'] = await call('/ui/brains/alpha', { as: 'boss' });
  pages['brain health, no data'] = await call('/ui/brains/beta', { as: 'boss' });
  pages['users'] = await call('/ui/users', { as: 'boss' });
  pages['users, refused'] = await call('/ui/users', { as: 'boss', method: 'POST', form: { csrf: bossCsrf, login: 'bad login' } });
  pages['user grants'] = await call('/ui/users/dev', { as: 'boss' });
  pages['user grants, refused'] = await call('/ui/users/dev/grants', { as: 'boss', method: 'POST', form: { csrf: bossCsrf, brain: 'alpha', role: 'god' } });
  pages['user grants, an admin'] = await call('/ui/users/boss', { as: 'boss' });
  await call('/ui/users', { as: 'boss', method: 'POST', form: { csrf: bossCsrf, login: 'newbie' } });
  pages['user grants, none'] = await call('/ui/users/newbie', { as: 'boss' });
  pages['not found'] = await call('/ui/nope', { as: 'dev' });
  pages['form refused'] = await call('/ui/tokens', { as: 'dev', method: 'POST', form: { name: 'x' } });
  pages['signed out'] = await call('/ui/tokens', { method: 'POST', form: { name: 'x' } });
  for (const [name, response] of Object.entries(pages)) {
    assert.match(response.headers.get('content-type') ?? '', /^text\/html/, name);
    assert.deepEqual(await axeViolations(await response.text()), [], name);
  }
});

test('axe: the check itself reports a known violation (an unlabelled input)', async () => {
  const html = '<!doctype html><html lang="en"><head><title>x</title></head><body><main><h1>x</h1><input type="text"></main></body></html>';
  const violations = await axeViolations(html);
  assert.ok(violations.some(violation => violation.startsWith('label:')), violations.join('\n'));
});
