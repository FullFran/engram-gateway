#!/usr/bin/env node
/**
 * Builds the private query dataset from Claude Code transcripts.
 *
 *   node eval/build-dataset.mjs [--transcripts ~/.claude/projects] [--out <data dir>]
 *                               [--window 6] [--seed engram-gateway-eval-v1]
 *
 * Writes `<out>/searches.jsonl` (every search episode) and
 * `<out>/dataset.json` (deduplicated queries, split, implicit labels).
 * Prints counts only: no query text reaches stdout.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_DATA_DIR, writeJson, writeText } from './lib/cli.mjs';
import { buildQueries, DEFAULT_HOLDOUT_FRACTION, DEFAULT_SEED } from './lib/dataset.mjs';
import { DEFAULT_WINDOW, labelSearches, transcriptSteps } from './lib/transcripts.mjs';

const { values } = parseArgs({
  options: {
    transcripts: { type: 'string', default: join(homedir(), '.claude', 'projects') },
    out: { type: 'string', default: DEFAULT_DATA_DIR },
    window: { type: 'string', default: String(DEFAULT_WINDOW) },
    seed: { type: 'string', default: DEFAULT_SEED },
    holdout: { type: 'string', default: String(DEFAULT_HOLDOUT_FRACTION) },
  },
});

function jsonlFiles(dir) {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    const stat = statSync(path);
    return stat.isDirectory() ? jsonlFiles(path) : name.endsWith('.jsonl') ? [path] : [];
  });
}

const window = Number(values.window);
const files = jsonlFiles(values.transcripts);
const records = [];
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  if (!text.includes('mem_search')) continue;
  for (const record of labelSearches(transcriptSteps(text.split('\n')), { window })) records.push({ ...record, file });
}

const queries = buildQueries(records, { seed: values.seed, holdoutFraction: Number(values.holdout) });
writeText(join(values.out, 'searches.jsonl'), records.map(r => JSON.stringify(r)).join('\n') + '\n');
writeJson(join(values.out, 'dataset.json'), {
  version: 1,
  seed: values.seed,
  window,
  holdoutFraction: Number(values.holdout),
  createdAt: new Date().toISOString(),
  queries,
});

const count = (list, pred) => list.filter(pred).length;
const statuses = {};
for (const r of records) statuses[r.status] = (statuses[r.status] ?? 0) + 1;
console.log(JSON.stringify({
  transcripts: files.length,
  searches: records.length,
  searchStatuses: statuses,
  originalZeroResult: count(records, r => r.zeroResult),
  queries: queries.length,
  duplicateShare: records.length ? Number((1 - queries.length / count(records, r => !r.error && r.query.trim())).toFixed(3)) : 0,
  withImplicitLabels: count(queries, q => q.implicit.length > 0),
  dev: count(queries, q => q.split === 'dev'),
  holdout: count(queries, q => q.split === 'holdout'),
  out: values.out,
}, null, 2));
