// Shared setup for the wiki tests (#16): brain data dirs with a journal, the
// wiki service over them, and a gateway serving the wiki tools over MCP.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createBrainDb } from '../fixtures/engram-brain.mjs';
import { GATEWAY_TOOL_ROLES, SqliteGrantRepository, TOOL_ROLES, bootstrapAccess, createToolAccess } from '../../dist/authz/index.js';
import { SqliteAuditLog, toolCallRecorder } from '../../dist/audit/index.js';
import { BrainRegistry, SqliteBrainRepository } from '../../dist/brains/index.js';
import { createEngramBridge } from '../../dist/bridge/index.js';
import { createGatewayApp } from '../../dist/http/app.js';
import { createAuditStage, createToolCallPipeline } from '../../dist/pipeline/index.js';
import { openGatewayDatabase } from '../../dist/shared/gateway-database.js';
import { createGatewayToolSet, createWikiTools } from '../../dist/gateway-tools/index.js';
import { createSqliteWikiService } from '../../dist/wiki/index.js';

const FAKE_ENGRAM = fileURLToPath(new URL('../fixtures/fake-mcp-server.mjs', import.meta.url));
export const logger = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level, () => {}]));
export const NOW_MS = Date.parse('2026-11-19T10:00:00Z');

export function scratch(t, prefix = 'engram-gateway-wiki-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Adds an observation with a sync_id (`obs-<n>` by default); returns its id. */
export function observe(db, { type = 'decision', title = 'a title', content = 'synthetic content', syncId, deleted = false, project = 'demo' } = {}) {
  const id = Number(db.prepare(
    `INSERT INTO observations (session_id, type, title, content, project, deleted_at) VALUES ('s1', ?, ?, ?, ?, ?)`
  ).run(type, title, content, project, deleted ? '2026-10-01 00:00:00' : null).lastInsertRowid);
  db.prepare('UPDATE observations SET sync_id = ? WHERE id = ?').run(syncId ?? `obs-${id}`, id);
  return id;
}

/** A brain dir whose engram.db holds `rows` (each an `observe` spec); returns the dir. */
export function brainDir(t, rows = []) {
  const dir = scratch(t, 'engram-gateway-brain-');
  const db = createBrainDb(dir);
  for (const row of rows) observe(db, row);
  db.close();
  return dir;
}

/** The wiki service over `dirs` (slug -> data dir); `held` lists quiesced brains. */
export function wikiService(dirs, { held = new Set() } = {}) {
  return createSqliteWikiService({ dataDirOf: slug => dirs[slug], isQuiesced: slug => held.has(slug), nowMs: () => NOW_MS });
}

export const OWNER = { login: 'olive', role: 'owner' };
export const WRITER = { login: 'wendy', role: 'writer' };
export const WRITER2 = { login: 'walt', role: 'writer' };
export const READER = { login: 'rita', role: 'reader' };

export const page = (slug, extra = {}) => ({ op: 'upsert_page', slug, kind: 'concept', title: `Title of ${slug}`, body: `Body of ${slug}`, citations: ['obs-1'], ...extra });
export const link = (from, to, type = 'depends_on', extra = {}) => ({ op: 'link', from, to, type, citations: ['obs-1'], ...extra });

/** The JSON inside the result's memory-data block (the wrap stage delimits it as data). */
export function unwrapJson(result) {
  const text = result.content.map(item => item.text).join('\n');
  const match = /<memory-data nonce="(\w+)">\n([\s\S]*)\n<\/memory-data nonce="\1">/.exec(text);
  assert.ok(match, `result is wrapped as data: ${text.slice(0, 120)}`);
  return JSON.parse(match[2]);
}

/** A gateway serving brain `team` (with `rows` in its journal) and the wiki tools over MCP, auth on. */
export async function wikiGateway(t, rows = []) {
  const db = openGatewayDatabase(join(scratch(t, 'engram-gateway-db-'), 'gateway.db'));
  t.after(() => db.close());
  const dataDirs = { default: scratch(t), team: brainDir(t, rows) };
  const repo = new SqliteBrainRepository(db);
  for (const slug of Object.keys(dataDirs)) repo.ensure(slug, dataDirs[slug]);
  const grants = new SqliteGrantRepository(db);
  bootstrapAccess(grants, {
    admins: [],
    grants: [OWNER, WRITER, WRITER2, READER].map(({ login, role }) => ({ login, brain: 'team', role })),
    brains: Object.keys(dataDirs),
  });
  const auditLog = new SqliteAuditLog(db);
  const pipeline = createToolCallPipeline({
    access: createToolAccess(grants),
    audit: createAuditStage({ record: toolCallRecorder(auditLog, { nowMs: () => Date.now() }) }),
  });
  const wiki = createSqliteWikiService({ dataDirOf: slug => repo.findActive(slug)?.dataDir, isQuiesced: () => false, nowMs: () => NOW_MS });
  const gatewayTools = createGatewayToolSet(createWikiTools(wiki), { engram: TOOL_ROLES, gateway: GATEWAY_TOOL_ROLES });
  const registry = new BrainRegistry({
    brains: { get: slug => repo.findActive(slug) },
    createProcess: brain => createEngramBridge({ command: process.execPath, args: [FAKE_ENGRAM], logger, pipeline, gatewayTools, brain: brain.slug }),
    clock: { now: () => Date.now() }, idleTimeoutMs: 60_000, maxLiveBrains: 2, logger,
  });
  t.after(() => registry.stopAll());
  const state = { login: 'olive' };
  const authenticator = {
    prepare: async () => {},
    authenticate: headers => headers.authorization
      ? { ok: true, principal: { login: state.login, clientId: 'c1', scopes: ['memory'], token: 't' } }
      : { ok: false, status: 401, error: 'unauthorized', challenge: 'Bearer realm="test"' },
  };
  const app = createGatewayApp({
    bindHost: '127.0.0.1', trustProxy: false, logger, brains: registry,
    auth: { router: express.Router(), authenticator, resource: 'http://127.0.0.1/mcp' },
    brainAccess: { mayOpen: (who, brain) => grants.roleOf(who, brain) !== undefined },
  });
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }));
  /** An MCP client on /mcp/team signed in as `login`. */
  const as = async login => {
    state.login = login;
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp/team`), { requestInit: { headers: { authorization: 'Bearer t' } } }));
    t.after(() => client.close().catch(() => {}));
    return client;
  };
  const audit = () => [...auditLog.read()].map(row => [row.actorLogin, row.target, row.outcome]);
  return { as, audit, dataDirs, wiki };
}
