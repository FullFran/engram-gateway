/**
 * A snapshot is one point-in-time copy of a backup unit: a brain
 * (`brains/<slug>`, its `engram.db` and sibling databases) or the gateway
 * database (`gateway`). Its id is the UTC time it was taken, with
 * milliseconds, so ids sort chronologically as strings.
 */
export const SNAPSHOT_ID_PATTERN = /^\d{8}T\d{9}Z$/;

/** The unit holding the gateway's own database. */
export const GATEWAY_UNIT = 'gateway';

/** The unit holding one brain's databases. */
export function brainUnit(slug: string): string {
  return `brains/${slug}`;
}

/** `YYYYMMDDTHHMMSSmmmZ` for `ms` since the epoch. */
export function formatSnapshotId(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:.]/g, '');
}

export function isSnapshotId(value: string): boolean {
  return SNAPSHOT_ID_PATTERN.test(value);
}

/** The snapshots to delete so that only the newest `keep` remain. */
export function expiredSnapshots(ids: readonly string[], keep: number): string[] {
  const sorted = [...ids].sort();
  return sorted.slice(0, Math.max(0, sorted.length - keep));
}

/** Daily run time, UTC. */
export interface DailySchedule {
  hour: number;
  minute: number;
}

const DAY_MS = 86_400_000;

/**
 * The next run strictly after `nowMs`: the next `HH:MM` UTC, plus a random
 * delay in `[0, jitterMs)` so several installations do not all hit the disk
 * at the same second.
 */
export function nextRunAt(nowMs: number, schedule: DailySchedule, jitterMs: number, random: () => number = Math.random): number {
  const now = new Date(nowMs);
  let at = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), schedule.hour, schedule.minute);
  if (at <= nowMs) at += DAY_MS;
  return at + Math.floor(random() * jitterMs);
}
