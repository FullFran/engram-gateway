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

/** `service` (#7): a non-human principal owned by an admin; it never signs in. */
export type UserKind = 'human' | 'service';

export interface UserView {
  login: string;
  status: UserStatus;
  isAdmin: boolean;
  kind: UserKind;
}

export interface ServiceAccountView {
  login: string;
  status: UserStatus;
  /** The instance admin who created it (null if that user row is gone). */
  owner: string | null;
}

export interface GrantView {
  login: string;
  brain: string;
  role: Role;
  source: GrantSource;
}
