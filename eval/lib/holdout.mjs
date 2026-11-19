/**
 * Holdout ledger: the holdout split runs once per engine label. A rerun needs
 * an explicit force and is recorded as forced, so tuning on the holdout is
 * visible. Returns a new ledger; the input is not mutated.
 */
export function claimHoldout(ledger, label, { split, at, force = false }) {
  const previous = ledger.runs.filter(r => r.label === label);
  if (previous.length > 0 && !force) {
    throw new Error(`holdout already run for "${label}" at ${previous[0].at}; pass --force-holdout to rerun (it is recorded)`);
  }
  return { ...ledger, runs: [...ledger.runs, { label, split, at, forced: previous.length > 0 }] };
}
