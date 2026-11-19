// Author attribution end to end (#21): two signed-in users share one brain
// over HTTP, backed by a real `engram mcp` (ENGRAM_BIN, as in CI). Each
// mem_search, from either user, shows the right author for each result, and
// a topic_key revision keeps the first author and records the last writer.
// Skipped when no engram binary can be run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { AUTHORS_META_KEY, SqliteAuthorshipRepository, createAttributor } from '../../dist/attribution/index.js';
import { BrainRegistry, buildChildEnv } from '../../dist/brains/index.js';
import { createEngramBridge } from '../../dist/bridge/index.js';
import { createGatewayApp } from '../../dist/http/app.js';
import { createAttributionStage, createToolCallPipeline } from '../../dist/pipeline/index.js';
import { openGatewayDatabase } from '../../dist/shared/gateway-database.js';

const ENGRAM_BIN = process.env.ENGRAM_BIN ?? 'engram';
const hasEngram = spawnSync(ENGRAM_BIN, ['version'], { encoding: 'utf8' }).status === 0;
const logger = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(l => [l, () => {}]));
const PROJECT = 'team';

const text = result => result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
/** Engram's JSON payload from inside the first memory-data block. */
const payload = result => JSON.parse(/<memory-data nonce="([0-9a-f]+)">\n([\s\S]*?)\n<\/memory-data nonce="\1">/.exec(result.content[0].text)[2]);

test('two users in one brain: mem_search shows each result\'s author; a topic_key revision keeps the first author', { skip: !hasEngram && 'no engram binary' }, async t => {
  const scratch = mkdtempSync(join(tmpdir(), 'engram-gateway-attribution-e2e-'));
  const db = openGatewayDatabase(join(scratch, 'gateway.db'));
  const pipeline = createToolCallPipeline({
    attribute: createAttributionStage({ attribute: createAttributor({ authors: new SqliteAuthorshipRepository(db), clock: { nowMs: () => Date.now() } }) })
  });
  const brain = { slug: 'team', dataDir: join(scratch, 'brains', 'team'), cloudSync: false };
  const registry = new BrainRegistry({
    brains: new Map([[brain.slug, brain]]),
    createProcess: b => createEngramBridge({
      command: ENGRAM_BIN, args: ['mcp', '--project', PROJECT], pipeline, brain: b.slug, logger,
      env: buildChildEnv(b, { HOME: join(scratch, 'home'), PATH: process.env.PATH })
    }),
    clock: { now: () => Date.now() }, idleTimeoutMs: 60_000, maxLiveBrains: 1, logger
  });
  // The bearer token is the login: enough to give each request its own principal.
  const authenticator = {
    prepare: async () => {},
    authenticate: headers => {
      const login = /^Bearer (\w+)$/.exec(headers.authorization ?? '')?.[1];
      return login ? { ok: true, principal: { login, clientId: `client-${login}`, scopes: ['memory'], token: login } } : { ok: false };
    }
  };
  const app = createGatewayApp({
    bindHost: '127.0.0.1', trustProxy: false, logger, brains: registry,
    auth: { router: express.Router(), authenticator, resource: 'http://127.0.0.1/mcp' },
    brainAccess: { mayOpen: () => true }
  });
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const clients = [];
  t.after(async () => {
    await Promise.all(clients.map(c => c.close().catch(() => undefined)));
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    await registry.stopAll();
    db.close();
    rmSync(scratch, { recursive: true, force: true });
  });
  const connect = async login => {
    const client = new Client({ name: `e2e-${login}`, version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp/team`), {
      requestInit: { headers: { authorization: `Bearer ${login}` } }
    }));
    clients.push(client);
    return client;
  };
  const alice = await connect('alice');
  const bob = await connect('bob');
  const marker = `attr${Date.now().toString(36)}`;
  const save = async (client, args) => {
    const result = await client.callTool({ name: 'mem_save', arguments: { type: 'decision', ...args } });
    assert.ok(!result.isError, text(result));
    return payload(result).id;
  };

  const aliceId = await save(alice, { title: `Alice note ${marker}`, content: `alpha ${marker}` });
  const bobId = await save(bob, { title: `Bob note ${marker}`, content: `beta ${marker}` });
  const sharedId = await save(alice, { title: `Shared ${marker}`, content: `v1 ${marker}`, topic_key: `shared/${marker}` });
  assert.equal(await save(bob, { title: `Shared ${marker}`, content: `v2 ${marker}`, topic_key: `shared/${marker}` }), sharedId, 'topic_key revises the same observation');

  for (const reader of [alice, bob]) {
    const found = await reader.callTool({ name: 'mem_search', arguments: { query: marker } });
    assert.ok(!found.isError, text(found));
    assert.deepEqual(payload(found).results.map(r => r.id).sort(), [aliceId, bobId, sharedId].sort());
    assert.deepEqual(found._meta?.[AUTHORS_META_KEY], {
      [aliceId]: { savedBy: 'alice', lastUpdatedBy: 'alice' },
      [bobId]: { savedBy: 'bob', lastUpdatedBy: 'bob' },
      [sharedId]: { savedBy: 'alice', lastUpdatedBy: 'bob' }
    });
    const authors = text(found);
    assert.match(authors, new RegExp(`#${aliceId} saved by alice\\n`));
    assert.match(authors, new RegExp(`#${bobId} saved by bob\\n`));
    assert.match(authors, new RegExp(`#${sharedId} saved by alice, last updated by bob\\n`));
  }

  // mem_capture_passive returns no id: the write goes through unattributed.
  const passive = await alice.callTool({ name: 'mem_capture_passive', arguments: { content: `## Key Learnings:\n1. passive ${marker} learning\n` } });
  assert.ok(!passive.isError, text(passive));

  // Deleting through the gateway forgets the author.
  const deleted = await bob.callTool({ name: 'mem_delete', arguments: { id: bobId, expected_project: PROJECT } });
  assert.ok(!deleted.isError, text(deleted));
  assert.deepEqual(db.prepare('SELECT observation_id FROM observation_authors ORDER BY observation_id').all().map(r => r.observation_id), [aliceId, sharedId].sort((a, b) => a - b));
});
