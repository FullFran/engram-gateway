// The MCP endpoint's answers that do not depend on a real engram child:
// unknown brains, brains that cannot be served right now.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import { createGatewayApp } from '../../dist/http/app.js';
import { BrainCapacityError } from '../../dist/brains/index.js';

const quiet = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(l => [l, () => {}]));

async function withApp(brains, fn, extra = {}) {
  const app = createGatewayApp({ bindHost: '127.0.0.1', trustProxy: false, brains, logger: quiet, ...extra });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

const post = (base, path) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
});

function fakeBrains({ retryAfterMs = 0, acquireError } = {}) {
  const released = [];
  const brains = {
    released,
    has: slug => slug === 'default' || slug === 'a',
    acquired: [],
    acquire: async slug => {
      brains.acquired.push(slug);
      if (acquireError) throw acquireError;
      return {
        process: { factory: () => { throw new Error('not reached'); }, retryAfterMs: () => retryAfterMs },
        release: () => released.push(slug)
      };
    },
    stats: () => ({ live: 0, idle: 0 })
  };
  return brains;
}

/** Auth on, with an authenticator that accepts every request as `alice`. */
function signedInAs(login, mayOpen) {
  const principal = { login, clientId: 'c', scopes: ['memory'], token: 't' };
  return {
    auth: { router: express.Router(), authenticator: { prepare: async () => {}, authenticate: () => ({ ok: true, principal }) }, resource: 'http://127.0.0.1/mcp' },
    brainAccess: { mayOpen }
  };
}

test('a signed-in user without a grant on the brain gets 403 before the brain is touched', async () => {
  const asked = [];
  const brains = fakeBrains({ retryAfterMs: 2500 });
  await withApp(brains, async base => {
    for (const path of ['/mcp/a', '/mcp']) {
      const response = await post(base, path);
      assert.equal(response.status, 403, path);
      assert.deepEqual(await response.json(), { error: 'forbidden' });
    }
  }, signedInAs('alice', (login, brain) => { asked.push([login, brain]); return false; }));
  assert.deepEqual(asked, [['alice', 'a'], ['alice', 'default']], 'the grant is checked for the brain of the path');
  assert.deepEqual(brains.acquired, [], 'no brain was started or leased');
});

test('a grant revoked between two requests: the next request is 403 (no cached authorization)', async () => {
  let granted = true;
  const brains = fakeBrains({ retryAfterMs: 2500 });
  await withApp(brains, async base => {
    assert.equal((await post(base, '/mcp/a')).status, 503, 'with the grant the request reaches the brain');
    granted = false;
    assert.equal((await post(base, '/mcp/a')).status, 403, 'without it, refused');
  }, signedInAs('alice', () => granted));
  assert.deepEqual(brains.acquired, ['a']);
});

test('auth on without brainAccess is a wiring error', () => {
  const { auth } = signedInAs('alice', () => true);
  assert.throws(() => createGatewayApp({ bindHost: '127.0.0.1', trustProxy: false, brains: fakeBrains(), logger: quiet, auth }), /brainAccess is required/);
});

test('a brain cooling down after a failed start answers 503 with Retry-After, without touching engram', async () => {
  const brains = fakeBrains({ retryAfterMs: 2500 });
  await withApp(brains, async base => {
    const response = await post(base, '/mcp/a');
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '3');
    assert.deepEqual(await response.json(), { error: 'brain_unavailable' });
  });
  assert.deepEqual(brains.released, ['a'], 'the lease is released');
});

test('every child slot busy: 503 with Retry-After', async () => {
  await withApp(fakeBrains({ acquireError: new BrainCapacityError(2) }), async base => {
    const response = await post(base, '/mcp');
    assert.equal(response.status, 503);
    assert.ok(Number(response.headers.get('retry-after')) >= 1);
  });
});

test('an unknown brain is 404 with the body of any unknown path', async () => {
  await withApp(fakeBrains(), async base => {
    const unknown = await post(base, '/mcp/ghost');
    const other = await post(base, '/nope');
    assert.equal(unknown.status, 404);
    assert.equal(await unknown.text(), await other.text());
  });
});
