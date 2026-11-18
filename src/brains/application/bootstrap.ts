import { isAbsolute } from 'node:path';
import type { Logger } from '../../shared/logger.js';
import { DEFAULT_BRAIN, parseBrainSlug } from '../domain/brain.js';
import type { Brain } from '../domain/brain.js';
import { brainDataDir } from './data-dir.js';
import type { BrainRepository } from './ports.js';

/** Startup settings for brains (see `resolveBrainsConfig`). */
export interface BrainsConfig {
  /** Absolute directory holding `<slug>/` data directories; required when `seed` is not empty. */
  brainsRoot: string | undefined;
  /** Data directory of the default brain when it is created. */
  defaultDataDir: string;
  /** Slugs (besides `default`) to create when missing. */
  seed: string[];
  /** Slugs whose children get the gateway's `ENGRAM_CLOUD_*` variables. */
  cloud: string[];
  idleTimeoutMs: number;
  maxLiveBrains: number;
}

/**
 * Makes the `brains` table match the startup configuration without ever
 * losing anything: the default brain and every seeded slug are created when
 * missing, existing brains keep their data directory, nothing is deleted.
 * The cloud flag follows `ENGRAM_CLOUD_BRAINS` exactly (its only source until
 * the admin API exists). Fails loudly on a bad slug or an unknown cloud brain.
 */
export function bootstrapBrains(repo: BrainRepository, config: BrainsConfig, logger: Logger): Brain[] {
  return repo.transaction(() => {
    const wanted: Array<[string, string]> = [[DEFAULT_BRAIN, config.defaultDataDir]];
    for (const slug of config.seed) {
      if (slug === DEFAULT_BRAIN) continue;
      if (!config.brainsRoot) throw new Error('BRAINS_ROOT is required to create brains');
      wanted.push([slug, brainDataDir(config.brainsRoot, slug)]);
    }
    for (const [slug, dataDir] of wanted) {
      const brain = repo.ensure(slug, dataDir);
      if (brain.dataDir !== dataDir) {
        logger.warn('Brain keeps its stored data directory; the configured one is ignored', { brain: slug, stored: brain.dataDir, configured: dataDir });
      }
    }
    const all = repo.list();
    for (const brain of all) {
      const check = parseBrainSlug(brain.slug);
      if (!check.ok) throw new Error(`invalid brain slug in the brains table: ${JSON.stringify(brain.slug)} (${check.reason})`);
      if (!isAbsolute(brain.dataDir)) throw new Error(`brain ${brain.slug} has a relative data directory in the brains table: ${JSON.stringify(brain.dataDir)}`);
    }
    const known = new Set(all.map(brain => brain.slug));
    for (const slug of config.cloud) {
      if (!known.has(slug)) throw new Error(`ENGRAM_CLOUD_BRAINS names an unknown brain: ${JSON.stringify(slug)}`);
    }
    repo.setCloudSync(new Set(config.cloud));
    return repo.list();
  });
}
