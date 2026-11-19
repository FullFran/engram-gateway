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
//   - roles (#6): a reader's tools/list holds reader tools only, its mem_save
//     is an MCP error that writes nothing (audited as denied), no token for a
//     brain without a grant, and a revoked grant answers 403 on the next request
//   - admin API (#10): admin browser session only, an invited user activated by
//     signing in, a brain created at runtime, an API grant surviving a restart,
//     archiving refusing new sessions while the data stays, the audit CSV
// Scratch state lives outside the repository and is removed on success.

import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { GATEWAY_TOOL_ROLES, TOOL_ROLES } from '../dist/authz/index.js';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assert, assertEqual, cookieHeader, freePort, sleep, waitFor, githubEnv, githubLogin, mcpCall, mcpToolsList, obtainToken, request, startFakeGitHub, startGateway
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
    // The consent page preselects reader (least privilege); a round trip needs writing, so pick owner, as a person would.
    const { accessToken } = await obtainToken(base, github1.jar, undefined, { 'role:default': 'owner' });
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

async function checkRoles(github) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const dataDir = join(scratch, `data-${port}`);
  const gateway = await startGateway(scratch, {
    PORT: String(port), BRAINS_ROOT: join(scratch, `brains-${port}`), BRAINS: 'alpha,beta',
    ...githubEnv(port, github.url, dataDir, { BRAIN_GRANTS: 'reader-r:alpha:reader,reader-r:beta:reader,writer-w:alpha:writer' })
  });
  const bearer = token => ({ authorization: `Bearer ${token}` });
  const names = list => list.result.result.tools.map(tool => tool.name).sort();
  // mem_stats as plain text: the data-wrapping nonce (#19) differs on every call.
  const stats = async token => toolText((await mcpCall(base, '/mcp/alpha', 'mem_stats', {}, bearer(token))).result).replace(/nonce="[0-9a-f]+"/g, 'nonce');
  // Engram's tools and the gateway's own (brain_resolve is a reader tool, #12).
  const rolesOf = role => Object.entries({ ...TOOL_ROLES, ...GATEWAY_TOOL_ROLES }).filter(([, required]) => required === role).map(([name]) => name).sort();
  try {
    // --- tokens: only for brains the user holds a grant on ---
    const reader = await githubLogin(base, github, 'reader-r');
    assert(reader.jar, `a user with a grant signs in: ${reader.poll.text.slice(0, 200)}`);
    const readerAlpha = await obtainToken(base, reader.jar, `${base}/mcp/alpha`);
    const refused = await obtainToken(base, reader.jar, `${base}/mcp/default`);
    assertEqual(refused.page.status, 403, 'no token without a grant (/mcp/default)');
    const readerBeta = await obtainToken(base, reader.jar, `${base}/mcp/beta`);
    const stranger = await githubLogin(base, github, 'stranger-s');
    assertEqual(stranger.jar, null, 'a login with no grant and not an admin cannot sign in');
    ok('a token is only issued for a brain the user holds a grant on');

    // --- tools/list shows exactly the reader tools; the admin sees every tool ---
    const admin = await githubLogin(base, github, 'FullFran');
    const adminAlpha = await obtainToken(base, admin.jar, `${base}/mcp/alpha`);
    const readerList = await mcpToolsList(base, '/mcp/alpha', bearer(readerAlpha.accessToken));
    assertEqual(readerList.status, 200, 'reader tools/list');
    assertEqual(JSON.stringify(names(readerList)), JSON.stringify(rolesOf('reader')), 'reader sees exactly the reader tools');
    const everyTool = [...Object.keys(TOOL_ROLES), ...Object.keys(GATEWAY_TOOL_ROLES)].sort();
    assertEqual(JSON.stringify(names(await mcpToolsList(base, '/mcp/alpha', bearer(adminAlpha.accessToken)))), JSON.stringify(everyTool), 'the admin (owner) sees every engram tool and every gateway tool');
    ok('tools/list holds exactly the tools the role allows');
    const resolved = await mcpCall(base, '/mcp/alpha', 'brain_resolve', { remote: 'git@github.com:someone/unmapped.git' }, bearer(readerAlpha.accessToken));
    assert(toolText(resolved.result).includes('{"brain":"alpha","source":"default","remote":"github.com/someone/unmapped"}'), `brain_resolve fails open to the route's brain: ${resolved.text.slice(0, 300)}`);
    // The README's SessionStart hook, against this gateway.
    const hookRepo = join(scratch, 'hook-repo');
    execFileSync('git', ['init', '-q', hookRepo]);
    execFileSync('git', ['-C', hookRepo, 'remote', 'add', 'origin', 'git@github.com:someone/unmapped.git']);
    const hookOut = execFileSync(process.execPath, [join(import.meta.dirname, '..', 'docs', 'examples', 'session-start-brain.mjs')], {
      cwd: hookRepo, encoding: 'utf8', input: '{}',
      env: { PATH: process.env.PATH ?? '', HOME: hookRepo, ENGRAM_GATEWAY_URL: `${base}/mcp/alpha`, ENGRAM_GATEWAY_TOKEN: readerAlpha.accessToken }
    });
    assert(hookOut.includes('brain "alpha"'), `the SessionStart hook prints the resolved brain: ${JSON.stringify(hookOut)}`);
    ok('brain_resolve: a reader resolves an unmapped remote to the brain of /mcp/<brain> (fail open), and the SessionStart hook prints it');

    // --- brain_health (#18): owner tool and admin endpoint, read-only from the brain's engram.db ---
    const healthCall = await mcpCall(base, '/mcp/alpha', 'brain_health', { sampleSize: 1 }, bearer(adminAlpha.accessToken));
    assert(healthCall.result?.result && !healthCall.result.result.isError, `brain_health answers the admin: ${healthCall.text.slice(0, 300)}`);
    assert(/"brain":"alpha"/.test(toolText(healthCall.result)) && /"observations":\{"live":\d+/.test(toolText(healthCall.result)), `brain_health reports on alpha: ${toolText(healthCall.result).slice(0, 300)}`);
    const readerHealth = await mcpCall(base, '/mcp/alpha', 'brain_health', {}, bearer(readerAlpha.accessToken));
    assertEqual(readerHealth.result?.error?.code, -32602, 'brain_health by a reader is an MCP error');
    const adminHealth = await fetch(`${base}/admin/brains/alpha/health`, { headers: bearer(adminAlpha.accessToken) });
    assertEqual(adminHealth.status, 200, 'the admin endpoint answers an instance admin');
    assertEqual((await adminHealth.json()).brain, 'alpha', 'the admin endpoint reports on alpha');
    assertEqual((await fetch(`${base}/admin/brains/alpha/health`, { headers: bearer(readerAlpha.accessToken) })).status, 403, 'the admin endpoint refuses a non-admin');
    assertEqual((await fetch(`${base}/admin/brains/alpha/health`)).status, 401, 'the admin endpoint needs authentication');
    ok('brain_health: owners call the tool, admins read the endpoint, everyone else is refused');

    // --- a reader calling mem_save: MCP error, nothing written, audited as denied ---
    const marker = `reader-write-${Date.now()}`;
    const statsBefore = await stats(adminAlpha.accessToken);
    assert(/Observations: \d+/.test(statsBefore), `mem_stats answers: ${statsBefore.slice(0, 200)}`);
    const denied = await mcpCall(base, '/mcp/alpha', 'mem_save', { title: marker, content: `reader wrote ${marker}`, type: 'discovery' }, bearer(readerAlpha.accessToken));
    assertEqual(denied.status, 200, 'the JSON-RPC answer arrives');
    assertEqual(denied.result?.error?.code, -32602, `mem_save by a reader is an MCP error: ${denied.text.slice(0, 200)}`);
    assert(denied.result.result === undefined, 'no tool result');
    const statsAfter = await stats(adminAlpha.accessToken);
    assertEqual(statsAfter, statsBefore, 'engram memory stats unchanged');
    const search = toolText((await mcpCall(base, '/mcp/alpha', 'mem_search', { query: marker }, bearer(adminAlpha.accessToken))).result);
    assert(/No memories found/.test(search) && !search.includes('reader wrote'), `nothing was saved: ${search.slice(0, 200)}`);
    const gatewayDb = new DatabaseSync(join(dataDir, 'gateway.db'), { readOnly: true });
    const audited = gatewayDb.prepare("SELECT a.outcome FROM audit_log a JOIN users u ON u.id = CAST(a.actor_id AS INTEGER) WHERE u.github_login = 'reader-r' AND a.target = 'mem_save'").all();
    gatewayDb.close();
    assertEqual(JSON.stringify(audited.map(row => row.outcome)), '["denied"]', 'the refused call is in the audit log as denied');
    ok('a reader calling mem_save gets an MCP error, engram is unchanged, the audit log says denied');

    // --- writer: may save, may not delete ---
    const writer = await githubLogin(base, github, 'writer-w');
    const writerAlpha = await obtainToken(base, writer.jar, `${base}/mcp/alpha`);
    const saved = await mcpCall(base, '/mcp/alpha', 'mem_save', { title: `${marker}-w`, content: `writer wrote ${marker}`, type: 'discovery' }, bearer(writerAlpha.accessToken));
    assert(saved.result?.result && !saved.result.result.isError, `a writer saves: ${saved.text.slice(0, 200)}`);
    const removed = await mcpCall(base, '/mcp/alpha', 'mem_delete', { id: 1 }, bearer(writerAlpha.accessToken));
    assertEqual(removed.result?.error?.code, -32602, 'mem_delete needs owner');
    ok('a writer saves but cannot delete');

    // --- revocation applies to the next request: 403, and the refresh token stops working ---
    const revoke = where => {
      const writable = new DatabaseSync(join(dataDir, 'gateway.db'));
      writable.exec('PRAGMA busy_timeout = 5000');
      writable.prepare(`DELETE FROM grants WHERE user_id = (SELECT id FROM users WHERE github_login = 'reader-r') ${where}`).run();
      writable.close();
    };
    revoke("AND brain_id = (SELECT id FROM brains WHERE slug = 'alpha')");
    const afterRevoke = await mcpToolsList(base, '/mcp/alpha', bearer(readerAlpha.accessToken));
    assertEqual(afterRevoke.status, 403, 'a revoked grant answers 403 on the next request');
    assertEqual(afterRevoke.body?.error, 'forbidden', '403 body');
    assertEqual((await mcpToolsList(base, '/mcp/beta', bearer(readerBeta.accessToken))).status, 200, 'the grant on beta still works');
    assertEqual((await mcpToolsList(base, '/mcp/alpha', bearer(adminAlpha.accessToken))).status, 200, 'other users keep their access');
    const refresh = await request(base, { method: 'POST', path: '/oauth/token', form: { grant_type: 'refresh_token', refresh_token: readerAlpha.refreshToken, client_id: readerAlpha.clientId } });
    assertEqual(refresh.status, 400, `no refreshed token without the grant (${refresh.text.slice(0, 200)})`);
    // Without any grant left the account is no longer allowed at all, as when a
    // login leaves ALLOWED_GITHUB_LOGINS: its tokens stop being valid (401).
    revoke('');
    assertEqual((await mcpToolsList(base, '/mcp/beta', bearer(readerBeta.accessToken))).status, 401, 'no grant left: the token is no longer valid');
    ok('revoking a grant answers 403 on the very next request, and the refresh token is refused');
  } finally {
    await gateway.stop();
  }
}

async function checkAdmin(github) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const dataDir = join(scratch, `data-${port}`);
  const brainsRoot = join(scratch, `brains-${port}`);
  const env = { PORT: String(port), BRAINS_ROOT: brainsRoot, BRAINS: 'alpha', ...githubEnv(port, github.url, dataDir) };
  const bearer = token => ({ authorization: `Bearer ${token}` });
  let gateway = await startGateway(scratch, env);
  try {
    const admin = await githubLogin(base, github, 'FullFran');
    const session = { cookie: cookieHeader(admin.jar) };
    const api = (method, path, json) => request(base, { method, path: `/admin/api${path}`, headers: session, ...(json !== undefined ? { json } : {}) });

    // --- who may call: the admin's browser session, never a bearer token ---
    assertEqual((await request(base, { path: '/admin/api/brains' })).status, 401, 'no session: 401');
    const adminAlpha = await obtainToken(base, admin.jar, `${base}/mcp/alpha`);
    assertEqual((await request(base, { path: '/admin/api/brains', headers: bearer(adminAlpha.accessToken) })).status, 401, 'an MCP access token is not an admin credential');
    const listed = await api('GET', '/brains');
    assertEqual(listed.status, 200, `admin lists brains (${listed.text.slice(0, 200)})`);
    assertEqual(JSON.stringify(listed.body.brains.map(brain => brain.slug)), '["alpha","default"]', 'brains listed');
    ok('the admin API answers the admin session only');

    // --- invite + grant: the invited user signs in and gets the role ---
    assertEqual((await api('POST', '/users', { login: 'invitee-i' })).status, 201, 'invite');
    assertEqual((await githubLogin(base, github, 'invitee-i')).jar, null, 'an invite without a grant does not sign in');
    assertEqual((await api('PUT', '/brains/alpha/grants/invitee-i', { role: 'writer' })).status, 200, 'grant writer');
    const invitee = await githubLogin(base, github, 'invitee-i');
    assert(invitee.jar, `the invited user signs in: ${invitee.poll.text.slice(0, 200)}`);
    const inviteeAlpha = await obtainToken(base, invitee.jar, `${base}/mcp/alpha`);
    assertEqual((await mcpToolsList(base, '/mcp/alpha', bearer(inviteeAlpha.accessToken))).status, 200, 'the invited writer uses alpha');
    assertEqual((await api('GET', '/users')).body.users.find(user => user.login === 'invitee-i').status, 'active', 'the sign-in activated the invite');
    ok('an invited user with a grant signs in, which activates the invite');

    // --- a brain created at runtime is served at once ---
    assertEqual((await request(base, { method: 'POST', path: '/mcp/gamma', json: {} })).status, 404, 'gamma does not exist yet');
    const created = await api('POST', '/brains', { slug: 'gamma' });
    assertEqual(created.status, 201, `create gamma (${created.text.slice(0, 200)})`);
    assertEqual((await request(base, { method: 'POST', path: '/mcp/gamma', json: {} })).status, 401, 'gamma is served (auth required) without a restart');
    ok('a brain created through the API is served without a restart');

    // --- restart: the API grant survives; gamma gets its OAuth resource ---
    await gateway.stop();
    gateway = await startGateway(scratch, env);
    assertEqual((await mcpToolsList(base, '/mcp/alpha', bearer(inviteeAlpha.accessToken))).status, 200, 'the API grant survived the restart');
    const adminGamma = await obtainToken(base, admin.jar, `${base}/mcp/gamma`);
    assertEqual((await mcpToolsList(base, '/mcp/gamma', bearer(adminGamma.accessToken))).status, 200, 'after the restart gamma has its OAuth resource');
    ok('after a restart the API grant still works and the new brain issues tokens');

    // --- archive: no new session, data stays on disk ---
    assertEqual((await api('POST', '/brains/gamma/archive', {})).status, 200, 'archive gamma');
    assertEqual((await mcpToolsList(base, '/mcp/gamma', bearer(adminGamma.accessToken))).status, 404, 'an archived brain is not served');
    assert(existsSync(join(brainsRoot, 'gamma')), 'the archived brain keeps its data directory');
    ok('archiving a brain refuses new sessions and keeps its data');

    // --- audit CSV ---
    const csv = await api('GET', '/audit.csv');
    assertEqual(csv.status, 200, 'CSV export');
    assert(/^text\/csv/.test(csv.headers['content-type']), 'CSV content type');
    for (const action of ['user.invite', 'grant.set', 'brain.create', 'brain.archive', 'audit.export']) {
      assert(csv.text.includes(`,FullFran,`) && csv.text.includes(`,${action},`), `the CSV holds ${action}`);
    }
    ok('every admin operation is in the audit CSV');
  } finally {
    await gateway.stop();
  }
}

async function checkConnections(github) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const dataDir = join(scratch, `data-${port}`);
  const gateway = await startGateway(scratch, {
    PORT: String(port), BRAINS_ROOT: join(scratch, `brains-${port}`), BRAINS: 'alpha',
    ...githubEnv(port, github.url, dataDir, { BRAIN_GRANTS: 'owner-o:default:owner,owner-o:alpha:reader' })
  });
  const bearer = token => ({ authorization: `Bearer ${token}` });
  const readDb = query => {
    const db = new DatabaseSync(join(dataDir, 'gateway.db'), { readOnly: true });
    try { return db.prepare(query).all(); } finally { db.close(); }
  };
  try {
    const owner = await githubLogin(base, github, 'owner-o');
    // --- the consent page on the bare /mcp offers the granted brains, capped at the owner's role ---
    const offered = await obtainToken(base, owner.jar, undefined, { decision: 'deny' });
    assert(/name="role:default"/.test(offered.page.text) && /name="role:alpha"/.test(offered.page.text), 'the picker lists every granted brain');
    assert(!/name="role:alpha"[^>]*>(?:(?!<\/select>).)*value="writer"/s.test(offered.page.text), 'no role above the owner\'s on alpha');
    ok('consent on /mcp shows a connection picker with the granted brains and roles up to the owner\'s');

    // --- a reader connection of an owner: mem_save is an MCP error, nothing written, audited with the connection id ---
    const reading = await obtainToken(base, owner.jar, undefined, { connection_name: 'read-only', 'role:default': 'reader' });
    assert(reading.accessToken, `a connection token is issued: ${reading.decided?.text?.slice(0, 200)}`);
    const [connection] = readDb("SELECT id, kind FROM connections WHERE name = 'read-only'");
    assertEqual(connection?.kind, 'oauth', 'the connection is saved');
    const marker = `connection-write-${Date.now()}`;
    const denied = await mcpCall(base, '/mcp', 'mem_save', { title: marker, content: `connection wrote ${marker}`, type: 'discovery' }, bearer(reading.accessToken));
    assertEqual(denied.result?.error?.code, -32602, `mem_save through a reader connection is an MCP error: ${denied.text.slice(0, 200)}`);
    const read = await mcpCall(base, '/mcp', 'mem_search', { query: marker }, bearer(reading.accessToken));
    assert(/No memories found/.test(toolText(read.result)), `nothing was saved: ${toolText(read.result).slice(0, 200)}`);
    const audited = readDb("SELECT outcome, meta_json FROM audit_log WHERE target = 'mem_save'");
    assertEqual(JSON.stringify(audited.map(row => [row.outcome, JSON.parse(row.meta_json).connectionId])), JSON.stringify([['denied', Number(connection.id)]]), 'the audit row carries the connection id');
    ok('a reader connection of an owner cannot save: MCP error, engram unchanged, audit row with the connection id');

    // --- the page's defaults give a reader connection (least privilege); raising the role on the page restores writing; /mcp/<slug> makes no connection ---
    const defaulted = await obtainToken(base, owner.jar, undefined);
    const refusedSave = await mcpCall(base, '/mcp', 'mem_save', { title: `${marker}-d`, content: `default consent ${marker}`, type: 'discovery' }, bearer(defaulted.accessToken));
    assert(refusedSave.result?.error || refusedSave.result?.result?.isError, `the default connection is a reader and cannot save: ${refusedSave.text.slice(0, 200)}`);
    const owning = await obtainToken(base, owner.jar, undefined, { 'role:default': 'owner', connection_name: `raised ${marker}` });
    const saved = await mcpCall(base, '/mcp', 'mem_save', { title: `${marker}-o`, content: `owner wrote ${marker}`, type: 'discovery' }, bearer(owning.accessToken));
    assert(saved.result?.result && !saved.result.result.isError, `a connection raised to owner saves: ${saved.text.slice(0, 200)}`);
    const before = readDb('SELECT count(*) AS n FROM connections')[0].n;
    const single = await obtainToken(base, owner.jar, `${base}/mcp/alpha`);
    assertEqual((await mcpToolsList(base, '/mcp/alpha', bearer(single.accessToken))).status, 200, 'a single-brain token still works');
    assertEqual(readDb('SELECT count(*) AS n FROM connections')[0].n, before, 'no connection for /mcp/<slug>');
    ok('the page defaults to reader on /mcp, the person can raise it; /mcp/<slug> tokens stay single-brain');
  } finally {
    await gateway.stop();
  }
}

async function checkConnectionRouting(github) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const dataDir = join(scratch, `data-${port}`);
  // owner-o owns alpha, beta and gamma and has no grant on default.
  const gateway = await startGateway(scratch, {
    PORT: String(port), BRAINS_ROOT: join(scratch, `brains-${port}`), BRAINS: 'alpha,beta,gamma',
    ...githubEnv(port, github.url, dataDir, { BRAIN_GRANTS: 'owner-o:alpha:owner,owner-o:beta:owner,owner-o:gamma:owner' })
  });
  const bearer = token => ({ authorization: `Bearer ${token}` });
  const enumOf = (list, name) => list.result.result.tools.find(tool => tool.name === name)?.inputSchema?.properties?.brain?.enum;
  const tag = `seedmark${Date.now()}`;
  try {
    const owner = await githubLogin(base, github, 'owner-o');
    // Seed each brain with its own memory through single-brain tokens.
    const single = {};
    for (const brain of ['alpha', 'beta', 'gamma']) {
      single[brain] = (await obtainToken(base, owner.jar, `${base}/mcp/${brain}`)).accessToken;
      const seeded = await mcpCall(base, `/mcp/${brain}`, 'mem_save', { title: `${brain} seed`, content: `${tag} lives in ${brain}`, type: 'discovery' }, bearer(single[brain]));
      assert(seeded.result?.result && !seeded.result.result.isError, `seed ${brain}: ${seeded.text.slice(0, 200)}`);
    }
    const connection = await obtainToken(base, owner.jar, undefined, { connection_name: 'routing', 'role:alpha': 'reader', 'role:beta': 'writer', 'role:gamma': 'none', default_brain: 'alpha' });
    assert(connection.accessToken, `a user without a grant on default connects /mcp to its brains: ${connection.page.text.slice(0, 200)}`);
    const token = bearer(connection.accessToken);

    const list = await mcpToolsList(base, '/mcp', token);
    assertEqual(list.status, 200, `tools/list on /mcp: ${list.text.slice(0, 200)}`);
    assertEqual(JSON.stringify(enumOf(list, 'mem_save')), '["alpha","beta"]', 'the brain argument names exactly the connection\'s brains');
    assertEqual(JSON.stringify(enumOf(list, 'mem_search')), '["alpha","beta","*"]', 'fan-out read tools also take "*"');
    ok('tools/list on /mcp: a `brain` argument naming exactly the connection\'s brains');

    const marker = `routed-${Date.now()}`;
    const denied = await mcpCall(base, '/mcp', 'mem_save', { brain: 'alpha', title: marker, content: `${marker} in alpha`, type: 'discovery' }, token);
    assertEqual(denied.result?.error?.code, -32602, `mem_save on a reader brain is an MCP error: ${denied.text.slice(0, 200)}`);
    const saved = await mcpCall(base, '/mcp', 'mem_save', { brain: 'beta', title: marker, content: `${marker} in beta`, type: 'discovery' }, token);
    assert(saved.result?.result && !saved.result.result.isError, `mem_save on the writer brain: ${saved.text.slice(0, 200)}`);
    const inAlpha = toolText((await mcpCall(base, '/mcp/alpha', 'mem_search', { query: marker }, bearer(single.alpha))).result);
    const inBeta = toolText((await mcpCall(base, '/mcp/beta', 'mem_search', { query: marker }, bearer(single.beta))).result);
    assert(/No memories found/.test(inAlpha), `alpha unchanged: ${inAlpha.slice(0, 200)}`);
    assert(inBeta.includes(`${marker} in beta`), `the write went to beta: ${inBeta.slice(0, 200)}`);
    ok('per-call routing: the reader brain refuses mem_save (engram unchanged), the writer brain takes it');

    const all = await mcpCall(base, '/mcp', 'mem_search', { brain: '*', query: tag }, token);
    const text = toolText(all.result);
    assert(/^brain: alpha$/m.test(text) && /^brain: beta$/m.test(text) && !/brain: gamma/.test(text), `sections for alpha and beta only: ${text.slice(0, 400)}`);
    assert(text.includes(`${tag} lives in alpha`) && text.includes(`${tag} lives in beta`) && !text.includes(`${tag} lives in gamma`), `results from attached brains only: ${text.slice(0, 400)}`);
    assertEqual(JSON.stringify(all.result.result.structuredContent?.results?.map(r => r.brain)), '["alpha","beta"]', 'one structured result per brain');
    ok('brain "*" searches every attached brain and labels each result; a granted but unattached brain is left out');

    const writable = new DatabaseSync(join(dataDir, 'gateway.db'));
    writable.exec('PRAGMA busy_timeout = 5000');
    writable.prepare("DELETE FROM connection_brains WHERE brain_id = (SELECT id FROM brains WHERE slug = 'beta')").run();
    writable.close();
    assertEqual(JSON.stringify(enumOf(await mcpToolsList(base, '/mcp', token), 'mem_search')), '["alpha","*"]', 'a detached brain leaves the list on the next request');
    const afterDetach = await mcpCall(base, '/mcp', 'mem_search', { brain: 'beta', query: tag }, token);
    assertEqual(afterDetach.result?.error?.code, -32602, `a call to a detached brain is refused: ${afterDetach.text.slice(0, 200)}`);
    ok('detaching a brain applies to the next request (same token)');

    const tools = list.result.result.tools.map(tool => tool.name);
    assert(['brain_list', 'connection_brains', 'connection_attach', 'connection_detach'].every(name => tools.includes(name)), `connection tools listed: ${tools.join(',')}`);
    // Attach and detach need the owner role on the connection: this one has reader on alpha only.
    const refused = await mcpCall(base, '/mcp', 'connection_attach', { brain: 'gamma', role: 'reader' }, token);
    assertEqual(refused.result?.error?.code, -32602, `a connection without the owner role cannot attach: ${refused.text.slice(0, 200)}`);
    assertEqual(JSON.stringify(enumOf(await mcpToolsList(base, '/mcp', token), 'mem_search')), '["alpha","*"]', 'a refused attach changes nothing');
    ok('a connection consented without the owner role cannot attach a brain');
    // As the admin UI (#17) would: give the connection owner on alpha.
    const promote = new DatabaseSync(join(dataDir, 'gateway.db'));
    promote.exec('PRAGMA busy_timeout = 5000');
    promote.prepare("UPDATE connection_brains SET role = 'owner' WHERE brain_id = (SELECT id FROM brains WHERE slug = 'alpha')").run();
    promote.close();
    const attached = await mcpCall(base, '/mcp', 'connection_attach', { brain: 'gamma', role: 'reader' }, token);
    assert(attached.result?.result && !attached.result.result.isError, `connection_attach gamma: ${attached.text.slice(0, 200)}`);
    assertEqual(JSON.stringify(enumOf(await mcpToolsList(base, '/mcp', token), 'mem_search')), '["alpha","gamma","*"]', 'an attached brain joins the list on the next request');
    const inGamma = toolText((await mcpCall(base, '/mcp', 'mem_search', { brain: 'gamma', query: tag }, token)).result);
    assert(inGamma.includes(`${tag} lives in gamma`), `the attached brain answers with the same token: ${inGamma.slice(0, 200)}`);
    const writeGamma = await mcpCall(base, '/mcp', 'mem_save', { brain: 'gamma', title: 'x', content: 'x', type: 'discovery' }, token);
    assertEqual(writeGamma.result?.error?.code, -32602, `gamma is attached as reader: ${writeGamma.text.slice(0, 200)}`);
    const detached = await mcpCall(base, '/mcp', 'connection_detach', { brain: 'gamma' }, token);
    assert(detached.result?.result && !detached.result.result.isError, `connection_detach gamma: ${detached.text.slice(0, 200)}`);
    assertEqual(JSON.stringify(enumOf(await mcpToolsList(base, '/mcp', token), 'mem_search')), '["alpha","*"]', 'connection_detach applies to the next request');
    ok('connection_attach / connection_detach from the client change its brains for the next request (same token)');
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
  await checkRoles(github);
  await checkAdmin(github);
  await checkConnections(github);
  await checkConnectionRouting(github);
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
