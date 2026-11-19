import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { loadMigrations, migrate, openSqliteDatabase } from './sqlite-database.js';

/**
 * The gateway's own state (OAuth clients and tokens, users, brains, grants):
 * one SQLite file, `GATEWAY_DB_PATH`, separate from every brain's `engram.db`.
 * Migrations are the ordered `.sql` files next to this module.
 */
const MIGRATIONS = loadMigrations(fileURLToPath(new URL('./gateway-migrations/', import.meta.url)));

export const GATEWAY_SCHEMA_VERSION = MIGRATIONS.length;

/** Opens the gateway database at `path`; `':memory:'` gives a throwaway one (auth off, no data directory). */
export function openGatewayDatabase(path: string): DatabaseSync {
  if (path === ':memory:') {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, MIGRATIONS);
    return db;
  }
  return openSqliteDatabase(path, MIGRATIONS);
}
