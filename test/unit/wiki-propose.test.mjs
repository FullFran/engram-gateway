// Wiki (#16), part 1: wiki.db per brain, brain_compile_pack and brain_propose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { GATEWAY_TOOL_ROLES, requiredRole } from '../../dist/authz/index.js';
import { BrainRegistry } from '../../dist/brains/index.js';
import { PACK_LIMITS, WIKI_DB_FILE, WikiError, computeWarnings, parseProposeInput } from '../../dist/wiki/index.js';
import { NOW_MS, OWNER, READER, WRITER, WRITER2, brainDir, link, page, unwrapJson, wikiGateway, wikiService } from './wiki-harness.mjs';

const wikiError = code => error => error instanceof WikiError && error.code === code;

// --- input and warnings (pure) ---

test('brain_propose input: typed pages and links, each with at least one citation; bad input is refused, naming the field', () => {
  const ok = parseProposeInput({ summary: 's', items: [page('a', { baseRevision: 2 }), link('a', 'b', 'part_of')] });
  assert.deepEqual(ok.items[0], { op: 'upsert_page', slug: 'a', kind: 'concept', title: 'Title of a', body: 'Body of a', citations: ['obs-1'], baseRevision: 2 });
  assert.deepEqual(ok.items[1], { op: 'link', from: 'a', to: 'b', type: 'part_of', citations: ['obs-1'] });
  const refused = [
    [{ summary: 's', items: [] }, /items must list at least one item/],
    [{ summary: 's', items: [page('a', { kind: 'essay' })] }, /items\[0\]\.kind must be one of concept, decision, component, procedure/],
    [{ summary: 's', items: [page('a', { citations: [] })] }, /items\[0\]\.citations must list at least one/],
    [{ summary: 's', items: [page('A b')] }, /items\[0\]\.slug must be lowercase/],
    [{ summary: 's', items: [link('a', 'a')] }, /cannot link to itself/],
    [{ summary: 's', items: [link('a', 'b', 'likes')] }, /type must be one of depends_on, part_of, supersedes, contradicts/],
    [{ summary: 's', items: [page('a'), page('a')] }, /items\[1\] repeats page a/],
    [{ summary: 's', items: Array.from({ length: 51 }, (_, i) => page(`p${i}`)) }, /more than 50/],
    [{ summary: 's', items: [page('a', { body: 'x'.repeat(20_001) })] }, /body is longer than 20000/],
    [{ summary: 's', items: [page('a')], extra: 1 }, /unknown field extra/],
    [{ summary: '', items: [page('a')] }, /summary must not be empty/],
  ];
  for (const [args, message] of refused) assert.throws(() => parseProposeInput(args), error => error instanceof WikiError && error.code === 'invalid' && message.test(error.message), message.source);
});

test('warnings: duplicate title, broken link, stale page, open conflict, missing citation; none of them blocks', () => {
  const view = {
    page: slug => ({ old: { revision: 3, title: 'Old' } })[slug],
    pagesTitled: title => (title.toLowerCase() === 'old' ? ['old'] : []),
    hasLiveLink: () => false,
    otherProposalsTouching: slug => (slug === 'old' ? [7] : []),
    citation: id => ({ 'obs-1': 'live', 'obs-2': 'deleted' })[id],
  };
  const items = [
    { id: 1, item: page('fresh', { title: 'OLD', baseRevision: null }) },
    { id: 2, item: page('old', { baseRevision: 2, citations: ['obs-1', 'obs-2', 'obs-9'] }) },
    { id: 3, item: link('fresh', 'ghost') },
    { id: 4, item: { op: 'unlink', from: 'old', to: 'fresh', type: 'part_of', citations: ['obs-1'] } },
    { id: 5, item: link('old', 'fresh', 'contradicts') },
  ];
  const got = computeWarnings(1, items, view).map(w => [w.itemId, w.code]);
  assert.deepEqual(got, [
    [1, 'duplicate_title'],
    [2, 'stale_page'], [2, 'open_conflict'], [2, 'missing_citation'], [2, 'missing_citation'],
    [3, 'broken_link'],
    [4, 'broken_link'], [4, 'open_conflict'],
    [5, 'open_conflict'], [5, 'open_conflict'],
  ]);
});

// --- brain_compile_pack ---

test('compile pack: live journal rows after the cursor, oldest first, noise and deleted rows skipped, contents cut at maxChars', async t => {
  const dir = brainDir(t, [
    { title: 'one', content: 'x'.repeat(150) },
    { type: 'passive', title: 'noise' },
    { type: 'checkpoint', title: 'noise' },
    { type: 'task-state', title: 'noise' },
    { title: 'gone', deleted: true },
    { type: 'architecture', title: 'two', project: 'other' },
    { title: 'three' },
  ]);
  const wiki = wikiService({ team: dir });
  const pack = wiki.compilePack(WRITER, 'team', { limit: 2, maxChars: 100 });
  assert.deepEqual(pack.entries.map(e => [e.id, e.syncId, e.title, e.truncated]), [[1, 'obs-1', 'one', true], [6, 'obs-6', 'two', false]]);
  assert.equal(pack.entries[0].content.length, 100);
  assert.deepEqual({ afterId: pack.afterId, more: pack.more, nextAfterId: pack.nextAfterId, skipped: pack.skippedTypes }, { afterId: 0, more: true, nextAfterId: 6, skipped: ['checkpoint', 'passive', 'task-state'] });
  const rest = wiki.compilePack(WRITER, 'team', { afterId: pack.nextAfterId });
  assert.deepEqual(rest.entries.map(e => e.id), [7]);
  assert.equal(rest.more, false);
  assert.deepEqual(wiki.compilePack(WRITER, 'team', { project: 'other' }).entries.map(e => e.id), [6]);
  assert.equal(existsSync(join(dir, WIKI_DB_FILE)), false, 'reading never creates wiki.db');
});

test('compile pack bounds: limit and maxChars are clamped; unknown or negative arguments are refused', async t => {
  const wiki = wikiService({ team: brainDir(t, [{ content: 'y'.repeat(9_000) }]) });
  const pack = wiki.compilePack(WRITER, 'team', { limit: 10_000, maxChars: 1_000_000 });
  assert.equal(pack.entries[0].content.length, PACK_LIMITS.maxMaxChars);
  assert.equal(wiki.compilePack(WRITER, 'team', { maxChars: 1 }).entries[0].content.length, PACK_LIMITS.minMaxChars);
  for (const bad of [{ limit: -1 }, { afterId: 1.5 }, { since: 3 }, { project: '' }]) {
    assert.throws(() => wiki.compilePack(WRITER, 'team', bad), wikiError('invalid'), JSON.stringify(bad));
  }
});

test('compile pack resumes after the highest observation a proposal cited, and lists existing pages', async t => {
  const wiki = wikiService({ team: brainDir(t, [{}, {}, {}, {}]) });
  wiki.propose(WRITER, 'team', { summary: 's', items: [page('a', { citations: ['obs-1', 'obs-3'] })] });
  const pack = wiki.compilePack(WRITER, 'team', {});
  assert.equal(pack.afterId, 3);
  assert.deepEqual(pack.entries.map(e => e.id), [4]);
  assert.deepEqual({ pages: pack.pages, total: pack.totalPages }, { pages: [], total: 0 }, 'nothing is a page until an owner approves');
});

test('compile pack errors: unknown brain, brain without engram.db, brain being restored', async t => {
  const empty = brainDir(t);
  const wiki = wikiService({ team: empty, fresh: join(empty, 'nothing-here') }, { held: new Set(['team']) });
  assert.throws(() => wiki.compilePack(WRITER, 'ghost', {}), error => error.code === 'not_found' && /unknown brain "ghost"/.test(error.message));
  assert.throws(() => wiki.compilePack(WRITER, 'fresh', {}), error => error.code === 'unavailable' && /no engram\.db/.test(error.message));
  assert.throws(() => wiki.compilePack(WRITER, 'team', {}), error => error.code === 'unavailable' && /being restored/.test(error.message));
});

// --- brain_propose ---

test('propose stores a proposal in the brain\'s own wiki.db (not engram.db), with item ids and warnings', async t => {
  const dir = brainDir(t, [{}, { deleted: true }]);
  const wiki = wikiService({ team: dir });
  const receipt = wiki.propose(WRITER, 'team', { summary: 'first', items: [page('a', { citations: ['obs-1', 'obs-2'] }), link('a', 'b')] });
  assert.deepEqual(receipt, {
    proposalId: 1,
    revision: 1,
    items: [{ id: 1, op: 'upsert_page', slugs: ['a'] }, { id: 2, op: 'link', slugs: ['a', 'b'] }],
    warnings: [
      { itemId: 1, code: 'missing_citation', message: 'cited observation obs-2 was deleted' },
      { itemId: 2, code: 'broken_link', message: 'page b does not exist and is not proposed here' },
    ],
  });
  const db = new DatabaseSync(join(dir, WIKI_DB_FILE), { readOnly: true });
  t.after(() => db.close());
  assert.deepEqual(db.prepare('SELECT id, revision, status, proposer, summary FROM proposals').all().map(r => ({ ...r })), [{ id: 1, revision: 1, status: 'open', proposer: 'wendy', summary: 'first' }]);
  assert.deepEqual(db.prepare('SELECT op, page_slug, other_slug, state FROM proposal_items ORDER BY seq').all().map(r => ({ ...r })), [
    { op: 'upsert_page', page_slug: 'a', other_slug: null, state: 'pending' },
    { op: 'link', page_slug: 'a', other_slug: 'b', state: 'pending' },
  ]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pages').get().n, 0, 'proposing changes no page');
  const engram = new DatabaseSync(join(dir, 'engram.db'), { readOnly: true });
  t.after(() => engram.close());
  assert.equal(engram.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name IN ('proposals', 'pages')").get().n, 0, 'engram.db is untouched');
});

test('a brain without engram.db yet can still propose; every citation is then a warning', async t => {
  const fresh = wikiService({ fresh: join(brainDir(t), 'no-journal') });
  const receipt = fresh.propose(WRITER, 'fresh', { summary: 's', items: [page('a')] });
  assert.deepEqual(receipt.warnings.map(w => w.code), ['missing_citation']);
});

test('revising: the proposer (or an owner) replaces the pending items and bumps the revision; another writer cannot', async t => {
  const wiki = wikiService({ team: brainDir(t, [{}]) });
  wiki.propose(WRITER, 'team', { summary: 'v1', items: [page('a')] });
  assert.throws(() => wiki.propose(WRITER2, 'team', { proposalId: 1, summary: 'hijack', items: [page('b')] }), error => error.code === 'forbidden' && /only the proposer/.test(error.message));
  const v2 = wiki.propose(WRITER, 'team', { proposalId: 1, summary: 'v2', items: [page('a', { title: 'Better' }), page('b')] });
  assert.deepEqual({ id: v2.proposalId, revision: v2.revision, items: v2.items.map(i => [i.id, i.slugs[0]]) }, { id: 1, revision: 2, items: [[2, 'a'], [3, 'b']] });
  const v3 = wiki.propose(OWNER, 'team', { proposalId: 1, summary: 'corrected by owner', items: [page('a', { title: 'Best' })] });
  assert.equal(v3.revision, 3);
  assert.throws(() => wiki.propose(WRITER, 'team', { proposalId: 9, summary: 's', items: [page('a')] }), wikiError('not_found'));
});

test('two open proposals touching the same page warn each other (open conflict)', async t => {
  const wiki = wikiService({ team: brainDir(t, [{}]) });
  wiki.propose(WRITER, 'team', { summary: 'one', items: [page('a')] });
  const second = wiki.propose(WRITER2, 'team', { summary: 'two', items: [page('a', { title: 'Other title' })] });
  assert.deepEqual(second.warnings, [{ itemId: 2, code: 'open_conflict', message: 'other open proposals touch the same pages: 1' }]);
});

test('roles: compile pack and propose need writer; the service checks it itself, for any entry point', async t => {
  assert.equal(GATEWAY_TOOL_ROLES.brain_compile_pack, 'writer');
  assert.equal(requiredRole('brain_propose'), 'writer');
  const dir = brainDir(t, [{}]);
  const wiki = wikiService({ team: dir });
  assert.throws(() => wiki.compilePack(READER, 'team', {}), error => error.code === 'forbidden' && /brain_compile_pack needs the writer role/.test(error.message));
  assert.throws(() => wiki.propose(READER, 'team', { summary: 's', items: [page('a')] }), wikiError('forbidden'));
  assert.equal(existsSync(join(dir, WIKI_DB_FILE)), false, 'a refused proposal creates nothing');
  assert.doesNotThrow(() => wiki.propose({}, 'team', { summary: 'auth off', items: [page('a')] }), 'no role: authentication is off and the pipeline allowed the call');
});

test('a brain being restored refuses proposals and never gets a new wiki.db', async t => {
  const dir = brainDir(t, [{}]);
  const wiki = wikiService({ team: dir }, { held: new Set(['team']) });
  assert.throws(() => wiki.propose(WRITER, 'team', { summary: 's', items: [page('a')] }), error => error.code === 'unavailable' && /being restored/.test(error.message));
  assert.equal(existsSync(join(dir, WIKI_DB_FILE)), false);
});

test('the brain registry says when a brain is quiesced (what main.ts feeds the wiki): only while the held work runs', async () => {
  const registry = new BrainRegistry({
    brains: new Map([['team', { slug: 'team', dataDir: '/nowhere', cloudSync: false }]]),
    createProcess: () => ({ live: () => false, close: async () => {} }),
    clock: { now: () => NOW_MS }, idleTimeoutMs: 60_000, maxLiveBrains: 1, logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
  assert.equal(registry.isQuiesced('team'), false);
  let during;
  await registry.quiesce('team', async () => { during = registry.isQuiesced('team'); });
  assert.equal(during, true);
  assert.equal(registry.isQuiesced('team'), false);
});

// --- over MCP, through the whole pipeline ---

test('over MCP: writers see and use the wiki tools; results are wrapped as data; secrets in a proposal are redacted before storage', async t => {
  const gw = await wikiGateway(t, [{ title: 'decided X', content: 'we chose X' }]);
  const writer = await gw.as('wendy');
  const names = (await writer.listTools()).tools.map(tool => tool.name);
  assert.ok(names.includes('brain_compile_pack') && names.includes('brain_propose'), names.join(','));
  const pack = unwrapJson(await writer.callTool({ name: 'brain_compile_pack', arguments: {} }));
  assert.deepEqual(pack.entries.map(e => [e.syncId, e.title, e.content]), [['obs-1', 'decided X', 'we chose X']]);
  const token = `ghp_${'a'.repeat(36)}`;
  const receipt = unwrapJson(await writer.callTool({ name: 'brain_propose', arguments: { summary: 's', items: [page('x', { body: `token ${token}` })] } }));
  assert.equal(receipt.proposalId, 1);
  const db = new DatabaseSync(join(gw.dataDirs.team, WIKI_DB_FILE), { readOnly: true });
  t.after(() => db.close());
  const stored = JSON.parse(db.prepare('SELECT payload FROM proposal_items').get().payload);
  assert.equal(stored.body, 'token [secret removed:github]');
  assert.deepEqual(gw.audit(), [['wendy', 'brain_compile_pack', 'ok'], ['wendy', 'brain_propose', 'ok']]);
});

test('over MCP: readers neither see nor may call compile pack or propose; refusals are audited', async t => {
  const gw = await wikiGateway(t, [{}]);
  const reader = await gw.as('rita');
  const names = (await reader.listTools()).tools.map(tool => tool.name);
  assert.ok(!names.includes('brain_compile_pack') && !names.includes('brain_propose'), names.join(','));
  await assert.rejects(reader.callTool({ name: 'brain_propose', arguments: { summary: 's', items: [page('a')] } }), error => error.code === -32602);
  assert.deepEqual(gw.audit(), [['rita', 'brain_propose', 'denied']]);
  assert.equal(existsSync(join(gw.dataDirs.team, WIKI_DB_FILE)), false);
});

test('over MCP: a use-case refusal is a wrapped tool error, not a protocol error', async t => {
  const gw = await wikiGateway(t, [{}]);
  const writer = await gw.as('wendy');
  const result = await writer.callTool({ name: 'brain_propose', arguments: { summary: 's', items: [page('a', { kind: 'essay' })] } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /<memory-data nonce="\w+">\ninvalid arguments: items\[0\]\.kind must be one of/);
});
