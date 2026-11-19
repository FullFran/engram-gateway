/**
 * Brain health report: counts and sample ids computed from a brain's
 * `engram.db`. It never carries titles or contents, and every list in it is
 * capped, so its size does not grow with the brain.
 */

/** Observation types Engram writes automatically; their share of live rows is the "noise" finding. */
export const NOISE_TYPES: readonly string[] = Object.freeze(['checkpoint', 'passive', 'task-state']);

export const DEFAULT_SAMPLE_SIZE = 5;
export const MAX_SAMPLE_SIZE = 50;
export const DEFAULT_MAX_TYPES = 50;
export const MAX_TYPES = 200;

export interface TypeCount {
  type: string;
  count: number;
}

export interface ByTypeFinding {
  /** Most frequent types of live observations, count descending then name ascending. */
  top: TypeCount[];
  /** Types beyond the cap, and how many live observations they hold together. */
  otherTypes: number;
  otherCount: number;
}

/** A finding: how many rows match and the lowest ids among them (at most the sample size). */
export interface SampledFinding {
  count: number;
  sampleIds: number[];
}

export interface NoiseFinding extends SampledFinding {
  types: string[];
  /** `count / live observations`, rounded to 4 decimals; 0 for an empty brain. */
  share: number;
}

export interface DuplicateTitlesFinding {
  /** Distinct titles shared by two or more live observations. */
  groups: number;
  /** Live observations in those groups. */
  rows: number;
  /** `rows - groups`: rows a dedupe would remove if it kept one per title. */
  excessRows: number;
  sampleIds: number[];
}

/** A finding whose data source does not exist yet in this gateway. */
export interface UnavailableFinding {
  status: 'unavailable';
  reason: string;
}

export interface BrainHealthReport {
  generatedAt: string;
  observations: { live: number; deleted: number };
  byType: ByTypeFinding;
  noise: NoiseFinding;
  duplicateTitles: DuplicateTitlesFinding;
  /** Unjudged, not superseded relations; `null` when the brain's Engram has no relations table. */
  pendingRelations: SampledFinding | null;
  /** Live observations whose `review_after` is before `generatedAt`. */
  pastReviewAfter: SampledFinding;
  /** Extension point: stale and orphan wiki pages, once the curated wiki (#16) exists. */
  wiki: UnavailableFinding;
  /** Extension point: semantic index lag, once the vector index (#14) exists. */
  semanticIndex: UnavailableFinding;
}

/** `part / whole` rounded to 4 decimals; 0 when `whole` is 0. */
export function share(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 10_000) / 10_000;
}

/** An integer in `[0, max]`; `fallback` when the value is missing or not a finite number. */
export function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(0, Math.trunc(value)));
}

/** The brain has no readable `engram.db` (never written to, or the wrong directory). */
export class BrainHealthUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrainHealthUnavailableError';
  }
}
