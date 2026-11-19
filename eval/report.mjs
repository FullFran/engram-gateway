#!/usr/bin/env node
/**
 * Prints the aggregate results table (markdown) for the run files.
 *
 *   node eval/report.mjs [--data <dir>] [--split dev|holdout|all]
 *
 * Only run summaries are read, so the table carries no query text or ids
 * and can be pasted into a pull request or issue.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_DATA_DIR, readJson } from './lib/cli.mjs';
import { renderReport } from './lib/report.mjs';

const { values } = parseArgs({
  options: {
    data: { type: 'string', default: DEFAULT_DATA_DIR },
    split: { type: 'string' },
  },
});

const dir = join(values.data, 'runs');
const runs = readdirSync(dir)
  .filter(n => n.endsWith('.json'))
  .map(n => ({ summary: readJson(join(dir, n)).summary }))
  .filter(r => !values.split || r.summary.split === values.split);
process.stdout.write(renderReport(runs));
