import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Proof that a gateway is serving a brain, without native addons: SQLite's
 * own file locks (POSIX advisory locks, released by the kernel when the
 * process dies) on an empty lock database in the brain's data directory,
 * in rollback-journal mode.
 *
 * - Every running gateway holds a SHARED lock on each brain's lock file
 *   (several gateways can, e.g. during a rolling deploy).
 * - Swapping a brain's files needs the EXCLUSIVE lock, which SQLite refuses
 *   while anyone else holds SHARED: an offline restore fails while a gateway
 *   runs, and a gateway refuses a restore while another gateway serves the
 *   same brain.
 *
 * Needs a local filesystem (no NFS), like the databases themselves.
 */
export const BRAIN_LOCK_FILE = '.gateway.lock';

function isBusy(error: unknown): boolean {
  return /database is locked|SQLITE_BUSY/i.test((error as Error).message);
}

function open(dataDir: string): DatabaseSync {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(dataDir, BRAIN_LOCK_FILE));
  db.exec('PRAGMA busy_timeout = 0');
  return db;
}

function takeShared(db: DatabaseSync): void {
  db.exec('BEGIN');
  // A read is what actually takes the SHARED lock.
  db.prepare('SELECT count(*) FROM sqlite_master').get();
}

export interface BrainLock {
  /**
   * Runs `work` holding the EXCLUSIVE lock; rejects without running it when
   * another process holds the brain. The SHARED lock is taken back afterwards.
   */
  withExclusive<T>(work: () => Promise<T>): Promise<T>;
  close(): void;
}

/** The running gateway's hold on one brain (SHARED until `close`). */
export function openBrainLock(dataDir: string): BrainLock {
  const db = open(dataDir);
  try {
    takeShared(db);
  } catch (error) {
    db.close();
    if (isBusy(error)) throw new Error(`brain directory ${dataDir} is locked by a restore in progress`);
    throw error;
  }
  let busy: Promise<unknown> = Promise.resolve();
  return {
    withExclusive<T>(work: () => Promise<T>): Promise<T> {
      const run = busy.then(async () => {
        db.exec('COMMIT');
        try {
          db.exec('BEGIN EXCLUSIVE');
        } catch (error) {
          takeShared(db);
          if (isBusy(error)) throw new Error(`another gateway is serving ${dataDir} (a rolling deploy?); restore refused, retry once it has stopped`);
          throw error;
        }
        try {
          return await work();
        } finally {
          db.exec('COMMIT');
          takeShared(db);
        }
      });
      busy = run.catch(() => undefined);
      return run;
    },
    close() {
      try { db.exec('COMMIT'); } catch { /* no transaction */ }
      db.close();
    }
  };
}

/** Runs `work` with the EXCLUSIVE lock from a process that is not a gateway (the offline CLI). */
export async function withOfflineBrainLock<T>(dataDir: string, work: () => Promise<T>): Promise<T> {
  const db = open(dataDir);
  try {
    try {
      db.exec('BEGIN EXCLUSIVE');
    } catch (error) {
      if (isBusy(error)) throw new Error(`a gateway is running on ${dataDir}: restore through it (without --offline), or stop it first`);
      throw error;
    }
    try {
      return await work();
    } finally {
      db.exec('COMMIT');
    }
  } finally {
    db.close();
  }
}
