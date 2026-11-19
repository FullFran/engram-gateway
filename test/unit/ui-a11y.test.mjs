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
