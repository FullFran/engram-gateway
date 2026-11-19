/**
 * Who runs an admin operation: a signed-in GitHub user (the HTTP API, which
 * must be an instance admin) or the operator CLI, which runs inside the
 * gateway's container with direct access to its database.
 */
export type AdminActor =
  | { kind: 'user'; login: string }
  | { kind: 'system'; id: 'cli' };

export const CLI_ACTOR: AdminActor = { kind: 'system', id: 'cli' };
