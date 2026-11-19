#!/usr/bin/env node
/**
 * Builds the pooled judging set: for a seeded sample of queries, the union of
 * the top-k results of every pooled engine configuration, with each
 * candidate's text, split into batch files for the judge.
 *
 *   node eval/pool.mjs [--n 150] [--k 10] [--modes all,any] [--batch 10]
 *
 * Writes `<data>/pool.json` and `<data>/judge/batch-NN.md`. Candidates are
 * shuffled per query and carry no engine or rank, so the judge is blind to
 * which configuration returned them. Judgments go to `<data>/judgments.json`
 * (format in docs/eval.md); see eval/RUBRIC.md.
 */
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_DATA_DIR, ENGINE_OPTIONS, engineOptions, mapLimit, openEngine, readJson, writeJson, writeText } from './lib/cli.mjs';
import { seededSample, seededUnit } from './lib/dataset.mjs';

const { values } = parseArgs({
  options: {
    ...ENGINE_OPTIONS,
    data: { type: 'string', default: DEFAULT_DATA_DIR },
    n: { type: 'string', default: '150' },
    k: { type: 'string', default: '10' },
    modes: { type: 'string', default: 'all,any' },
    batch: { type: 'string', default: '10' },
    excerpt: { type: 'string', default: '240' },
  },
});

const dataset = readJson(join(values.data, 'dataset.json'));
const sample = seededSample(dataset.queries, Number(values.n), { seed: dataset.seed });
const k = Number(values.k);
const modes = values.modes.split(',').filter(Boolean);

const pooled = sample.map(q => ({ id: q.id, query: q.query, scope: q.scope, split: q.split, candidates: new Set() }));
for (const mode of modes) {
  const engine = await openEngine({ ...engineOptions(values, { matchMode: mode }), limit: k });
  const results = await mapLimit(pooled, 4, p => engine.search(p.query, p.scope));
  results.forEach((r, i) => r.ids.forEach(id => pooled[i].candidates.add(id)));
  await engine.close();
}

const ids = [...new Set(pooled.flatMap(p => [...p.candidates]))];
const engine = await openEngine(engineOptions(values));
const texts = await mapLimit(ids, 4, id => engine.getObservation(id));
await engine.close();
const textById = new Map(ids.map((id, i) => [id, texts[i] ?? '']));

const pool = pooled.map(p => ({
  ...p,
  candidates: [...p.candidates].sort((a, b) => seededUnit(`${dataset.seed}\u0000blind\u0000${p.id}`, a) - seededUnit(`${dataset.seed}\u0000blind\u0000${p.id}`, b)),
}));
writeJson(join(values.data, 'pool.json'), { seed: dataset.seed, k, modes, createdAt: new Date().toISOString(), queries: pool });

const excerpt = Number(values.excerpt);
const size = Number(values.batch);
for (let b = 0; b * size < pool.length; b++) {
  const lines = [];
  for (const p of pool.slice(b * size, (b + 1) * size)) {
    lines.push(`## ${p.id}`, `Query: ${p.query}`, `Scope: ${JSON.stringify(p.scope)}`, '');
    if (p.candidates.length === 0) lines.push('(no candidates)', '');
    for (const id of p.candidates) {
      const text = textById.get(id).replace(/\s+/g, ' ').slice(0, excerpt);
      lines.push(`- #${id}: ${text}`);
    }
    lines.push('');
  }
  writeText(join(values.data, 'judge', `batch-${String(b + 1).padStart(2, '0')}.md`), lines.join('\n'));
}
console.log(JSON.stringify({ queries: pool.length, candidates: pool.reduce((n, p) => n + p.candidates.length, 0), uniqueObservations: ids.length, batches: Math.ceil(pool.length / size) }, null, 2));
