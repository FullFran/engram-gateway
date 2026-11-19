import type { Role } from '../../authz/domain/role.js';

/**
 * Personal access tokens (#7): a `token` connection (#27) with a secret a
 * headless client sends as a Bearer token on `/mcp`. The prefix lets secret
 * scanners and the redaction stage (#9) recognise one.
 */
export const PAT_PREFIX = 'egw_pat_';

/** Identity provider id the gateway reports for a request made with a PAT. */
export const PAT_PROVIDER = 'pat';

/** The OAuth scope a PAT request reports (`memory`, read and write): the token's role is per brain, on its connection. */
export const MEMORY_SCOPE_FOR_PATS = 'memory';

export const PAT_SCOPES = ['read', 'read+write'] as const;
export type PatScope = (typeof PAT_SCOPES)[number];

/** The lifetimes a PAT may be created with, in days. */
export const PAT_LIFETIME_DAYS = [30, 90, 365] as const;
export type PatLifetimeDays = (typeof PAT_LIFETIME_DAYS)[number];

/** `last_used_at` is written at most this often per token. */
export const PAT_LAST_USED_RESOLUTION_S = 60;

export function isPatScope(value: unknown): value is PatScope {
  return typeof value === 'string' && (PAT_SCOPES as readonly string[]).includes(value);
}

export function isPatLifetime(value: unknown): value is PatLifetimeDays {
  return typeof value === 'number' && (PAT_LIFETIME_DAYS as readonly number[]).includes(value);
}

/** The connection role a scope gives on each of the token's brains. */
export function roleOfScope(scope: PatScope): Role {
  return scope === 'read' ? 'reader' : 'writer';
}

/** Whether a bearer value is meant as a PAT (decided by prefix alone). */
export function isPatShaped(token: string): boolean {
  return token.startsWith(PAT_PREFIX);
}

export type PatStatus = 'active' | 'expired' | 'revoked';

/** A PAT as its owner sees it: never the secret. Times in epoch seconds. */
export interface PatView {
  id: number;
  name: string;
  /** Sorted by slug. */
  brains: string[];
  scope: PatScope;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export function patStatus(view: Pick<PatView, 'expiresAt' | 'revokedAt'>, nowS: number): PatStatus {
  if (view.revokedAt !== null) return 'revoked';
  return view.expiresAt <= nowS ? 'expired' : 'active';
}
