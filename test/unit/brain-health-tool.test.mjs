// Gateway tools (#18 phase B): tools the gateway serves itself, merged into
// engram's tools/list and run through the same pipeline (authorize -> host paths -> redact ->
// handler -> audit -> wrap). First tool: brain_health (owner only), plus the
// admin-only HTTP endpoint GET /admin/brains/<slug>/health.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { addObservation, addRelation, createBrainDb } from '../fixtures/engram-brain.mjs';
import { GATEWAY_TOOL_ROLES, SqliteGrantRepository, TOOL_ROLES, bootstrapAccess, createToolAccess, decideTool, requiredRole } from '../../dist/authz/index.js';
import { SqliteAuditLog, toolCallRecorder } from '../../dist/audit/index.js';
import { BrainRegistry, SqliteBrainRepository } from '../../dist/brains/index.js';
import { createEngramBridge } from '../../dist/bridge/index.js';
import { createGatewayApp } from '../../dist/http/app.js';
import { createAuditStage, createToolCallPipeline } from '../../dist/pipeline/index.js';
import { openGatewayDatabase } from '../../dist/shared/gateway-database.js';
import { createEngramBrainHealthService } from '../../dist/health/index.js';
import { BRAIN_HEALTH_TOOL, createBrainHealthTool, createGatewayToolSet, mergeToolLists } from '../../dist/gateway-tools/index.js';

const FAKE_ENGRAM = fileURLToPath(new URL('../fixtures/fake-mcp-server.mjs', import.meta.url));
const logger = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level, () => {}]));
const NOW_MS = Date.parse('2026-11-19T10:00:00Z');

function scratch(t, prefix = 'engram-gateway-gwtools-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A brain data dir with 3 live observations (2 passive, a duplicate title pair) and 1 pending relation. */
function seededBrainDir(t) {
  const dir = scratch(t, 'engram-gateway-brain-');
  const db = createBrainDb(dir);
  addObservation(db, { type: 'passive', title: 'same' });
  addObservation(db, { type: 'passive', title: 'same' });
  addObservation(db, { type: 'decision', title: 'other', reviewAfter: '2026-01-01 00:00:00' });
  addRelation(db, { status: 'pending' });
  db.close();
  return dir;
}

const EXPECTED_SEEDED = {
  observations: { live: 3, deleted: 0 },
  noise: { types: ['checkpoint', 'passive', 'task-state'], count: 2, share: 0.6667, sampleIds: [1, 2] },
  duplicateTitles: { groups: 1, rows: 2, excessRows: 1, sampleIds: [1, 2] },
  pendingRelations: { count: 1, sampleIds: [1] },
  pastReviewAfter: { count: 1, sampleIds: [3] },
};

/** The JSON inside the result's memory-data block (the wrap stage delimits it as data). */
function unwrapJson(result) {
  const text = result.content.map(item => item.text).join('\n');
  const match = /<memory-data nonce="(\w+)">\n([\s\S]*)\n<\/memory-data nonce="\1">/.exec(text);
  assert.ok(match, `result is wrapped as data: ${text.slice(0, 120)}`);
  return JSON.parse(match[2]);
}

// --- the mechanism ---

test('a gateway tool set lists its definitions, calls a tool by name and refuses duplicate names', async () => {
  const echo = { definition: { name: 'gw_echo', description: 'echo', inputSchema: { type: 'object' } }, call: async (args, ctx) => ({ content: [{ type: 'text', text: `${ctx.brain}:${args.x}` }] }) };
  const set = createGatewayToolSet([echo]);
  assert.deepEqual(set.definitions().map(tool => tool.name), ['gw_echo']);
  assert.equal(set.has('gw_echo'), true);
  assert.equal(set.has('mem_save'), false);
  assert.deepEqual(await set.call('gw_echo', { x: 1 }, { brain: 'team' }), { content: [{ type: 'text', text: 'team:1' }] });
  await assert.rejects(set.call('nope', {}, { brain: 'team' }), /not a gateway tool/);
  assert.throws(() => createGatewayToolSet([echo, echo]), /duplicate gateway tool gw_echo/);
});

test('merged tools/list: engram tools first, then gateway tools; a gateway tool shadows an engram tool of the same name', () => {
  const merged = mergeToolLists([{ name: 'mem_search' }, { name: 'brain_health', description: 'engram one' }], [{ name: 'brain_health', description: 'gateway one' }]);
  assert.deepEqual(merged, [{ name: 'mem_search' }, { name: 'brain_health', description: 'gateway one' }]);
});

// --- roles ---

test('brain_health needs the owner role (instance admins own every brain); the engram role table is unchanged', () => {
  assert.equal(BRAIN_HEALTH_TOOL, 'brain_health');
  assert.equal(GATEWAY_TOOL_ROLES.brain_health, 'owner');
  assert.equal(requiredRole('brain_health'), 'owner');
  assert.equal(Object.hasOwn(TOOL_ROLES, 'brain_health'), false, 'TOOL_ROLES stays the table of engram tools only (check-bridge compares it with engram)');
  assert.deepEqual(decideTool({ user: 'owner' }, 'brain_health'), { allowed: true, role: 'owner' });
  assert.deepEqual(decideTool({ user: 'writer' }, 'brain_health'), { allowed: false, reason: 'insufficient_role', role: 'writer', required: 'owner' });
  assert.deepEqual(decideTool({ user: 'reader' }, 'brain_health'), { allowed: false, reason: 'insufficient_role', role: 'reader', required: 'owner' });
  // Pinned: engram tools keep their roles and unknown tools stay denied.
  assert.equal(requiredRole('mem_save'), 'writer');
  assert.equal(requiredRole('mem_brand_new'), undefined);
});

// --- the brain_health tool on its own ---

test('brain_health returns the report of the brain the call was routed to, as JSON text', async t => {
  const dir = seededBrainDir(t);
  const service = createEngramBrainHealthService({ dataDirOf: slug => (slug === 'team' ? dir : undefined), nowMs: () => NOW_MS });
  const tool = createBrainHealthTool(service);
  assert.equal(tool.definition.name, 'brain_health');
  assert.deepEqual(Object.keys(tool.definition.inputSchema.properties).sort(), ['maxTypes', 'sampleSize']);
  assert.equal(tool.definition.annotations.readOnlyHint, true);
  const result = await tool.call({ sampleSize: 1 }, { brain: 'team' });
  assert.equal(result.isError, undefined);
  const report = JSON.parse(result.content[0].text);
  assert.equal(report.brain, 'team');
  assert.equal(report.generatedAt, '2026-11-19T10:00:00.000Z');
  assert.deepEqual(report.noise.sampleIds, [1]);
  assert.deepEqual(report.duplicateTitles, { ...EXPECTED_SEEDED.duplicateTitles, sampleIds: [1] });
});

test('brain_health tool errors: no engram.db yet, unknown brain, invalid arguments', async t => {
  const empty = scratch(t);
  const service = createEngramBrainHealthService({ dataDirOf: slug => (slug === 'fresh' ? empty : undefined), nowMs: () => NOW_MS });
  const tool = createBrainHealthTool(service);
  const fresh = await tool.call({}, { brain: 'fresh' });
  assert.equal(fresh.isError, true);
  assert.match(fresh.content[0].text, /no engram\.db/);
  const unknown = await tool.call({}, { brain: 'ghost' });
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /unknown brain/);
  for (const bad of [{ sampleSize: -1 }, { sampleSize: 1.5 }, { maxTypes: 'many' }, { extra: 1 }]) {
    const result = await tool.call(bad, { brain: 'fresh' });
    assert.equal(result.isError, true, JSON.stringify(bad));
    assert.match(result.content[0].text, /invalid arguments/);
  }
});

// --- over HTTP, through the bridge and the whole pipeline ---

async function gateway(t, { auth = true } = {}) {
  const dbDir = scratch(t, 'engram-gateway-db-');
  const db = openGatewayDatabase(join(dbDir, 'gateway.db'));
  t.after(() => db.close());
  const slugs = ['default', 'team'];
  const repo = new SqliteBrainRepository(db);
  const dataDirs = { default: scratch(t), team: seededBrainDir(t) };
  for (const slug of slugs) repo.ensure(slug, dataDirs[slug]);
  const grants = new SqliteGrantRepository(db);
  bootstrapAccess(grants, {
    admins: ['FullFran'],
    grants: [{ login: 'olive', brain: 'team', role: 'owner' }, { login: 'wendy', brain: 'team', role: 'writer' }, { login: 'rita', brain: 'team', role: 'reader' }],
    brains: slugs,
  });
  const auditLog = new SqliteAuditLog(db);
  const pipeline = createToolCallPipeline({
    ...(auth ? { access: createToolAccess(grants) } : {}),
    audit: createAuditStage({ record: toolCallRecorder(auditLog, { nowMs: () => Date.now() }) }),
  });
  const health = createEngramBrainHealthService({ dataDirOf: slug => dataDirs[slug], nowMs: () => NOW_MS });
  const gatewayTools = createGatewayToolSet([createBrainHealthTool(health)]);
  const registry = new BrainRegistry({
    brains: new Map(slugs.map(slug => [slug, { slug, dataDir: dataDirs[slug], cloudSync: false }])),
    createProcess: brain => createEngramBridge({ command: process.execPath, args: [FAKE_ENGRAM], logger, pipeline, gatewayTools, brain: brain.slug }),
    clock: { now: () => Date.now() }, idleTimeoutMs: 60_000, maxLiveBrains: 2, logger,
  });
  t.after(() => registry.stopAll());
  const state = { login: 'FullFran', lastOptions: undefined };
  const authenticator = {
    prepare: async () => {},
    authenticate: (headers, options) => {
      state.lastOptions = options;
      if (!headers.authorization) return { ok: false, status: 401, error: 'unauthorized', challenge: 'Bearer realm="test"' };
      return { ok: true, principal: { login: state.login, clientId: 'c1', scopes: ['memory'], token: 't' } };
    },
  };
  const app = createGatewayApp({
    bindHost: '127.0.0.1', trustProxy: false, logger, brains: registry,
    ...(auth ? {
      auth: { router: express.Router(), authenticator, resource: 'http://127.0.0.1/mcp' },
      brainAccess: { mayOpen: (who, brain) => grants.roleOf(who, brain) !== undefined },
    } : {}),
    admin: { isAdmin: login => grants.isAdmin(login), brainHealth: (slug, options) => health.report(slug, options) },
  });
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }));
  const url = path => new URL(`http://127.0.0.1:${server.address().port}${path}`);
  const connect = async path => {
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(url(path), { requestInit: { headers: { authorization: 'Bearer t' } } }));
    t.after(() => client.close().catch(() => {}));
    return client;
  };
  const audit = () => [...auditLog.read()].map(row => [row.actorLogin, row.brain, row.target, row.outcome]);
  const auditRows = () => [...auditLog.read()];
  return { state, url, connect, audit, auditRows };
}

test('over MCP: an owner sees brain_health next to engram tools and gets the report; it never reaches engram and is audited', async t => {
  const gw = await gateway(t);
  gw.state.login = 'olive';
  const owner = await gw.connect('/mcp/team');
  const names = (await owner.listTools()).tools.map(tool => tool.name);
  assert.deepEqual(names, ['mem_save', 'mem_search', 'brain_health']);
  const result = await owner.callTool({ name: 'brain_health', arguments: {} });
  assert.ok(!result.isError, 'handled by the gateway: the fake engram would answer "unknown tool brain_health" with isError');
  const report = unwrapJson(result);
  assert.equal(report.brain, 'team');
  for (const [key, value] of Object.entries(EXPECTED_SEEDED)) assert.deepEqual(report[key], value, key);
  assert.deepEqual(gw.audit(), [['olive', 'team', 'brain_health', 'ok']]);
});

test('over MCP: writers and readers neither see nor may call brain_health; refusals are audited as denied', async t => {
  const gw = await gateway(t);
  for (const login of ['wendy', 'rita']) {
    gw.state.login = login;
    const client = await gw.connect('/mcp/team');
    assert.ok(!(await client.listTools()).tools.some(tool => tool.name === 'brain_health'), `${login} does not see brain_health`);
    await assert.rejects(client.callTool({ name: 'brain_health', arguments: {} }), error => error.code === -32602 && /brain_health/.test(error.message));
  }
  assert.deepEqual(gw.audit(), [['wendy', 'team', 'brain_health', 'denied'], ['rita', 'team', 'brain_health', 'denied']]);
  assert.deepEqual(gw.auditRows().map(row => row.meta.denyReason), ['insufficient_role', 'insufficient_role'], 'a denied gateway-tool call audits why (#32)');
});

test('over MCP: gateway tools pass the host-paths stage; cwd and directory never reach the handler and the audit row counts them', async t => {
  const gw = await gateway(t);
  gw.state.login = 'olive';
  const owner = await gw.connect('/mcp/team');
  // brain_health refuses unknown options, so a success proves cwd and directory were dropped before the handler.
  const result = await owner.callTool({ name: 'brain_health', arguments: { cwd: '/etc', directory: '/root', sampleSize: 1 } });
  assert.ok(!result.isError, `host path arguments were stripped: ${JSON.stringify(result.content).slice(0, 200)}`);
  assert.deepEqual(unwrapJson(result).noise.sampleIds, [1]);
  const rows = gw.auditRows();
  assert.deepEqual(rows.map(row => [row.target, row.outcome, row.meta.hostPathArguments]), [['brain_health', 'ok', 2]]);
  assert.ok(!JSON.stringify(rows).includes('/etc') && !JSON.stringify(rows).includes('/root'), 'no host path in the audit log');
});

test('over MCP: the instance admin gets the report of a brain without engram.db as a tool error', async t => {
  const gw = await gateway(t);
  const admin = await gw.connect('/mcp');
  const result = await admin.callTool({ name: 'brain_health', arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.content.map(item => item.text).join('\n'), /no engram\.db/);
  assert.deepEqual(gw.audit(), [['FullFran', 'default', 'brain_health', 'error']], 'a tool error result is audited as error');
});

// --- the admin endpoint ---

test('GET /admin/brains/<slug>/health: admin only, authenticated against the brain resource (bearer or session)', async t => {
  const gw = await gateway(t);
  const get = (path, headers = { authorization: 'Bearer t' }) => fetch(gw.url(path), { headers });

  const anonymous = await get('/admin/brains/team/health', {});
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get('www-authenticate'), 'Bearer realm="test"');
  assert.deepEqual(gw.state.lastOptions, { resource: ['http://127.0.0.1/mcp/team'], acceptSession: true });

  gw.state.login = 'olive';
  const owner = await get('/admin/brains/team/health');
  assert.equal(owner.status, 403, 'a brain owner who is not an instance admin is refused');
  assert.deepEqual(await owner.json(), { error: 'forbidden' });

  gw.state.login = 'FullFran';
  const ok = await get('/admin/brains/team/health?sampleSize=1');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  const report = await ok.json();
  assert.equal(report.brain, 'team');
  assert.deepEqual(report.observations, EXPECTED_SEEDED.observations);
  assert.deepEqual(report.noise.sampleIds, [1]);
  assert.deepEqual(report.pendingRelations, EXPECTED_SEEDED.pendingRelations);

  assert.deepEqual([(await get('/admin/brains/ghost/health')).status], [404]);
  const fresh = await get('/admin/brains/default/health');
  assert.equal(fresh.status, 404);
  assert.deepEqual(await fresh.json(), { error: 'no_data' });
  const bad = await get('/admin/brains/team/health?sampleSize=-3');
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: 'invalid_request' });
  assert.deepEqual(gw.audit(), [], 'the admin endpoint is not a tool call');
});

test('GET /admin/brains/<slug>/health with auth off (loopback) is open, like /mcp', async t => {
  const gw = await gateway(t, { auth: false });
  const response = await fetch(gw.url('/admin/brains/team/health'));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).observations, EXPECTED_SEEDED.observations);
});

test('pinned: without gateway tools the bridge lists and forwards engram tools only', async t => {
  const bridge = createEngramBridge({ command: process.execPath, args: [FAKE_ENGRAM], logger });
  t.after(() => bridge.close());
  await bridge.start();
  const { createMcpHandler } = await import('@modelcontextprotocol/server');
  const handler = createMcpHandler(bridge.factory);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), { fetch: (input, init) => handler.fetch(new Request(input, init)) }));
  t.after(() => client.close().catch(() => {}));
  const names = (await client.listTools()).tools.map(tool => tool.name);
  assert.ok(!names.includes('brain_health'));
  const forwarded = await client.callTool({ name: 'brain_health', arguments: {} });
  assert.equal(forwarded.isError, true, 'forwarded to engram, which does not know it');
});
