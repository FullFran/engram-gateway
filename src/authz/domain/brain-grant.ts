import type { Role } from './role.js';

/** One grant from configuration: `login` holds `role` on brain `brain` (a slug). */
export interface BrainGrant {
  login: string;
  brain: string;
  role: Role;
}

const GITHUB_LOGIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38})$/i;

export function isGitHubLogin(value: string): boolean {
  return GITHUB_LOGIN_PATTERN.test(value);
}
