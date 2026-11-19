/**
 * Query dataset: dedupe, deterministic split, and sampling.
 *
 * Dedupe happens before the split, so a query and its near-copy (same text
 * after case and whitespace normalization) can never land in both splits.
 * The split is a keyed hash of the normalized query: stable for a fixed seed
 * and unchanged for existing queries when new transcripts add queries.
 */
import { createHash } from 'node:crypto';

export const DEFAULT_SEED = 'engram-gateway-eval-v1';
export const DEFAULT_HOLDOUT_FRACTION = 0.3;

/** Lower case, trimmed, inner whitespace collapsed. */
export function normalizeQuery(query) {
  return String(query ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Uniform number in [0, 1) from a seed and a key. */
export function seededUnit(seed, key) {
  const digest = createHash('sha256').update(`${seed}\u0000${key}`).digest();
  return digest.readUInt32BE(0) / 2 ** 32;
}

/** Opaque, stable query id: does not reveal the query text. */
export function queryId(seed, normalized) {
  return `q_${createHash('sha256').update(`${seed}\u0000id\u0000${normalized}`).digest('hex').slice(0, 12)}`;
}

/**
 * Search arguments replayed against an engine: the scope the agent searched
 * (project resolved by the engine at the time, else the explicit argument;
 * `all_projects` and `type` kept). Ranking knobs (`limit`, `match_mode`,
 * `response_format`) are set by the runner, not by the dataset.
 */
export function replayScope(record) {
  const args = record.args ?? {};
  const scope = {};
  if (args.all_projects === true) {
    scope.all_projects = true;
  } else {
    const project = record.originalProject || (typeof args.project === 'string' ? args.project : '');
    if (project) scope.project = project;
  }
  if (typeof args.type === 'string' && args.type) scope.type = args.type;
  if (typeof args.scope === 'string' && args.scope) scope.scope = args.scope;
  return scope;
}

/**
 * Deduplicates search records into dataset queries.
 * The first occurrence (by timestamp) fixes the text and scope; implicit
 * labels are the union over occurrences; flags count occurrences.
 */
export function buildQueries(records, { seed = DEFAULT_SEED, holdoutFraction = DEFAULT_HOLDOUT_FRACTION } = {}) {
  const sorted = [...records].sort((a, b) => String(a.timestamp ?? '').localeCompare(String(b.timestamp ?? '')));
  const byKey = new Map();
  for (const record of sorted) {
    const key = normalizeQuery(record.query);
    if (!key || record.error) continue;
    let q = byKey.get(key);
    if (!q) {
      q = {
        id: queryId(seed, key),
        query: record.query.trim(),
        scope: replayScope(record),
        split: seededUnit(seed, key) < holdoutFraction ? 'holdout' : 'dev',
        occurrences: 0,
        statuses: {},
        originalZeroResult: 0,
        implicit: new Set(),
        sessions: new Set(),
        firstSeen: record.timestamp,
      };
      byKey.set(key, q);
    }
    q.occurrences++;
    q.statuses[record.status] = (q.statuses[record.status] ?? 0) + 1;
    if (record.zeroResult) q.originalZeroResult++;
    for (const id of record.relevant ?? []) q.implicit.add(id);
    if (record.sessionId) q.sessions.add(record.sessionId);
  }
  return [...byKey.values()]
    .map(q => ({ ...q, implicit: [...q.implicit].sort((a, b) => a - b), sessions: q.sessions.size }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Deterministic sample of `n` items, ordered by keyed hash of `key(item)`. */
export function seededSample(items, n, { seed = DEFAULT_SEED, key = item => item.id } = {}) {
  return [...items]
    .map(item => ({ item, u: seededUnit(`${seed}\u0000sample`, key(item)) }))
    .sort((a, b) => a.u - b.u)
    .slice(0, n)
    .map(x => x.item);
}
