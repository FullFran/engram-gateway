/**
 * Encrypted backups: consistent snapshots (`VACUUM INTO`) of every brain's
 * databases and of the gateway database, AES-256-GCM at rest, retention, and
 * restore of one brain through the brain registry's quiesce hook.
 */
export { GATEWAY_UNIT, brainUnit, expiredSnapshots, formatSnapshotId, isSnapshotId, nextRunAt } from './domain/snapshot.js';
export type { DailySchedule } from './domain/snapshot.js';
export type { BackupCipher, BackupClock, DatabaseSnapshotter, QuiesceBrain } from './application/ports.js';
export { BRAIN_DATABASES, BackupService } from './application/backup-service.js';
export type { BackupReport, BackupServiceOptions } from './application/backup-service.js';
export { backupKeyId, createBackupCipher } from './infrastructure/aes-gcm-cipher.js';
export type { BackupKeys } from './infrastructure/aes-gcm-cipher.js';
export { integrityCheck, snapshotDatabase, sqliteSnapshotter } from './infrastructure/sqlite-snapshot.js';
export { parseBackupKey, resolveBackupConfig } from './infrastructure/env-config.js';
export type { BackupConfig } from './infrastructure/env-config.js';
export { startBackupSchedule } from './infrastructure/scheduler.js';
export type { BackupSchedule } from './infrastructure/scheduler.js';
export { callBackupControl, serveBackupControl } from './infrastructure/control-socket.js';
export type { ControlHandlers, ControlRequest } from './infrastructure/control-socket.js';

/** The control socket of a backup directory. */
export const CONTROL_SOCKET_NAME = 'control.sock';
