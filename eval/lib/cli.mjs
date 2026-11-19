/** Shared CLI plumbing for the eval scripts. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createMcpEngine } from './engine.mjs';

/** Private data lives outside any repository by default. */
export const DEFAULT_DATA_DIR = process.env.EVAL_DATA_DIR || join(homedir(), '.local', 'share', 'engram-gateway-eval');

/** Engine options shared by run and pool (see eval/README in docs/eval.md). */
export const ENGINE_OPTIONS = {
  transport: { type: 'string', default: 'stdio' },
  command: { type: 'string', default: 'engram' },
  'command-args': { type: 'string', default: 'mcp' },
  'engram-data-dir': { type: 'string' },
  url: { type: 'string' },
  'token-env': { type: 'string', default: 'EVAL_MCP_TOKEN' },
  tool: { type: 'string', default: 'mem_search' },
  'match-mode': { type: 'string' },
  'search-args': { type: 'string' },
  limit: { type: 'string', default: '10' },
};

export function engineOptions(values, overrides = {}) {
  const searchArgs = values['search-args'] ? JSON.parse(values['search-args']) : {};
  const matchMode = overrides.matchMode ?? values['match-mode'];
  if (matchMode) searchArgs.match_mode = matchMode;
  const env = {};
  if (values['engram-data-dir']) env.ENGRAM_DATA_DIR = values['engram-data-dir'];
  return {
    transport: values.transport === 'http' ? 'http' : 'stdio',
    command: values.command,
    args: values['command-args'].split(' ').filter(Boolean),
    env,
    // Neutral cwd so engram's cwd project detection never applies.
    cwd: '/',
    url: values.url,
    token: process.env[values['token-env']] || undefined,
    tool: values.tool,
    searchArgs,
    limit: Number(values.limit),
  };
}

export const openEngine = opts => createMcpEngine(opts);

export const readJson = path => JSON.parse(readFileSync(path, 'utf8'));

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export function writeText(path, text) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, text, { mode: 0o600 });
}

/** Runs `fn` over items with at most `n` in flight; keeps input order. */
export async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}
