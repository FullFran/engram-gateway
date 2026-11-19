/**
 * Connections (#27): a named client credential owned by a user (ChatGPT, a
 * code project, a CI job) with its own role on each brain it may use. The
 * effective role on a brain is the weaker of the owner's grant and the
 * connection's role, so a connection never exceeds its owner.
 */
export { checkChoice, describeProblem, isConnectionName, rolesUpTo } from './domain/connection.js';
export type { ChoiceCheck, ChoiceProblem, Connection, ConnectionBrain, ConnectionChoice, ConnectionKind } from './domain/connection.js';
export { ALL_BRAINS, BRAIN_ARGUMENT, FAN_OUT_TOOLS, mergeFanOut, resolveTarget, withBrainArgument } from './domain/brain-argument.js';
export type { BrainOutcome, BrainTarget } from './domain/brain-argument.js';
export { ConnectionNameTakenError } from './application/ports.js';
export type { ConnectionReader, ConnectionStore } from './application/ports.js';
export { parseConnectionTool } from './domain/connection-tools.js';
export type { ConnectionToolArguments, ParsedConnectionTool } from './domain/connection-tools.js';
export { ConnectionAdmin } from './application/connection-admin.js';
export type { AttachOutcome, AttachableBrain, ConnectionToolAccess, ConnectionToolCheck, ConnectionView, OwnerGrants } from './application/connection-admin.js';
export { ConnectionConsentService, NO_ROLE } from './application/connection-consent.js';
export { OwnConnectionError, OwnConnections } from './application/own-connections.js';
export type { OwnConnectionActor, OwnConnectionErrorCode, OwnConnectionView, OwnConnectionsDeps } from './application/own-connections.js';
export { SqliteConnectionStore } from './infrastructure/sqlite-connection-store.js';
export { MEMORY_SCOPE_FOR_PATS, PAT_LIFETIME_DAYS, PAT_PREFIX, PAT_PROVIDER, PAT_SCOPES, isPatShaped, patStatus, roleOfScope } from './domain/personal-access-token.js';
export type { PatLifetimeDays, PatScope, PatStatus, PatView } from './domain/personal-access-token.js';
export { PatError, PersonalAccessTokens } from './application/personal-access-tokens.js';
export type { CreatePatRequest, PatActor, PatAuthentication, PatDenyReason, PatRecord, PatSecrets, PatStore } from './application/personal-access-tokens.js';
export { SqlitePatStore, nodePatSecrets } from './infrastructure/sqlite-pat-store.js';
export { patIdentityProvider } from './infrastructure/pat-identity-provider.js';
export { adminPatPort, createAccountRouter, patJson } from './presentation/http/account-router.js';
export type { AccountIdentify, AccountRouterOptions } from './presentation/http/account-router.js';
