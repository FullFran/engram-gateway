#!/usr/bin/env node

// Wire-level checks for personal access tokens (#7) against a real
// `dist/main.js` gateway and a real `engram mcp` child:
//   - a signed-in user creates PATs from /account/api (secret shown once)
//   - a `read` PAT of a writer cannot save (MCP error, engram unchanged);
//     a `read+write` PAT saves; both on the bare /mcp as a Bearer token
//   - on /mcp/<slug> a read PAT cannot save (engram unchanged); a brain
//     outside the token is 403
//   - revoked and expired tokens get 401 with the standard WWW-Authenticate
//   - revoking the owner's grant, then disabling the owner, block the token
//     on the next request
//   - a service account works through its own grants and PAT, never signs
//     in, and disabling it blocks its token
//   - the gateway database holds no token secret; refusals are audited
// Scratch state lives outside the repository and is kept (its path is printed).

import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assert, assertEqual, cookieHeader, freePort, githubEnv, githubLogin, mcpCall, mcpToolsList, repoRoot, request, startFakeGitHub, startGateway
} from './lib/harness.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'engram-gateway-pats-'));
let passed = 0;
const ok = label => { passed += 1; console.log(`  ok - ${label}`); };
const toolText = result => (result?.result?.content ?? []).map(part => part.text ?? '').join('\n');
const bearer = token => ({ authorization: `Bearer ${token}` });

async function checkPats(github) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const dataDir = join(scratch, `data-${port}`);
  const gateway = await startGateway(scratch, { PORT: String(port), BRAINS_ROOT: join(scratch, `brains-${port}`), BRAINS: 'alpha', ...githubEnv(port, github.url, dataDir) });
  const cli = (...args) => execFileSync(process.execPath, [join(repoRoot, 'dist', 'cli.js'), 'admin', ...args], { env: { ...process.env, GATEWAY_DATA_DIR: dataDir }, encoding: 'utf8' });
  const gatewayDb = (query, ...params) => {
    const db = new DatabaseSync(join(dataDir, 'gateway.db'));
    try { return db.prepare(query).all(...params); } finally { db.close(); }
  };
  try {
    cli('users', 'invite', 'dev-d');
    cli('grants', 'set', 'dev-d', 'default', 'writer');
    cli('grants', 'set', 'dev-d', 'alpha', 'writer');
    const { jar } = await githubLogin(base, github, 'dev-d');
    assert(jar, 'dev-d signs in');
    const createPat = async body => request(base, { method: 'POST', path: '/account/api/tokens', headers: { cookie: cookieHeader(jar), origin: base }, json: { expiresInDays: 30, ...body } });

    // --- create: 201 with the secret once; read scope is a reader connection even though dev-d is a writer ---
    const reading = await createPat({ name: 'ci-read', brains: ['default'], scope: 'read' });
    assertEqual(reading.status, 201, `create a read PAT (${reading.text.slice(0, 200)})`);
    const writing = await createPat({ name: 'ci-write', brains: ['default'], scope: 'read+write' });
    assertEqual(writing.status, 201, `create a read+write PAT (${writing.text.slice(0, 200)})`);
    const listed = await request(base, { path: '/account/api/tokens', headers: { cookie: cookieHeader(jar) } });
    assertEqual(listed.body.tokens.length, 2, 'both listed');
    assert(!listed.text.includes(reading.body.token) && !listed.text.includes(writing.body.token), 'the list holds no secret');
    ok('a signed-in user creates PATs from /account/api; the secret is shown once');

    // --- read PAT of a writer: no mem_save in tools/list, mem_save refused, engram unchanged ---
    const tools = await mcpToolsList(base, '/mcp', bearer(reading.body.token));
    assertEqual(tools.status, 200, `tools/list with a PAT (${tools.text.slice(0, 200)})`);
    const names = tools.result.result.tools.map(tool => tool.name);
    assert(names.includes('mem_search') && !names.includes('mem_save'), `reader tools only: ${names.join(',')}`);
    const marker = `pat-write-${Date.now()}`;
    const denied = await mcpCall(base, '/mcp', 'mem_save', { title: marker, content: `read PAT wrote ${marker}`, type: 'discovery' }, bearer(reading.body.token));
    assertEqual(denied.result?.error?.code, -32602, `mem_save with a read PAT is an MCP error: ${denied.text.slice(0, 200)}`);
    const nothing = await mcpCall(base, '/mcp', 'mem_search', { query: marker }, bearer(writing.body.token));
    assert(/No memories found/.test(toolText(nothing.result)), `nothing was saved: ${toolText(nothing.result).slice(0, 200)}`);
    const saved = await mcpCall(base, '/mcp', 'mem_save', { title: `${marker}-w`, content: `write PAT wrote ${marker}`, type: 'discovery' }, bearer(writing.body.token));
    assert(saved.result?.result && !saved.result.result.isError, `mem_save with a read+write PAT: ${saved.text.slice(0, 200)}`);
    const found = await mcpCall(base, '/mcp', 'mem_search', { query: marker }, bearer(reading.body.token));
    assert(toolText(found.result).includes(`${marker}-w`), `the read PAT reads it: ${toolText(found.result).slice(0, 200)}`);
    ok('a read PAT cannot write even though its owner is a writer (engram unchanged); a read+write PAT can');

    // --- /mcp/<slug>: its own brain only ---
    assertEqual((await mcpToolsList(base, '/mcp/default', bearer(reading.body.token))).status, 200, 'its brain on /mcp/default');
    const slugMarker = `${marker}-slug`;
    const slugDenied = await mcpCall(base, '/mcp/default', 'mem_save', { title: slugMarker, content: `read PAT wrote ${slugMarker}`, type: 'discovery' }, bearer(reading.body.token));
    assertEqual(slugDenied.result?.error?.code, -32602, `mem_save with a read PAT on /mcp/default is an MCP error: ${slugDenied.text.slice(0, 200)}`);
    const slugNothing = await mcpCall(base, '/mcp/default', 'mem_search', { query: slugMarker }, bearer(writing.body.token));
    assert(/No memories found/.test(toolText(slugNothing.result)), `nothing was saved through /mcp/default: ${toolText(slugNothing.result).slice(0, 200)}`);
    assertEqual((await mcpToolsList(base, '/mcp/alpha', bearer(reading.body.token))).status, 403, 'alpha is outside the token (dev-d has a grant there)');
    ok('a PAT on /mcp/<slug>: a read PAT cannot write its own brain (engram unchanged); a brain outside it is refused');

    // --- revoked and expired: 401 with the standard challenge ---
    const revoke = await request(base, { method: 'DELETE', path: `/account/api/tokens/${reading.body.id}`, headers: { cookie: cookieHeader(jar), origin: base, 'content-type': 'application/json' } });
    assertEqual(revoke.status, 200, `revoke (${revoke.text.slice(0, 200)})`);
    const expiring = await createPat({ name: 'ci-expiring', brains: ['default'], scope: 'read' });
    gatewayDb('UPDATE personal_access_tokens SET expires_at = unixepoch() - 1 WHERE id = ?', expiring.body.id);
    for (const [label, token] of [['revoked', reading.body.token], ['expired', expiring.body.token]]) {
      const refused = await mcpToolsList(base, '/mcp', bearer(token));
      assertEqual(refused.status, 401, `${label} PAT`);
      const challenge = String(refused.headers['www-authenticate'] ?? '');
      assert(challenge.startsWith('Bearer resource_metadata=') && challenge.includes('error="invalid_token"'), `${label}: standard challenge (${challenge})`);
    }
    ok('revoked and expired PATs get 401 with the standard WWW-Authenticate challenge');

    // --- the owner's grant, then the owner, decide on the next request ---
    cli('grants', 'revoke', 'dev-d', 'default');
    const noGrant = await mcpCall(base, '/mcp', 'mem_search', { query: marker }, bearer(writing.body.token));
    assertEqual(noGrant.result?.error?.code, -32602, `a PAT whose owner lost the grant is refused: ${noGrant.text.slice(0, 200)}`);
    assertEqual((await mcpToolsList(base, '/mcp/default', bearer(writing.body.token))).status, 403, '403 on /mcp/default');
    cli('grants', 'set', 'dev-d', 'default', 'writer');
    assertEqual((await mcpToolsList(base, '/mcp/default', bearer(writing.body.token))).status, 200, 'back with the grant');
    cli('users', 'disable', 'dev-d');
    assertEqual((await mcpToolsList(base, '/mcp', bearer(writing.body.token))).status, 401, 'a disabled owner\'s PAT gets 401');
    ok('revoking the owner\'s grant or disabling the owner blocks the PAT on the next request');

    // --- service accounts: their own grants and PATs; never a sign-in; disabling blocks their tokens ---
    cli('service-accounts', 'create', 'ci-bot', '--owner', 'FullFran');
    cli('grants', 'set', 'ci-bot', 'default', 'writer');
    const botToken = cli('tokens', 'create', 'ci-bot', '--name', 'deploy', '--brains', 'default', '--scope', 'read+write', '--expires', '30').trim().split('\n').at(-1);
    const botSaved = await mcpCall(base, '/mcp', 'mem_save', { title: `${marker}-bot`, content: `service account wrote ${marker}`, type: 'discovery' }, bearer(botToken));
    assert(botSaved.result?.result && !botSaved.result.result.isError, `a service account's PAT saves: ${botSaved.text.slice(0, 200)}`);
    assertEqual((await githubLogin(base, github, 'ci-bot')).jar, null, 'a GitHub user with the service account\'s login cannot sign in');
    cli('users', 'disable', 'ci-bot');
    assertEqual((await mcpToolsList(base, '/mcp', bearer(botToken))).status, 401, 'a disabled service account\'s PAT gets 401');
    ok('a service account uses its own grants through its PAT, never signs in, and disabling it blocks the token');

    // --- hashes only; audit rows without token material ---
    for (const token of [reading.body.token, writing.body.token, expiring.body.token, botToken]) {
      const db = new DatabaseSync(join(dataDir, 'gateway.db'), { readOnly: true });
      try {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name);
        for (const table of tables) {
          const hit = db.prepare(`SELECT * FROM "${table}"`).all().some(row => Object.values(row).some(value => String(value).includes(token.slice(8))));
          assert(!hit, `table ${table} holds no PAT secret`);
        }
      } finally {
        db.close();
      }
    }
    const audited = gatewayDb("SELECT action, outcome, meta_json FROM audit_log WHERE action LIKE 'pat.%' ORDER BY id").map(row => `${row.action}:${row.outcome}:${JSON.parse(row.meta_json).errorKind ?? ''}`);
    for (const expected of ['pat.create:ok:', 'pat.revoke:ok:', 'pat.use:denied:revoked', 'pat.use:denied:expired', 'pat.use:denied:owner_disabled']) {
      assert(audited.includes(expected), `audited ${expected}: ${audited.join(', ')}`);
    }
    assert(!gateway.output().includes('egw_pat_'), 'no token in the gateway log');
    assert(readdirSync(dataDir).includes('gateway.db'), 'gateway database in the data directory');
    ok('the gateway database holds PAT hashes only; creation, revocation and refused uses are audited');
  } finally {
    await gateway.stop();
  }
}

const github = await startFakeGitHub();
try {
  console.log(`PAT checks (scratch: ${scratch})`);
  await checkPats(github);
  console.log(`PAT check passed: ${passed} groups.`);
} catch (error) {
  console.error(`PAT check failed after ${passed} passing groups: ${error.stack || error.message}`);
  process.exitCode = 1;
} finally {
  await github.close();
  console.log(`scratch kept: ${scratch}`);
}
process.exit(process.exitCode ?? 0);
