/**
 * One audit log entry, as the domain sees it. An event records who did what,
 * on which brain, with which outcome and how long it took; never memory
 * content, argument values, error messages or secrets.
 */
export type AuditOutcome = 'ok' | 'error' | 'denied';

/** A signed-in GitHub user (through an OAuth client) or the gateway itself. */
export type AuditActor =
  | { kind: 'user'; login: string; clientId?: string }
  | { kind: 'system'; id: string };

/**
 * Counts and ids only: finite numbers, booleans, maps of counts (such as
 * redactions per kind) and a few id-shaped strings under known keys.
 */
export type AuditMeta = Record<string, number | boolean | string | Record<string, number>>;

export interface AuditEvent {
  atMs: number;
  actor: AuditActor;
  /** Opaque brain key (the slug); null when the action is not tied to a brain. */
  brain: string | null;
  /** What happened, e.g. `tool_call`, later `brain.create`. */
  action: string;
  /** What it happened to, e.g. the tool name. */
  target: string | null;
  outcome: AuditOutcome;
  durationMs: number | null;
  meta: AuditMeta;
}

/** Why a call failed, as a fixed word (never the error message, which may echo arguments). */
export type AuditErrorKind = 'forward_failed' | 'tool_error';

/** String-valued meta keys allowed through, all ids; any other string is dropped. */
const ID_KEYS = new Set(['observationId', 'clientId', 'errorKind', 'sessionId']);
const META_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const ID_VALUE = /^[A-Za-z0-9._:-]{1,128}$/;

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function countMap(value: unknown): Record<string, number> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const counts: Record<string, number> = {};
  for (const [key, count] of Object.entries(value)) {
    if (!META_KEY.test(key) || !isCount(count)) return undefined;
    counts[key] = count;
  }
  return counts;
}

/**
 * Keeps what the audit log may hold from free-form pipeline facts: numbers,
 * booleans, maps of counts, and id-shaped strings under known id keys.
 * Everything else (argument values, messages, nested objects) is dropped, so
 * a caller cannot leak content into the log by mistake.
 */
export function toAuditMeta(input: Record<string, unknown>): AuditMeta {
  const meta: AuditMeta = {};
  for (const [key, value] of Object.entries(input)) {
    if (!META_KEY.test(key)) continue;
    if (isCount(value) || typeof value === 'boolean') {
      meta[key] = value;
    } else if (typeof value === 'string') {
      if (ID_KEYS.has(key) && ID_VALUE.test(value)) meta[key] = value;
    } else {
      const counts = countMap(value);
      if (counts) meta[key] = counts;
    }
  }
  return meta;
}
