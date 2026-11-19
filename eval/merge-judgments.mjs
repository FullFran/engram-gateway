#!/usr/bin/env node
/**
 * Merges the judge's verdict files into `<data>/judgments.json`.
 *
 *   node eval/merge-judgments.mjs [--data <dir>] [--verdicts <dir>]
 *
 * Reads `<data>/pool.json` and every `*.txt` in `<data>/verdicts/` (format in
 * eval/lib/judgments.mjs). Fails when a pooled query has no verdict or a
 * verdict names an id outside its candidates. Prints counts only.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_DATA_DIR, readJson, writeJson } from './lib/cli.mjs';
import { mergeJudgments, parseVerdicts } from './lib/judgments.mjs';

const { values } = parseArgs({
  options: {
    data: { type: 'string', default: DEFAULT_DATA_DIR },
    verdicts: { type: 'string' },
  },
});

const dir = values.verdicts ?? join(values.data, 'verdicts');
const verdicts = new Map();
for (const name of readdirSync(dir).filter(n => n.endsWith('.txt')).sort()) {
  for (const [id, ids] of parseVerdicts(readFileSync(join(dir, name), 'utf8'))) {
    if (verdicts.has(id)) throw new Error(`${name}: ${id} already judged in another file`);
    verdicts.set(id, ids);
  }
}

const judgments = mergeJudgments(readJson(join(values.data, 'pool.json')), verdicts, { rubric: 'eval/RUBRIC.md' });
writeJson(join(values.data, 'judgments.json'), judgments);
const all = Object.values(judgments.queries);
console.log(JSON.stringify({
  queries: all.length,
  withRelevant: all.filter(q => q.relevant.length > 0).length,
  judgedPairs: all.reduce((n, q) => n + q.judged.length, 0),
  relevantPairs: all.reduce((n, q) => n + q.relevant.length, 0),
}, null, 2));
