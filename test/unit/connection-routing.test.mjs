// Connections on the bare /mcp endpoint (#27): one MCP server for every brain
// of the caller's connection. tools/list gets a `brain` argument listing the
// connection's brains; tools/call routes to the named brain (else the
// connection's default brain) through the full pipeline; `brain: "*"` fans a
// read tool out to every brain. Real app, registry, bridges (fake engram
// child per brain) and SQLite grants and connections.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { GATEWAY_TOOL_ROLES, TOOL_ROLES, SqliteGrantRepository, bootstrapAccess, createToolAccess } from '../../dist/authz/index.js';
import { CONNECTION_TOOL_KINDS } from '../../dist/authz/index.js';
import { createBrainHealthTool, createBrainResolveTool, createConnectionTools, createGatewayToolSet, parseRemoteMapping } from '../../dist/gateway-tools/index.js';
import { SqliteAuditLog, toolCallRecorder } from '../../dist/audit/index.js';
import { BrainRegistry, SqliteBrainRepository } from '../../dist/brains/index.js';
import { createConnectionServer, createEngramBridge } from '../../dist/bridge/index.js';
import { ConnectionAdmin, FAN_OUT_TOOLS, SqliteConnectionStore, resolveTarget } from '../../dist/connections/index.js';
import { createGatewayApp } from '../../dist/http/app.js';
import { createAuditStage, createToolCallPipeline, passResult } from '../../dist/pipeline/index.js';
import { openGatewayDatabase } from '../../dist/shared/gateway-database.js';

const fixture = fileURLToPath(new URL('../fixtures/fake-mcp-server.mjs', import.meta.url));
const logger = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level, () => {}]));
/** `slow` hangs on mem_search (or fails, `slowMode: 'fail'`). */
const ALL = ['default', 'alpha', 'beta', 'gamma', 'slow'];

/**
 * `owner-o` is owner on alpha, beta, gamma and slow (not on default). Its
 * connection `c` has alpha (reader, the default brain) and beta (writer).
 * `kind`: a `token` connection (default) or an `oauth` one; `tools`: serve
 * the connection tools (brain_list, connection_*).
 */
/** The connection most tests use: no `owner` role, so it cannot manage its own brains. */
const CHOICE = { name: 'c', defaultBrain: 'alpha', brains: [{ brain: 'alpha', role: 'reader' }, { brain: 'beta', role: 'writer' }] };
/** Owner on `slow`: the connection may attach and detach (#27: owner role on the connection). */
const MANAGER = { name: 'c', defaultBrain: 'alpha', brains: [...CHOICE.brains, { brain: 'slow', role: 'owner' }] };

async function gateway(t, { fanOutTimeoutMs = 5000, slowMode = 'hang', withDefault = true, maxFanOutsPerLogin, kind = 'token', tools = false, choice = CHOICE, remotes = '' } = {}) {
  const BRAINS = withDefault ? ALL : ALL.filter(slug => slug !== 'default');
  const dir = mkdtempSync(join(tmpdir(), 'engram-gateway-connection-routing-'));
  const db = openGatewayDatabase(join(dir, 'gateway.db'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const repo = new SqliteBrainRepository(db);
  for (const slug of BRAINS) repo.ensure(slug, `/data/brains/${slug}`);
  const grants = new SqliteGrantRepository(db);
  bootstrapAccess(grants, {
    admins: [],
    grants: ['alpha', 'beta', 'gamma', 'slow'].map(brain => ({ login: 'owner-o', brain, role: 'owner' })).concat(withDefault ? [{ login: 'other-u', brain: 'default', role: 'owner' }] : []),
    brains: BRAINS
  });
  const connections = new SqliteConnectionStore(db);
  const connectionId = kind === 'oauth' ? connections.saveOAuth('owner-o', 'c1', choice) : connections.createToken('owner-o', choice);
  const pipeline = createToolCallPipeline({
    access: createToolAccess(grants, connections),
    audit: createAuditStage({ record: toolCallRecorder(new SqliteAuditLog(db), { nowMs: () => Date.now() }) }),
    wrap: passResult
  });
  const healthAsked = [];
  const gatewayTools = createGatewayToolSet(
    [
      createBrainHealthTool({ report: brain => { healthAsked.push(brain); return { ok: false, reason: 'no_data', message: `no data for ${brain}` }; } }),
      createBrainResolveTool({ rules: parseRemoteMapping(remotes), connections: new ConnectionAdmin(grants, connections) })
    ],
    { engram: TOOL_ROLES, gateway: GATEWAY_TOOL_ROLES }
  );
  /** Every lease the connection server takes, by brain. */
  const leases = [];
  const registry = new BrainRegistry({
    brains: new Map(BRAINS.map(slug => [slug, { slug, dataDir: `/unused/${slug}`, cloudSync: false }])),
    createProcess: brain => createEngramBridge({
      command: process.execPath, args: [fixture], logger, pipeline, brain: brain.slug,
      env: { PATH: process.env.PATH ?? '', FAKE_BRAIN: brain.slug, ...(brain.slug === 'slow' ? { [slowMode === 'fail' ? 'FAKE_FAIL_SEARCH' : 'FAKE_SLOW_SEARCH']: '1' } : {}) }
    }),
    clock: { now: () => Date.now() }, idleTimeoutMs: 60_000, maxLiveBrains: BRAINS.length, logger
  });
  t.after(() => registry.stopAll());
  const principal = { login: 'owner-o', clientId: 'c1', scopes: ['memory'], token: 't', connectionId };
  const authenticator = { prepare: async () => {}, authenticate: () => ({ ok: true, principal }) };
  const app = createGatewayApp({
    bindHost: '127.0.0.1', trustProxy: false, logger, brains: registry,
    auth: { router: express.Router(), authenticator, resource: 'http://127.0.0.1/mcp' },
    brainAccess: { mayOpen: (who, brain) => grants.roleOf(who, brain) !== undefined },
    connectionServer: createConnectionServer({
      brains: { has: slug => registry.has(slug), acquire: slug => { leases.push(slug); return registry.acquire(slug); } },
      connections, pipeline, gatewayTools, logger, fanOutTimeoutMs,
      ...(maxFanOutsPerLogin !== undefined ? { maxFanOutsPerLogin } : {}),
      ...(tools ? { connectionTools: connectionToolsFor(grants, connections) } : {})
    })
  });
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }));
  const connect = async (path = '/mcp') => {
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}${path}`)));
    t.after(() => client.close().catch(() => {}));
    return client;
  };
  const audit = () => [...new SqliteAuditLog(db).read()].map(row => [row.brain, row.target, row.outcome, row.meta?.connectionId]);
  return { db, connectionId, principal, connect, audit, healthAsked, registry, leases };
}

const brainEnum = tool => tool.inputSchema.properties?.brain?.enum;
const deniedCall = error => error.code === -32602;

test('tools/list on /mcp: tools allowed on at least one of the connection\'s brains, each with a `brain` argument naming exactly its brains', async t => {
  const g = await gateway(t);
  const client = await g.connect();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['brain_resolve', 'mem_save', 'mem_search'], 'mem_save: writer on beta; brain_resolve: reader; unmapped tools and brain_health (owner) hidden');
  const byName = Object.fromEntries(tools.map(tool => [tool.name, tool]));
  assert.deepEqual(brainEnum(byName.mem_save), ['alpha', 'beta']);
  assert.deepEqual(brainEnum(byName.mem_search), ['alpha', 'beta', '*'], 'a fan-out read tool also takes "*"');
  assert.equal(byName.mem_save.inputSchema.type, 'object');
  assert.ok(!byName.mem_save.inputSchema.required?.includes('brain'), '`brain` is optional (default brain)');
});

test('tools/call routes to the named brain with the connection\'s role there: a reader brain refuses mem_save (MCP error, never forwarded, audited)', async t => {
  const g = await gateway(t);
  const client = await g.connect();
  await assert.rejects(client.callTool({ name: 'mem_save', arguments: { brain: 'alpha', content: 'x' } }), deniedCall);
  const saved = await client.callTool({ name: 'mem_save', arguments: { brain: 'beta', content: 'note' } });
  assert.ok(!saved.isError);
  assert.deepEqual(saved.structuredContent.received, { content: 'note' }, 'the `brain` argument is not forwarded to engram');
  assert.deepEqual(g.audit(), [['alpha', 'mem_save', 'denied', g.connectionId], ['beta', 'mem_save', 'ok', g.connectionId]]);
});

test('tools/call without `brain` goes to the connection\'s default brain', async t => {
  const g = await gateway(t);
  const client = await g.connect();
  const found = await client.callTool({ name: 'mem_search', arguments: { text: 'hello' } });
  assert.equal(found.structuredContent.results[0].brain, 'alpha');
});

test('a brain outside the connection and an unknown brain are refused the same way (same text), both audited as denied', async t => {
  const g = await gateway(t);
  const client = await g.connect();
  const refusal = async brain => {
    try {
      await client.callTool({ name: 'mem_search', arguments: { brain, text: 'x' } });
    } catch (error) {
      assert.ok(deniedCall(error), String(error));
      return error.message;
    }
    assert.fail(`${brain} was not refused`);
  };
  const outside = await refusal('gamma');
  assert.equal(await refusal('nope'), outside, 'an unknown brain is indistinguishable from one outside the connection');
  await assert.rejects(client.callTool({ name: 'mem_search', arguments: { brain: 7, text: 'x' } }), deniedCall);
  assert.deepEqual(g.audit(), [['gamma', 'mem_search', 'denied', g.connectionId], ['nope', 'mem_search', 'denied', g.connectionId]]);
  assert.ok(!g.leases.includes('nope') && !g.leases.includes('gamma'), 'no lease on a refused brain');
});

test('brain "*" fans a read tool out to every brain of the connection: one tagged section and one structured result per brain', async t => {
  const g = await gateway(t);
  const client = await g.connect();
  const result = await client.callTool({ name: 'mem_search', arguments: { brain: '*', text: 'q' } });
  assert.ok(!result.isError);
  assert.deepEqual(result.content.map(item => item.text), ['brain: alpha', 'alpha: q', 'brain: beta', 'beta: q']);
  assert.deepEqual(result.structuredContent.results.map(r => [r.brain, r.structuredContent?.results[0].brain]), [['alpha', 'alpha'], ['beta', 'beta']]);
  assert.deepEqual(g.audit(), [['alpha', 'mem_search', 'ok', g.connectionId], ['beta', 'mem_search', 'ok', g.connectionId]], 'each brain ran the pipeline');
  await assert.rejects(client.callTool({ name: 'mem_save', arguments: { brain: '*', content: 'x' } }), error => deniedCall(error) && /\*/.test(error.message));
});

test('fan-out has a time bound: a brain that does not answer in time is an error entry, the others still answer', async t => {
  const g = await gateway(t, { fanOutTimeoutMs: 1500 });
  g.db.prepare("INSERT INTO connection_brains (connection_id, brain_id, role) SELECT ?, id, 'reader' FROM brains WHERE slug = 'slow'").run(g.connectionId);
  const client = await g.connect();
  const started = Date.now();
  const result = await client.callTool({ name: 'mem_search', arguments: { brain: '*', text: 'q' } });
  assert.ok(Date.now() - started < 4000, 'bounded by the fan-out timeout');
  assert.ok(!result.isError, 'not every brain failed');
  const byBrain = Object.fromEntries(result.structuredContent.results.map(r => [r.brain, r]));
  assert.deepEqual(Object.keys(byBrain), ['alpha', 'beta', 'slow']);
  assert.match(byBrain.slow.error, /timed out/);
  assert.ok(result.content.some(item => /^brain: slow\b.*timed out/.test(item.text)));
});

test('detaching a brain applies to the next request: gone from the `brain` list, and a call to it is refused', async t => {
  const g = await gateway(t);
  const client = await g.connect();
  g.db.prepare("DELETE FROM connection_brains WHERE connection_id = ? AND brain_id = (SELECT id FROM brains WHERE slug = 'beta')").run(g.connectionId);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => [tool.name, brainEnum(tool)]), [['mem_search', ['alpha', '*']], ['brain_resolve', ['alpha']]]);
  await assert.rejects(client.callTool({ name: 'mem_save', arguments: { brain: 'beta', content: 'x' } }), deniedCall);
});

test('fails closed with a clear MCP error: default brain detached, or the owner lost the grant (no HTTP 403: the owner has no grant on default)', async t => {
  const g = await gateway(t);
  const client = await g.connect();
  g.db.prepare("DELETE FROM connection_brains WHERE connection_id = ? AND brain_id = (SELECT id FROM brains WHERE slug = 'alpha')").run(g.connectionId);
  await assert.rejects(client.callTool({ name: 'mem_search', arguments: { text: 'x' } }), error => deniedCall(error) && /no default brain/.test(error.message) && /beta/.test(error.message));
  assert.ok(!(await client.callTool({ name: 'mem_search', arguments: { brain: 'beta', text: 'x' } })).isError);
  g.db.prepare("DELETE FROM grants WHERE brain_id = (SELECT id FROM brains WHERE slug = 'beta')").run();
  await assert.rejects(client.callTool({ name: 'mem_search', arguments: { brain: 'beta', text: 'x' } }), deniedCall);
  g.db.prepare('DELETE FROM connections WHERE id = ?').run(g.connectionId);
  await assert.rejects(client.callTool({ name: 'mem_search', arguments: { brain: 'beta', text: 'x' } }), error => deniedCall(error) && /connection/.test(error.message));
});

test('a token without a connection on /mcp keeps the default brain, with no `brain` argument (pins the single-brain path)', async t => {
  const g = await gateway(t);
  delete g.principal.connectionId;
  g.principal.login = 'other-u';
  const client = await g.connect();
  const { tools } = await client.listTools();
  assert.ok(tools.length > 0 && tools.every(tool => brainEnum(tool) === undefined));
  const found = await client.callTool({ name: 'mem_search', arguments: { text: 'x' } });
  assert.equal(found.structuredContent.results[0].brain, 'default');
});

test('gateway tools are served on /mcp too, routed by `brain` like engram tools, with the connection\'s role', async t => {
  const g = await gateway(t);
  const client = await g.connect();
  assert.ok(!(await client.listTools()).tools.some(tool => tool.name === 'brain_health'), 'brain_health needs owner: the connection is at most writer');
  g.db.prepare("UPDATE connection_brains SET role = 'owner' WHERE connection_id = ? AND brain_id = (SELECT id FROM brains WHERE slug = 'beta')").run(g.connectionId);
  const health = (await client.listTools()).tools.find(tool => tool.name === 'brain_health');
  assert.deepEqual(brainEnum(health), ['alpha', 'beta']);
  await assert.rejects(client.callTool({ name: 'brain_health', arguments: { brain: 'alpha' } }), deniedCall);
  const result = await client.callTool({ name: 'brain_health', arguments: { brain: 'beta' } });
  assert.match(result.content.map(item => item.text).join('\n'), /no data for beta/);
  assert.deepEqual(g.healthAsked, ['beta']);
});

// --- review fixes (#36/#38) ---

test('mem_timeline is not a fan-out tool: its observation id belongs to one brain', () => {
  assert.ok(!FAN_OUT_TOOLS.has('mem_timeline'));
  const target = resolveTarget('mem_timeline', { brain: '*', observation_id: 3 }, ['alpha', 'beta'], 'alpha');
  assert.equal(target.kind, 'invalid');
  assert.deepEqual(resolveTarget('mem_timeline', { brain: 'beta', observation_id: 3 }, ['alpha', 'beta'], 'alpha'), { kind: 'one', brain: 'beta', arguments: { observation_id: 3 } });
});

test('a timed-out fan-out cancels the late call and releases its lease', async t => {
  const g = await gateway(t, { fanOutTimeoutMs: 800 });
  g.db.prepare("INSERT INTO connection_brains (connection_id, brain_id, role) SELECT ?, id, 'reader' FROM brains WHERE slug = 'slow'").run(g.connectionId);
  const client = await g.connect();
  const result = await client.callTool({ name: 'mem_search', arguments: { brain: '*', text: 'q' } });
  assert.match(result.structuredContent.results.find(r => r.brain === 'slow').error, /timed out/);
  await new Promise(resolve => setTimeout(resolve, 200));
  const { live, idle } = g.registry.stats();
  assert.equal(idle, live, 'every live brain is idle again: the slow brain\'s lease was released');
});

test('a login runs at most maxFanOutsPerLogin fan-outs at once; one more is a tool error right away', async t => {
  const g = await gateway(t, { fanOutTimeoutMs: 1500, maxFanOutsPerLogin: 2 });
  g.db.prepare("INSERT INTO connection_brains (connection_id, brain_id, role) SELECT ?, id, 'reader' FROM brains WHERE slug = 'slow'").run(g.connectionId);
  const client = await g.connect();
  const running = [1, 2].map(() => client.callTool({ name: 'mem_search', arguments: { brain: '*', text: 'q' } }));
  await new Promise(resolve => setTimeout(resolve, 300));
  const started = Date.now();
  const third = await client.callTool({ name: 'mem_search', arguments: { brain: '*', text: 'q' } });
  assert.ok(Date.now() - started < 700, 'refused without waiting');
  assert.equal(third.isError, true);
  assert.match(third.content.map(item => item.text).join(''), /Too many/);
  for (const result of await Promise.all(running)) assert.ok(!result.isError);
  const after = await client.callTool({ name: 'mem_search', arguments: { brain: '*', text: 'q' } });
  assert.ok(!after.isError, 'the slots free up once the running fan-outs end');
});

test('fan-out error entries are fixed, short words: no upstream text', async t => {
  const g = await gateway(t, { slowMode: 'fail' });
  g.db.prepare("INSERT INTO connection_brains (connection_id, brain_id, role) SELECT ?, id, 'reader' FROM brains WHERE slug = 'slow'").run(g.connectionId);
  const client = await g.connect();
  const result = await client.callTool({ name: 'mem_search', arguments: { brain: '*', text: 'q' } });
  const entry = result.structuredContent.results.find(r => r.brain === 'slow');
  assert.equal(entry.error, 'call failed');
  assert.ok(!JSON.stringify(result).includes('UPSTREAM-DETAIL'));
});

test('the connection server reads engram\'s version and instructions once, not on every request', async t => {
  const g = await gateway(t);
  const first = await g.connect();
  for (let i = 0; i < 3; i++) await first.callTool({ name: 'mem_search', arguments: { brain: 'beta', text: 'q' } });
  const second = await g.connect();
  await second.callTool({ name: 'mem_search', arguments: { brain: 'beta', text: 'q' } });
  assert.equal(g.leases.filter(slug => slug === 'alpha').length, 1, `alpha leased only for the first server info: ${g.leases.join(',')}`);
  assert.equal(second.getInstructions(), 'Fake instructions: save things.');
});

test('the bare /mcp serves connections when no brain is named default; a token without a connection gets 403 there (no grant on default)', async t => {
  const g = await gateway(t, { withDefault: false });
  const client = await g.connect();
  const found = await client.callTool({ name: 'mem_search', arguments: { text: 'q' } });
  assert.equal(found.structuredContent.results[0].brain, 'alpha');
  delete g.principal.connectionId;
  await assert.rejects(g.connect(), error => /403|forbidden/.test(String(error)));
});

// --- connection tools (brain_list, connection_brains, connection_attach, connection_detach) ---

function connectionToolsFor(grants, connections) {
  const access = new ConnectionAdmin(grants, connections);
  return { tools: createGatewayToolSet(createConnectionTools(access), { engram: TOOL_ROLES, gateway: CONNECTION_TOOL_KINDS }), access };
}
/** The test pipeline does not wrap results (`wrap: passResult`): the tool's JSON as is. */
const json = result => JSON.parse(result.content.map(item => item.text).join(''));
const auditRows = db => db.prepare('SELECT brain_id, target, outcome, meta_json FROM audit_log ORDER BY id').all()
  .map(row => [row.brain_id, row.target, row.outcome, JSON.parse(row.meta_json).denyReason]);
const auditMeta = db => db.prepare('SELECT brain_id, target, outcome, meta_json FROM audit_log ORDER BY id').all()
  .map(row => [row.brain_id, row.target, row.outcome, JSON.parse(row.meta_json).role]);
const attachedRows = (db, id) => db.prepare('SELECT b.slug, cb.role FROM connection_brains cb JOIN brains b ON b.id = cb.brain_id WHERE cb.connection_id = ? ORDER BY b.slug').all(id).map(row => [row.slug, row.role]);

test('connection tools are listed on /mcp without a `brain` enum; a token connection only gets the read ones', async t => {
  const oauth = await gateway(t, { kind: 'oauth', tools: true });
  const listed = (await (await oauth.connect()).listTools()).tools;
  const names = listed.map(tool => tool.name);
  for (const name of ['brain_list', 'connection_brains', 'connection_attach', 'connection_detach']) assert.ok(names.includes(name), name);
  assert.equal(brainEnum(listed.find(tool => tool.name === 'brain_list')), undefined);
  const token = await gateway(t, { kind: 'token', tools: true });
  const tokenNames = (await (await token.connect()).listTools()).tools.map(tool => tool.name);
  assert.ok(tokenNames.includes('brain_list') && tokenNames.includes('connection_brains'));
  assert.ok(!tokenNames.includes('connection_attach') && !tokenNames.includes('connection_detach'));
});

test('brain_list: the connection\'s brains with its role and the effective role; connection_brains: what the owner could attach', async t => {
  const g = await gateway(t, { kind: 'oauth', tools: true });
  const client = await g.connect();
  assert.deepEqual(json(await client.callTool({ name: 'brain_list', arguments: {} })), {
    connection: 'c', defaultBrain: 'alpha',
    brains: [{ brain: 'alpha', role: 'reader', effectiveRole: 'reader' }, { brain: 'beta', role: 'writer', effectiveRole: 'writer' }]
  });
  assert.deepEqual(json(await client.callTool({ name: 'connection_brains', arguments: {} })), {
    brains: [
      { brain: 'alpha', maxRole: 'owner', attached: 'reader' },
      { brain: 'beta', maxRole: 'owner', attached: 'writer' },
      { brain: 'gamma', maxRole: 'owner' },
      { brain: 'slow', maxRole: 'owner' }
    ]
  });
});

test('connection_attach adds a brain (or changes its role) and applies to the next request', async t => {
  const g = await gateway(t, { kind: 'oauth', tools: true, choice: MANAGER });
  const client = await g.connect();
  const attached = await client.callTool({ name: 'connection_attach', arguments: { brain: 'gamma', role: 'reader' } });
  assert.ok(!attached.isError, JSON.stringify(attached));
  assert.deepEqual(attachedRows(g.db, g.connectionId), [['alpha', 'reader'], ['beta', 'writer'], ['gamma', 'reader'], ['slow', 'owner']]);
  const search = (await client.listTools()).tools.find(tool => tool.name === 'mem_search');
  assert.deepEqual(brainEnum(search), ['alpha', 'beta', 'gamma', 'slow', '*']);
  assert.equal((await client.callTool({ name: 'mem_search', arguments: { brain: 'gamma', text: 'x' } })).structuredContent.results[0].brain, 'gamma');
  await client.callTool({ name: 'connection_attach', arguments: { brain: 'alpha', role: 'writer', default: true } });
  assert.deepEqual(attachedRows(g.db, g.connectionId)[0], ['alpha', 'writer']);
  assert.deepEqual(auditRows(g.db).filter(row => row[1] === 'connection_attach'), [['gamma', 'connection_attach', 'ok', undefined], ['alpha', 'connection_attach', 'ok', undefined]]);
  // The role asked for is in the audit row (closed set: reader, writer, owner).
  assert.deepEqual(auditMeta(g.db).filter(row => row[1] === 'connection_attach'), [['gamma', 'connection_attach', 'ok', 'reader'], ['alpha', 'connection_attach', 'ok', 'writer']]);
});

test('connection_attach never exceeds the owner: no grant or a role above it is refused (MCP error), nothing written, audited as denied', async t => {
  const g = await gateway(t, { kind: 'oauth', tools: true, choice: MANAGER });
  const client = await g.connect();
  g.db.prepare("UPDATE grants SET role = 'reader' WHERE brain_id = (SELECT id FROM brains WHERE slug = 'gamma')").run();
  const before = attachedRows(g.db, g.connectionId);
  await assert.rejects(client.callTool({ name: 'connection_attach', arguments: { brain: 'default', role: 'reader' } }), error => deniedCall(error) && /no grant/.test(error.message));
  await assert.rejects(client.callTool({ name: 'connection_attach', arguments: { brain: 'gamma', role: 'writer' } }), error => deniedCall(error) && /insufficient role/.test(error.message));
  await assert.rejects(client.callTool({ name: 'connection_attach', arguments: { brain: 'beta', role: 'owner', default: 'yes' } }), deniedCall);
  await assert.rejects(client.callTool({ name: 'connection_attach', arguments: { brain: 'gamma', role: 'admin' } }), error => deniedCall(error) && /role/.test(error.message));
  assert.deepEqual(attachedRows(g.db, g.connectionId), before);
  assert.deepEqual(auditRows(g.db).filter(row => row[2] === 'denied'), [['default', 'connection_attach', 'denied', 'no_grant'], ['gamma', 'connection_attach', 'denied', 'insufficient_role']]);
});

test('a token connection cannot attach or detach (MCP error, audited as denied, nothing written)', async t => {
  const g = await gateway(t, { kind: 'token', tools: true });
  const client = await g.connect();
  const before = attachedRows(g.db, g.connectionId);
  await assert.rejects(client.callTool({ name: 'connection_attach', arguments: { brain: 'gamma', role: 'reader' } }), error => deniedCall(error) && /connection kind/.test(error.message));
  await assert.rejects(client.callTool({ name: 'connection_detach', arguments: { brain: 'beta' } }), deniedCall);
  assert.deepEqual(attachedRows(g.db, g.connectionId), before);
  assert.deepEqual(auditRows(g.db), [['gamma', 'connection_attach', 'denied', 'connection_kind'], ['beta', 'connection_detach', 'denied', 'connection_kind']]);
});

test('connection_detach removes a brain: gone from the next tools/list, calls to it refused; detaching the default brain leaves none', async t => {
  const g = await gateway(t, { kind: 'oauth', tools: true, choice: MANAGER });
  const client = await g.connect();
  assert.ok(!(await client.callTool({ name: 'connection_detach', arguments: { brain: 'beta' } })).isError);
  assert.deepEqual(brainEnum((await client.listTools()).tools.find(tool => tool.name === 'mem_search')), ['alpha', 'slow', '*']);
  await assert.rejects(client.callTool({ name: 'mem_search', arguments: { brain: 'beta', text: 'x' } }), deniedCall);
  assert.equal((await client.callTool({ name: 'connection_detach', arguments: { brain: 'gamma' } })).isError, true, 'not attached: a tool error');
  await client.callTool({ name: 'connection_detach', arguments: { brain: 'alpha' } });
  assert.equal(json(await client.callTool({ name: 'brain_list', arguments: {} })).defaultBrain, null);
  await assert.rejects(client.callTool({ name: 'mem_search', arguments: { text: 'x' } }), error => /no default brain/.test(error.message));
});

test('attach and detach need the owner role on the connection: a connection with reader and writer only is refused (MCP error, audited as denied, nothing written)', async t => {
  const g = await gateway(t, { kind: 'oauth', tools: true });
  const client = await g.connect();
  const before = attachedRows(g.db, g.connectionId);
  await assert.rejects(client.callTool({ name: 'connection_attach', arguments: { brain: 'gamma', role: 'writer' } }), error => deniedCall(error) && /insufficient role/.test(error.message));
  await assert.rejects(client.callTool({ name: 'connection_detach', arguments: { brain: 'beta' } }), error => deniedCall(error) && /insufficient role/.test(error.message));
  assert.deepEqual(attachedRows(g.db, g.connectionId), before);
  assert.deepEqual(auditRows(g.db), [['gamma', 'connection_attach', 'denied', 'insufficient_role'], ['beta', 'connection_detach', 'denied', 'insufficient_role']]);
  // Read tools stay open to it.
  assert.equal(json(await client.callTool({ name: 'brain_list', arguments: {} })).brains.length, 2);
});

test('the owner role counts only while the owner still holds it: a connection whose owner grant was lowered cannot manage', async t => {
  const g = await gateway(t, { kind: 'oauth', tools: true, choice: MANAGER });
  const client = await g.connect();
  g.db.prepare("UPDATE grants SET role = 'writer' WHERE brain_id = (SELECT id FROM brains WHERE slug = 'slow')").run();
  await assert.rejects(client.callTool({ name: 'connection_attach', arguments: { brain: 'gamma', role: 'reader' } }), error => deniedCall(error) && /insufficient role/.test(error.message));
  assert.deepEqual(attachedRows(g.db, g.connectionId), [['alpha', 'reader'], ['beta', 'writer'], ['slow', 'owner']]);
});

test('a refused connection tool call audits the brain only when it is a valid brain name (else null)', async t => {
  const g = await gateway(t, { kind: 'oauth', tools: true, choice: MANAGER });
  const client = await g.connect();
  for (const brain of ['x'.repeat(300), 'Not A Slug', '-dash']) {
    await assert.rejects(client.callTool({ name: 'connection_attach', arguments: { brain, role: 'reader' } }), deniedCall);
  }
  await assert.rejects(client.callTool({ name: 'connection_attach', arguments: { brain: 'unknown-brain', role: 'reader' } }), deniedCall);
  assert.deepEqual(auditRows(g.db).map(row => row[0]), [null, null, null, 'unknown-brain']);
});

// --- brain_resolve (#12) ---

test('brain_resolve on /mcp: maps a remote to one of the connection\'s brains, else its default brain; audited, never an error', async t => {
  const g = await gateway(t, { remotes: 'github.com/hagalink/*=beta,github.com/hagalink/secret=gamma' });
  const client = await g.connect();
  const resolve = async remote => JSON.parse((await client.callTool({ name: 'brain_resolve', arguments: { remote } })).content[0].text);
  assert.deepEqual(await resolve('git@github.com:hagalink/website.git'), { brain: 'beta', source: 'mapping', remote: 'github.com/hagalink/website' });
  // gamma is granted to the owner but not attached to this connection.
  assert.deepEqual(await resolve('https://github.com/hagalink/secret'), { brain: 'alpha', source: 'default', remote: 'github.com/hagalink/secret' });
  assert.deepEqual(await resolve('https://example.org/x/y'), { brain: 'alpha', source: 'default', remote: 'example.org/x/y' });
  assert.deepEqual(auditRows(g.db).filter(row => row[1] === 'brain_resolve'), [
    ['alpha', 'brain_resolve', 'ok', undefined], ['alpha', 'brain_resolve', 'ok', undefined], ['alpha', 'brain_resolve', 'ok', undefined]
  ]);
});
