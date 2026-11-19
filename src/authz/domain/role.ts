/** Per-brain roles, weakest first: each one can do everything the previous one can. */
export const ROLES = ['reader', 'writer', 'owner'] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function roleRank(role: Role): number {
  return ROLES.indexOf(role);
}

/** `have` is at least as strong as `need`. */
export function atLeast(have: Role, need: Role): boolean {
  return roleRank(have) >= roleRank(need);
}

/** The weaker of two roles. */
export function weakerRole(a: Role, b: Role): Role {
  return roleRank(a) <= roleRank(b) ? a : b;
}
