import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { DatabaseSnapshotter } from '../application/ports.js';

/**
 * `VACUUM INTO` through a read-only connection: one read transaction, so the
 * copy is a consistent state of the database even while another process (a
 * brain's `engram mcp` child, the gateway itself) writes it in WAL mode. The
 * file is never copied byte by byte (that would miss the `-wal` contents).
 */
export async function snapshotDatabase(source: string, destination: string): Promise<void> {
  if (!existsSync(source)) throw new Error(`no database at ${source}`);
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.prepare('VACUUM INTO ?').run(destination);
  } finally {
    db.close();
  }
}

/** `PRAGMA integrity_check`: `'ok'` for a healthy file, otherwise the first problems found. */
export function integrityCheck(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare('PRAGMA integrity_check').all().map(row => String(Object.values(row)[0])).join('; ');
  } finally {
    db.close();
  }
}

export const sqliteSnapshotter: DatabaseSnapshotter = { snapshot: snapshotDatabase, integrityCheck };
