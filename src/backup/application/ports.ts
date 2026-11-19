/** Encrypts and decrypts whole files; `context` (e.g. `brains/work/engram.db`) is authenticated with the data. */
export interface BackupCipher {
  encryptFile(source: string, destination: string, context: string): Promise<void>;
  /** Fails, leaving no `destination`, when the file was altered, the context differs, or no known key matches. */
  decryptFile(source: string, destination: string, context: string): Promise<void>;
}

/** Consistent copies of a SQLite database that another process may be writing. */
export interface DatabaseSnapshotter {
  /** Writes a consistent copy of `source` to `destination` (which must not exist). */
  snapshot(source: string, destination: string): Promise<void>;
  /** `PRAGMA integrity_check` of the file: `'ok'` when healthy. */
  integrityCheck(path: string): Promise<string>;
}

/**
 * Runs `work` while the brain has no Engram child and none can start (the
 * brain registry's `quiesce`); offline, it simply runs `work`.
 */
export type QuiesceBrain = <T>(slug: string, work: () => Promise<T>) => Promise<T>;

export interface BackupClock {
  /** Milliseconds since the epoch. */
  now(): number;
}
