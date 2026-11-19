/**
 * The port through which the consent screen turns an OAuth grant into a
 * connection (#27): a client credential with its own role on each brain.
 * Auth knows nothing about brains or roles beyond these strings; the
 * composition root supplies the implementation (src/connections).
 */

/** One brain the person may attach, with the roles they may give it (weakest first) and the one preselected. */
export interface ConsentBrain {
  brain: string;
  roles: readonly string[];
  /** Preselected role; absent: not attached. */
  selected?: string;
}

/** What the consent screen offers for one resource. */
export interface ConnectionOffer {
  /** Preselected connection name. */
  name: string;
  /** Preselected default brain. */
  defaultBrain?: string;
  brains: ConsentBrain[];
}

/** The consent form's answer: a name, a role (or `none`) per brain, and the default brain. */
export interface ConnectionAnswer {
  name: string | undefined;
  defaultBrain: string | undefined;
  /** brain -> role, or `none` to leave it out. */
  roles: Readonly<Record<string, string>>;
}

export interface ConsentClient {
  clientId: string;
  clientName?: string;
}

export type ConnectionAcceptance = { ok: true; connectionId: number } | { ok: false; message: string };

export interface ConnectionConsent {
  /**
   * What to offer `login` for a grant on `resource`; undefined when the
   * resource gives plain single-brain tokens (no connection).
   */
  offer(login: string, resource: string, client: ConsentClient): ConnectionOffer | undefined;
  /** Checks the answer against the person's current access and saves the connection. Nothing is saved on refusal. */
  accept(login: string, resource: string, client: ConsentClient, answer: ConnectionAnswer): ConnectionAcceptance;
}
