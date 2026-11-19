#!/usr/bin/env node

// Runs the unit suite with TMPDIR set to a fresh, empty directory and fails
// when the suite leaves anything in it (#48): every test removes its scratch.
// This is what `npm run test:unit` runs, so the guard costs no extra run.
// Arguments are test files; the default is every test/unit/*.test.mjs.
// On success the directory is removed; on failure it is kept and its path printed.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const unitDir = join(repoRoot, 'test', 'unit');
const files = process.argv.length > 2
  ? process.argv.slice(2)
  : readdirSync(unitDir).filter(name => name.endsWith('.test.mjs')).sort().map(name => join(unitDir, name));

const scratch = mkdtempSync(join(tmpdir(), 'eg-unit-'));
const run = spawnSync(process.execPath, ['--test', ...files], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch }
});
if (run.error) throw run.error;

const left = readdirSync(scratch);
if (left.length > 0) {
  console.error(`Unit tests left ${left.length} entr${left.length === 1 ? 'y' : 'ies'} in TMPDIR (kept: ${scratch}):`);
  for (const name of left.sort().slice(0, 20)) console.error(`  ${name}`);
  if (left.length > 20) console.error(`  ... and ${left.length - 20} more`);
  process.exitCode = 1;
} else if (run.status !== 0) {
  console.error(`Unit tests failed (scratch kept: ${scratch})`);
} else {
  rmSync(scratch, { recursive: true, force: true });
  console.log('Unit tests left TMPDIR empty');
}
if (run.status !== 0) process.exitCode = run.status ?? 1;
