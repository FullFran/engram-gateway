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
//   - brains: `/mcp/<brain>` isolation (one engram child and data dir each),
//     lazy spawn and idle reaping seen on /health/brains, per-brain OAuth
//     audiences, unknown brains answering 404 before authentication
// Scratch state lives outside the repository and is removed on success.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assert, assertEqual, freePort, sleep, waitFor, githubEnv, githubLogin, mcpCall, mcpToolsList, obtainToken, request, startFakeGitHub, startGateway
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

/** Pids of the gateway's direct children (the engram processes). */
function childPids(pid) {
  try {
    return execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function brainStats(base) {
  const response = await request(base, { path: '/health/brains' });
  assertEqual(response.status, 200, '/health/brains');
  return response.body;
}

async function checkBrains() {
  const port = await freePort();
  const brainsRoot = join(scratch, `brains-${port}`);
  const gateway = await startGateway(scratch, { PORT: String(port), BRAINS_ROOT: brainsRoot, BRAINS: 'alpha,beta', BRAIN_IDLE_TIMEOUT: '2' });
  const base = gateway.base;
  try {
    // --- unknown brains: 404, same body as any unknown path, nothing listed ---
    const notFound = await request(base, { path: '/nope' });
    for (const path of ['/mcp/ghost', '/mcp/Alpha', '/mcp/..%2fetc', '/mcp/alpha/deeper']) {
      const response = await mcpToolsList(base, path);
      assertEqual(response.status, 404, `${path} is not a brain`);
      assertEqual(response.text, notFound.text, `${path} answers like any unknown path`);
    }
    assertEqual(JSON.stringify(Object.keys(await brainStats(base)).sort()), '["idle","live"]', '/health/brains holds counts only');
    ok('unknown brains answer 404 like any unknown path; /health/brains lists no brain');

    // --- lazy spawn and idle reaping, seen on /health/brains and in the process table ---
    await waitFor(async () => (await brainStats(base)).live === 0, 10000, 'the warmed default brain is reaped when idle');
    assertEqual(childPids(gateway.child.pid).length, 0, 'no engram child once every brain is idle');
    const first = await mcpToolsList(base, '/mcp/alpha');
    assertEqual(first.status, 200, 'tools/list on /mcp/alpha');
    assertEqual((await brainStats(base)).live, 1, 'the first request starts the brain');
    assertEqual(childPids(gateway.child.pid).length, 1, 'one engram child for brain alpha');
    await sleep(500);
    assertEqual((await brainStats(base)).live, 1, 'the brain survives a pause shorter than the idle timeout');
    await waitFor(async () => (await brainStats(base)).live === 0, 10000, 'brain alpha is reaped after BRAIN_IDLE_TIMEOUT');
    assertEqual(childPids(gateway.child.pid).length, 0, 'the reaped child exited');
    ok('a brain child starts on its first request and exits after the idle timeout');

    // --- isolation: a memory saved in alpha is not found in beta nor in the default brain ---
    const marker = `brain-check-${Date.now()}`;
    const saved = await mcpCall(base, '/mcp/alpha', 'mem_save', { title: marker, content: `Only in alpha: ${marker}`, type: 'discovery' });
    assert(saved.status === 200 && !saved.result.result.isError, `mem_save in alpha: ${saved.text.slice(0, 200)}`);
    const inAlpha = await mcpCall(base, '/mcp/alpha', 'mem_search', { query: marker });
    assert(toolText(inAlpha.result).includes(marker), 'alpha finds its memory');
    for (const path of ['/mcp/beta', '/mcp', '/mcp/default']) {
      const other = await mcpCall(base, path, 'mem_search', { query: marker });
      assertEqual(other.status, 200, `mem_search on ${path}`);
      // Engram echoes the query when nothing matches, so look for the empty answer, not the marker.
      assert(/No memories found/.test(toolText(other.result)) && !toolText(other.result).includes('Only in alpha'), `${path} must not see alpha's memory: ${toolText(other.result).slice(0, 200)}`);
    }
    assertEqual((await brainStats(base)).live, 3, 'alpha, beta and default each run their own child');
    ok('a memory saved in brain alpha is not returned by mem_search in beta or the default brain');

    // --- /mcp and /mcp/default are the same brain ---
    const shared = `default-check-${Date.now()}`;
    await mcpCall(base, '/mcp', 'mem_save', { title: shared, content: `Default brain: ${shared}`, type: 'discovery' });
    const viaSlug = await mcpCall(base, '/mcp/default', 'mem_search', { query: shared });
    assert(toolText(viaSlug.result).includes(shared), '/mcp/default sees what /mcp saved');
    ok('/mcp and /mcp/default serve the same default brain');

    // --- the tool-call pipeline runs in every brain's call path ---
    const secretMarker = `brain-secret-${Date.now()}`;
    const fakeToken = `ghp_${'a1B2c3D4e5'.repeat(4).slice(0, 36)}`;
    await mcpCall(base, '/mcp/beta', 'mem_save', { title: secretMarker, content: `token ${fakeToken} for ${secretMarker}`, type: 'discovery' });
    const redacted = toolText((await mcpCall(base, '/mcp/beta', 'mem_search', { query: secretMarker })).result);
    assert(redacted.includes(secretMarker) && !redacted.includes(fakeToken) && redacted.includes('[secret removed'), `beta stored the redacted text: ${redacted.slice(0, 300)}`);
    ok('secret redaction applies on /mcp/<brain>');

    // --- shutdown stops every child ---
    const pids = childPids(gateway.child.pid);
    assertEqual(pids.length, 3, 'three live children before shutdown');
    await gateway.stop();
    await waitFor(() => pids.every(pid => !alive(pid)), 8000, 'every engram child exits on SIGTERM');
    ok('SIGTERM stops every brain child');
  } finally {
    await gateway.stop();
  }
}

async function checkInvalidBrainConfig() {
  for (const [env, pattern] of [[{ BRAINS_ROOT: join(scratch, 'bad-brains'), BRAINS: 'Work' }, /BRAINS: invalid brain slug \\?"Work/], [{ BRAINS: 'work' }, /BRAINS needs BRAINS_ROOT/], [{ BRAINS_ROOT: join(scratch, 'bad-brains'), BRAINS: 'oauth' }, /reserved/]]) {
    const gateway = await startGateway(scratch, env, { wait: false });
    await waitFor(() => gateway.child.exitCode !== null, 8000, `gateway with ${JSON.stringify(env)} exits`);
    assert(gateway.child.exitCode !== 0, 'startup fails');
    assert(pattern.test(gateway.output()), `startup error names the problem: ${gateway.output().slice(0, 300)}`);
  }
  ok('an invalid, reserved or rootless BRAINS entry fails startup loudly');
}

async function checkBrainAudiences(github) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const dataDir = join(scratch, `data-${port}`);
  const gateway = await startGateway(scratch, { PORT: String(port), BRAINS_ROOT: join(scratch, `brains-${port}`), BRAINS: 'alpha,beta', ...githubEnv(port, github.url, dataDir) });
  try {
    assertEqual((await mcpToolsList(base, '/mcp/ghost')).status, 404, 'an unknown brain is 404 even without a token');
    const anonymous = await mcpToolsList(base, '/mcp/alpha');
    assertEqual(anonymous.status, 401, '/mcp/alpha without a token');
    assertEqual(anonymous.headers['www-authenticate'], `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp/alpha", scope="memory"`, 'per-brain challenge');
    const metadata = await request(base, { path: '/.well-known/oauth-protected-resource/mcp/alpha' });
    assertEqual(metadata.body.resource, `${base}/mcp/alpha`, 'brain alpha is its own protected resource');
    // Accepted existence oracle (README "Brains"): known brain 401 + metadata 200, unknown brain 404 for both.
    assertEqual(metadata.status, 200, 'metadata of a known brain');
    assertEqual((await request(base, { path: '/.well-known/oauth-protected-resource/mcp/ghost' })).status, 404, 'no metadata for an unknown brain');

    const login = await githubLogin(base, github, 'FullFran');
    const alpha = await obtainToken(base, login.jar, `${base}/mcp/alpha`);
    const legacy = await obtainToken(base, login.jar);
    const bearer = token => ({ authorization: `Bearer ${token}` });
    assertEqual((await mcpToolsList(base, '/mcp/alpha', bearer(alpha.accessToken))).status, 200, 'alpha token on /mcp/alpha');
    for (const path of ['/mcp/beta', '/mcp', '/mcp/default']) {
      assertEqual((await mcpToolsList(base, path, bearer(alpha.accessToken))).status, 401, `alpha token refused on ${path}`);
    }
    assertEqual((await mcpToolsList(base, '/mcp', bearer(legacy.accessToken))).status, 200, '/mcp token (no resource) still works on /mcp');
    assertEqual((await mcpToolsList(base, '/mcp/default', bearer(legacy.accessToken))).status, 200, '/mcp token works on /mcp/default');
    assertEqual((await mcpToolsList(base, '/mcp/alpha', bearer(legacy.accessToken))).status, 401, '/mcp token refused on /mcp/alpha');
    ok('each brain is its own OAuth resource: a token only opens the brain it was issued for');
  } finally {
    await gateway.stop();
  }
}

const github = await startFakeGitHub();
try {
  console.log(`MCP HTTP checks (scratch: ${scratch})`);
  await checkOpenLoopback();
  await checkGuardedEndpoint(github);
  await checkBrains();
  await checkInvalidBrainConfig();
  await checkBrainAudiences(github);
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
