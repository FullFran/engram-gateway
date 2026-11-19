// Brain health report (#18): read-only, size-bounded findings computed from a
// brain's engram.db. The fixture DB uses the real Engram schema
// (test/fixtures/engram-schema.sql) with synthetic rows only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addObservation, addRelation, createBrainDb } from '../fixtures/engram-brain.mjs';
import { DatabaseSync } from 'node:sqlite';
import { BrainHealthUnavailableError, MAX_SAMPLE_SIZE, NOISE_TYPES, buildHealthReport, createEngramBrainHealthService, openEngramHealthSource, readBrainHealth } from '../../dist/health/index.js';

const NOW = new Date('2026-11-19T10:00:00Z');

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'engram-gateway-health-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Known fixture: 11 live and 2 deleted observations, 4 relations.
 * Ids are assigned in insertion order, starting at 1.
 */
function seedKnownBrain(db) {
  addObservation(db, { type: 'decision', title: 'A' });                                   // 1 dup A
  addObservation(db, { type: 'decision', title: 'A' });                                   // 2 dup A
  addObservation(db, { type: 'passive', title: 'B' });                                    // 3 noise, dup B
  addObservation(db, { type: 'passive', title: 'B' });                                    // 4 noise, dup B
  addObservation(db, { type: 'passive', title: 'C' });                                    // 5 noise
  addObservation(db, { type: 'checkpoint', title: 'D' });                                 // 6 noise
  addObservation(db, { type: 'task-state', title: 'E', reviewAfter: '2026-01-01 00:00:00' }); // 7 noise, past review
  addObservation(db, { type: 'bugfix', title: 'F', reviewAfter: '2027-01-01 00:00:00' }); // 8 future review
  addObservation(db, { type: 'bugfix', title: 'A' });                                     // 9 dup A
  addObservation(db, { type: 'decision', title: 'G', deleted: true, reviewAfter: '2026-01-01 00:00:00' }); // 10 deleted
  addObservation(db, { type: 'decision', title: 'A', deleted: true });                    // 11 deleted
  addObservation(db, { type: 'architecture', title: 'I', reviewAfter: '2026-06-01 12:00:00' }); // 12 past review
  addObservation(db, { type: 'architecture', title: 'J', reviewAfter: 'not a date' });    // 13 unparseable review
  addRelation(db, { status: 'pending' });                    // 1 counted
  addRelation(db, { status: 'pending', superseded: true });  // 2 superseded: not counted
  addRelation(db, { status: 'judged' });                     // 3 judged: not counted
  addRelation(db, { status: 'pending' });                    // 4 counted
}

function knownBrain(t, options) {
  const dir = scratch(t);
  const db = createBrainDb(dir, options);
  seedKnownBrain(db);
  return { dir, db };
}

test('counts live and deleted observations, and live observations by type (count desc, then name)', t => {
  const { dir, db } = knownBrain(t);
  db.close();
  const report = readBrainHealth({ dataDir: dir, now: NOW });
  assert.equal(report.generatedAt, '2026-11-19T10:00:00.000Z');
  assert.deepEqual(report.observations, { live: 11, deleted: 2 });
  assert.deepEqual(report.byType, {
    top: [
      { type: 'passive', count: 3 },
      { type: 'architecture', count: 2 },
      { type: 'bugfix', count: 2 },
      { type: 'decision', count: 2 },
      { type: 'checkpoint', count: 1 },
      { type: 'task-state', count: 1 },
    ],
    otherTypes: 0,
    otherCount: 0,
  });
});

test('noise share counts live passive, checkpoint and task-state rows', t => {
  const { dir, db } = knownBrain(t);
  db.close();
  assert.deepEqual([...NOISE_TYPES], ['checkpoint', 'passive', 'task-state']);
  const { noise } = readBrainHealth({ dataDir: dir, now: NOW });
  assert.deepEqual(noise, { types: ['checkpoint', 'passive', 'task-state'], count: 5, share: 0.4545, sampleIds: [3, 4, 5, 6, 7] });
});

test('duplicate titles: groups of live rows sharing an exact title, deleted rows ignored', t => {
  const { dir, db } = knownBrain(t);
  db.close();
  const { duplicateTitles } = readBrainHealth({ dataDir: dir, now: NOW });
  // Groups: "A" -> 1, 2, 9 (11 is deleted); "B" -> 3, 4.
  assert.deepEqual(duplicateTitles, { groups: 2, rows: 5, excessRows: 3, sampleIds: [1, 2, 3, 4, 9] });
});

test('pending relations: judgment_status pending and not superseded', t => {
  const { dir, db } = knownBrain(t);
  db.close();
  const { pendingRelations } = readBrainHealth({ dataDir: dir, now: NOW });
  assert.deepEqual(pendingRelations, { count: 2, sampleIds: [1, 4] });
});

test('past review_after: live rows whose review_after is before now; unparseable dates are skipped', t => {
  const { dir, db } = knownBrain(t);
  db.close();
  const { pastReviewAfter } = readBrainHealth({ dataDir: dir, now: NOW });
  assert.deepEqual(pastReviewAfter, { count: 2, sampleIds: [7, 12] });
  // Moving "now" past 2027-01-01 adds row 8.
  const later = readBrainHealth({ dataDir: dir, now: new Date('2027-02-01T00:00:00Z') });
  assert.deepEqual(later.pastReviewAfter, { count: 3, sampleIds: [7, 8, 12] });
});

test('wiki and semantic index findings are reported as not available yet', t => {
  const { dir, db } = knownBrain(t);
  db.close();
  const report = readBrainHealth({ dataDir: dir, now: NOW });
  assert.deepEqual(report.wiki, { status: 'unavailable', reason: 'requires the curated wiki (#16)' });
  assert.deepEqual(report.semanticIndex, { status: 'unavailable', reason: 'requires the semantic index (#14)' });
});

test('an empty brain reports zeros and a zero noise share', t => {
  const dir = scratch(t);
  createBrainDb(dir).close();
  const report = readBrainHealth({ dataDir: dir, now: NOW });
  assert.deepEqual(report.observations, { live: 0, deleted: 0 });
  assert.deepEqual(report.byType, { top: [], otherTypes: 0, otherCount: 0 });
  assert.deepEqual(report.noise, { types: ['checkpoint', 'passive', 'task-state'], count: 0, share: 0, sampleIds: [] });
  assert.deepEqual(report.duplicateTitles, { groups: 0, rows: 0, excessRows: 0, sampleIds: [] });
  assert.deepEqual(report.pendingRelations, { count: 0, sampleIds: [] });
  assert.deepEqual(report.pastReviewAfter, { count: 0, sampleIds: [] });
});

test('the report is bounded: sample ids capped by sampleSize, types capped by maxTypes', t => {
  const dir = scratch(t);
  const db = createBrainDb(dir);
  db.exec('BEGIN');
  for (let i = 0; i < 300; i += 1) addObservation(db, { type: `type-${String(i % 60).padStart(2, '0')}`, title: 'same title', reviewAfter: '2020-01-01 00:00:00' });
  for (let i = 0; i < 120; i += 1) addObservation(db, { type: 'passive', title: `passive ${i}` });
  for (let i = 0; i < 80; i += 1) addRelation(db, { status: 'pending' });
  db.exec('COMMIT');
  db.close();

  const small = readBrainHealth({ dataDir: dir, now: NOW, sampleSize: 2, maxTypes: 3 });
  assert.deepEqual(small.byType.top, [
    { type: 'passive', count: 120 },
    { type: 'type-00', count: 5 },
    { type: 'type-01', count: 5 },
  ]);
  assert.equal(small.byType.otherTypes, 58);
  assert.equal(small.byType.otherCount, 290);
  assert.deepEqual(small.noise.sampleIds, [301, 302]);
  assert.equal(small.noise.count, 120);
  assert.equal(small.noise.share, 0.2857);
  assert.deepEqual(small.duplicateTitles, { groups: 1, rows: 300, excessRows: 299, sampleIds: [1, 2] });
  assert.deepEqual(small.pendingRelations.sampleIds.length, 2);
  assert.equal(small.pendingRelations.count, 80);
  assert.deepEqual(small.pastReviewAfter, { count: 300, sampleIds: [1, 2] });

  // Defaults: 5 sample ids, 50 types. Oversized options are clamped.
  const byDefault = readBrainHealth({ dataDir: dir, now: NOW });
  assert.equal(byDefault.noise.sampleIds.length, 5);
  assert.equal(byDefault.byType.top.length, 50);
  assert.equal(byDefault.byType.otherTypes, 11);
  const huge = readBrainHealth({ dataDir: dir, now: NOW, sampleSize: 10_000, maxTypes: 10_000 });
  assert.equal(huge.pastReviewAfter.sampleIds.length, MAX_SAMPLE_SIZE);
  assert.equal(huge.byType.top.length, 61);
  const none = readBrainHealth({ dataDir: dir, now: NOW, sampleSize: 0 });
  assert.deepEqual(none.noise.sampleIds, []);
});

test('the report carries ids and numbers only, never titles or contents', t => {
  const dir = scratch(t);
  const db = createBrainDb(dir);
  addObservation(db, { type: 'passive', title: 'SECRET-TITLE-MARKER' });
  addObservation(db, { type: 'passive', title: 'SECRET-TITLE-MARKER' });
  db.close();
  const json = JSON.stringify(readBrainHealth({ dataDir: dir, now: NOW }));
  assert.ok(!json.includes('SECRET-TITLE-MARKER'));
  assert.ok(!json.includes('synthetic content'));
});

test('read-only: the database file is byte-identical after a report', t => {
  const { dir, db } = knownBrain(t);
  db.close();
  const path = join(dir, 'engram.db');
  const before = createHash('sha256').update(readFileSync(path)).digest('hex');
  readBrainHealth({ dataDir: dir, now: NOW });
  assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), before);
  assert.ok(!existsSync(join(dir, 'engram.db-journal')));
});

test('reads a WAL database while a writer (the engram child) holds it open, including uncheckpointed rows', t => {
  const { dir, db } = knownBrain(t, { wal: true });
  t.after(() => db.close());
  addObservation(db, { type: 'passive', title: 'fresh' });
  const report = readBrainHealth({ dataDir: dir, now: NOW });
  assert.equal(report.observations.live, 12);
  assert.equal(report.noise.count, 6);
});

test('a brain with no engram.db is reported as unavailable and no file is created', t => {
  const dir = scratch(t);
  assert.throws(() => readBrainHealth({ dataDir: dir, now: NOW }), error => {
    assert.ok(error instanceof BrainHealthUnavailableError);
    assert.match(error.message, /no engram\.db/);
    return true;
  });
  assert.ok(!existsSync(join(dir, 'engram.db')));
});

test('an engram.db without memory_relations (older Engram) reports pendingRelations as null', t => {
  const dir = scratch(t);
  const db = createBrainDb(dir);
  db.exec('DROP TABLE memory_relations');
  addObservation(db, { type: 'decision', title: 'x' });
  db.close();
  const report = readBrainHealth({ dataDir: dir, now: NOW });
  assert.equal(report.pendingRelations, null);
  assert.equal(report.observations.live, 1);
});

test('reads a WAL database after its writer closed (no -wal or -shm files left)', t => {
  const { dir, db } = knownBrain(t, { wal: true });
  db.close();
  assert.ok(!existsSync(join(dir, 'engram.db-wal')));
  const report = readBrainHealth({ dataDir: dir, now: NOW });
  assert.equal(report.observations.live, 11);
});

test('the adapter reads one consistent snapshot: a commit between two queries is not seen inside it', t => {
  const { dir, db } = knownBrain(t, { wal: true });
  t.after(() => db.close());
  const source = openEngramHealthSource(dir);
  t.after(() => source.close());
  const passive = rows => rows.find(row => row.type === 'passive').count;
  const [before, during] = source.snapshot(() => {
    const first = passive(source.typeCounts());
    addObservation(db, { type: 'passive', title: 'committed meanwhile' });
    return [first, passive(source.typeCounts())];
  });
  assert.equal(before, 3);
  assert.equal(during, 3, 'same snapshot inside the transaction');
  assert.equal(passive(source.typeCounts()), 4, 'a new read after it sees the commit');
});

test('buildHealthReport runs every query inside one snapshot', () => {
  let inside = false;
  const guard = value => { assert.ok(inside, 'query outside the snapshot'); return value; };
  const source = {
    snapshot: work => { inside = true; try { return work(); } finally { inside = false; } },
    typeCounts: () => guard([{ type: 'passive', count: 2 }]),
    deletedCount: () => guard(0),
    observationsOfTypes: () => guard({ count: 2, sampleIds: [1, 2] }),
    duplicateTitles: () => guard({ groups: 0, rows: 0, excessRows: 0, sampleIds: [] }),
    pendingRelations: () => guard(null),
    pastReviewAfter: () => guard({ count: 0, sampleIds: [] }),
    close: () => {},
  };
  const report = buildHealthReport(source, { now: NOW });
  assert.equal(report.noise.share, 1);
});

test('a locked database fails fast (busy timeout about 500 ms), it does not stall for 5 s', t => {
  const { dir, db } = knownBrain(t);
  db.exec('BEGIN EXCLUSIVE');
  t.after(() => { db.exec('ROLLBACK'); db.close(); });
  const started = Date.now();
  assert.throws(() => readBrainHealth({ dataDir: dir, now: NOW }), /locked|busy/i);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 300 && elapsed < 2000, `gave up after ${elapsed} ms`);
  const service = createEngramBrainHealthService({ dataDirOf: () => dir, nowMs: () => NOW.getTime() });
  const lookup = service.report('team');
  assert.equal(lookup.ok, false);
  assert.equal(lookup.reason, 'busy');
  assert.match(lookup.message, /busy/);
});

test('WAL brain: reading may create -wal/-shm (as engram itself does) but never changes engram.db', t => {
  const { dir, db } = knownBrain(t, { wal: true });
  db.close();
  const path = join(dir, 'engram.db');
  const before = createHash('sha256').update(readFileSync(path)).digest('hex');
  readBrainHealth({ dataDir: dir, now: NOW });
  assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), before);
  const check = new DatabaseSync(path, { readOnly: true });
  assert.equal(check.prepare('SELECT COUNT(*) AS n FROM observations').get().n, 13);
  check.close();
});
