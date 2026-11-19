import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type { Brain } from '../domain/brain.js';
import type { BrainRepository } from '../application/ports.js';
import { immediateTransaction } from '../../shared/sqlite-database.js';

function toBrain(row: Record<string, SQLOutputValue>): Brain {
  return { slug: String(row.slug), dataDir: String(row.data_dir), cloudSync: Number(row.cloud_sync) === 1 };
}

/** The `brains` table of the gateway database. */
export class SqliteBrainRepository implements BrainRepository {
  constructor(private readonly db: DatabaseSync) {}

  list(): Brain[] {
    return this.db.prepare('SELECT slug, data_dir, cloud_sync FROM brains ORDER BY slug').all().map(toBrain);
  }

  ensure(slug: string, dataDir: string): Brain {
    this.db.prepare('INSERT INTO brains (slug, data_dir) VALUES (?, ?) ON CONFLICT (slug) DO NOTHING').run(slug, dataDir);
    return toBrain(this.db.prepare('SELECT slug, data_dir, cloud_sync FROM brains WHERE slug = ?').get(slug)!);
  }

  findActive(slug: string): Brain | undefined {
    const row = this.db.prepare("SELECT slug, data_dir, cloud_sync FROM brains WHERE slug = ? AND status = 'active'").get(slug);
    return row ? toBrain(row) : undefined;
  }

  exists(slug: string): boolean {
    return this.db.prepare('SELECT 1 AS ok FROM brains WHERE slug = ?').get(slug) !== undefined;
  }

  archive(slug: string): void {
    this.db.prepare("UPDATE brains SET status = 'archived' WHERE slug = ?").run(slug);
  }

  setCloudSync(slugs: ReadonlySet<string>): void {
    const update = this.db.prepare('UPDATE brains SET cloud_sync = ? WHERE slug = ?');
    for (const brain of this.list()) update.run(slugs.has(brain.slug) ? 1 : 0, brain.slug);
  }

  transaction<T>(work: () => T): T {
    return immediateTransaction(this.db, work);
  }
}
