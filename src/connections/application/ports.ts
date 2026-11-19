import type { Role } from '../../authz/domain/role.js';
import type { Connection, ConnectionChoice } from '../domain/connection.js';

/** Reads connections from the gateway database on every call: no cache, so a detach applies to the next request. */
export interface ConnectionReader {
  /**
   * The connection's role on `brain`: a role when attached, `null` when the
   * connection exists but the brain is not one of its brains, `undefined`
   * when there is no such connection.
   */
  roleOn(connectionId: number, brain: string): Role | null | undefined;
  get(connectionId: number): Connection | undefined;
}

export class ConnectionNameTakenError extends Error {
  constructor(readonly connectionName: string) {
    super(`A connection named ${JSON.stringify(connectionName)} already exists`);
    this.name = 'ConnectionNameTakenError';
  }
}

export interface ConnectionStore extends ConnectionReader {
  /** The `oauth` connection of `login` for an OAuth client, if one was made. */
  findOAuth(login: string, clientId: string): Connection | undefined;
  /**
   * Creates the `oauth` connection of (`login`, `clientId`), or replaces its
   * name, brains and default brain. Returns its id. Throws
   * `ConnectionNameTakenError` when another connection of the user has that name.
   * The choice must already be checked against the owner's grants.
   */
  saveOAuth(login: string, clientId: string, choice: ConnectionChoice): number;
  /** Creates a `token` connection (code projects, CI); issuance lands with #7. */
  createToken(login: string, choice: ConnectionChoice): number;
  /**
   * Attaches `brain` with `role`, or changes its role when already attached;
   * `makeDefault` also makes it the default brain. The caller has already
   * checked the role against the owner's grant.
   */
  attach(connectionId: number, brain: string, role: Role, makeDefault: boolean): void;
  /** Detaches `brain`; false when it was not attached. Detaching the default brain leaves the connection without one. */
  detach(connectionId: number, brain: string): boolean;
}
