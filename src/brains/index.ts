/**
 * Brains: one Engram data directory and one `engram mcp` child each. The
 * registry starts a brain's child on first use and stops it when idle; the
 * gateway database's `brains` table says which brains exist.
 */
export { DEFAULT_BRAIN, parseBrainSlug } from './domain/brain.js';
export type { Brain, SlugCheck } from './domain/brain.js';
export type { BrainProcess, BrainRepository, Clock } from './application/ports.js';
export { brainDataDir } from './application/data-dir.js';
export { buildChildEnv, cloudSyncWarning } from './application/child-env.js';
export { bootstrapBrains } from './application/bootstrap.js';
export type { BrainsConfig } from './application/bootstrap.js';
export { BrainCapacityError, BrainRegistry } from './application/brain-registry.js';
export type { BrainLease, BrainLookup, BrainRegistryOptions } from './application/brain-registry.js';
export { resolveBrainsConfig } from './infrastructure/env-config.js';
export { SqliteBrainRepository } from './infrastructure/sqlite-brain-repository.js';
