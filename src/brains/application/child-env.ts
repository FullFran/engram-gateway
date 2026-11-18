import type { Brain } from '../domain/brain.js';

/** Gateway variables a brain's child may see, besides its own `ENGRAM_DATA_DIR`. */
const PASSED_THROUGH = ['HOME', 'PATH', 'ENGRAM_PROJECT'] as const;
const CLOUD_PREFIX = 'ENGRAM_CLOUD_';

/**
 * The environment of a brain's `engram mcp` child: an allowlist, never the
 * gateway's whole environment (which holds OAuth secrets and, for some
 * brains only, Engram Cloud credentials). `ENGRAM_CLOUD_*` pass through only
 * when the brain opted in to cloud sync.
 */
export function buildChildEnv(brain: Brain, parent: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env: Record<string, string> = { ENGRAM_DATA_DIR: brain.dataDir };
  for (const name of PASSED_THROUGH) {
    const value = parent[name];
    if (value !== undefined && value !== '') env[name] = value;
  }
  if (brain.cloudSync) {
    for (const [name, value] of Object.entries(parent)) {
      if (name.startsWith(CLOUD_PREFIX) && value !== undefined && value !== '') env[name] = value;
    }
  }
  return env;
}
