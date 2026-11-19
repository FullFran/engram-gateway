import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { BrainHealthSource } from '../application/ports.js';
import { BrainHealthUnavailableError, type DuplicateTitlesFinding, type SampledFinding, type TypeCount } from '../domain/report.js';


const LIVE = 'deleted_at IS NULL';

/** How long a query waits for a lock before failing: short, since node:sqlite blocks the event loop. */
export const HEALTH_BUSY_TIMEOUT_MS = 500;

/**
 * Opens `<dataDir>/engram.db` read-only through `node:sqlite`, never through
 * the brain's `engram mcp` child, so a report works whether or not the child
 * runs. `readOnly` plus `query_only` make any write to the database fail. For
 * a WAL-mode database SQLite may create the `-wal` and `-shm` files when they
 * are missing (readers need the shared-memory index); engram opens them the
 * same way, so this is harmless and `engram.db` itself is never changed.
 */
export function openEngramHealthSource(dataDir: string): BrainHealthSource {
  const path = join(dataDir, 'engram.db');
  if (!existsSync(path)) throw new BrainHealthUnavailableError(`brain has no engram.db at ${path}`);
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec('PRAGMA query_only = ON');
    db.exec(`PRAGMA busy_timeout = ${HEALTH_BUSY_TIMEOUT_MS}`);
  } catch (error) {
    throw new BrainHealthUnavailableError(`cannot open ${path} read-only: ${(error as Error).message}`);
  }
  return new EngramDbSource(db);
}

class EngramDbSource implements BrainHealthSource {
  constructor(private readonly db: DatabaseSync) {}

  snapshot<T>(work: () => T): T {
    // A deferred read transaction: every query inside sees the same snapshot.
    this.db.exec('BEGIN');
    try {
      return work();
    } finally {
      this.db.exec('COMMIT');
    }
  }

  private count(sql: string, ...params: SQLInputValue[]): number {
    return Number(this.db.prepare(sql).get(...params)?.n ?? 0);
  }

  private ids(sql: string, ...params: SQLInputValue[]): number[] {
    return this.db.prepare(sql).all(...params).map(row => Number(row.id));
  }

  private sampled(from: string, params: SQLInputValue[], sampleSize: number): SampledFinding {
    return {
      count: this.count(`SELECT COUNT(*) AS n FROM ${from}`, ...params),
      sampleIds: this.ids(`SELECT id FROM ${from} ORDER BY id LIMIT ?`, ...params, sampleSize),
    };
  }

  typeCounts(): TypeCount[] {
    return this.db
      .prepare(`SELECT type, COUNT(*) AS n FROM observations WHERE ${LIVE} GROUP BY type ORDER BY n DESC, type ASC`)
      .all()
      .map(row => ({ type: String(row.type), count: Number(row.n) }));
  }

  deletedCount(): number {
    return this.count('SELECT COUNT(*) AS n FROM observations WHERE deleted_at IS NOT NULL');
  }

  observationsOfTypes(types: readonly string[], sampleSize: number): SampledFinding {
    if (types.length === 0) return { count: 0, sampleIds: [] };
    const placeholders = types.map(() => '?').join(', ');
    return this.sampled(`observations WHERE ${LIVE} AND type IN (${placeholders})`, [...types], sampleSize);
  }

  duplicateTitles(sampleSize: number): DuplicateTitlesFinding {
    const repeated = `SELECT title FROM observations WHERE ${LIVE} GROUP BY title HAVING COUNT(*) > 1`;
    const totals = this.db
      .prepare(`SELECT COUNT(*) AS groups, COALESCE(SUM(n), 0) AS rows FROM (SELECT COUNT(*) AS n FROM observations WHERE ${LIVE} GROUP BY title HAVING n > 1)`)
      .get();
    const groups = Number(totals?.groups ?? 0);
    const rows = Number(totals?.rows ?? 0);
    return {
      groups,
      rows,
      excessRows: rows - groups,
      sampleIds: this.ids(`SELECT id FROM observations WHERE ${LIVE} AND title IN (${repeated}) ORDER BY id LIMIT ?`, sampleSize),
    };
  }

  pendingRelations(sampleSize: number): SampledFinding | null {
    const exists = this.db.prepare("SELECT 1 AS found FROM sqlite_schema WHERE type = 'table' AND name = 'memory_relations'").get();
    if (!exists) return null;
    return this.sampled("memory_relations WHERE judgment_status = 'pending' AND superseded_at IS NULL", [], sampleSize);
  }

  pastReviewAfter(now: string, sampleSize: number): SampledFinding {
    // julianday() is NULL for unparseable values, so those rows never match.
    return this.sampled(`observations WHERE ${LIVE} AND review_after IS NOT NULL AND julianday(review_after) < julianday(?)`, [now], sampleSize);
  }

  close(): void {
    this.db.close();
  }
}
