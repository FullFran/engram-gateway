#!/usr/bin/env node

// Wire-level checks for the Streamable HTTP MCP endpoint (`/mcp`) in front of
// the Engram bridge. Real `dist/main.js` gateways (each spawning a real
// `engram mcp` child with a throwaway data directory) are driven with
// hand-written HTTP requests, so what is asserted is exactly what a remote
// client sees on the wire:
//   - the auth guard: 401 + WWW-Authenticate (resource_metadata, scope="memory")
//     without a valid bearer, and an authorized call with one
//   - both protocol eras: 2026-07-28 stateless requests (`_meta` envelope,
//     Mcp-Method / Mcp-Name headers) and the 2025-era `initialize` handshake
//   - the memory itself: mem_save then mem_search through the bridge
// Scratch state lives outside the repository and is removed on success.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assert, assertEqual, freePort, githubEnv, githubLogin, mcpCall, mcpToolsList, obtainToken, request, startFakeGitHub, startGateway
} from './lib/harness.mjs';

const LEGACY_VERSION = '2025-11-25';
const scratch = mkdtempSync(join(tmpdir(), 'engram-gateway-mcp-http-'));
let passed = 0;
const ok = label => { passed += 1; console.log(`  ok - ${label}`); };

function toolText(result) {
  return (result?.result?.content ?? []).map(part => part.text ?? '').join('\n');
}

async function checkOpenLoopback() {
  const gateway = await startGateway(scratch);
  try {
    const list = await mcpToolsList(gateway.base, '/mcp');
    assertEqual(list.status, 200, 'tools/list on default loopback');
    const names = list.result.result.tools.map(tool => tool.name);
    assert(names.includes('mem_save') && names.includes('mem_search'), `engram tools are served: ${names.join(',')}`);
    // DNS rebinding guard on a loopback bind: a foreign Host is refused.
    const rebinding = await request(gateway.base, { method: 'POST', path: '/mcp', headers: { host: 'evil.example', accept: 'application/json, text/event-stream' }, json: {} });
    assert(rebinding.status === 403 || rebinding.status === 421, `foreign Host refused (got ${rebinding.status})`);
    assertEqual((await request(gateway.base, { path: '/mcp-other' })).status, 404, 'unknown path');
    ok('loopback without auth serves the engram tools and refuses a foreign Host');
  } finally {
    await gateway.stop();
  }
}

async function checkGuardedEndpoint(github) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const dataDir = join(scratch, `data-${port}`);
  const gateway = await startGateway(scratch, { PORT: String(port), ...githubEnv(port, github.url, dataDir) });
  try {
    // --- the guard ---
    const anonymous = await mcpToolsList(base, '/mcp');
    assertEqual(anonymous.status, 401, '/mcp without a token');
    assertEqual(anonymous.headers['www-authenticate'], `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource", scope="memory"`, 'challenge');
    const bad = await mcpToolsList(base, '/mcp', { authorization: 'Bearer nope' });
    assertEqual(bad.status, 401, '/mcp with a bad token');
    assert(/error="invalid_token"/.test(bad.headers['www-authenticate'] ?? ''), 'bad token challenge says invalid_token');
    assertEqual((await request(base, { path: '/health' })).status, 200, '/health needs no credentials');
    const metadata = await request(base, { path: '/.well-known/oauth-protected-resource' });
    assertEqual(JSON.stringify(metadata.body.scopes_supported), '["memory"]', 'metadata advertises the memory scope');
    ok('/mcp answers 401 with resource_metadata and scope="memory" without a valid bearer');

    // --- an authorized call ---
    const github1 = await githubLogin(base, github, 'FullFran');
    assert(github1.jar, `GitHub login completes (${github1.poll.text})`);
    const { accessToken } = await obtainToken(base, github1.jar);
    assert(accessToken, 'an access token is issued');
    const auth = { authorization: `Bearer ${accessToken}` };
    const list = await mcpToolsList(base, '/mcp', auth);
    assertEqual(list.status, 200, 'tools/list with a bearer');
    assert(list.result.result.tools.some(tool => tool.name === 'mem_save'), 'tools/list carries mem_save');
    ok('an authorized tools/list reaches engram');

    // --- the memory round trip (2026-07-28) ---
    const marker = `gateway-check-${Date.now()}`;
    const saved = await mcpCall(base, '/mcp', 'mem_save', { title: marker, content: `Remembered through the gateway: ${marker}`, type: 'discovery' }, auth);
    assertEqual(saved.status, 200, `mem_save (${saved.text.slice(0, 200)})`);
    assert(!saved.result.result.isError, `mem_save succeeded: ${toolText(saved.result)}`);
    const found = await mcpCall(base, '/mcp', 'mem_search', { query: marker }, auth);
    assertEqual(found.status, 200, 'mem_search');
    assert(toolText(found.result).includes(marker), `mem_search finds the saved memory: ${toolText(found.result).slice(0, 300)}`);
    ok('mem_save then mem_search round trip over 2026-07-28 requests');

    // --- the 2025-era handshake, stateless ---
    const init = await request(base, {
      method: 'POST', path: '/mcp',
      headers: { ...auth, accept: 'application/json, text/event-stream', 'mcp-protocol-version': LEGACY_VERSION },
      json: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LEGACY_VERSION, capabilities: {}, clientInfo: { name: 'legacy-check', version: '0.0.0' } } }
    });
    assertEqual(init.status, 200, `legacy initialize (${init.text.slice(0, 200)})`);
    const initBody = String(init.headers['content-type']).includes('text/event-stream')
      ? JSON.parse(init.text.split(/\r?\n/).find(line => line.startsWith('data:')).slice(5))
      : init.body;
    assert(initBody?.result?.serverInfo, `initialize answers with serverInfo: ${init.text.slice(0, 200)}`);
    const noToken = await request(base, {
      method: 'POST', path: '/mcp', headers: { accept: 'application/json, text/event-stream', 'mcp-protocol-version': LEGACY_VERSION },
      json: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LEGACY_VERSION, capabilities: {}, clientInfo: { name: 'legacy-check', version: '0.0.0' } } }
    });
    assertEqual(noToken.status, 401, 'legacy initialize without a token');
    ok('the 2025-era initialize path works with a bearer and is refused without one');
  } finally {
    await gateway.stop();
  }
}

const github = await startFakeGitHub();
try {
  console.log(`MCP HTTP checks (scratch: ${scratch})`);
  await checkOpenLoopback();
  await checkGuardedEndpoint(github);
  console.log(`MCP HTTP check passed: ${passed} groups.`);
} catch (error) {
  console.error(`MCP HTTP check failed after ${passed} passing groups: ${error.stack || error.message}`);
  console.error(`scratch kept: ${scratch}`);
  process.exitCode = 1;
} finally {
  await github.close();
}
if (process.exitCode !== 1) rmSync(scratch, { recursive: true, force: true });
process.exit(process.exitCode ?? 0);
