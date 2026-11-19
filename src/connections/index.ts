/**
 * Connections (#27): a named client credential owned by a user (ChatGPT, a
 * code project, a CI job) with its own role on each brain it may use. The
 * effective role on a brain is the weaker of the owner's grant and the
 * connection's role, so a connection never exceeds its owner.
 */
export { checkChoice, describeProblem, isConnectionName, rolesUpTo } from './domain/connection.js';
export type { ChoiceCheck, ChoiceProblem, Connection, ConnectionBrain, ConnectionChoice, ConnectionKind } from './domain/connection.js';
export { ConnectionNameTakenError } from './application/ports.js';
export type { ConnectionReader, ConnectionStore } from './application/ports.js';
export { ConnectionConsentService, NO_ROLE } from './application/connection-consent.js';
export { SqliteConnectionStore } from './infrastructure/sqlite-connection-store.js';
