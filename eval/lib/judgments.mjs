/**
 * Judged labels: verdict files from the judge merged with the pool.
 *
 * Verdict format, one line per pooled query (blank lines and `#` comments
 * are ignored):
 *
 *   q_0123456789ab: 812 77      relevant candidate ids
 *   q_ba9876543210: -           no relevant candidate
 */

export function parseVerdicts(text) {
  const verdicts = new Map();
  text.split('\n').forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const match = /^(q_[0-9a-f]+):\s*(.*)$/.exec(line);
    if (!match) throw new Error(`verdict line ${index + 1} is not "<query id>: <ids> | -"`);
    const rest = match[2].trim();
    const ids = rest === '-' || rest === '' ? [] : rest.split(/\s+/).map(Number);
    if (ids.some(id => !Number.isInteger(id) || id <= 0)) throw new Error(`verdict line ${index + 1} has a non-numeric id`);
    if (verdicts.has(match[1])) throw new Error(`verdict line ${index + 1} repeats ${match[1]}`);
    verdicts.set(match[1], ids);
  });
  return verdicts;
}

/**
 * `judgments.json` document: for every pooled query, the relevant ids and
 * every judged candidate (the rest are judged not relevant).
 */
export function mergeJudgments(pool, verdicts, { rubric } = {}) {
  const queries = {};
  for (const q of pool.queries) {
    if (!verdicts.has(q.id)) throw new Error(`missing verdict for ${q.id}`);
    const candidates = new Set(q.candidates);
    const relevant = [...new Set(verdicts.get(q.id))].sort((a, b) => a - b);
    const stray = relevant.filter(id => !candidates.has(id));
    if (stray.length > 0) throw new Error(`${q.id}: #${stray.join(', #')} is not a candidate of the pool`);
    queries[q.id] = { relevant, judged: [...q.candidates].sort((a, b) => a - b) };
  }
  const unknown = [...verdicts.keys()].filter(id => !(id in queries));
  if (unknown.length > 0) throw new Error(`verdicts for queries outside the pool: ${unknown.join(', ')}`);
  return { version: 1, rubric, queries };
}
