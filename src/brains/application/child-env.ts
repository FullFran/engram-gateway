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

/**
 * A startup warning when the gateway holds Engram Cloud settings but no brain
 * receives them (the pre-brains layout synced the one memory). Names only,
 * never values.
 */
export function cloudSyncWarning(parent: Readonly<Record<string, string | undefined>>, config: { cloud: readonly string[] }): string | undefined {
  if (config.cloud.length > 0) return undefined;
  const names = Object.keys(parent).filter(name => name.startsWith(CLOUD_PREFIX) && parent[name] !== undefined && parent[name] !== '').sort();
  if (names.length === 0) return undefined;
  return `${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} set but ENGRAM_CLOUD_BRAINS is empty, so no brain syncs to Engram Cloud. Set ENGRAM_CLOUD_BRAINS=default to keep syncing the existing memory.`;
}
