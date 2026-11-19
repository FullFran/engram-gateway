// Recall evaluation harness (eval/): synthetic fixtures only, no real queries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSearchResult, unwrapMemoryData } from '../../eval/lib/search-result.mjs';
import { labelSearches, transcriptSteps } from '../../eval/lib/transcripts.mjs';
import { buildQueries, normalizeQuery, queryId, seededSample } from '../../eval/lib/dataset.mjs';
import { aggregate, recallAt, reciprocalRank } from '../../eval/lib/metrics.mjs';
import { mergeJudgments, parseVerdicts } from '../../eval/lib/judgments.mjs';
import { claimHoldout } from '../../eval/lib/holdout.mjs';
import { renderReport } from '../../eval/lib/report.mjs';

const json = value => [{ type: 'text', text: JSON.stringify(value) }];

test('search results: JSON envelope, wrapped leaves, legacy text and errors', () => {
  assert.deepEqual(parseSearchResult(json({ project: 'p', results: [{ id: 3 }, { id: 1 }, { id: 3 }] })), { ids: [3, 1], project: 'p', error: false });

  const wrapped = `<memory-data nonce="abc">${JSON.stringify({ results: [{ id: 7 }] })}</memory-data nonce="abc">`;
  assert.deepEqual(parseSearchResult([{ type: 'text', text: wrapped }]).ids, [7]);
  assert.equal(unwrapMemoryData('<memory-data nonce="n1">hello</memory-data nonce="n1">'), 'hello');

  assert.deepEqual(parseSearchResult([{ type: 'text', text: 'Found 2:\n[1] #42 (decision)\n[2] #9 (bugfix)' }]).ids, [42, 9]);
  assert.equal(parseSearchResult([{ type: 'text', text: 'boom' }], { isError: true }).error, true);
});

// Builds a transcript: each entry is a tool call with its result, or assistant text.
function transcript(events) {
  const lines = [];
  events.forEach((e, i) => {
    if (e.text) {
      lines.push(JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: e.text }] } }));
      return;
    }
    const id = `tu_${i}`;
    lines.push(JSON.stringify({ sessionId: 's1', timestamp: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: e.name, input: e.input }] } }));
    lines.push(JSON.stringify({ message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: e.result ?? json({ results: [] }) }] } }));
  });
  return transcriptSteps(lines);
}
const search = (query, ids) => ({ name: 'mcp__engram__mem_search', input: { query }, result: json({ results: ids.map(id => ({ id })) }) });
const fetch = id => ({ name: 'mcp__plugin_engram_engram__mem_get_observation', input: { id } });
const other = { name: 'Bash', input: { command: 'ls' } };

test('implicit labels: a fetch labels the whole reformulation chain', () => {
  const records = labelSearches(transcript([search('first try', []), search('second try', [5, 6]), other, fetch(6)]));
  assert.deepEqual(records.map(r => [r.query, r.status, r.relevant, r.zeroResult]), [
    ['first try', 'reformulated', [6], true],
    ['second try', 'fetched', [6], false],
  ]);
});

test('implicit labels: citing a shown id counts, an unshown id does not', () => {
  const records = labelSearches(transcript([search('q', [5, 6]), { text: 'See #6 and #99.' }]));
  assert.deepEqual(records[0].relevant, [6]);
  assert.equal(records[0].status, 'fetched');
});

test('implicit labels: no fetch within the window leaves the search abandoned', () => {
  const late = [search('q', [5]), other, other, other, fetch(5)];
  assert.equal(labelSearches(transcript(late), { window: 2 })[0].status, 'abandoned');
  assert.deepEqual(labelSearches(transcript(late), { window: 2 })[0].relevant, []);
  assert.deepEqual(labelSearches(transcript(late), { window: 6 })[0].relevant, [5]);
});

test('dataset: dedupe by normalized text, deterministic split and opaque ids', () => {
  const rec = (query, relevant, timestamp) => ({ query, args: { query, project: 'p' }, relevant, timestamp, status: 'fetched', originalIds: [], zeroResult: false, error: false });
  const records = [rec('Foo  Bar', [1], '2026-01-02'), rec('foo bar', [2], '2026-01-01'), rec('other', [], '2026-01-03')];
  const a = buildQueries(records, { seed: 's', holdoutFraction: 0.5 });
  const b = buildQueries([...records].reverse(), { seed: 's', holdoutFraction: 0.5 });
  assert.equal(a.length, 2);
  const foo = a.find(q => normalizeQuery(q.query) === 'foo bar');
  assert.equal(foo.query, 'foo bar', 'first occurrence by time fixes the text');
  assert.deepEqual(foo.implicit, [1, 2]);
  assert.equal(foo.occurrences, 2);
  assert.match(foo.id, /^q_[0-9a-f]{12}$/);
  assert.equal(foo.id, queryId('s', 'foo bar'));
  assert.deepEqual(a.map(q => [q.id, q.split]).sort(), b.map(q => [q.id, q.split]).sort());
  assert.notEqual(queryId('s', 'foo bar'), queryId('t', 'foo bar'), 'the seed keys the ids');
  assert.deepEqual(seededSample(a, 1, { seed: 's' }), seededSample([...a].reverse(), 1, { seed: 's' }));
});

test('metrics: recall@k, MRR and zero-result rate per label source', () => {
  assert.equal(recallAt([1, 2, 3], [3, 9], 2), 0);
  assert.equal(recallAt([1, 2, 3], [3, 9], 3), 0.5);
  assert.equal(reciprocalRank([4, 3], [3]), 0.5);
  assert.equal(reciprocalRank([4], [3]), 0);
  assert.deepEqual(aggregate([
    { ranked: [1, 2], relevant: [2] },
    { ranked: [], relevant: [5] },
    { ranked: [], relevant: [] },
  ]), { queries: 3, labeled: 2, recallAt5: 0.5, recallAt10: 0.5, mrr: 0.25, zeroResultRate: 2 / 3 });
});

test('judgments: verdict lines merge into judged labels restricted to the pool', () => {
  const verdicts = parseVerdicts('q_a: 2 1\n# comment\n\nq_b: -\n');
  assert.deepEqual(verdicts, new Map([['q_a', [2, 1]], ['q_b', []]]));
  const pool = { queries: [{ id: 'q_a', candidates: [1, 2, 3] }, { id: 'q_b', candidates: [4] }] };
  assert.deepEqual(mergeJudgments(pool, verdicts, { rubric: 'eval/RUBRIC.md' }), {
    version: 1,
    rubric: 'eval/RUBRIC.md',
    queries: { q_a: { relevant: [1, 2], judged: [1, 2, 3] }, q_b: { relevant: [], judged: [4] } },
  });
  assert.throws(() => mergeJudgments(pool, new Map([['q_a', [9]], ['q_b', []]]), {}), /not a candidate/);
  assert.throws(() => mergeJudgments(pool, new Map([['q_a', [1]]]), {}), /missing verdict.*q_b/);
  assert.throws(() => parseVerdicts('q_a 1 2'), /line 1/);
});

test('holdout ledger: one run per label, forced reruns are recorded', () => {
  const at = '2026-01-01T00:00:00Z';
  const first = claimHoldout({ runs: [] }, 'engram-default', { split: 'holdout', at });
  assert.deepEqual(first.runs, [{ label: 'engram-default', split: 'holdout', at, forced: false }]);
  assert.throws(() => claimHoldout(first, 'engram-default', { split: 'holdout', at }), /already run.*--force-holdout/);
  const other = claimHoldout(first, 'engram-any', { split: 'holdout', at });
  assert.equal(other.runs.length, 2);
  const forced = claimHoldout(first, 'engram-default', { split: 'holdout', at, force: true });
  assert.equal(forced.runs.at(-1).forced, true);
  assert.equal(first.runs.length, 1, 'the input ledger is not mutated');
});

test('report: aggregate-only markdown table, no per-query data', () => {
  const metric = (labeled, r5) => ({ queries: 10, labeled, recallAt5: r5, recallAt10: 0.5, mrr: 0.25, zeroResultRate: 0.1 });
  const md = renderReport([
    { summary: { label: 'engram-any', split: 'dev', implicit: metric(4, 0.75), judged: metric(2, null) }, rows: [{ id: 'q_secret', ranked: [1] }] },
    { summary: { label: 'engram-default', split: 'dev', implicit: metric(4, 1 / 3), judged: metric(0, null) } },
  ]);
  const lines = md.trim().split('\n');
  assert.equal(lines[0], '| Engine | Split | Labels | Labeled queries | Recall@5 | Recall@10 | MRR | Zero-result rate |');
  assert.equal(lines[2], '| engram-any | dev | implicit | 4 | 0.750 | 0.500 | 0.250 | 0.100 |', 'rows sort by label source, split, engine');
  assert.equal(lines[3], '| engram-default | dev | implicit | 4 | 0.333 | 0.500 | 0.250 | 0.100 |');
  assert.ok(lines.includes('| engram-any | dev | judged | 2 | n/a | 0.500 | 0.250 | 0.100 |'));
  assert.equal(lines.length, 6, 'header, divider and one row per engine and label source');
  assert.doesNotMatch(md, /q_secret/);
});
