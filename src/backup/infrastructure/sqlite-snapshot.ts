import { Worker } from 'node:worker_threads';
import type { DatabaseSnapshotter } from '../application/ports.js';

const WORKER = new URL('./sqlite-worker.js', import.meta.url);

/** Runs one job in a fresh worker thread (see `sqlite-worker.ts`). */
function inWorker(job: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER, { workerData: job });
    let settled = false;
    worker.once('message', (message: { ok: boolean; result?: string; error?: string }) => {
      settled = true;
      if (message.ok) resolve(message.result ?? '');
      else reject(new Error(message.error ?? 'SQLite worker failed'));
    });
    worker.once('error', error => { settled = true; reject(error); });
    worker.once('exit', code => { if (!settled) reject(new Error(`SQLite worker exited with code ${code}`)); });
  });
}

/**
 * `VACUUM INTO` through a read-only connection: one read transaction, so the
 * copy is a consistent state of the database even while another process (a
 * brain's `engram mcp` child, the gateway itself) writes it in WAL mode. The
 * file is never copied byte by byte (that would miss the `-wal` contents).
 * Runs in a worker thread so the event loop keeps serving.
 */
export async function snapshotDatabase(source: string, destination: string): Promise<void> {
  await inWorker({ op: 'snapshot', source, destination });
}

/** `PRAGMA integrity_check` (in a worker thread): `'ok'` for a healthy file, otherwise the first problems found. */
export function integrityCheck(path: string): Promise<string> {
  return inWorker({ op: 'integrity', path });
}

export const sqliteSnapshotter: DatabaseSnapshotter = { snapshot: snapshotDatabase, integrityCheck };
