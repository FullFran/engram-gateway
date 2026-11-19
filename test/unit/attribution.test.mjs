// Author attribution in shared brains (#21): the pipeline records who wrote
// each observation (from the id in Engram's result) in the gateway database
// and shows it next to read results. Unknown authors are never guessed, and a
// write whose result carries no id still succeeds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AUTHORS_META_KEY, SqliteAuthorshipRepository, createAttributor } from '../../dist/attribution/index.js';
import { SqliteAuditLog, toolCallRecorder } from '../../dist/audit/index.js';
import {
  createAttributionStage, createAuditStage, createToolCallPipeline, passResult, runToolCall
} from '../../dist/pipeline/index.js';
import { openGatewayDatabase } from '../../dist/shared/gateway-database.js';

const T0 = 1_800_000_000_000;
const ALICE = { login: 'alice', clientId: 'client-a' };
const BOB = { login: 'bob', clientId: 'client-b' };

function gatewayDb(t) {
  const dir = mkdtempSync(join(tmpdir(), 'engram-gateway-attribution-'));
  const db = openGatewayDatabase(join(dir, 'gateway.db'));
  t.after(() => { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  return db;
}

/** Engram 3.7.2 result shapes, as `engram mcp` returns them (JSON in one text item). */
const engram = payload => ({ content: [{ type: 'text', text: JSON.stringify(payload) }] });
const saved = (id, syncId) => engram({ id, sync_id: syncId, project: 'p', result: 'Memory saved: "T" (decision)' });
const updated = id => engram({ project: 'p', result: `Memory updated: #${id} "T" (decision, scope=project)` });
const searched = ids => engram({ project: 'p', result: `Found ${ids.length} memories`, results: ids.map(id => ({ id, sync_id: `obs-${id}`, title: 'T' })) });
const passive = () => engram({ project: 'p', result: 'Passive capture complete: extracted=1 saved=1 duplicates=0' });
const toolError = text => ({ content: [{ type: 'text', text }], isError: true });

/** A pipeline with the attribution stage (and an audit stage) on a fresh gateway database; the clock advances 5 ms per read. */
function attributedPipeline(t, { onError, wrap = passResult } = {}) {
  const db = gatewayDb(t);
  let now = T0;
  const clock = { nowMs: () => (now += 5) };
  const attribute = createAttributor({ authors: new SqliteAuthorshipRepository(db), clock });
  const pipeline = createToolCallPipeline({
    attribute: createAttributionStage({ attribute, ...(onError ? { onError } : {}) }),
    audit: createAuditStage({ record: toolCallRecorder(new SqliteAuditLog(db), clock) }),
    wrap
  });
  const call = (name, args, result, caller, brain = 'team') =>
    runToolCall(pipeline, { name, arguments: args }, async () => result, { ...(caller ? { caller } : {}), brain, nowMs: clock.nowMs });
  return { db, call };
}

const authorRows = db => db.prepare(
  `SELECT a.brain_id, a.observation_id, a.sync_id, f.github_login AS author, l.github_login AS last_writer, a.first_written_at, a.last_written_at
   FROM observation_authors a LEFT JOIN users f ON f.id = a.user_id LEFT JOIN users l ON l.id = a.last_writer_id
   ORDER BY a.brain_id, a.observation_id`).all().map(row => ({ ...row }));
const auditMeta = db => db.prepare('SELECT meta_json FROM audit_log ORDER BY id').all().map(row => JSON.parse(row.meta_json));
const texts = result => result.content.filter(item => item.type === 'text').map(item => item.text);

test('mem_save records the caller as author of the returned id, per brain, and returns the result unchanged', async t => {
  const { db, call } = attributedPipeline(t);
  const result = saved(7, 'obs-7');
  const out = await call('mem_save', { title: 'T', content: 'c' }, result, ALICE);
  assert.equal(out, result);
  assert.deepEqual(authorRows(db), [
    { brain_id: 'team', observation_id: 7, sync_id: 'obs-7', author: 'alice', last_writer: 'alice', first_written_at: T0 + 10, last_written_at: T0 + 10 }
  ]);
  assert.equal(auditMeta(db)[0].attribution.recorded, 1);
});

test('mem_session_summary is attributed like mem_save', async t => {
  const { db, call } = attributedPipeline(t);
  await call('mem_session_summary', { content: '## Goal' }, saved(3, 'obs-3'), BOB);
  assert.deepEqual(authorRows(db).map(row => [row.observation_id, row.author, row.last_writer]), [[3, 'bob', 'bob']]);
});

test('a topic_key revision by another user keeps the original author and records the last writer', async t => {
  const { db, call } = attributedPipeline(t);
  await call('mem_save', { title: 'T', content: 'v1', topic_key: 'x/b' }, saved(2, 'obs-2'), ALICE);
  await call('mem_save', { title: 'T', content: 'v2', topic_key: 'x/b' }, saved(2, 'obs-2'), BOB);
  const [row] = authorRows(db);
  assert.deepEqual([row.author, row.last_writer, row.first_written_at], ['alice', 'bob', T0 + 10]);
  assert.ok(row.last_written_at > row.first_written_at);
});

test('mem_update records the last writer; an observation written before attribution keeps an unknown author', async t => {
  const { db, call } = attributedPipeline(t);
  await call('mem_save', { title: 'T', content: 'c' }, saved(1, 'obs-1'), ALICE);
  await call('mem_update', { id: 1, content: 'c2' }, updated(1), BOB);
  await call('mem_update', { id: 9, content: 'old one' }, updated(9), BOB);
  assert.deepEqual(authorRows(db).map(row => [row.observation_id, row.author, row.last_writer, row.first_written_at === null]), [
    [1, 'alice', 'bob', false],
    [9, null, 'bob', true]
  ]);
});

test('a write whose result has no id succeeds, records nothing and is counted in the audit row', async t => {
  const { db, call } = attributedPipeline(t);
  const result = passive();
  const out = await call('mem_capture_passive', { content: '## Key Learnings:\n1. x' }, result, ALICE);
  assert.equal(out, result);
  assert.deepEqual(authorRows(db), []);
  assert.deepEqual(auditMeta(db)[0].attribution, { skipped_no_id: 1 });
});

test('tool errors, calls without a signed-in caller and calls without a brain record nothing', async t => {
  const { db, call } = attributedPipeline(t);
  await call('mem_save', { title: 'T', content: 'c' }, toolError('expected_project must be a valid non-empty project name'), ALICE);
  await call('mem_save', { title: 'T', content: 'c' }, saved(4, 'obs-4'), undefined);
  await call('mem_save', { title: 'T', content: 'c' }, saved(5, 'obs-5'), ALICE, null);
  assert.deepEqual(authorRows(db), []);
  assert.deepEqual(auditMeta(db).map(meta => meta.attribution), [undefined, { skipped_no_caller: 1 }, { skipped_no_brain: 1 }]);
});

test('a failing attribution store never fails the call; onError gets only the tool name', async t => {
  const errors = [];
  const { db, call } = attributedPipeline(t, { onError: (error, tool) => errors.push([error instanceof Error, tool]) });
  db.exec('DROP TABLE observation_authors');
  const result = saved(1, 'obs-1');
  assert.equal(await call('mem_save', { title: 'T', content: 'c' }, result, ALICE), result);
  assert.deepEqual(errors, [[true, 'mem_save']]);
  assert.deepEqual(auditMeta(db)[0].attribution, { failed: 1 });
});

test('mem_delete removes the attribution row; a failed delete keeps it', async t => {
  const { db, call } = attributedPipeline(t);
  await call('mem_save', { title: 'T', content: 'c' }, saved(1, 'obs-1'), ALICE);
  await call('mem_save', { title: 'T', content: 'c' }, saved(2, 'obs-2'), ALICE);
  await call('mem_delete', { id: 1, expected_project: 'p' }, { content: [{ type: 'text', text: 'Memory #1 soft-deleted' }] }, BOB);
  await call('mem_delete', { id: 2 }, toolError('expected_project must be a valid non-empty project name'), BOB);
  assert.deepEqual(authorRows(db).map(row => row.observation_id), [2]);
});

test('mem_search gets an authors item and _meta map for known authors only; Engram text is untouched', async t => {
  const { call } = attributedPipeline(t);
  await call('mem_save', { title: 'T', content: 'c' }, saved(1, 'obs-1'), ALICE);
  await call('mem_save', { title: 'T', content: 'c', topic_key: 'k' }, saved(2, 'obs-2'), ALICE);
  await call('mem_save', { title: 'T', content: 'c', topic_key: 'k' }, saved(2, 'obs-2'), BOB);
  await call('mem_update', { id: 4, content: 'c' }, updated(4), BOB);
  const result = searched([1, 2, 3, 4]);
  const out = await call('mem_search', { query: 'T' }, result, BOB);
  assert.equal(out.content[0], result.content[0], 'engram text item is the same object');
  assert.deepEqual(texts(out).slice(1), [
    'Authors recorded by the gateway (observations not listed have no known author):\n' +
    '#1 saved by alice\n' +
    '#2 saved by alice, last updated by bob\n' +
    '#4 author unknown, last updated by bob'
  ]);
  assert.deepEqual(out._meta[AUTHORS_META_KEY], {
    1: { savedBy: 'alice', lastUpdatedBy: 'alice' },
    2: { savedBy: 'alice', lastUpdatedBy: 'bob' },
    4: { savedBy: null, lastUpdatedBy: 'bob' }
  });
});

test('mem_get_observation is annotated for the requested id; other brains and unknown ids get nothing', async t => {
  const { call } = attributedPipeline(t);
  await call('mem_save', { title: 'T', content: 'c' }, saved(1, 'obs-1'), ALICE);
  const observation = { content: [{ type: 'text', text: JSON.stringify({ result: '#1 [decision] T\nc' }) }] };
  const out = await call('mem_get_observation', { id: 1 }, observation, BOB);
  assert.match(texts(out)[1], /#1 saved by alice$/);
  for (const [args, brain] of [[{ id: 1 }, 'other'], [{ id: 5 }, 'team']]) {
    const plain = { content: [{ type: 'text', text: '#x' }] };
    const same = await call('mem_get_observation', args, plain, BOB, brain);
    assert.equal(same, plain);
  }
  const missing = toolError('Observation #1 not found');
  assert.equal(await call('mem_get_observation', { id: 1 }, missing, BOB), missing);
});

test('the authors item is wrapped as data with the rest of the result (#19)', async t => {
  const { call } = attributedPipeline(t, { wrap: createToolCallPipeline().wrap });
  await call('mem_save', { title: 'T', content: 'c' }, saved(1, 'obs-1'), ALICE);
  const out = await call('mem_search', { query: 'T' }, searched([1]), BOB);
  const [, authors] = texts(out);
  assert.match(authors, /^<memory-data nonce="([0-9a-f]{32})">\nAuthors recorded by the gateway[\s\S]*#1 saved by alice\n<\/memory-data nonce="\1">$/);
});

test('without an attribution stage the pipeline returns the forwarded result unchanged (previous behavior)', async () => {
  const result = saved(1, 'obs-1');
  const out = await runToolCall(createToolCallPipeline({ wrap: passResult }), { name: 'mem_save', arguments: {} }, async () => result, { caller: ALICE, brain: 'team' });
  assert.equal(out, result);
});
