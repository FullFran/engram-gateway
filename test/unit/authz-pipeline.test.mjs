// The authorize stage of the tool-call pipeline (#6): denials are never
// forwarded and reach the audit log as `denied`; tools/list is filtered by the
// same check; over HTTP a reader sees and calls only reader tools.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOOL_ROLES, SqliteGrantRepository, bootstrapAccess, createToolAccess } from '../../dist/authz/index.js';
import { ToolCallDeniedError, createAuditStage, createAuthorizeStage, createToolCallPipeline, filterToolList, passResult, runToolCall } from '../../dist/pipeline/index.js';
import { SqliteAuditLog, toolCallRecorder } from '../../dist/audit/index.js';
import { SqliteBrainRepository } from '../../dist/brains/index.js';
import { openGatewayDatabase } from '../../dist/shared/gateway-database.js';
import { ENGRAM_TOOLS } from '../fixtures/engram-tools.mjs';

function scratchDb(t) {
  const dir = mkdtempSync(join(tmpdir(), 'engram-gateway-authz-'));
  const db = openGatewayDatabase(join(dir, 'gateway.db'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return db;
}

function withBrains(db, slugs) {
  const brains = new SqliteBrainRepository(db);
  for (const slug of slugs) brains.ensure(slug, `/data/brains/${slug}`);
  return slugs;
}

// --- the pipeline ---

const CALLER = { login: 'alice', clientId: 'client-1' };

function auditedPipeline(t, check) {
  const db = scratchDb(t);
  let now = 1_800_000_000_000;
  const record = toolCallRecorder(new SqliteAuditLog(db), { nowMs: () => (now += 5) });
  const pipeline = createToolCallPipeline({ authorize: createAuthorizeStage(check), audit: createAuditStage({ record }), wrap: passResult });
  return { db, pipeline };
}

const readerOnly = { check: (caller, brain, tool) => (caller?.login === 'alice' && brain === 'work' && TOOL_ROLES[tool] === 'reader' ? { allowed: true } : { allowed: false, reason: 'insufficient_role' }) };

test('authorize stage: a denied call is never forwarded, throws ToolCallDeniedError and is audited as denied', async t => {
  const { db, pipeline } = auditedPipeline(t, readerOnly);
  let forwarded = 0;
  const forward = async () => { forwarded += 1; return { content: [{ type: 'text', text: 'saved' }] }; };
  await assert.rejects(
    runToolCall(pipeline, { name: 'mem_save', arguments: { content: 'secret note' } }, forward, { caller: CALLER, brain: 'work' }),
    error => error instanceof ToolCallDeniedError && error.reason === 'insufficient_role' && /mem_save/.test(error.message)
  );
  assert.equal(forwarded, 0, 'nothing reached engram');
  const rows = [...new SqliteAuditLog(db).read()];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].target, 'mem_save');
  assert.equal(rows[0].outcome, 'denied');
  assert.equal(rows[0].actorLogin, 'alice');
  assert.equal(rows[0].brain, 'work');
  assert.ok(!JSON.stringify(rows[0]).includes('secret note'), 'no argument values in the audit row');
});

test('authorize stage: an allowed call is forwarded and audited as ok', async t => {
  const { db, pipeline } = auditedPipeline(t, readerOnly);
  const result = await runToolCall(pipeline, { name: 'mem_search', arguments: { query: 'x' } }, async () => ({ content: [] }), { caller: CALLER, brain: 'work' });
  assert.deepEqual(result, { content: [] });
  assert.deepEqual(db.prepare('SELECT target, outcome FROM audit_log').all().map(row => ({ ...row })), [{ target: 'mem_search', outcome: 'ok' }]);
});

test('tools/list filter keeps exactly the tools the caller may call', () => {
  const tools = ENGRAM_TOOLS.map(name => ({ name })).concat({ name: 'mem_brand_new' });
  const visible = filterToolList(readerOnly, { caller: CALLER, brain: 'work' }, tools).map(tool => tool.name);
  assert.deepEqual(visible, ENGRAM_TOOLS.filter(name => TOOL_ROLES[name] === 'reader'));
  assert.deepEqual(filterToolList(readerOnly, { caller: { login: 'mallory' }, brain: 'work' }, tools), []);
});

test('pinned: the default pipeline (auth off) still allows every call', async () => {
  const pipeline = createToolCallPipeline({ wrap: passResult });
  const result = await runToolCall(pipeline, { name: 'mem_brand_new' }, async () => ({ content: [] }));
  assert.deepEqual(result, { content: [] });
});

// --- over HTTP, through the real app, bridge and grants (fake engram child) ---

test('over HTTP: a reader sees only reader tools, a denied mem_save is an MCP error, never forwarded, audited as denied', async t => {
  const { createServer } = await import('node:http');
  const express = (await import('express')).default;
  const { fileURLToPath } = await import('node:url');
  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const { createGatewayApp } = await import('../../dist/http/app.js');
  const { BrainRegistry } = await import('../../dist/brains/index.js');
  const { createEngramBridge } = await import('../../dist/bridge/index.js');
  const fixture = fileURLToPath(new URL('../fixtures/fake-mcp-server.mjs', import.meta.url));
  const logger = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(l => [l, () => {}]));

  const db = scratchDb(t);
  const brains = withBrains(db, ['default', 'team']);
  const grants = new SqliteGrantRepository(db);
  bootstrapAccess(grants, { admins: ['FullFran'], grants: [{ login: 'alice', brain: 'team', role: 'reader' }], brains });
  const record = toolCallRecorder(new SqliteAuditLog(db), { nowMs: () => Date.now() });
  const pipeline = createToolCallPipeline({ access: createToolAccess(grants), audit: createAuditStage({ record }), wrap: passResult });
  const registry = new BrainRegistry({
    brains: new Map(brains.map(slug => [slug, { slug, dataDir: `/unused/${slug}`, cloudSync: false }])),
    createProcess: brain => createEngramBridge({ command: process.execPath, args: [fixture], logger, pipeline, brain: brain.slug }),
    clock: { now: () => Date.now() }, idleTimeoutMs: 60_000, maxLiveBrains: 2, logger
  });
  t.after(() => registry.stopAll());
  let login = 'alice';
  const authenticator = { prepare: async () => {}, authenticate: () => ({ ok: true, principal: { login, clientId: 'c1', scopes: ['memory'], token: 't' } }) };
  const app = createGatewayApp({
    bindHost: '127.0.0.1', trustProxy: false, logger, brains: registry,
    auth: { router: express.Router(), authenticator, resource: 'http://127.0.0.1/mcp' },
    brainAccess: { mayOpen: (who, brain) => grants.roleOf(who, brain) !== undefined }
  });
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }));
  const url = path => new URL(`http://127.0.0.1:${server.address().port}${path}`);
  const connect = async path => {
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(url(path)));
    t.after(() => client.close().catch(() => {}));
    return client;
  };

  const reader = await connect('/mcp/team');
  const { tools } = await reader.listTools();
  assert.deepEqual(tools.map(tool => tool.name), ['mem_search'], 'echo/fail/... are unmapped (hidden), mem_save needs writer');
  await assert.rejects(reader.callTool({ name: 'mem_save', arguments: { content: 'reader note' } }), error => error.code === -32602 && /mem_save/.test(error.message));
  await assert.rejects(reader.callTool({ name: 'echo', arguments: { text: 'x' } }), error => error.code === -32602, 'an unmapped tool is refused even when called directly');
  const found = await reader.callTool({ name: 'mem_search', arguments: { text: 'hello' } });
  assert.ok(!found.isError);

  const rows = [...new SqliteAuditLog(db).read()].map(row => [row.actorLogin, row.brain, row.target, row.outcome]);
  assert.deepEqual(rows, [['alice', 'team', 'mem_save', 'denied'], ['alice', 'team', 'echo', 'denied'], ['alice', 'team', 'mem_search', 'ok']]);

  // The admin owns every brain and sees every mapped tool the fake serves.
  login = 'FullFran';
  const owner = await connect('/mcp/team');
  assert.deepEqual((await owner.listTools()).tools.map(tool => tool.name).sort(), ['mem_save', 'mem_search']);
  const saved = await owner.callTool({ name: 'mem_save', arguments: { content: 'owner note' } });
  assert.ok(!saved.isError, 'the fake engram received the owner call');

  // No grant on default: 403 at the HTTP layer.
  login = 'alice';
  const denied = await fetch(url('/mcp'), { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
  assert.equal(denied.status, 403);
});
