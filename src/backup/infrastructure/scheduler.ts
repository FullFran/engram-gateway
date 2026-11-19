import type { Logger } from '../../shared/logger.js';
import { nextRunAt } from '../domain/snapshot.js';
import type { DailySchedule } from '../domain/snapshot.js';

export interface BackupSchedule {
  stop(): void;
}

/**
 * Runs `run` once a day at `schedule` (UTC) plus jitter, in this process (one
 * gateway replica). Timers never keep the process alive; a failing run is
 * logged and the next one is still scheduled.
 */
export function startBackupSchedule(run: () => Promise<unknown>, schedule: DailySchedule, jitterMs: number, logger: Logger): BackupSchedule {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const arm = () => {
    if (stopped) return;
    const at = nextRunAt(Date.now(), schedule, jitterMs);
    logger.info('Next backup scheduled', { at: new Date(at).toISOString() });
    timer = setTimeout(() => {
      void run()
        .catch(error => logger.error('Scheduled backup failed', { error: (error as Error).message }))
        .finally(arm);
    }, Math.max(0, at - Date.now()));
    timer.unref();
  };
  arm();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    }
  };
}
