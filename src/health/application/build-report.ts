import {
  clampLimit,
  DEFAULT_MAX_TYPES,
  DEFAULT_SAMPLE_SIZE,
  MAX_SAMPLE_SIZE,
  MAX_TYPES,
  NOISE_TYPES,
  share,
  type BrainHealthReport,
} from '../domain/report.js';
import type { BrainHealthSource } from './ports.js';

export interface HealthReportOptions {
  now: Date;
  /** Sample ids per finding; default 5, clamped to [0, 50]. */
  sampleSize?: number;
  /** Types listed in `byType.top`; default 50, clamped to [0, 200]. */
  maxTypes?: number;
}

/** `YYYY-MM-DD HH:MM:SS` in UTC, the timestamp format Engram stores. */
function engramTimestamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

export function buildHealthReport(source: BrainHealthSource, options: HealthReportOptions): BrainHealthReport {
  const sampleSize = clampLimit(options.sampleSize, DEFAULT_SAMPLE_SIZE, MAX_SAMPLE_SIZE);
  const maxTypes = clampLimit(options.maxTypes, DEFAULT_MAX_TYPES, MAX_TYPES);

  const types = source.typeCounts();
  const live = types.reduce((sum, row) => sum + row.count, 0);
  const top = types.slice(0, maxTypes);
  const rest = types.slice(maxTypes);
  const noise = source.observationsOfTypes(NOISE_TYPES, sampleSize);

  return {
    generatedAt: options.now.toISOString(),
    observations: { live, deleted: source.deletedCount() },
    byType: { top, otherTypes: rest.length, otherCount: rest.reduce((sum, row) => sum + row.count, 0) },
    noise: { types: [...NOISE_TYPES], count: noise.count, share: share(noise.count, live), sampleIds: noise.sampleIds },
    duplicateTitles: source.duplicateTitles(sampleSize),
    pendingRelations: source.pendingRelations(sampleSize),
    pastReviewAfter: source.pastReviewAfter(engramTimestamp(options.now), sampleSize),
    wiki: { status: 'unavailable', reason: 'requires the curated wiki (#16)' },
    semanticIndex: { status: 'unavailable', reason: 'requires the semantic index (#14)' },
  };
}
