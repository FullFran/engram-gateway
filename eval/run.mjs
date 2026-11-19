#!/usr/bin/env node
/**
 * Scores one engine configuration on one split.
 *
 *   node eval/run.mjs --label engram-default --split dev
 *   node eval/run.mjs --label engram-any --match-mode any --split dev
 *   node eval/run.mjs --label gateway --transport http --url https://host/mcp --split dev
 *
 * Writes `<data>/runs/<label>.<split>.json` (per-query ranked ids: private)
 * and prints aggregate metrics only. The holdout split runs once per label;
 * the ledger `<data>/holdout-ledger.json` refuses a second run unless
 * `--force-holdout` is given (and records that it was forced).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_DATA_DIR, ENGINE_OPTIONS, engineOptions, mapLimit, openEngine, readJson, writeJson } from './lib/cli.mjs';
import { claimHoldout } from './lib/holdout.mjs';
import { aggregate } from './lib/metrics.mjs';

const { values } = parseArgs({
  options: {
    ...ENGINE_OPTIONS,
    data: { type: 'string', default: DEFAULT_DATA_DIR },
    label: { type: 'string' },
    split: { type: 'string', default: 'dev' },
    concurrency: { type: 'string', default: '4' },
    'force-holdout': { type: 'boolean', default: false },
  },
});

if (!values.label) throw new Error('--label is required (names the engine configuration)');
if (!['dev', 'holdout', 'all'].includes(values.split)) throw new Error('--split must be dev, holdout or all');

const dataset = readJson(join(values.data, 'dataset.json'));
const judgedPath = join(values.data, 'judgments.json');
const judged = existsSync(judgedPath) ? readJson(judgedPath).queries : {};

const ledgerPath = join(values.data, 'holdout-ledger.json');
if (values.split !== 'dev') {
  const ledger = existsSync(ledgerPath) ? readJson(ledgerPath) : { runs: [] };
  writeJson(ledgerPath, claimHoldout(ledger, values.label, { split: values.split, at: new Date().toISOString(), force: values['force-holdout'] }));
}

const queries = dataset.queries.filter(q => values.split === 'all' || q.split === values.split);
const engine = await openEngine(engineOptions(values));
let errors = 0;
const ranked = await mapLimit(queries, Number(values.concurrency), async q => {
  const result = await engine.search(q.query, q.scope);
  if (result.error) errors++;
  return result.ids;
});
await engine.close();

const rows = queries.map((q, i) => ({ id: q.id, ranked: ranked[i], implicit: q.implicit, judged: judged[q.id]?.relevant }));
const judgedRows = rows.filter(r => judged[r.id] !== undefined);
const summary = {
  label: values.label,
  split: values.split,
  tool: values.tool,
  searchArgs: engineOptions(values).searchArgs,
  at: new Date().toISOString(),
  engineErrors: errors,
  all: aggregate(rows.map(r => ({ ranked: r.ranked }))),
  implicit: aggregate(rows.map(r => ({ ranked: r.ranked, relevant: r.implicit }))),
  judged: aggregate(judgedRows.map(r => ({ ranked: r.ranked, relevant: r.judged }))),
};
writeJson(join(values.data, 'runs', `${values.label}.${values.split}.json`), { summary, rows });
console.log(JSON.stringify(summary, null, 2));
