// Builds a brain's engram.db for tests from the real Engram schema
// (engram-schema.sql), with synthetic rows only.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = readFileSync(fileURLToPath(new URL('./engram-schema.sql', import.meta.url)), 'utf8');

/** Creates `<dir>/engram.db` with the real schema and one session; returns an open writer connection. */
export function createBrainDb(dir, { wal = false } = {}) {
  const db = new DatabaseSync(join(dir, 'engram.db'));
  if (wal) db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);
  db.prepare("INSERT INTO sessions (id, project, directory) VALUES ('s1', 'demo', '/tmp/demo')").run();
  return db;
}

export function addObservation(db, { type, title, deleted = false, reviewAfter = null }) {
  return Number(db.prepare(
    `INSERT INTO observations (session_id, type, title, content, deleted_at, review_after)
     VALUES ('s1', ?, ?, 'synthetic content', ?, ?)`,
  ).run(type, title, deleted ? '2026-10-01 00:00:00' : null, reviewAfter).lastInsertRowid);
}

let relationSeq = 0;
export function addRelation(db, { status, superseded = false }) {
  relationSeq += 1;
  return Number(db.prepare(
    `INSERT INTO memory_relations (sync_id, source_id, target_id, relation, judgment_status, superseded_at)
     VALUES (?, 'obs-a', 'obs-b', ?, ?, ?)`,
  ).run(`rel-${relationSeq}`, status === 'pending' ? 'pending' : 'related', status, superseded ? '2026-10-02 00:00:00' : null).lastInsertRowid);
}
