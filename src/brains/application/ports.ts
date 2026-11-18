import type { Brain } from '../domain/brain.js';

/** The `brains` table of the gateway database. */
export interface BrainRepository {
  /** Every brain, ordered by slug. */
  list(): Brain[];
  /**
   * Inserts the brain when its slug is new; an existing brain is returned
   * unchanged (its data directory is never rewritten).
   */
  ensure(slug: string, dataDir: string): Brain;
  /** Sets the cloud flag: on for `slugs`, off for every other brain. */
  setCloudSync(slugs: ReadonlySet<string>): void;
  /** Runs `work` in one write transaction. */
  transaction<T>(work: () => T): T;
}

/** One brain's running Engram child, as the registry sees it. */
export interface BrainProcess {
  /** A child is connected (or connecting) right now. */
  live(): boolean;
  /** Stops the child; the process object is not reused afterwards. */
  close(): Promise<void>;
}

export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
}
