import { mkdirSync, readdirSync } from 'node:fs';
import type { BrainDirectories } from '../application/ports.js';
import { AdminError } from '../domain/admin-error.js';

/** Brain data directories under `BRAINS_ROOT`: created owner-only, never over an existing non-empty directory. */
export function fsBrainDirectories(root: string | undefined): BrainDirectories {
  return {
    root,
    prepare(dir) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (readdirSync(dir).length > 0) throw new AdminError('conflict', `the data directory of a new brain must be empty: ${dir}`);
    }
  };
}
