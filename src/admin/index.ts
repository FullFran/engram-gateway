/**
 * Admin (#10): manage brains, users and grants, and export the audit log.
 * One application layer (`AdminService`), two adapters: the HTTP API under
 * `/admin/api` (for the admin UI, #17) and the operator CLI.
 */
export { AdminError } from './domain/admin-error.js';
export type { AdminErrorCode } from './domain/admin-error.js';
export { CLI_ACTOR } from './domain/admin-actor.js';
export type { AdminActor } from './domain/admin-actor.js';
export type { BrainStatus, BrainView, GrantSource, GrantView, ServiceAccountView, UserKind, UserStatus, UserView } from './domain/views.js';
export type { AdminBackups, AdminBrainHealth, AdminClock, AdminStore, AdminTokens, BrainDirectories, BrainRuntime } from './application/ports.js';
export { AdminService } from './application/admin-service.js';
export { AUDIT_PAGE_DEFAULT, AUDIT_PAGE_MAX } from './application/admin-service.js';
export type { AdminServiceDeps, AuditPage, BackupStatus, AuditQueryRequest, BrainHealthResult, BrainListing, ExportOptions } from './application/admin-service.js';
export { SqliteAdminStore } from './infrastructure/sqlite-admin-store.js';
export { fsBrainDirectories } from './infrastructure/brain-directories.js';
export { ADMIN_API_PATH, createAdminRouter } from './presentation/http/admin-router.js';
export type { AdminIdentify, AdminRouterOptions } from './presentation/http/admin-router.js';
