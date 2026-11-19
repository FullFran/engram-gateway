import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { WikiError } from '../domain/wiki.js';
import type { JournalEntry, JournalQuery, JournalReader } from '../application/ports.js';

/** How long a journal query waits for engram's lock: short, since node:sqlite blocks the event loop. */
export const JOURNAL_BUSY_TIMEOUT_MS = 500;

/** SQLite caps bound parameters; citations are looked up in chunks below it. */
const CITATION_CHUNK = 500;

/**
 * Opens `<dataDir>/engram.db` read-only (`readOnly` plus `query_only`), never
 * through the brain's `engram mcp` child, as the health report does (#18).
 * Undefined when the brain has no `engram.db` yet.
 */
export function openEngramJournal(dataDir: string): JournalReader | undefined {
  const path = join(dataDir, 'engram.db');
  if (!existsSync(path)) return undefined;
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec('PRAGMA query_only = ON');
    db.exec(`PRAGMA busy_timeout = ${JOURNAL_BUSY_TIMEOUT_MS}`);
  } catch (error) {
    throw new WikiError('unavailable', `cannot open the brain's engram.db read-only: ${(error as Error).message}`);
  }
  return new EngramJournal(db);
}

class EngramJournal implements JournalReader {
  constructor(private readonly db: DatabaseSync) {}

  entries(query: JournalQuery): { entries: JournalEntry[]; more: boolean } {
    const params: SQLInputValue[] = [query.maxChars, query.afterId, ...query.excludeTypes];
    const skip = query.excludeTypes.length > 0 ? `AND type NOT IN (${query.excludeTypes.map(() => '?').join(', ')})` : '';
    const project = query.project !== undefined ? 'AND project = ?' : '';
    if (query.project !== undefined) params.push(query.project);
    params.push(query.limit + 1);
    const rows = this.db.prepare(
      `SELECT id, sync_id, type, title, substr(content, 1, ?) AS content, length(content) AS length, project, topic_key, created_at
       FROM observations WHERE deleted_at IS NULL AND id > ? ${skip} ${project} ORDER BY id LIMIT ?`
    ).all(...params);
    const more = rows.length > query.limit;
    const entries = rows.slice(0, query.limit).map(row => ({
      id: Number(row.id),
      syncId: row.sync_id === null ? null : String(row.sync_id),
      type: String(row.type),
      title: String(row.title),
      content: String(row.content),
      truncated: Number(row.length) > query.maxChars,
      project: row.project === null ? null : String(row.project),
      topicKey: row.topic_key === null ? null : String(row.topic_key),
      createdAt: String(row.created_at)
    }));
    return { entries, more };
  }

  citations(syncIds: readonly string[]): Map<string, { id: number; live: boolean }> {
    const found = new Map<string, { id: number; live: boolean }>();
    for (let start = 0; start < syncIds.length; start += CITATION_CHUNK) {
      const chunk = syncIds.slice(start, start + CITATION_CHUNK);
      const rows = this.db
        .prepare(`SELECT id, sync_id, deleted_at FROM observations WHERE sync_id IN (${chunk.map(() => '?').join(', ')})`)
        .all(...chunk);
      for (const row of rows) found.set(String(row.sync_id), { id: Number(row.id), live: row.deleted_at === null });
    }
    return found;
  }

  close(): void {
    this.db.close();
  }
}
