/**
 * Brain health (#18): a read-only, size-bounded report computed from one
 * brain's `engram.db`. Wiki staleness (#16) and semantic index lag (#14) are
 * reported as unavailable until those sources exist.
 */
import { buildHealthReport, type HealthReportOptions } from './application/build-report.js';
import type { BrainHealthReport } from './domain/report.js';
import { openEngramHealthSource } from './infrastructure/engram-db-source.js';

export { DEFAULT_MAX_TYPES, DEFAULT_SAMPLE_SIZE, MAX_SAMPLE_SIZE, MAX_TYPES, NOISE_TYPES } from './domain/report.js';
export type { BrainHealthReport, DuplicateTitlesFinding, NoiseFinding, SampledFinding, TypeCount, UnavailableFinding } from './domain/report.js';
export type { BrainHealthSource } from './application/ports.js';
export { buildHealthReport } from './application/build-report.js';
export type { HealthReportOptions } from './application/build-report.js';
export { BrainHealthUnavailableError, openEngramHealthSource } from './infrastructure/engram-db-source.js';

/** Opens `<dataDir>/engram.db` read-only, builds the report and closes the database. */
export function readBrainHealth(options: HealthReportOptions & { dataDir: string }): BrainHealthReport {
  const source = openEngramHealthSource(options.dataDir);
  try {
    return buildHealthReport(source, options);
  } finally {
    source.close();
  }
}
