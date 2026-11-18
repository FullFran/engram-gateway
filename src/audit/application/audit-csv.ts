import type { AuditRecord } from './ports.js';

const HEADER = ['id', 'at', 'actor_kind', 'actor_id', 'actor_login', 'brain', 'action', 'target', 'outcome', 'duration_ms', 'meta'];
/** Cells a spreadsheet would read as a formula (CSV injection). */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * One CSV cell: a leading `= + - @` (or tab/CR) gets a `'` prefix so a
 * spreadsheet shows it as text, then RFC 4180 quoting when needed.
 */
export function csvCell(value: string | number | null): string {
  if (value === null) return '';
  let text = String(value);
  if (typeof value === 'string' && FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function line(cells: (string | number | null)[]): string {
  return `${cells.map(csvCell).join(',')}\r\n`;
}

/** Lines of the CSV export, header first, each ending in CRLF; pulls records one at a time. */
export function* auditCsvLines(records: Iterable<AuditRecord>): Generator<string> {
  yield line(HEADER);
  for (const record of records) {
    yield line([
      record.id, new Date(record.atMs).toISOString(), record.actorKind, record.actorId, record.actorLogin,
      record.brain, record.action, record.target, record.outcome, record.durationMs, JSON.stringify(record.meta)
    ]);
  }
}
