import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createEngramBridge } from '../../dist/bridge/index.js';
import { createToolCallPipeline } from '../../dist/pipeline/index.js';
import { TOOLS } from '../fixtures/fake-tools.mjs';

const FIXTURE = fileURLToPath(new URL('../fixtures/fake-mcp-server.mjs', import.meta.url));
const logs = [];
const logger = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(l => [l, (m, f) => logs.push({ l, m, f })]));

function newBridge() {
  return createEngramBridge({ command: process.execPath, args: [FIXTURE], logger });
}

/** Connects a downstream client to a fresh server built by the bridge factory. */
async function connectDownstream(bridge) {
  const server = await bridge.factory({});
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientSide);
  return { client, server };
}

test('tools/list is forwarded verbatim with schemas, annotations and instructions', async () => {
  const bridge = newBridge();
  await bridge.start();
  try {
    const { client } = await connectDownstream(bridge);
    const { tools } = await client.listTools();
    assert.deepEqual(tools, TOOLS);
    assert.equal(client.getInstructions(), 'Fake instructions: save things.');
    assert.equal(client.getServerVersion()?.name, 'engram-gateway');
    await client.close();
  } finally {
    await bridge.close();
  }
});

test('tools/call is forwarded including isError and structured content', async () => {
  const bridge = newBridge();
  await bridge.start();
  try {
    const { client } = await connectDownstream(bridge);
    const ok = await client.callTool({ name: 'echo', arguments: { text: 'hi' } });
    assert.deepEqual(ok.content, [{ type: 'text', text: 'hi' }]);
    assert.deepEqual(ok.structuredContent, { echoed: 'hi' });
    const bad = await client.callTool({ name: 'fail', arguments: {} });
    assert.equal(bad.isError, true);
    assert.deepEqual(bad.content, [{ type: 'text', text: 'boom' }]);
    await client.close();
  } finally {
    await bridge.close();
  }
});

test('a child crash rejects the in-flight call and the next request reconnects', async () => {
  const bridge = newBridge();
  await bridge.start();
  try {
    const first = await connectDownstream(bridge);
    await assert.rejects(first.client.callTool({ name: 'crash', arguments: {} }));
    await first.client.close();
    const second = await connectDownstream(bridge);
    const res = await second.client.callTool({ name: 'echo', arguments: { text: 'back' } });
    assert.deepEqual(res.content, [{ type: 'text', text: 'back' }]);
    assert.ok(logs.some(e => /exit|clos/i.test(e.m)), 'child death is logged');
    await second.client.close();
  } finally {
    await bridge.close();
  }
});

test('an in-flight call rejects promptly when the child dies', async () => {
  const bridge = newBridge();
  await bridge.start();
  try {
    const { client } = await connectDownstream(bridge);
    const slow = client.callTool({ name: 'slow', arguments: {} });
    slow.catch(() => {});
    const other = await connectDownstream(bridge);
    const started = Date.now();
    await assert.rejects(other.client.callTool({ name: 'crash', arguments: {} }));
    await assert.rejects(slow);
    assert.ok(Date.now() - started < 5000);
    await client.close();
    await other.client.close();
  } finally {
    await bridge.close();
  }
});

test('start() fails loudly when the command cannot start', async () => {
  const bridge = createEngramBridge({ command: '/nonexistent/engram-bin', args: ['mcp'], logger });
  await assert.rejects(bridge.start());
  await bridge.close();
});

test('requests fail (not hang) while the child cannot be restarted', async () => {
  const bridge = createEngramBridge({ command: process.execPath, args: ['-e', 'process.exit(1)'], logger });
  await assert.rejects(bridge.start());
  const { client } = await connectDownstream(bridge).catch(e => ({ client: null, e }));
  if (client) await assert.rejects(client.listTools());
  await bridge.close();
});

test('close() ends the child process', async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'bridge-test-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const pidFile = join(scratch, 'pid');
  const bridge = createEngramBridge({ command: process.execPath, args: [FIXTURE], env: { FAKE_PID_FILE: pidFile }, logger });
  await bridge.start();
  const pid = Number(readFileSync(pidFile, 'utf8'));
  assert.ok(pid > 0);
  process.kill(pid, 0);
  await bridge.close();
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

const fakeToken = () => 'gh' + 'p_' + 'aB3dE5gH7jK9mN1pQ2'.repeat(2);

test('mem_save content with a GitHub token reaches the server redacted and is never logged', async () => {
  const token = fakeToken();
  const before = logs.length;
  const bridge = newBridge();
  await bridge.start();
  try {
    const { client } = await connectDownstream(bridge);
    const res = await client.callTool({ name: 'mem_save', arguments: { title: 'creds', content: `use ${token} for CI` } });
    assert.deepEqual(res.structuredContent, { received: { title: 'creds', content: 'use [secret removed:github] for CI' } });
    assert.ok(!JSON.stringify(logs.slice(before)).includes(token), 'secret not logged');
    await client.close();
  } finally {
    await bridge.close();
  }
});

test('exempt read tools still forward their arguments verbatim; other tools are redacted by default', async () => {
  const token = fakeToken();
  const bridge = newBridge();
  await bridge.start();
  try {
    const { client } = await connectDownstream(bridge);
    const read = await client.callTool({ name: 'mem_search', arguments: { text: token } });
    assert.deepEqual(read.structuredContent, { results: [{ id: 1, content: token }] });
    const other = await client.callTool({ name: 'echo', arguments: { text: token } });
    assert.deepEqual(other.structuredContent, { echoed: '[secret removed:github]' });
    await client.close();
  } finally {
    await bridge.close();
  }
});

test('redaction can be turned off through the bridge pipeline option', async () => {
  const token = fakeToken();
  const bridge = createEngramBridge({
    command: process.execPath,
    args: [FIXTURE],
    logger,
    pipeline: createToolCallPipeline({ redactSecrets: false })
  });
  await bridge.start();
  try {
    const { client } = await connectDownstream(bridge);
    const res = await client.callTool({ name: 'mem_save', arguments: { content: token } });
    assert.deepEqual(res.structuredContent, { received: { content: token } });
    await client.close();
  } finally {
    await bridge.close();
  }
});

test('tool calls run authorize -> redact -> forward -> audit -> wrap, and audit sees redaction counts', async () => {
  const order = [];
  let auditMeta;
  const bridge = createEngramBridge({
    command: process.execPath,
    args: [FIXTURE],
    logger,
    pipeline: createToolCallPipeline({
      authorize: ctx => (order.push('authorize'), ctx),
      audit: (ctx, result) => {
        order.push(`audit:${result.structuredContent.received.content}`);
        auditMeta = ctx.meta;
        return result;
      },
      wrap: (ctx, result) => (order.push('wrap'), { ...result, content: [{ type: 'text', text: 'wrapped' }] })
    })
  });
  await bridge.start();
  try {
    const { client } = await connectDownstream(bridge);
    const res = await client.callTool({ name: 'mem_save', arguments: { content: fakeToken() } });
    assert.deepEqual(order, ['authorize', 'audit:[secret removed:github]', 'wrap']);
    assert.deepEqual(auditMeta, { redactions: { github: 1 } });
    assert.deepEqual(res.content, [{ type: 'text', text: 'wrapped' }]);
    await client.close();
  } finally {
    await bridge.close();
  }
});
