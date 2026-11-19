import { existsSync, readdirSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Brain } from '../../brains/index.js';
import type { Logger } from '../../shared/logger.js';
import { GATEWAY_UNIT, brainUnit, expiredSnapshots, formatSnapshotId, isSnapshotId } from '../domain/snapshot.js';
import type { BackupCipher, BackupClock, DatabaseSnapshotter, QuiesceBrain } from './ports.js';

/** Databases a brain directory may hold: Engram's own and, when present, the vector index (#14) and wiki (#16). */
export const BRAIN_DATABASES = ['engram.db', 'vectors.db', 'wiki.db'] as const;
const GATEWAY_DATABASE = 'gateway.db';
const ENCRYPTED_SUFFIX = '.enc';
const PARTIAL_SUFFIX = '.partial';

export interface BackupReport {
  taken: Array<{ unit: string; id: string; files: string[] }>;
  skipped: Array<{ unit: string; reason: string }>;
  failed: Array<{ unit: string; error: string }>;
}

export interface BackupServiceOptions {
  /** Root of the snapshots: `<dir>/brains/<slug>/<id>/` and `<dir>/gateway/<id>/`. */
  backupDir: string;
  /** Snapshots kept per unit. */
  retention: number;
  cipher: BackupCipher;
  /** The brains to back up, read on every run (brains can be added while running). */
  brains(): readonly Brain[];
  /** The gateway database file; omitted when it lives in memory. */
  gatewayDbPath?: string;
  quiesce: QuiesceBrain;
  clock: BackupClock;
  logger: Logger;
  snapshotter: DatabaseSnapshotter;
}

interface Source {
  unit: string;
  dir: string;
  files: readonly string[];
}

/**
 * Encrypted snapshots of every brain and of the gateway database, with
 * retention, and restore of one brain. Operations run one at a time. Backing
 * up never starts a brain's child: it reads the database files directly.
 */
export class BackupService {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly snapshotter: DatabaseSnapshotter;

  constructor(private readonly options: BackupServiceOptions) {
    if (!Number.isInteger(options.retention) || options.retention < 1) throw new Error('backup retention must be a positive integer');
    this.snapshotter = options.snapshotter;
  }

  /** Takes one snapshot of every unit, then applies retention. A failing unit does not stop the others. */
  runAll(): Promise<BackupReport> {
    return this.serial(() => this.backupEverything());
  }

  /** Snapshot ids of one unit (`brains/<slug>` or `gateway`), oldest first. */
  list(unit: string): string[] {
    const dir = join(this.options.backupDir, unit);
    if (!existsSync(dir)) return [];
    return listIds(dir);
  }

  /** Snapshot ids of every unit that has any, by unit. */
  listAll(): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    for (const unit of [GATEWAY_UNIT, ...this.options.brains().map(brain => brainUnit(brain.slug))]) {
      const ids = this.list(unit);
      if (ids.length > 0) result[unit] = ids;
    }
    return result;
  }

  /**
   * Replaces the brain's databases with snapshot `id`. Every file is
   * decrypted and integrity-checked first, next to the brain's data; only
   * then is the brain quiesced (child stopped, requests held), stale
   * `-wal`/`-shm` files removed and each file renamed into place atomically.
   * The child starts again on the next request.
   */
  restoreBrain(slug: string, id: string): Promise<void> {
    return this.serial(() => this.restore(slug, id));
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private sources(): { sources: Source[]; skipped: BackupReport['skipped'] } {
    const sources: Source[] = [];
    const skipped: BackupReport['skipped'] = [];
    for (const brain of this.options.brains()) {
      const files = BRAIN_DATABASES.filter(file => existsSync(join(brain.dataDir, file)));
      if (!files.includes('engram.db')) skipped.push({ unit: brainUnit(brain.slug), reason: 'no database yet' });
      else sources.push({ unit: brainUnit(brain.slug), dir: brain.dataDir, files });
    }
    const gatewayDb = this.options.gatewayDbPath;
    if (gatewayDb && existsSync(gatewayDb)) {
      sources.push({ unit: GATEWAY_UNIT, dir: '', files: [gatewayDb] });
    } else {
      skipped.push({ unit: GATEWAY_UNIT, reason: gatewayDb ? 'no database yet' : 'kept in memory' });
    }
    return { sources, skipped };
  }

  private async backupEverything(): Promise<BackupReport> {
    await mkdir(this.options.backupDir, { recursive: true, mode: 0o700 });
    await chmod(this.options.backupDir, 0o700);
    const { sources, skipped } = this.sources();
    const report: BackupReport = { taken: [], skipped: skipped.filter(s => s.reason !== 'kept in memory'), failed: [] };
    for (const source of sources) {
      try {
        const taken = await this.backupUnit(source);
        report.taken.push(taken);
        await this.prune(source.unit);
      } catch (error) {
        const message = (error as Error).message;
        report.failed.push({ unit: source.unit, error: message });
        this.options.logger.error('Backup failed', { unit: source.unit, error: message });
      }
    }
    this.options.logger.info('Backup finished', {
      taken: report.taken.map(t => `${t.unit}@${t.id}`),
      skipped: report.skipped.map(s => s.unit),
      failed: report.failed.map(f => f.unit)
    });
    return report;
  }

  private async backupUnit(source: Source): Promise<BackupReport['taken'][number]> {
    const unitDir = join(this.options.backupDir, source.unit);
    await mkdir(unitDir, { recursive: true, mode: 0o700 });
    const id = formatSnapshotId(this.options.clock.now());
    const final = join(unitDir, id);
    if (existsSync(final)) throw new Error(`snapshot ${source.unit}/${id} already exists`);
    const partial = `${final}${PARTIAL_SUFFIX}`;
    await rm(partial, { recursive: true, force: true });
    await mkdir(partial, { mode: 0o700 });
    const files: string[] = [];
    try {
      for (const file of source.files) {
        const name = source.unit === GATEWAY_UNIT ? GATEWAY_DATABASE : file;
        const from = source.unit === GATEWAY_UNIT ? file : join(source.dir, file);
        const plain = join(partial, `${name}.plain`);
        await this.snapshotter.snapshot(from, plain);
        const check = this.snapshotter.integrityCheck(plain);
        if (check !== 'ok') throw new Error(`integrity_check of the copy of ${name} failed: ${check}`);
        await this.options.cipher.encryptFile(plain, join(partial, `${name}${ENCRYPTED_SUFFIX}`), `${source.unit}/${name}`);
        await rm(plain);
        files.push(name);
      }
      await rename(partial, final);
    } catch (error) {
      await rm(partial, { recursive: true, force: true });
      throw error;
    }
    return { unit: source.unit, id, files };
  }

  /** Keeps the newest `retention` snapshots and removes partial ones (left by an interrupted run). */
  private async prune(unit: string): Promise<void> {
    const dir = join(this.options.backupDir, unit);
    for (const entry of await readdir(dir)) {
      if (entry.endsWith(PARTIAL_SUFFIX)) await rm(join(dir, entry), { recursive: true, force: true });
    }
    for (const id of expiredSnapshots(listIds(dir), this.options.retention)) {
      await rm(join(dir, id), { recursive: true, force: true });
      this.options.logger.info('Backup snapshot expired', { unit, id });
    }
  }

  private async restore(slug: string, id: string): Promise<void> {
    const brain = this.options.brains().find(candidate => candidate.slug === slug);
    if (!brain) throw new Error(`unknown brain: ${slug}`);
    if (!isSnapshotId(id)) throw new Error(`not a snapshot id: ${JSON.stringify(id)} (expected YYYYMMDDTHHMMSSmmmZ, see \`backup list\`)`);
    const unit = brainUnit(slug);
    const snapshotDir = join(this.options.backupDir, unit, id);
    if (!existsSync(snapshotDir)) throw new Error(`no snapshot ${id} for brain ${slug}`);
    const names = (await readdir(snapshotDir))
      .filter(entry => entry.endsWith(ENCRYPTED_SUFFIX))
      .map(entry => entry.slice(0, -ENCRYPTED_SUFFIX.length))
      .filter(name => (BRAIN_DATABASES as readonly string[]).includes(name));
    if (!names.includes('engram.db')) throw new Error(`snapshot ${id} of brain ${slug} has no engram.db`);

    await mkdir(brain.dataDir, { recursive: true, mode: 0o700 });
    // Staging inside the data directory: same filesystem, so the final rename is atomic.
    const staging = await mkdtemp(join(brain.dataDir, '.restore-'));
    try {
      for (const name of names) {
        const plain = join(staging, name);
        await this.options.cipher.decryptFile(join(snapshotDir, `${name}${ENCRYPTED_SUFFIX}`), plain, `${unit}/${name}`);
        const check = this.snapshotter.integrityCheck(plain);
        if (check !== 'ok') throw new Error(`snapshot ${id} of brain ${slug}: integrity_check of ${name} failed: ${check}`);
      }
      await this.options.quiesce(slug, async () => {
        for (const name of names) {
          const target = join(brain.dataDir, name);
          // A leftover WAL belongs to the old file and would be replayed onto the restored one.
          await rm(`${target}-wal`, { force: true });
          await rm(`${target}-shm`, { force: true });
          await rename(join(staging, name), target);
        }
      });
      this.options.logger.info('Brain restored', { brain: slug, snapshot: id, files: names });
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
}

/** Complete snapshot ids in a unit directory, oldest first. */
function listIds(dir: string): string[] {
  try {
    return readdirSync(dir).filter(isSnapshotId).sort();
  } catch {
    return [];
  }
}
