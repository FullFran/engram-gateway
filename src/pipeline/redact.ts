/**
 * Secret redaction for write tools (#9).
 *
 * One table of named patterns for well-known secret shapes. No entropy
 * heuristics: they flag git SHAs and UUIDs. A match is replaced by
 * `[secret removed:<kind>]`; only per-kind counts leave this module, never
 * the matched text.
 */
import type { RequestStage } from './tool-call-pipeline.js';

export type RedactionCounts = Record<string, number>;

interface SecretPattern {
  kind: string;
  /** Global regex; the whole match is replaced unless `keepAround` is set. */
  regex: RegExp;
  /** Keep groups 1 and 3 around the marker (URL credentials keep `scheme://user:` and `@`). */
  keepAround?: boolean;
}

// Not preceded by a token character, so `task-...` or `disk_live_...` never start a match.
const START = '(?<![A-Za-z0-9_-])';

/** Order matters: more specific prefixes (sk-ant-) come before general ones (sk-). */
const PATTERNS: readonly SecretPattern[] = [
  {
    kind: 'private-key',
    regex: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/g
  },
  { kind: 'anthropic', regex: new RegExp(`${START}sk-ant-[A-Za-z0-9_-]{20,}`, 'g') },
  // Requires a digit so kebab-case words such as `sk-learn-pipeline-...` survive.
  { kind: 'openai', regex: new RegExp(`${START}sk-(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{20,}`, 'g') },
  { kind: 'github', regex: new RegExp(`${START}(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})`, 'g') },
  { kind: 'aws', regex: new RegExp(`${START}(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])`, 'g') },
  { kind: 'stripe', regex: new RegExp(`${START}(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}`, 'g') },
  { kind: 'jwt', regex: new RegExp(`${START}eyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}`, 'g') },
  // scheme://user:password@host -> keep scheme, user and host; replace the password.
  { kind: 'url-password', regex: /([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)([^\s@/]+)(@)/gi, keepAround: true }
];

const marker = (kind: string): string => `[secret removed:${kind}]`;

/** Write tools whose arguments are scanned before forwarding (#9). */
export const REDACTED_TOOLS: ReadonlySet<string> = new Set([
  'mem_save',
  'mem_update',
  'mem_session_summary',
  'mem_save_prompt',
  'mem_capture_passive'
]);

function addCounts(into: RedactionCounts, from: RedactionCounts): void {
  for (const [kind, n] of Object.entries(from)) into[kind] = (into[kind] ?? 0) + n;
}

export function redactSecrets(text: string): { text: string; counts: RedactionCounts } {
  const counts: RedactionCounts = {};
  let out = text;
  for (const { kind, regex, keepAround } of PATTERNS) {
    out = out.replace(regex, (...groups: string[]) => {
      counts[kind] = (counts[kind] ?? 0) + 1;
      return keepAround ? `${groups[1]}${marker(kind)}${groups[3]}` : marker(kind);
    });
  }
  return { text: out, counts };
}

/** Returns a copy of `value` with every string redacted; numbers, booleans and null are untouched. */
export function redactValue(value: unknown): { value: unknown; counts: RedactionCounts } {
  const counts: RedactionCounts = {};
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const r = redactSecrets(v);
      addCounts(counts, r.counts);
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, inner]) => [k, walk(inner)]));
    }
    return v;
  };
  return { value: walk(value), counts };
}

export interface RedactStageOptions {
  /** Default true. Turning it off is an admin decision (per brain once #4/#6 land). */
  enabled?: boolean;
  tools?: ReadonlySet<string>;
}

/** Pipeline stage: redacts write-tool arguments and records `meta.redactions` (counts only). */
export function createRedactStage(opts: RedactStageOptions = {}): RequestStage {
  const enabled = opts.enabled ?? true;
  const tools = opts.tools ?? REDACTED_TOOLS;
  return ctx => {
    if (!enabled || !tools.has(ctx.request.name) || ctx.request.arguments === undefined) return ctx;
    const { value, counts } = redactValue(ctx.request.arguments);
    if (Object.keys(counts).length === 0) return ctx;
    return {
      request: { ...ctx.request, arguments: value as Record<string, unknown> },
      meta: { ...ctx.meta, redactions: counts }
    };
  };
}
