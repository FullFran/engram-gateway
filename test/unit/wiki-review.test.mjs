// Wiki (#16), part 2: review bound to a fingerprint, decisions applied all-or-nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { GATEWAY_TOOL_ROLES } from '../../dist/authz/index.js';
import { WIKI_DB_FILE, WikiError } from '../../dist/wiki/index.js';
import { OWNER, READER, WRITER, WRITER2, brainDir, link, page, unwrapJson, wikiGateway, wikiService } from './wiki-harness.mjs';

const wikiError = (code, message) => error => error instanceof WikiError && error.code === code && (!message || message.test(error.message));

/** The brain's wiki.db, read-only, as plain rows. */
function rows(t, dir, sql) {
  const db = new DatabaseSync(join(dir, WIKI_DB_FILE), { readOnly: true });
  try {
    return db.prepare(sql).all().map(row => ({ ...row }));
  } finally {
    db.close();
  }
}

const livePages = (t, dir) => rows(t, dir, 'SELECT p.slug, r.rev_no, r.title FROM pages p JOIN page_revisions r ON r.id = p.current_revision_id ORDER BY p.slug');
const liveLinks = (t, dir) => rows(t, dir, 'SELECT f.slug AS "from", t.slug AS "to", l.type FROM links l JOIN pages f ON f.id = l.from_page JOIN pages t ON t.id = l.to_page WHERE l.removed_by_decision IS NULL ORDER BY l.id');

function setup(t) {
  const dir = brainDir(t, [{}, {}]);
  return { dir, wiki: wikiService({ team: dir }) };
}

// --- review and fingerprint ---

test('review shows the pending items, warnings and a fingerprint for the selection; the fingerprint depends on the selection', async t => {
  const { wiki } = setup(t);
  wiki.propose(WRITER, 'team', { summary: 'three pages', items: [page('a'), page('b'), link('a', 'b')] });
  const all = wiki.review(WRITER, 'team', { proposalId: 1 });
  assert.deepEqual({ id: all.proposalId, revision: all.revision, status: all.status, proposer: all.proposer, summary: all.summary }, { id: 1, revision: 1, status: 'open', proposer: 'wendy', summary: 'three pages' });
  assert.deepEqual(all.items.map(i => [i.id, i.item.op, i.current]), [[1, 'upsert_page', [{ slug: 'a', revision: null }]], [2, 'upsert_page', [{ slug: 'b', revision: null }]], [3, 'link', [{ slug: 'a', revision: null }, { slug: 'b', revision: null }]]]);
  assert.deepEqual(all.selected, [1, 2, 3]);
  assert.match(all.fingerprint, /^[0-9a-f]{64}$/);
  const part = wiki.review(WRITER, 'team', { proposalId: 1, itemIds: [3, 1] });
  assert.deepEqual(part.selected, [1, 3]);
  assert.notEqual(part.fingerprint, all.fingerprint);
  assert.equal(wiki.review(WRITER, 'team', { proposalId: 1, itemIds: [1, 3] }).fingerprint, part.fingerprint, 'same selection, same state: same fingerprint');
  assert.throws(() => wiki.review(WRITER, 'team', { proposalId: 1, itemIds: [9] }), wikiError('invalid', /item 9 is not a pending item of proposal 1/));
  assert.throws(() => wiki.review(WRITER, 'team', { proposalId: 7 }), wikiError('not_found'));
});

test('proposals lists proposals with their pending item counts, newest first, filtered by status', async t => {
  const { wiki } = setup(t);
  wiki.propose(WRITER, 'team', { summary: 'one', items: [page('a')] });
  wiki.propose(WRITER2, 'team', { summary: 'two', items: [page('b'), page('c')] });
  const listed = wiki.proposals(WRITER, 'team', {});
  assert.deepEqual(listed.proposals.map(p => [p.id, p.status, p.proposer, p.summary, p.pendingItems]), [[2, 'open', 'walt', 'two', 2], [1, 'open', 'wendy', 'one', 1]]);
  wiki.decide(OWNER, 'team', { proposalId: 1, action: 'reject', comment: 'not needed' });
  assert.deepEqual(wiki.proposals(WRITER, 'team', { status: 'open' }).proposals.map(p => p.id), [2]);
  assert.deepEqual(wiki.proposals(WRITER, 'team', { status: 'rejected' }).proposals.map(p => p.id), [1]);
});

// --- AC1: approving a stale fingerprint is rejected ---

test('AC1: approving with the fingerprint of an older revision of the proposal is rejected and changes nothing', async t => {
  const { dir, wiki } = setup(t);
  wiki.propose(WRITER, 'team', { summary: 'v1', items: [page('a', { title: 'Read by the owner' })] });
  const seen = wiki.review(OWNER, 'team', { proposalId: 1 });
  wiki.propose(WRITER, 'team', { proposalId: 1, summary: 'v2', items: [page('a', { title: 'Swapped after review' })] });
  assert.throws(
    () => wiki.decide(OWNER, 'team', { proposalId: 1, action: 'approve', fingerprint: seen.fingerprint }),
    wikiError('stale', /changed since it was reviewed/),
  );
  assert.deepEqual(livePages(t, dir), []);
  assert.deepEqual(rows(t, dir, 'SELECT COUNT(*) AS n FROM decisions'), [{ n: 0 }]);
  assert.deepEqual(rows(t, dir, "SELECT state FROM proposal_items WHERE proposal_id = 1 AND state = 'pending'").length, 1);
});

test('AC1: a page changed by another decision after the review makes the fingerprint stale', async t => {
  const { dir, wiki } = setup(t);
  wiki.propose(WRITER, 'team', { summary: 'first', items: [page('a', { title: 'First' })] });
  wiki.propose(WRITER2, 'team', { summary: 'second', items: [page('a', { title: 'Second' })] });
  const second = wiki.review(OWNER, 'team', { proposalId: 2 });
  const first = wiki.review(OWNER, 'team', { proposalId: 1 });
  wiki.decide(OWNER, 'team', { proposalId: 1, action: 'approve', fingerprint: first.fingerprint });
  assert.throws(() => wiki.decide(OWNER, 'team', { proposalId: 2, action: 'approve', fingerprint: second.fingerprint }), wikiError('stale'));
  assert.deepEqual(livePages(t, dir), [{ slug: 'a', rev_no: 1, title: 'First' }]);
});

test('AC1: approving needs a fingerprint, and the one for another selection does not fit', async t => {
  const { dir, wiki } = setup(t);
  wiki.propose(WRITER, 'team', { summary: 's', items: [page('a'), page('b')] });
  const onlyA = wiki.review(OWNER, 'team', { proposalId: 1, itemIds: [1] });
  assert.throws(() => wiki.decide(OWNER, 'team', { proposalId: 1, action: 'approve' }), wikiError('invalid', /fingerprint/));
  assert.throws(() => wiki.decide(OWNER, 'team', { proposalId: 1, action: 'approve', itemIds: [1, 2], fingerprint: onlyA.fingerprint }), wikiError('stale'));
  assert.deepEqual(livePages(t, dir), []);
});

// --- AC2: partial approval applies only the selected items, atomically ---

test('AC2: approving part applies only the selected items; the rest stay pending and can be decided later', async t => {
  const { dir, wiki } = setup(t);
  wiki.propose(WRITER, 'team', { summary: 's', items: [page('a'), page('b'), page('c'), link('a', 'b', 'part_of')] });
  const review = wiki.review(OWNER, 'team', { proposalId: 1, itemIds: [1, 2, 4] });
  const decision = wiki.decide(OWNER, 'team', { proposalId: 1, action: 'approve', itemIds: [1, 2, 4], fingerprint: review.fingerprint, comment: 'c later' });
  assert.deepEqual({ applied: decision.applied, pending: decision.pending, status: decision.status }, { applied: [1, 2, 4], pending: [3], status: 'open' });
  assert.deepEqual(livePages(t, dir), [{ slug: 'a', rev_no: 1, title: 'Title of a' }, { slug: 'b', rev_no: 1, title: 'Title of b' }]);
  assert.deepEqual(liveLinks(t, dir), [{ from: 'a', to: 'b', type: 'part_of' }]);
  assert.deepEqual(rows(t, dir, 'SELECT id, state, decision_id FROM proposal_items ORDER BY id'), [
    { id: 1, state: 'applied', decision_id: 1 }, { id: 2, state: 'applied', decision_id: 1 }, { id: 3, state: 'pending', decision_id: null }, { id: 4, state: 'applied', decision_id: 1 },
  ]);
  assert.deepEqual(rows(t, dir, 'SELECT action, item_ids, fingerprint, decided_by, comment FROM decisions'), [
    { action: 'approve', item_ids: '[1,2,4]', fingerprint: review.fingerprint, decided_by: 'olive', comment: 'c later' },
  ]);
  const rest = wiki.review(OWNER, 'team', { proposalId: 1 });
  assert.deepEqual(rest.selected, [3]);
  const last = wiki.decide(OWNER, 'team', { proposalId: 1, action: 'approve', fingerprint: rest.fingerprint });
  assert.deepEqual({ applied: last.applied, pending: last.pending, status: last.status }, { applied: [3], pending: [], status: 'closed' });
});

test('AC2: if any selected item cannot be applied, nothing of the selection is applied', async t => {
  const { dir, wiki } = setup(t);
  // The link's target page is in the proposal but not in the selection: applying would leave a dangling link.
  wiki.propose(WRITER, 'team', { summary: 's', items: [page('a'), page('b'), link('a', 'b')] });
  const review = wiki.review(OWNER, 'team', { proposalId: 1, itemIds: [1, 3] });
  assert.throws(
    () => wiki.decide(OWNER, 'team', { proposalId: 1, action: 'approve', itemIds: [1, 3], fingerprint: review.fingerprint }),
    wikiError('conflict', /item 3: page b does not exist/),
  );
  assert.deepEqual(livePages(t, dir), []);
  assert.deepEqual(liveLinks(t, dir), []);
  assert.deepEqual(rows(t, dir, 'SELECT COUNT(*) AS n FROM decisions'), [{ n: 0 }]);
  assert.deepEqual(rows(t, dir, 'SELECT state FROM proposal_items ORDER BY id').map(r => r.state), ['pending', 'pending', 'pending']);
});

test('approving a revision of an existing page appends a revision; unlink removes a live link without deleting it', async t => {
  const { dir, wiki } = setup(t);
  wiki.propose(WRITER, 'team', { summary: 's', items: [page('a'), page('b'), link('a', 'b')] });
  wiki.decide(OWNER, 'team', { proposalId: 1, action: 'approve', fingerprint: wiki.review(OWNER, 'team', { proposalId: 1 }).fingerprint });
  wiki.propose(WRITER, 'team', { summary: 's2', items: [page('a', { title: 'A v2', baseRevision: 1 }), { op: 'unlink', from: 'a', to: 'b', type: 'depends_on', citations: ['obs-2'] }] });
  const review = wiki.review(OWNER, 'team', { proposalId: 2 });
  assert.deepEqual(review.warnings, [], 'based on the current revision, unlinking a live link: nothing to warn about');
  wiki.decide(OWNER, 'team', { proposalId: 2, action: 'approve', fingerprint: review.fingerprint });
  assert.deepEqual(livePages(t, dir), [{ slug: 'a', rev_no: 2, title: 'A v2' }, { slug: 'b', rev_no: 1, title: 'Title of b' }]);
  assert.deepEqual(liveLinks(t, dir), []);
  assert.deepEqual(rows(t, dir, 'SELECT removed_by_decision FROM links'), [{ removed_by_decision: 2 }]);
  assert.deepEqual(rows(t, dir, "SELECT rev_no, title, created_by FROM page_revisions WHERE page_id = 1 ORDER BY rev_no"), [{ rev_no: 1, title: 'Title of a', created_by: 'wendy' }, { rev_no: 2, title: 'A v2', created_by: 'wendy' }]);
});

test('return sends the proposal back with a comment; its proposer revises it and it can then be approved', async t => {
  const { dir, wiki } = setup(t);
  wiki.propose(WRITER, 'team', { summary: 's', items: [page('a')] });
  const returned = wiki.decide(OWNER, 'team', { proposalId: 1, action: 'return', comment: 'cite the decision, not the checkpoint' });
  assert.equal(returned.status, 'returned');
  const review = wiki.review(WRITER, 'team', { proposalId: 1 });
  assert.deepEqual(review.decisions.map(d => [d.action, d.decidedBy, d.comment]), [['return', 'olive', 'cite the decision, not the checkpoint']]);
  assert.throws(() => wiki.decide(OWNER, 'team', { proposalId: 1, action: 'approve', fingerprint: review.fingerprint }), wikiError('conflict', /returned/));
  wiki.propose(WRITER, 'team', { proposalId: 1, summary: 's', items: [page('a', { citations: ['obs-2'] })] });
  const again = wiki.review(OWNER, 'team', { proposalId: 1 });
  assert.equal(wiki.decide(OWNER, 'team', { proposalId: 1, action: 'approve', fingerprint: again.fingerprint }).status, 'closed');
  assert.deepEqual(livePages(t, dir).map(p => p.slug), ['a']);
});

test('reject closes the whole proposal: every pending item is rejected and it can no longer be revised or approved', async t => {
  const { dir, wiki } = setup(t);
  wiki.propose(WRITER, 'team', { summary: 's', items: [page('a'), page('b')] });
  const review = wiki.review(OWNER, 'team', { proposalId: 1 });
  assert.equal(wiki.decide(OWNER, 'team', { proposalId: 1, action: 'reject' }).status, 'rejected');
  assert.deepEqual(rows(t, dir, 'SELECT state FROM proposal_items').map(r => r.state), ['rejected', 'rejected']);
  assert.throws(() => wiki.decide(OWNER, 'team', { proposalId: 1, action: 'approve', fingerprint: review.fingerprint }), wikiError('conflict'));
  assert.throws(() => wiki.propose(WRITER, 'team', { proposalId: 1, summary: 's', items: [page('a')] }), wikiError('conflict'));
  assert.throws(() => wiki.decide(OWNER, 'team', { proposalId: 1, action: 'reject', itemIds: [1] }), wikiError('invalid', /itemIds/));
});

// --- AC3 (decide side): only owners decide ---

test('AC3: only owners decide; writers and readers are refused by the service itself, and nothing changes', async t => {
  const { dir, wiki } = setup(t);
  wiki.propose(WRITER, 'team', { summary: 's', items: [page('a')] });
  const fingerprint = wiki.review(WRITER, 'team', { proposalId: 1 }).fingerprint;
  assert.equal(GATEWAY_TOOL_ROLES.brain_decide, 'owner');
  assert.equal(GATEWAY_TOOL_ROLES.brain_review, 'writer');
  assert.equal(GATEWAY_TOOL_ROLES.brain_proposals, 'writer');
  for (const actor of [WRITER, READER]) {
    assert.throws(() => wiki.decide(actor, 'team', { proposalId: 1, action: 'approve', fingerprint }), wikiError('forbidden', /brain_decide needs the owner role/));
  }
  assert.throws(() => wiki.review(READER, 'team', { proposalId: 1 }), wikiError('forbidden'));
  assert.deepEqual(livePages(t, dir), []);
});

test('over MCP: an owner reviews and approves part of a proposal; a writer is refused (audited); results are wrapped', async t => {
  const gw = await wikiGateway(t, [{}]);
  const writer = await gw.as('wendy');
  unwrapJson(await writer.callTool({ name: 'brain_propose', arguments: { summary: 's', items: [page('a'), page('b')] } }));
  const writerTools = (await writer.listTools()).tools.map(tool => tool.name);
  assert.ok(writerTools.includes('brain_review') && writerTools.includes('brain_proposals') && !writerTools.includes('brain_decide'), writerTools.join(','));
  await assert.rejects(writer.callTool({ name: 'brain_decide', arguments: { proposalId: 1, action: 'reject' } }), error => error.code === -32602);
  const owner = await gw.as('olive');
  const review = unwrapJson(await owner.callTool({ name: 'brain_review', arguments: { proposalId: 1, itemIds: [2] } }));
  const decision = unwrapJson(await owner.callTool({ name: 'brain_decide', arguments: { proposalId: 1, action: 'approve', itemIds: [2], fingerprint: review.fingerprint } }));
  assert.deepEqual({ applied: decision.applied, pending: decision.pending }, { applied: [2], pending: [1] });
  const stale = await owner.callTool({ name: 'brain_decide', arguments: { proposalId: 1, action: 'approve', fingerprint: review.fingerprint } });
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /changed since it was reviewed/);
  assert.deepEqual(gw.audit(), [
    ['wendy', 'brain_propose', 'ok'], ['wendy', 'brain_decide', 'denied'],
    ['olive', 'brain_review', 'ok'], ['olive', 'brain_decide', 'ok'], ['olive', 'brain_decide', 'error'],
  ]);
});

test('a brain being restored refuses review and decisions; the wiki is unchanged once the restore lets go', async t => {
  const dir = brainDir(t, [{}]);
  const held = new Set();
  const wiki = wikiService({ team: dir }, { held });
  wiki.propose(WRITER, 'team', { summary: 's', items: [page('a')] });
  const { fingerprint } = wiki.review(OWNER, 'team', { proposalId: 1 });
  held.add('team');
  assert.throws(() => wiki.review(OWNER, 'team', { proposalId: 1 }), wikiError('unavailable', /being restored/));
  assert.throws(() => wiki.decide(OWNER, 'team', { proposalId: 1, action: 'approve', fingerprint }), wikiError('unavailable', /being restored/));
  held.delete('team');
  assert.deepEqual(livePages(t, dir), []);
  assert.equal(wiki.decide(OWNER, 'team', { proposalId: 1, action: 'approve', fingerprint }).status, 'closed');
});
