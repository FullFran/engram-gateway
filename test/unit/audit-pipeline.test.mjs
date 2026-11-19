// The audit stage of the tool-call pipeline (#8): every call that reaches the
// forward step writes exactly one audit row, including forward failures, with
// redaction counts but never argument values or error messages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, InMemoryTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createServer } from 'node:http';
import express from 'express';
import { createGatewayApp } from '../../dist/http/app.js';
import { BrainRegistry } from '../../dist/brains/index.js';
import { createEngramBridge } from '../../dist/bridge/index.js';
import { createAuditStage, createToolCallPipeline, passResult, runToolCall } from '../../dist/pipeline/index.js';
import { SqliteAuditLog, toolCallRecorder } from '../../dist/audit/index.js';
import { openGatewayDatabase } from '../../dist/shared/gateway-database.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/fake-mcp-server.mjs', import.meta.url));
const logger = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(l => [l, () => {}]));
const T0 = 1_800_000_000_000;
const fakeToken = () => 'gh' + 'p_' + 'aB3dE5gH7jK9mN1pQ2'.repeat(2);
const CALLER = { login: 'octocat', clientId: 'client-1' };

function auditDb(t) {
  const dir = mkdtempSync(join(tmpdir(), 'engram-gateway-audit-pipeline-'));
  const db = openGatewayDatabase(join(dir, 'gateway.db'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return db;
}

/** A pipeline whose audit stage writes to a fresh gateway database; the clock advances 5 ms per read. */
function auditedPipeline(t, stageOptions = {}) {
  const db = auditDb(t);
  let now = T0;
  const clock = { nowMs: () => (now += 5) };
  const record = toolCallRecorder(new SqliteAuditLog(db), clock);
  const pipeline = createToolCallPipeline({ audit: createAuditStage({ record, ...stageOptions }), wrap: passResult });
  return { db, pipeline, nowMs: clock.nowMs };
}

const rows = db => db.prepare('SELECT a.*, u.github_login FROM audit_log a LEFT JOIN users u ON u.id = CAST(a.actor_id AS INTEGER) ORDER BY a.id').all();

test('an ok call writes one row with caller, tool, timing and redaction counts, and returns the result unchanged', async t => {
  const { db, pipeline, nowMs } = auditedPipeline(t);
  const token = fakeToken();
  const result = { content: [{ type: 'text', text: 'saved' }], structuredContent: { id: 7 } };
  const out = await runToolCall(pipeline, { name: 'mem_save', arguments: { content: `note ${token}`, title: 'my title' } },
    async () => result, { caller: CALLER, brain: 'team', nowMs });
  assert.equal(out, result);
  const all = rows(db);
  assert.equal(all.length, 1);
  const [row] = all;
  assert.equal(row.github_login, 'octocat');
  assert.equal(row.brain_id, 'team');
  assert.equal(row.target, 'mem_save');
  assert.equal(row.outcome, 'ok');
  assert.equal(row.at_ms, T0 + 5);
  assert.equal(row.duration_ms, 5);
  assert.deepEqual(JSON.parse(row.meta_json), { redactions: { github: 1 }, clientId: 'client-1' });
  const stored = JSON.stringify(row);
  for (const value of [token, 'note', 'my title']) assert.ok(!stored.includes(value), `row does not hold ${value}`);
});

test('a forward failure writes an error row without the message and rethrows the original error', async t => {
  const { db, pipeline, nowMs } = auditedPipeline(t);
  const failure = new Error('upstream died while saving "my secret note"');
  await assert.rejects(
    runToolCall(pipeline, { name: 'mem_save', arguments: { content: 'my secret note' } }, async () => { throw failure; }, { caller: CALLER, nowMs }),
    error => error === failure
  );
  const all = rows(db);
  assert.equal(all.length, 1);
  assert.equal(all[0].outcome, 'error');
  assert.equal(all[0].brain_id, null);
  assert.deepEqual(JSON.parse(all[0].meta_json), { errorKind: 'forward_failed', clientId: 'client-1' });
  assert.ok(!JSON.stringify(all[0]).includes('secret note'));
});

test('a tool error result is recorded as an error of kind tool_error', async t => {
  const { db, pipeline, nowMs } = auditedPipeline(t);
  const result = { content: [{ type: 'text', text: 'bad input: my secret' }], isError: true };
  assert.equal(await runToolCall(pipeline, { name: 'mem_search', arguments: { query: 'x' } }, async () => result, { caller: CALLER, nowMs }), result);
  const [row] = rows(db);
  assert.equal(row.outcome, 'error');
  assert.equal(JSON.parse(row.meta_json).errorKind, 'tool_error');
  assert.ok(!JSON.stringify(row).includes('my secret'));
});

test('a call without a signed-in caller is recorded as the anonymous system actor', async t => {
  const { db, pipeline, nowMs } = auditedPipeline(t);
  await runToolCall(pipeline, { name: 'mem_search' }, async () => ({ content: [] }), { nowMs });
  const [row] = rows(db);
  assert.deepEqual([row.actor_kind, row.actor_id], ['system', 'anonymous']);
});

test('a failing audit write does not fail the call; onError gets only the tool name', async t => {
  const reported = [];
  const pipeline = createToolCallPipeline({
    audit: createAuditStage({ record: () => { throw new Error('database is locked'); }, onError: (error, tool) => reported.push([error.message, tool]) }),
    wrap: passResult
  });
  const result = { content: [{ type: 'text', text: 'ok' }] };
  assert.equal(await runToolCall(pipeline, { name: 'mem_save', arguments: { content: 'x' } }, async () => result, { caller: CALLER }), result);
  const failure = new Error('forward failed');
  await assert.rejects(runToolCall(pipeline, { name: 'mem_save' }, async () => { throw failure; }), error => error === failure);
  assert.deepEqual(reported, [['database is locked', 'mem_save'], ['database is locked', 'mem_save']]);
});

/** Connects a downstream client to a server the bridge factory builds for one authenticated request. */
async function connect(bridge, authInfo) {
  const server = await bridge.factory({ era: 'modern', ...(authInfo ? { authInfo } : {}) });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientSide);
  return client;
}

test('through the bridge, a mem_save writes exactly one row with the login from authInfo; a crash writes an error row', async t => {
  const db = auditDb(t);
  const record = toolCallRecorder(new SqliteAuditLog(db), { nowMs: () => Date.now() });
  const bridge = createEngramBridge({
    command: process.execPath, args: [FIXTURE], logger,
    pipeline: createToolCallPipeline({ audit: createAuditStage({ record }) })
  });
  await bridge.start();
  t.after(() => bridge.close());
  const client = await connect(bridge, { token: 'opaque', clientId: 'client-1', scopes: ['memory'], extra: { login: 'octocat' } });
  await client.callTool({ name: 'mem_save', arguments: { content: `remember ${fakeToken()}` } });
  let all = rows(db);
  assert.equal(all.length, 1);
  assert.deepEqual([all[0].github_login, all[0].target, all[0].outcome], ['octocat', 'mem_save', 'ok']);
  assert.deepEqual(JSON.parse(all[0].meta_json), { redactions: { github: 1 }, clientId: 'client-1' });

  await client.callTool({ name: 'crash', arguments: {} }).catch(() => undefined);
  all = rows(db);
  assert.equal(all.length, 2);
  assert.deepEqual([all[1].target, all[1].outcome, JSON.parse(all[1].meta_json).errorKind], ['crash', 'error', 'forward_failed']);
  await client.close();
});

test('over HTTP, a call on /mcp/<slug> is audited with that brain and the authenticated principal; /mcp with the default brain', async t => {
  const db = auditDb(t);
  const record = toolCallRecorder(new SqliteAuditLog(db), { nowMs: () => Date.now() });
  const pipeline = createToolCallPipeline({ audit: createAuditStage({ record }) });
  const registry = new BrainRegistry({
    brains: new Map(['default', 'team'].map(slug => [slug, { slug, dataDir: `/unused/${slug}`, cloudSync: false }])),
    createProcess: brain => createEngramBridge({ command: process.execPath, args: [FIXTURE], logger, pipeline, brain: brain.slug }),
    clock: { now: () => Date.now() }, idleTimeoutMs: 60_000, maxLiveBrains: 2, logger
  });
  t.after(() => registry.stopAll());
  const principal = { login: 'octocat', clientId: 'client-http', scopes: ['memory'], token: 'opaque' };
  const authenticator = { prepare: async () => {}, authenticate: () => ({ ok: true, principal }) };
  const app = createGatewayApp({
    bindHost: '127.0.0.1', trustProxy: false, logger, brains: registry,
    auth: { router: express.Router(), authenticator, resource: 'http://127.0.0.1/mcp' },
    brainAccess: { mayOpen: () => true }
  });
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }));
  const call = async path => {
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}${path}`)));
    await client.callTool({ name: 'echo', arguments: { text: 'hello there' } });
    await client.close();
  };
  await call('/mcp/team');
  await call('/mcp');
  const all = rows(db);
  assert.equal(all.length, 2);
  assert.deepEqual(all.map(row => [row.brain_id, row.github_login, row.target, row.outcome]), [
    ['team', 'octocat', 'echo', 'ok'],
    ['default', 'octocat', 'echo', 'ok']
  ]);
  assert.deepEqual(JSON.parse(all[0].meta_json), { clientId: 'client-http' });
  assert.ok(!JSON.stringify(all).includes('hello there'));
});
