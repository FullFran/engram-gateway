/**
 * Worker thread for the SQLite work of a backup: `VACUUM INTO` and
 * `PRAGMA integrity_check` are synchronous in `node:sqlite` and can take
 * seconds on a large brain, so they run here and the gateway keeps serving.
 */
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';

type Job = { op: 'snapshot'; source: string; destination: string } | { op: 'integrity'; path: string };

function run(job: Job): string {
  if (job.op === 'snapshot') {
    if (!existsSync(job.source)) throw new Error(`no database at ${job.source}`);
    const db = new DatabaseSync(job.source, { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      db.prepare('VACUUM INTO ?').run(job.destination);
    } finally {
      db.close();
    }
    return 'done';
  }
  const db = new DatabaseSync(job.path, { readOnly: true });
  try {
    return db.prepare('PRAGMA integrity_check').all().map(row => String(Object.values(row)[0])).join('; ');
  } finally {
    db.close();
  }
}

try {
  parentPort!.postMessage({ ok: true, result: run(workerData as Job) });
} catch (error) {
  parentPort!.postMessage({ ok: false, error: (error as Error).message });
}
