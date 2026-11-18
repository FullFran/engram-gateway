import { chmodSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** One schema change: `NNNN_name.sql`, applied once, in order, in its own transaction. */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const MIGRATION_FILE = /^(\d+)_([\w-]+)\.sql$/;

/** Reads `NNNN_name.sql` files from `dir`, ordered by version. */
export function loadMigrations(dir: string): Migration[] {
  return readdirSync(dir)
    .flatMap(file => {
      const match = MIGRATION_FILE.exec(file);
      return match ? [{ version: Number(match[1]), name: match[2]!, sql: readFileSync(join(dir, file), 'utf8') }] : [];
    })
    .sort((a, b) => a.version - b.version);
}

/**
 * Runs `work` inside `BEGIN IMMEDIATE`: the write lock is taken up front, so
 * two processes on one file (two gateways during a deploy) serialise their
 * read-decide-write steps; the loser waits up to the busy timeout.
 */
export function immediateTransaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* the transaction was already rolled back */ }
    throw error;
  }
}

function userVersion(db: DatabaseSync): number {
  return Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
}

/**
 * Brings the schema to the last migration. `PRAGMA user_version` is the
 * version; each pending migration runs in one transaction with its version
 * bump, so a failure leaves the database at the previous version, unchanged.
 * Refuses a database newer than the code (a rollback to an older image) and
 * gaps in the migration list. Returns the resulting version.
 */
export function migrate(db: DatabaseSync, migrations: Migration[]): number {
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) throw new Error(`Bad migration list: expected migration ${index + 1}, found ${migration.version} (${migration.name})`);
  });
  const latest = migrations.length;
  for (;;) {
    const applied = immediateTransaction(db, () => {
      const current = userVersion(db);
      if (current > latest) throw new Error(`Database schema version ${current} is newer than this gateway supports (${latest}); refusing to open it.`);
      const next = migrations[current];
      if (!next) return false;
      try {
        db.exec(next.sql);
      } catch (error) {
        throw new Error(`Migration ${next.version} (${next.name}) failed: ${(error as Error).message}`);
      }
      db.exec(`PRAGMA user_version = ${next.version}`);
      return true;
    });
    if (!applied) return userVersion(db);
  }
}

/**
 * Opens (creating it, mode 0600, in a 0700 directory) a SQLite file shared by
 * several processes: WAL journal, foreign keys on, 5 s busy timeout. Then
 * applies pending migrations.
 */
export function openSqliteDatabase(path: string, migrations: Migration[]): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Create the file with a private mode; SQLite gives its -wal and -shm files the same mode.
  closeSync(openSync(path, 'a', 0o600));
  chmodSync(path, 0o600);
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, migrations);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
