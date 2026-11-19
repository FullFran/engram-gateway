import type { DuplicateTitlesFinding, SampledFinding, TypeCount } from '../domain/report.js';

/**
 * Read-only aggregate queries over one brain's Engram data. Every method
 * returns counts and at most `sampleSize` ids, lowest first.
 */
export interface BrainHealthSource {
  /** Live observations per type, count descending then type ascending (all types). */
  typeCounts(): TypeCount[];
  deletedCount(): number;
  observationsOfTypes(types: readonly string[], sampleSize: number): SampledFinding;
  duplicateTitles(sampleSize: number): DuplicateTitlesFinding;
  /** `null` when the source has no relations data. */
  pendingRelations(sampleSize: number): SampledFinding | null;
  /** `now` is a UTC timestamp `YYYY-MM-DD HH:MM:SS`, the format Engram stores. */
  pastReviewAfter(now: string, sampleSize: number): SampledFinding;
  close(): void;
}
