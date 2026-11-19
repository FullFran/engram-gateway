#!/usr/bin/env node
/**
 * Writes `<data>/review-sample.md` (private): a seeded sample of judged
 * queries with each candidate's first line and verdict, for a human to
 * spot-check the judge.
 *
 *   node eval/review-sample.mjs [--n 30] [engine options, e.g. --engram-data-dir <dir>]
 */
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_DATA_DIR, ENGINE_OPTIONS, engineOptions, mapLimit, openEngine, readJson, writeText } from './lib/cli.mjs';
import { seededSample } from './lib/dataset.mjs';

const { values } = parseArgs({
  options: {
    ...ENGINE_OPTIONS,
    data: { type: 'string', default: DEFAULT_DATA_DIR },
    n: { type: 'string', default: '30' },
  },
});

const pool = readJson(join(values.data, 'pool.json'));
const judged = readJson(join(values.data, 'judgments.json')).queries;
const sample = seededSample(pool.queries, Number(values.n), { seed: `${pool.seed}\u0000review` });

const ids = [...new Set(sample.flatMap(q => q.candidates))];
const engine = await openEngine(engineOptions(values));
const texts = await mapLimit(ids, 4, id => engine.getObservation(id));
await engine.close();
const titleById = new Map(ids.map((id, i) => [id, (texts[i] ?? '').trim().split('\n')[0].slice(0, 160)]));

const lines = ['# Judge review sample', '', `Rubric: eval/RUBRIC.md. ${sample.length} judged queries, seeded. Private: do not publish.`, ''];
for (const q of sample) {
  const relevant = new Set(judged[q.id].relevant);
  lines.push(`## ${q.id} (${q.split})`, '', `Query: ${q.query}`, `Scope: ${JSON.stringify(q.scope)}`, '');
  if (q.candidates.length === 0) lines.push('(no candidates)');
  for (const id of [...q.candidates].sort((a, b) => Number(relevant.has(b)) - Number(relevant.has(a)))) {
    lines.push(`- ${relevant.has(id) ? 'RELEVANT' : 'not     '} #${id} ${titleById.get(id)}`);
  }
  lines.push('');
}
writeText(join(values.data, 'review-sample.md'), lines.join('\n'));
console.log(JSON.stringify({ queries: sample.length, out: join(values.data, 'review-sample.md') }));
