import { ROLES, atLeast } from '../../authz/domain/role.js';
import type { Role } from '../../authz/domain/role.js';

/** `oauth`: made on the OAuth consent screen (ChatGPT, Claude.ai). `token`: a code project or CI credential (#7). */
export type ConnectionKind = 'oauth' | 'token';

/** One brain a connection may use, with the connection's role on it. */
export interface ConnectionBrain {
  brain: string;
  role: Role;
}

/** A named client credential owned by a user, with its own role on each brain it may use. */
export interface Connection {
  id: number;
  login: string;
  name: string;
  kind: ConnectionKind;
  /** The OAuth client it was made for (`oauth` connections only). */
  clientId?: string;
  /** The brain a call naming none goes to; absent when it was detached. */
  defaultBrain?: string;
  /** Sorted by brain slug. */
  brains: ConnectionBrain[];
}

/** What the owner picks for a connection: its name, its brains with a role each, and the default brain. */
export interface ConnectionChoice {
  name: string;
  defaultBrain: string;
  brains: ConnectionBrain[];
}

export type ChoiceProblem =
  | { problem: 'bad_name' }
  | { problem: 'no_brains' }
  | { problem: 'duplicate_brain'; brain: string }
  | { problem: 'no_grant'; brain: string }
  | { problem: 'role_above_grant'; brain: string; role: Role; max: Role }
  | { problem: 'bad_default'; brain: string };

export type ChoiceCheck = { ok: true; choice: ConnectionChoice } | ({ ok: false } & ChoiceProblem);

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._:@/-]{0,63}$/;

export function isConnectionName(value: string): boolean {
  return NAME_PATTERN.test(value);
}

/** The roles an owner holding `max` may give a connection, weakest first. */
export function rolesUpTo(max: Role): Role[] {
  return ROLES.filter(role => atLeast(max, role));
}

/**
 * Validates a choice against the owner's grants (`ownerRoles`: brain -> the
 * owner's role). A connection never exceeds its owner: every brain needs a
 * grant, and the connection's role on it is at most the owner's. Pure.
 */
export function checkChoice(choice: ConnectionChoice, ownerRoles: ReadonlyMap<string, Role>): ChoiceCheck {
  if (!isConnectionName(choice.name)) return { ok: false, problem: 'bad_name' };
  if (choice.brains.length === 0) return { ok: false, problem: 'no_brains' };
  const seen = new Set<string>();
  for (const { brain, role } of choice.brains) {
    if (seen.has(brain)) return { ok: false, problem: 'duplicate_brain', brain };
    seen.add(brain);
    const max = ownerRoles.get(brain);
    if (!max) return { ok: false, problem: 'no_grant', brain };
    if (!atLeast(max, role)) return { ok: false, problem: 'role_above_grant', brain, role, max };
  }
  if (!seen.has(choice.defaultBrain)) return { ok: false, problem: 'bad_default', brain: choice.defaultBrain };
  const brains = [...choice.brains].sort((a, b) => a.brain.localeCompare(b.brain));
  return { ok: true, choice: { name: choice.name, defaultBrain: choice.defaultBrain, brains } };
}

/** A problem as one sentence for a person (consent page, tool error). */
export function describeProblem(problem: ChoiceProblem): string {
  switch (problem.problem) {
    case 'bad_name': return 'The connection name must be 1 to 64 letters, digits, spaces or . _ : @ / - and start with a letter or digit.';
    case 'no_brains': return 'Choose at least one brain for this connection.';
    case 'duplicate_brain': return `Brain ${problem.brain} is listed twice.`;
    case 'no_grant': return `You have no access to brain ${problem.brain}.`;
    case 'role_above_grant': return `You are ${problem.max} on brain ${problem.brain}; a connection cannot get ${problem.role} there.`;
    case 'bad_default': return `The default brain ${problem.brain} must be one of the connection's brains.`;
  }
}
