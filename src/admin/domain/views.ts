import type { Role } from '../../authz/index.js';

export type UserStatus = 'invited' | 'active' | 'disabled';
export type BrainStatus = 'active' | 'archived';
/** Who owns a grant: `config` rows follow ALLOWED_GITHUB_LOGINS and BRAIN_GRANTS on every start; `api` rows are managed here. */
export type GrantSource = 'config' | 'api';

export interface BrainView {
  slug: string;
  dataDir: string;
  cloudSync: boolean;
  status: BrainStatus;
}

export interface UserView {
  login: string;
  status: UserStatus;
  isAdmin: boolean;
}

export interface GrantView {
  login: string;
  brain: string;
  role: Role;
  source: GrantSource;
}
