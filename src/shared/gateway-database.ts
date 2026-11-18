import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { loadMigrations, openSqliteDatabase } from './sqlite-database.js';

/**
 * The gateway's own state (OAuth clients and tokens, users, brains, grants):
 * one SQLite file, `GATEWAY_DB_PATH`, separate from every brain's `engram.db`.
 * Migrations are the ordered `.sql` files next to this module.
 */
const MIGRATIONS = loadMigrations(fileURLToPath(new URL('./gateway-migrations/', import.meta.url)));

export const GATEWAY_SCHEMA_VERSION = MIGRATIONS.length;

export function openGatewayDatabase(path: string): DatabaseSync {
  return openSqliteDatabase(path, MIGRATIONS);
}
