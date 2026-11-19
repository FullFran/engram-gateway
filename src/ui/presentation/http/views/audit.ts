import { escapeHtml } from '../../../../auth/index.js';
import type { AuditRecord } from '../../../../audit/index.js';
import { alertBox } from '../layout.js';

/** The filter as typed (strings), kept in the form and in the paging links. */
export interface AuditFilterForm {
  brain: string;
  action: string;
  actor: string;
  outcome: string;
  from: string;
  to: string;
}

export interface AuditView {
  form: AuditFilterForm;
  rows: AuditRecord[];
  /** Link to the next (older) page, or none on the last. */
  olderHref: string | null;
  /** The CSV export (#10) of the same brain and dates; it has no other filter. */
  csvHref: string;
  error?: string;
}

const OUTCOMES = ['ok', 'error', 'denied'];

function textInput(id: string, name: keyof AuditFilterForm, label: string, value: string, type = 'text'): string {
  return `<label for="${id}">${label}</label> <input type="${type}" id="${id}" name="${name}" value="${escapeHtml(value)}"> `;
}

function row(record: AuditRecord): string {
  const actor = record.actorLogin ?? `${record.actorKind}:${record.actorId}`;
  const meta = Object.keys(record.meta).length > 0 ? `<code>${escapeHtml(JSON.stringify(record.meta))}</code>` : '';
  return `<tr><td>${escapeHtml(new Date(record.atMs).toISOString())}</td><td>${escapeHtml(actor)}</td><td><code>${escapeHtml(record.action)}</code></td>` +
    `<td>${escapeHtml(record.brain ?? '')}</td><td>${escapeHtml(record.target ?? '')}</td><td>${escapeHtml(record.outcome)}</td><td>${meta}</td></tr>`;
}

/** The audit log (#8): newest first, filtered, paged, with the CSV export. */
export function auditContent(view: AuditView): string {
  const { form } = view;
  const outcomes = ['', ...OUTCOMES].map(value =>
    `<option value="${value}"${form.outcome === value ? ' selected' : ''}>${value === '' ? 'any' : value}</option>`).join('');
  const filter = '<section aria-labelledby="audit-filter"><h2 id="audit-filter">Filter</h2><form method="get" action="/ui/audit">' +
    textInput('f-brain', 'brain', 'Brain', form.brain) + textInput('f-action', 'action', 'Action', form.action) +
    textInput('f-actor', 'actor', 'Actor login', form.actor) +
    `<label for="f-outcome">Outcome</label> <select id="f-outcome" name="outcome">${outcomes}</select> ` +
    textInput('f-from', 'from', 'From (UTC)', form.from, 'date') + textInput('f-to', 'to', 'To (UTC, inclusive)', form.to, 'date') +
    '<button class="primary" type="submit">Filter</button></form>' +
    `<p class="note"><a href="${escapeHtml(view.csvHref)}">Download CSV</a> of the same brain and dates (the export filters by nothing else; it is audited).</p></section>`;
  const table = view.rows.length === 0
    ? '<p>No entries match.</p>'
    : '<table><thead><tr><th scope="col">When (UTC)</th><th scope="col">Actor</th><th scope="col">Action</th><th scope="col">Brain</th>' +
      `<th scope="col">Target</th><th scope="col">Outcome</th><th scope="col">Details</th></tr></thead><tbody>${view.rows.map(row).join('')}</tbody></table>`;
  const older = view.olderHref ? `<p><a href="${escapeHtml(view.olderHref)}">Older entries</a></p>` : '';
  return `<h1>Audit log</h1>${view.error ? alertBox(view.error) : ''}${filter}` +
    `<section aria-labelledby="audit-entries"><h2 id="audit-entries">Entries, newest first</h2>${table}${older}</section>`;
}
