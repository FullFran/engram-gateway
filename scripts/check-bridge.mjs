// End-to-end check of the Engram bridge against a real `engram` binary.
//
//   ENGRAM_BIN=/path/to/engram node scripts/check-bridge.mjs
//
// Flow: start the bridge, list tools, mem_save a unique observation, mem_search
// finds it, close, start a NEW bridge on the same data dir, mem_search still
// finds it. Requests go through the real `createMcpHandler` (web Request in,
// web Response out) with a Streamable HTTP client whose fetch is the handler.
//
// Tool profile: `engram mcp` with no flags serves the `all` profile (27 tools),
// the superset of `agent` and `admin`; the bridge forwards exactly what Engram
// advertises, so the gateway uses the default to expose every memory tool.
//
// Isolation: ENGRAM_DATA_DIR and HOME are fresh temp dirs and every
// ENGRAM_CLOUD_* variable is removed, so a developer's cloud sync never sees
// test data. The script re-runs itself as a child to capture stderr and
// asserts that autosync never started.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENGRAM_BIN = process.env.ENGRAM_BIN ?? 'engram';

function scrubbedEnv(dataDir, home) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('ENGRAM_CLOUD_')) env[key] = value;
  }
  return { ...env, ENGRAM_DATA_DIR: dataDir, HOME: home };
}

if (!process.env.CHECK_BRIDGE_CHILD) {
  const dataDir = mkdtempSync(join(tmpdir(), 'engram-bridge-data-'));
  const home = mkdtempSync(join(tmpdir(), 'engram-bridge-home-'));
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    env: { ...scrubbedEnv(dataDir, home), CHECK_BRIDGE_CHILD: '1', ENGRAM_BIN },
    encoding: 'utf8'
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.status !== 0) {
    console.error(`check-bridge: failed; scratch kept for debugging: ${dataDir} ${home}`);
    process.exit(result.status ?? 1);
  }
  assert.ok(!(result.stderr ?? '').includes('[autosync] started'), 'engram started cloud autosync');
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  console.log('check-bridge: ok');
  process.exit(0);
}

const { createMcpHandler } = await import('@modelcontextprotocol/server');
const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
const { createEngramBridge } = await import('../dist/bridge/index.js');

const logger = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level, (message, fields) => {
  if (level !== 'debug') console.error(JSON.stringify({ level, message, ...fields }));
}]));

async function withBridge(fn, clientOptions) {
  const bridge = createEngramBridge({ command: ENGRAM_BIN, args: ['mcp', '--project', project], logger });
  await bridge.start();
  const handler = createMcpHandler(bridge.factory);
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
    fetch: (input, init) => handler.fetch(new Request(input, init))
  });
  const client = new Client({ name: 'check-bridge', version: '0.0.0' }, clientOptions);
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => undefined);
    await bridge.close();
  }
}

const text = result => result.content.map(c => (c.type === 'text' ? c.text : '')).join('\n');
const project = 'bridge-e2e';
const marker = `bridge-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;


await withBridge(async client => {
  const { tools } = await client.listTools();
  const names = tools.map(t => t.name);
  assert.ok(names.includes('mem_save'), 'mem_save listed');
  assert.ok(names.includes('mem_search'), 'mem_search listed');
  assert.ok(client.getInstructions(), 'engram instructions forwarded');
  console.log(`tools: ${names.length}; protocol: ${client.getNegotiatedProtocolVersion()}`);

  const saved = await client.callTool({
    name: 'mem_save',
    arguments: { title: `Bridge check ${marker}`, content: `Unique observation ${marker}`, type: 'discovery' }
  });
  assert.ok(!saved.isError, `mem_save failed: ${text(saved)}`);
  const found = await client.callTool({ name: 'mem_search', arguments: { query: marker } });
  assert.ok(!found.isError, `mem_search failed: ${text(found)}`);
  assert.ok(text(found).includes(marker), 'mem_search finds the saved observation');
});

await withBridge(async client => {
  const found = await client.callTool({ name: 'mem_search', arguments: { query: marker } });
  assert.ok(text(found).includes(marker), 'observation survives a bridge restart');
});

// Same bridge, downstream client negotiating the 2026-07-28 protocol.
await withBridge(async client => {
  assert.equal(client.getProtocolEra(), 'modern', 'downstream client negotiated the modern era');
  const { tools } = await client.listTools();
  assert.ok(tools.some(t => t.name === 'mem_search'), 'mem_search listed on the modern path');
  const found = await client.callTool({ name: 'mem_search', arguments: { query: marker } });
  assert.ok(!found.isError && text(found).includes(marker), 'mem_search works on the modern path');
  console.log(`modern protocol: ${client.getNegotiatedProtocolVersion()}`);
}, { versionNegotiation: { mode: 'auto' } });

console.log('bridge e2e passed');
