import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { DEFAULT_BRAIN, parseBrainSlug } from '../domain/brain.js';
import type { BrainsConfig } from '../application/bootstrap.js';

const DEFAULT_IDLE_TIMEOUT_SECONDS = 600;
const DEFAULT_MAX_LIVE_BRAINS = 10;

function slugList(name: string, raw: string | undefined): string[] {
  const slugs: string[] = [];
  for (const item of (raw ?? '').split(',')) {
    const slug = item.trim();
    if (!slug) continue;
    const check = parseBrainSlug(slug);
    if (!check.ok) throw new Error(`${name}: invalid brain slug ${JSON.stringify(slug)} (${check.reason})`);
    if (!slugs.includes(slug)) slugs.push(slug);
  }
  return slugs;
}

function positiveInteger(name: string, raw: string | undefined, fallback: number): number {
  const value = raw?.trim();
  if (!value) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1) throw new Error(`${name} must be a positive integer, got ${JSON.stringify(value)}`);
  return Number(value);
}

/**
 * Brain settings from the environment:
 * - `BRAINS_ROOT`: absolute directory of the brains' data directories (`<root>/<slug>`).
 * - `BRAINS`: comma-separated slugs created at startup when missing (needs `BRAINS_ROOT`).
 * - `ENGRAM_CLOUD_BRAINS`: slugs whose child gets `ENGRAM_CLOUD_*` (default: none).
 * - `BRAIN_IDLE_TIMEOUT`: seconds without requests before a brain's child stops (default 600).
 * - `MAX_LIVE_BRAINS`: most children at once (default 10).
 * The default brain's data directory is `ENGRAM_DATA_DIR` when set (the
 * single-brain layout), else `<BRAINS_ROOT>/default`, else Engram's own default (`~/.engram`).
 */
export function resolveBrainsConfig(env: Readonly<Record<string, string | undefined>>): BrainsConfig {
  const rootRaw = env.BRAINS_ROOT?.trim();
  if (rootRaw && !isAbsolute(rootRaw)) throw new Error(`BRAINS_ROOT must be an absolute path, got ${JSON.stringify(rootRaw)}`);
  const brainsRoot = rootRaw ? resolve(rootRaw) : undefined;
  const seed = slugList('BRAINS', env.BRAINS).filter(slug => slug !== DEFAULT_BRAIN);
  if (seed.length > 0 && !brainsRoot) throw new Error('BRAINS needs BRAINS_ROOT (the directory holding each brain\'s data directory)');
  const legacy = env.ENGRAM_DATA_DIR?.trim();
  const home = env.HOME?.trim() || homedir();
  const defaultDataDir = legacy ? resolve(legacy) : brainsRoot ? join(brainsRoot, DEFAULT_BRAIN) : join(home, '.engram');
  return {
    brainsRoot,
    defaultDataDir,
    seed,
    cloud: slugList('ENGRAM_CLOUD_BRAINS', env.ENGRAM_CLOUD_BRAINS),
    idleTimeoutMs: positiveInteger('BRAIN_IDLE_TIMEOUT', env.BRAIN_IDLE_TIMEOUT, DEFAULT_IDLE_TIMEOUT_SECONDS) * 1000,
    maxLiveBrains: positiveInteger('MAX_LIVE_BRAINS', env.MAX_LIVE_BRAINS, DEFAULT_MAX_LIVE_BRAINS)
  };
}
