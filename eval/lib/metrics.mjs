/**
 * Retrieval metrics over ranked id lists.
 *
 * recall@k: |relevant ∩ top k| / |relevant|, averaged over labeled queries.
 * MRR: mean of 1 / rank of the first relevant id (0 when none in the list).
 * zero-result rate: share of all queries whose ranked list is empty.
 */

export function recallAt(ranked, relevant, k) {
  if (relevant.length === 0) return undefined;
  const top = new Set(ranked.slice(0, k));
  return relevant.filter(id => top.has(id)).length / relevant.length;
}

export function reciprocalRank(ranked, relevant) {
  if (relevant.length === 0) return undefined;
  const wanted = new Set(relevant);
  const index = ranked.findIndex(id => wanted.has(id));
  return index === -1 ? 0 : 1 / (index + 1);
}

const mean = values => (values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length);

/**
 * Aggregate metrics for one label source.
 * `rows`: `[{ ranked: number[], relevant: number[] | undefined }]`; rows with
 * `relevant` undefined or empty count for the zero-result rate only.
 */
export function aggregate(rows) {
  const labeled = rows.filter(r => Array.isArray(r.relevant) && r.relevant.length > 0);
  return {
    queries: rows.length,
    labeled: labeled.length,
    recallAt5: mean(labeled.map(r => recallAt(r.ranked, r.relevant, 5))),
    recallAt10: mean(labeled.map(r => recallAt(r.ranked, r.relevant, 10))),
    mrr: mean(labeled.map(r => reciprocalRank(r.ranked, r.relevant))),
    zeroResultRate: rows.length === 0 ? null : rows.filter(r => r.ranked.length === 0).length / rows.length,
  };
}
