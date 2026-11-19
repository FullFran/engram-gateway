/**
 * Secret redaction of tool arguments (#9).
 *
 * One table of named patterns for well-known secret shapes. No entropy
 * heuristics: they flag git SHAs and UUIDs. A match is replaced by
 * `[secret removed:<kind>]`; only per-kind counts leave this module, never
 * the matched text.
 *
 * Every quantifier is bounded and every pattern can only start at a token
 * boundary, so the cost stays linear in the input length (no ReDoS: the stage
 * runs synchronously on the event loop).
 *
 * Limits: secrets that are encoded (base64, URL-encoding), split across
 * fields or lines, or in a shape not listed here are not detected.
 */
import type { RequestStage } from './tool-call-pipeline.js';

export type RedactionCounts = Record<string, number>;

interface SecretPattern {
  kind: string;
  /** Global regex. Without `split`, the whole match is the secret. */
  regex: RegExp;
  /**
   * Groups are (kept prefix)(secret)(optional kept suffix): only group 2 is
   * replaced, e.g. `scheme://user:` + marker + `@`.
   */
  split?: boolean;
  /** Extra check on the secret; a rejected match is left as is. */
  accept?: (secret: string) => boolean;
}

// A pattern starts only where no token character precedes it, so `task-...`
// never starts a match and the engine rejects mid-token positions in O(1).
const START = '(?<![A-Za-z0-9_-])';
const MARKER_PREFIX = '[secret removed:';
const marker = (kind: string): string => `${MARKER_PREFIX}${kind}]`;
// Assignment value: quoted string, or a run of non-space characters, unless an
// earlier pattern already replaced it (then it is counted by its specific kind).
const VALUE = `(?!["']?\\[secret removed:)("[^"\\n]{1,4096}"|'[^'\\n]{1,4096}'|[^\\s'"]\\S{0,4095})`;

/** Order matters: specific shapes first (sk-ant- before sk-, JWT before bearer, known tokens before assignments). */
const PATTERNS: readonly SecretPattern[] = [
  // An unterminated key is redacted up to the end of the string.
  {
    kind: 'private-key',
    regex: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----|$)/g
  },
  { kind: 'anthropic', regex: new RegExp(`${START}sk-ant-[A-Za-z0-9_-]{20,1024}`, 'g') },
  { kind: 'openai', regex: new RegExp(`${START}sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,1024}`, 'g') },
  // Legacy keys have no dashes after `sk-`, so kebab-case words such as `sk-learn-...` survive.
  { kind: 'openai', regex: new RegExp(`${START}sk-[A-Za-z0-9]{32,1024}`, 'g') },
  { kind: 'github', regex: new RegExp(`${START}(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})`, 'g') },
  { kind: 'aws', regex: new RegExp(`${START}(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])`, 'g') },
  { kind: 'stripe', regex: new RegExp(`${START}(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,255}`, 'g') },
  { kind: 'slack', regex: new RegExp(`${START}xox[bpars]-[A-Za-z0-9-]{10,255}`, 'g') },
  { kind: 'google', regex: new RegExp(`${START}AIza[A-Za-z0-9_-]{35}`, 'g') },
  { kind: 'npm', regex: new RegExp(`${START}npm_[A-Za-z0-9]{36}`, 'g') },
  // This gateway's own personal access tokens (#7): `egw_pat_` + 32 bytes in base64url.
  { kind: 'engram-gateway', regex: new RegExp(`${START}egw_pat_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])`, 'g') },
  { kind: 'jwt', regex: new RegExp(`${START}eyJ[A-Za-z0-9_-]{1,8192}\\.eyJ[A-Za-z0-9_-]{1,8192}\\.[A-Za-z0-9_-]{0,8192}`, 'g') },
  // AWS secret access key: exactly 40 base64 characters with upper, lower and
  // digits (git SHAs are lowercase hex and survive).
  {
    kind: 'aws-secret',
    regex: /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/g,
    accept: s => /[A-Z]/.test(s) && /[a-z]/.test(s) && /[0-9]/.test(s)
  },
  // `Bearer <token>`; the token needs a digit so prose like "Bearer authentication" survives.
  {
    kind: 'bearer',
    regex: /(?<![A-Za-z0-9_])(Bearer[ \t]{1,8})([A-Za-z0-9._~+/=-]{16,4096})/g,
    split: true,
    accept: s => /[0-9]/.test(s)
  },
  // scheme://user:password@host; the user may be empty and the password runs to the last `@` before the host.
  { kind: 'url-password', regex: /(?<![A-Za-z0-9+.-])([a-z][a-z0-9+.-]{0,31}:\/\/[^\s:@/]{0,256}:)([^\s/]{1,256})(@)/gi, split: true },
  // .env style: NAME_ENDING_IN_KEY/SECRET/TOKEN/PASSWORD = value (upper case only).
  {
    kind: 'credential',
    regex: new RegExp(`(?<![A-Za-z0-9_])((?:[A-Z][A-Z0-9_]{0,63})?(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD)[ \\t]{0,8}[=:][ \\t]{0,8})${VALUE}`, 'g'),
    split: true
  },
  // password=, api_key:, client_secret = ... in any case.
  {
    kind: 'credential',
    regex: new RegExp(
      `(?<![A-Za-z0-9_])((?:password|passwd|pwd|api[_-]?key|apikey|secret[_-]?key|private[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|refresh[_-]?token)[ \\t]{0,8}[=:][ \\t]{0,8})${VALUE}`,
      'gi'
    ),
    split: true
  }
];

// Invisible characters that can be slipped inside a secret to split it.
const INVISIBLE = /[­᠎​⁠-⁤﻿]/g;
const JOINERS = /[‌‍]/;
const isAsciiVisible = (c: string | undefined): boolean => c !== undefined && c >= '!' && c <= '~';

/**
 * Removes invisible characters. Zero-width (non-)joiners are removed only next
 * to ASCII, so emoji sequences and scripts that need them keep them. Linear.
 */
function stripInvisible(text: string): string {
  const stripped = text.replace(INVISIBLE, '');
  if (!JOINERS.test(stripped)) return stripped;
  const chars = [...stripped];
  const nextVisible: (string | undefined)[] = new Array(chars.length);
  let next: string | undefined;
  for (let i = chars.length - 1; i >= 0; i--) {
    nextVisible[i] = next;
    if (!JOINERS.test(chars[i]!)) next = chars[i];
  }
  let out = '';
  let prev: string | undefined;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (JOINERS.test(c)) {
      if (isAsciiVisible(prev) || isAsciiVisible(nextVisible[i])) continue;
    } else {
      prev = c;
    }
    out += c;
  }
  return out;
}

export function redactSecrets(text: string): { text: string; counts: RedactionCounts } {
  const counts: RedactionCounts = {};
  let out = stripInvisible(text);
  for (const { kind, regex, split, accept } of PATTERNS) {
    out = out.replace(regex, (match: string, ...groups: unknown[]) => {
      const secret = split ? String(groups[1]) : match;
      if (accept && !accept(secret)) return match;
      counts[kind] = (counts[kind] ?? 0) + 1;
      if (!split) return marker(kind);
      const suffix = typeof groups[2] === 'string' ? groups[2] : '';
      return `${String(groups[0])}${marker(kind)}${suffix}`;
    });
  }
  // Text without secrets is returned byte for byte, invisible characters included.
  return Object.keys(counts).length === 0 ? { text, counts } : { text: out, counts };
}

function addCounts(into: RedactionCounts, from: RedactionCounts): void {
  for (const [kind, n] of Object.entries(from)) into[kind] = (into[kind] ?? 0) + n;
}

/** Returns a copy of `value` with every string value and object key redacted; numbers, booleans and null are untouched. */
export function redactValue(value: unknown): { value: unknown; counts: RedactionCounts } {
  const counts: RedactionCounts = {};
  const redactString = (s: string): string => {
    const r = redactSecrets(s);
    addCounts(counts, r.counts);
    return r.text;
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return redactString(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, inner]) => [redactString(k), walk(inner)]));
    }
    return v;
  };
  return { value: walk(value), counts };
}

/**
 * Read-only tools whose arguments are never stored. Every other tool,
 * including tools Engram adds later, is redacted (default deny).
 */
export const REDACTION_EXEMPT_TOOLS: ReadonlySet<string> = new Set([
  'mem_context',
  'mem_current_project',
  'mem_doctor',
  'mem_get_observation',
  'mem_list_projects',
  'mem_search',
  'mem_search_prompts',
  'mem_stats',
  'mem_suggest_topic_key',
  'mem_timeline'
]);

export interface RedactStageOptions {
  /** Default true. Turning it off is an admin decision (per brain once #4/#6 land). */
  enabled?: boolean;
  exempt?: ReadonlySet<string>;
}

/** Pipeline stage: redacts the arguments of every non-exempt tool and records `meta.redactions` (counts only). */
export function createRedactStage(opts: RedactStageOptions = {}): RequestStage {
  const enabled = opts.enabled ?? true;
  const exempt = opts.exempt ?? REDACTION_EXEMPT_TOOLS;
  return ctx => {
    if (!enabled || exempt.has(ctx.request.name) || ctx.request.arguments === undefined) return ctx;
    const { value, counts } = redactValue(ctx.request.arguments);
    if (Object.keys(counts).length === 0) return ctx;
    return {
      ...ctx,
      request: { ...ctx.request, arguments: value as Record<string, unknown> },
      meta: { ...ctx.meta, redactions: counts }
    };
  };
}
