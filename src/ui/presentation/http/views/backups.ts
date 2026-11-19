import { escapeHtml } from '../../../../auth/index.js';
import type { BackupStatus } from '../../../../admin/index.js';
import type { BackupReport } from '../../../../backup/index.js';
import { alertBox, csrfField } from '../layout.js';

export interface BackupsView {
  csrf: string;
  /** Null when backups are not enabled. */
  status: BackupStatus | null;
  /** The run just made from this page. */
  report?: BackupReport;
  error?: string;
}

const two = (n: number) => String(n).padStart(2, '0');

function reportContent(report: BackupReport): string {
  const counts = `${report.taken.length} taken, ${report.skipped.length} skipped, ${report.failed.length} failed`;
  const summary = report.failed.length === 0
    ? `<p role="status">Backup finished: ${counts}.</p>`
    : alertBox(`Backup finished with failures: ${counts}.`);
  const items = [
    ...report.skipped.map(unit => `<li><code>${escapeHtml(unit.unit)}</code> skipped: ${escapeHtml(unit.reason)}</li>`),
    ...report.failed.map(unit => `<li><code>${escapeHtml(unit.unit)}</code> failed: ${escapeHtml(unit.error)}</li>`)
  ];
  return `<section aria-labelledby="backup-report"><h2 id="backup-report">This run</h2>${summary}${items.length > 0 ? `<ul>${items.join('')}</ul>` : ''}</section>`;
}

/** Backups (#9): schedule, retention, snapshots by unit, and a run now (admins, audited as `backup.run`). */
export function backupsContent(view: BackupsView): string {
  const error = view.error ? alertBox(view.error) : '';
  const { status } = view;
  if (!status) return `<h1>Backups</h1>${error}<section><p>Backups are not enabled on this gateway. Set BACKUP_DIR to enable them.</p></section>`;
  const schedule = status.schedule === 'off' ? 'off (only runs started by hand)' : `daily at ${two(status.schedule.hour)}:${two(status.schedule.minute)} UTC`;
  const settings = '<section aria-labelledby="backup-settings"><h2 id="backup-settings">Settings</h2><table><tbody>' +
    `<tr><th scope="row">Schedule</th><td>${schedule}</td></tr><tr><th scope="row">Snapshots kept per unit</th><td>${status.retention}</td></tr></tbody></table></section>`;
  const rows = status.units.map(unit =>
    `<tr><th scope="row"><code>${escapeHtml(unit.unit)}</code></th><td>${unit.count}</td><td><code>${escapeHtml(unit.latest)}</code></td></tr>`).join('');
  const units = '<section aria-labelledby="backup-units"><h2 id="backup-units">Snapshots</h2>' + (status.units.length === 0
    ? '<p>No snapshot yet.</p>'
    : `<table><thead><tr><th scope="col">Unit</th><th scope="col">Snapshots</th><th scope="col">Latest (UTC)</th></tr></thead><tbody>${rows}</tbody></table>`) +
    '<p class="note">Restoring a snapshot stays a CLI command (<code>backup restore</code>).</p></section>';
  const run = '<section aria-labelledby="backup-run"><h2 id="backup-run">Run now</h2>' +
    `<form method="post" action="/ui/backups/run">${csrfField(view.csrf)}<button class="primary" type="submit">Back up everything now</button></form>` +
    '<p class="note">Each brain is paused while its snapshot is taken. The page answers when the run is over; a scheduled run in progress finishes first.</p></section>';
  return `<h1>Backups</h1>${error}${view.report ? reportContent(view.report) : ''}${settings}${units}${run}`;
}
