import { BrainHealthUnavailableError, type BrainHealthReport } from '../domain/report.js';
import { buildHealthReport } from './build-report.js';
import type { BrainHealthSource } from './ports.js';

/** Report size options as callers send them (tool arguments or a query string). */
export interface HealthSizeOptions {
  sampleSize?: number;
  maxTypes?: number;
}

export type ParsedHealthOptions = { ok: true; options: HealthSizeOptions } | { ok: false; error: string };

const OPTION_KEYS = ['sampleSize', 'maxTypes'] as const;

/**
 * Accepts `undefined` or an object with only `sampleSize` and `maxTypes`, each
 * a non-negative integer (a number or a string of digits, as in a query
 * string). Values above the caps are clamped later, not refused.
 */
export function parseHealthOptions(raw: unknown): ParsedHealthOptions {
  if (raw === undefined || raw === null) return { ok: true, options: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'expected an object' };
  const options: HealthSizeOptions = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!(OPTION_KEYS as readonly string[]).includes(key)) return { ok: false, error: `unknown option ${key}` };
    const number = typeof value === 'string' && /^\d{1,9}$/.test(value) ? Number(value) : value;
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0) return { ok: false, error: `${key} must be a non-negative integer` };
    options[key as (typeof OPTION_KEYS)[number]] = number;
  }
  return { ok: true, options };
}

export type BrainHealthLookup =
  | { ok: true; report: BrainHealthReport & { brain: string } }
  | { ok: false; reason: 'unknown_brain' | 'no_data' | 'invalid_arguments' | 'busy'; message: string };

/** The one entry point the `brain_health` tool and the admin endpoint share. */
export interface BrainHealthService {
  report(brain: string, rawOptions?: unknown): BrainHealthLookup;
}

export interface BrainHealthServiceDeps {
  /** The brain's Engram data directory; undefined for a brain the gateway does not serve. */
  dataDirOf(brain: string): string | undefined;
  /** Opens a brain's data read-only; throws `BrainHealthUnavailableError` when there is none. */
  open(dataDir: string): BrainHealthSource;
  nowMs(): number;
}

export function createBrainHealthService(deps: BrainHealthServiceDeps): BrainHealthService {
  return {
    report(brain, rawOptions) {
      const parsed = parseHealthOptions(rawOptions);
      if (!parsed.ok) return { ok: false, reason: 'invalid_arguments', message: `invalid arguments: ${parsed.error}` };
      const dataDir = deps.dataDirOf(brain);
      if (dataDir === undefined) return { ok: false, reason: 'unknown_brain', message: `unknown brain ${JSON.stringify(brain)}` };
      let source: BrainHealthSource;
      try {
        source = deps.open(dataDir);
      } catch (error) {
        if (error instanceof BrainHealthUnavailableError) return { ok: false, reason: 'no_data', message: `brain ${brain} has no engram.db yet (nothing saved)` };
        throw error;
      }
      try {
        return { ok: true, report: { brain, ...buildHealthReport(source, { ...parsed.options, now: new Date(deps.nowMs()) }) } };
      } catch (error) {
        if (isBusy(error)) return { ok: false, reason: 'busy', message: `brain ${brain} database is busy; retry shortly` };
        throw error;
      } finally {
        source.close();
      }
    }
  };
}

/** SQLITE_BUSY / SQLITE_LOCKED: another connection holds a lock longer than the busy timeout. */
function isBusy(error: unknown): boolean {
  const code = (error as { errcode?: unknown })?.errcode;
  return code === 5 || code === 6 || /database (table )?is locked/i.test((error as Error)?.message ?? '');
}
