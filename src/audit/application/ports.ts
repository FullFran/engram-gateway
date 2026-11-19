import type { AuditEvent, AuditMeta, AuditOutcome } from '../domain/audit-event.js';

export interface AuditClock {
  nowMs(): number;
}

/** A stored audit row; `actorLogin` is resolved from `users` at read time. */
export interface AuditRecord {
  id: number;
  atMs: number;
  actorKind: 'user' | 'system';
  actorId: string;
  actorLogin: string | null;
  brain: string | null;
  action: string;
  target: string | null;
  outcome: AuditOutcome;
  durationMs: number | null;
  meta: AuditMeta;
}

/** Append-only: there is no update or delete. */
export interface AuditLog {
  append(event: AuditEvent): number;
}

/** Brain and a half-open `[fromMs, toMs)` time range; every field optional. */
export interface AuditFilter {
  brain?: string;
  fromMs?: number;
  toMs?: number;
}

/** One page of the log, newest first (#17): every field narrows it; `before` continues from an earlier page. */
export interface AuditQuery {
  brain?: string;
  action?: string;
  /** The acting user's login, any case. */
  actor?: string;
  outcome?: AuditOutcome;
  fromMs?: number;
  toMs?: number;
  /** Only rows with a smaller id. */
  before?: number;
  limit: number;
}

/** Reads rows oldest first, lazily, so an export never loads the whole log. */
export interface AuditReader {
  read(filter?: AuditFilter): Iterable<AuditRecord>;
}
