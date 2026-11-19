import type { AuditEvent } from '../../audit/domain/audit-event.js';
import type { Role } from '../../authz/domain/role.js';
import { checkChoice, describeProblem } from '../domain/connection.js';
import type { ConnectionChoice } from '../domain/connection.js';
import { PAT_LAST_USED_RESOLUTION_S, isPatLifetime, isPatScope, isPatShaped, roleOfScope } from '../domain/personal-access-token.js';
import type { PatLifetimeDays, PatScope, PatView } from '../domain/personal-access-token.js';
import { ConnectionNameTakenError } from './ports.js';

/** A stored PAT, as authentication reads it. Times in epoch seconds. */
export interface PatRecord {
  id: number;
  connectionId: number;
  login: string;
  /** The owner's `users.status` is `active`. */
  ownerActive: boolean;
  expiresAt: number;
  revokedAt: number | null;
}

export interface NewPat {
  hash: string;
  scope: PatScope;
  createdAt: number;
  expiresAt: number;
}

export interface PatStore {
  /**
   * Creates the token connection of `login` with `choice`, its PAT row and
   * the audit row `audit(patId)`, in one transaction. Throws
   * `ConnectionNameTakenError` when the owner already has a connection with that name.
   */
  create(login: string, choice: ConnectionChoice, pat: NewPat, audit: (patId: number) => AuditEvent): PatView;
  /** The owner's PATs, newest first. */
  list(login: string): PatView[];
  /** Sets `revoked_at` on the owner's active PAT and writes `audit` in one transaction; false when there is none to revoke. */
  revoke(login: string, id: number, atS: number, audit: AuditEvent): boolean;
  view(login: string, id: number): PatView | undefined;
  findByHash(hash: string): PatRecord | undefined;
  /** Sets `last_used_at` to `nowS` unless it was set less than `resolutionS` ago. */
  touch(id: number, nowS: number, resolutionS: number): void;
}

/** Makes and hashes secrets (Node crypto in production). */
export interface PatSecrets {
  /** `egw_pat_` + 256 random bits. */
  generate(): string;
  /** Hex SHA-256: what the store keeps and looks up. */
  hash(secret: string): string;
}

/** Who acts on a PAT: its owner (HTTP) or the operator CLI on the owner's behalf. */
export type PatActor = { kind: 'user'; login: string } | { kind: 'system'; id: string };

export type PatErrorCode = 'invalid' | 'not_found' | 'conflict';

export class PatError extends Error {
  constructor(readonly code: PatErrorCode, message: string) {
    super(message);
    this.name = 'PatError';
  }
}

export interface CreatePatRequest {
  name: unknown;
  brains: unknown;
  scope: unknown;
  expiresInDays: unknown;
}

export type PatDenyReason = 'revoked' | 'expired' | 'owner_disabled';

export type PatAuthentication =
  /** Not a PAT: another provider's credential. */
  | { kind: 'none' }
  /** Shaped like a PAT but unknown, revoked, expired, or its owner is disabled. */
  | { kind: 'invalid'; reason: PatDenyReason | 'unknown' }
  | { kind: 'ok'; login: string; connectionId: number; patId: number; expiresAt: number };

export interface PersonalAccessTokensDeps {
  store: PatStore;
  /** The owner's grants (src/authz): a token never exceeds them. */
  grants: { grantsOf(login: string): { brain: string; role: Role }[] };
  secrets: PatSecrets;
  clock: { nowMs(): number };
  /** Appends one audit row on its own (use denials). */
  audit: { append(event: AuditEvent): unknown };
  /** A use denial is audited once per token in this window (default one minute); every use is still refused. */
  deniedAuditIntervalMs?: number;
  /** Called when a use-denial audit row cannot be written; the request is refused anyway. */
  onAuditError?(error: unknown): void;
}

const DAY_S = 86_400;
const DENIED_AUDIT_INTERVAL_MS = 60_000;
const DENIED_MEMORY = 10_000;

function actorOf(actor: PatActor): AuditEvent['actor'] {
  return actor.kind === 'user' ? { kind: 'user', login: actor.login } : { kind: 'system', id: actor.id };
}

/** The audit target of a PAT: its id, never its name (free text) or secret. */
function target(id: number): string {
  return `pat-${id}`;
}

/**
 * Personal access tokens (#7): create (the secret is returned once and only
 * its hash is stored), list, revoke, and authenticate a bearer value.
 * A PAT is a `token` connection, so the per-call role check of #27 applies
 * unchanged: the effective role is the weaker of the owner's grant (read on
 * every call) and the token's role. Creation, revocation and refused uses
 * are audited; no audit row or error holds token material.
 */
export class PersonalAccessTokens {
  private readonly deniedAt = new Map<number, number>();

  constructor(private readonly deps: PersonalAccessTokensDeps) {}

  private nowS(): number {
    return Math.floor(this.deps.clock.nowMs() / 1000);
  }

  create(actor: PatActor, owner: string, request: CreatePatRequest): { token: string; pat: PatView } {
    const { name, brains, scope, expiresInDays } = request;
    if (typeof name !== 'string') throw new PatError('invalid', 'name must be a string');
    if (!Array.isArray(brains) || !brains.every(brain => typeof brain === 'string')) throw new PatError('invalid', 'brains must be a list of brain names');
    if (!isPatScope(scope)) throw new PatError('invalid', 'scope must be "read" or "read+write"');
    if (!isPatLifetime(expiresInDays)) throw new PatError('invalid', 'expiresInDays must be 30, 90 or 365');
    const role = roleOfScope(scope);
    const ownerRoles = new Map(this.deps.grants.grantsOf(owner).map(grant => [grant.brain, grant.role]));
    const checked = checkChoice({ name, defaultBrain: (brains as string[])[0] ?? '', brains: (brains as string[]).map(brain => ({ brain, role })) }, ownerRoles);
    if (!checked.ok) throw new PatError('invalid', describeProblem(checked).replace('connection', 'token'));
    const startedAtMs = this.deps.clock.nowMs();
    const createdAt = Math.floor(startedAtMs / 1000);
    const secret = this.deps.secrets.generate();
    const pat: NewPat = { hash: this.deps.secrets.hash(secret), scope, createdAt, expiresAt: createdAt + (expiresInDays as PatLifetimeDays) * DAY_S };
    try {
      const view = this.deps.store.create(owner, checked.choice, pat, id => ({
        atMs: startedAtMs, actor: actorOf(actor), brain: null, action: 'pat.create', target: target(id), outcome: 'ok', durationMs: null,
        meta: { patId: id, brains: checked.choice.brains.length, expiresInDays: expiresInDays as number, write: scope === 'read+write' }
      }));
      return { token: secret, pat: view };
    } catch (error) {
      if (error instanceof ConnectionNameTakenError) throw new PatError('conflict', `a token or connection named ${JSON.stringify(name)} already exists`);
      throw error;
    }
  }

  list(owner: string): PatView[] {
    return this.deps.store.list(owner);
  }

  revoke(actor: PatActor, owner: string, id: number): PatView {
    const atMs = this.deps.clock.nowMs();
    const event: AuditEvent = { atMs, actor: actorOf(actor), brain: null, action: 'pat.revoke', target: target(id), outcome: 'ok', durationMs: null, meta: { patId: id } };
    if (!this.deps.store.revoke(owner, id, Math.floor(atMs / 1000), event)) {
      if (this.deps.store.view(owner, id)) throw new PatError('conflict', `token ${id} is already revoked`);
      throw new PatError('not_found', `no token ${id}`);
    }
    return this.deps.store.view(owner, id)!;
  }

  /**
   * Is `bearer` a usable PAT? Revoked, expired and disabled-owner tokens are
   * refused and audited (`pat.use`, outcome `denied`, at most once a minute
   * per token). The grant itself is checked per call, not here.
   */
  authenticate(bearer: string): PatAuthentication {
    if (!isPatShaped(bearer)) return { kind: 'none' };
    const record = this.deps.store.findByHash(this.deps.secrets.hash(bearer));
    if (!record) return { kind: 'invalid', reason: 'unknown' };
    const now = this.nowS();
    const reason: PatDenyReason | undefined = record.revokedAt !== null ? 'revoked' : record.expiresAt <= now ? 'expired' : !record.ownerActive ? 'owner_disabled' : undefined;
    if (reason) {
      this.recordDenied(record, reason);
      return { kind: 'invalid', reason };
    }
    this.deps.store.touch(record.id, now, PAT_LAST_USED_RESOLUTION_S);
    return { kind: 'ok', login: record.login, connectionId: record.connectionId, patId: record.id, expiresAt: record.expiresAt };
  }

  private recordDenied(record: PatRecord, reason: PatDenyReason): void {
    const now = this.deps.clock.nowMs();
    const interval = this.deps.deniedAuditIntervalMs ?? DENIED_AUDIT_INTERVAL_MS;
    const last = this.deniedAt.get(record.id);
    if (last !== undefined && now - last < interval) return;
    if (this.deniedAt.size >= DENIED_MEMORY) this.deniedAt.delete(this.deniedAt.keys().next().value!);
    this.deniedAt.delete(record.id);
    this.deniedAt.set(record.id, now);
    try {
      this.deps.audit.append({
        atMs: now, actor: { kind: 'user', login: record.login }, brain: null, action: 'pat.use', target: target(record.id),
        outcome: 'denied', durationMs: null, meta: { patId: record.id, errorKind: reason }
      });
    } catch (error) {
      this.deps.onAuditError?.(error);
    }
  }
}
