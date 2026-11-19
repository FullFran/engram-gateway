import { escapeHtml } from '../../../../auth/index.js';
import type { BrainHealthResult, BrainListing } from '../../../../admin/index.js';
import { DEFAULT_BRAIN } from '../../../../brains/index.js';
import type { SampledFinding } from '../../../../health/index.js';
import { alertBox, csrfField } from '../layout.js';

export interface BrainsView {
  csrf: string;
  brains: BrainListing[];
  error?: string;
  /** The slug typed into the create form, kept after a refusal. */
  slug?: string;
}

/** What the running gateway does with the brain right now. */
function runtimeState(brain: BrainListing): string {
  if (brain.status !== 'active') return 'not served';
  if (!brain.live) return 'stopped';
  return brain.idle ? 'live, idle' : 'live, serving';
}

function brainRow(brain: BrainListing, csrf: string): string {
  const slug = escapeHtml(brain.slug);
  const archive = brain.status === 'active' && brain.slug !== DEFAULT_BRAIN
    ? `<form class="inline" method="post" action="/ui/brains/${encodeURIComponent(brain.slug)}/archive">${csrfField(csrf)}` +
      `<button class="danger" type="submit" aria-label="Archive ${slug}">Archive</button></form>`
    : '';
  const health = `<a href="/ui/brains/${encodeURIComponent(brain.slug)}" aria-label="Health of ${slug}">Health</a>`;
  return `<tr><th scope="row"><code>${slug}</code></th><td>${escapeHtml(brain.status)}</td><td>${runtimeState(brain)}</td>` +
    `<td><code>${escapeHtml(brain.dataDir)}</code></td><td>${health} ${archive}</td></tr>`;
}

/** Brains (#10): every brain of the instance, its runtime status, create and archive. */
export function brainsContent(view: BrainsView): string {
  const table = '<section aria-labelledby="brains-list"><h2 id="brains-list">All brains</h2><table><thead><tr>' +
    '<th scope="col">Brain</th><th scope="col">Status</th><th scope="col">Runtime</th><th scope="col">Data directory</th>' +
    `<th scope="col"><span class="note">Actions</span></th></tr></thead><tbody>${view.brains.map(brain => brainRow(brain, view.csrf)).join('')}</tbody></table>` +
    '<p class="note">Archiving stops a brain\'s child and refuses new sessions; its grants and data stay. The default brain cannot be archived.</p></section>';
  const create = '<section aria-labelledby="brains-create"><h2 id="brains-create">Create a brain</h2>' +
    `<form method="post" action="/ui/brains">${csrfField(view.csrf)}` +
    `<label for="brain-slug">Slug</label> <input type="text" id="brain-slug" name="slug" required maxlength="64" value="${escapeHtml(view.slug ?? '')}"> ` +
    '<button class="primary" type="submit">Create</button></form>' +
    '<p class="note">Lowercase letters, digits and hyphens. Instance admins own a new brain; it is served on the next request.</p></section>';
  return `<h1>Brains</h1>${view.error ? alertBox(view.error) : ''}${table}${create}`;
}

function sampled(label: string, finding: SampledFinding): string {
  const ids = finding.sampleIds.length > 0 ? ` <span class="note">(for example ids ${finding.sampleIds.join(', ')})</span>` : '';
  return `<tr><th scope="row">${escapeHtml(label)}</th><td>${finding.count}</td><td>${ids}</td></tr>`;
}

const percent = (share: number) => `${Math.round(share * 1000) / 10}%`;

/** A brain's health report (#18), or why there is none yet. */
export function brainHealthContent(slug: string, result: BrainHealthResult): string {
  const title = `<h1>Health of <code>${escapeHtml(slug)}</code></h1><p><a href="/ui/brains">Back to brains</a></p>`;
  if (!result.ok) return `${title}<section><p>${escapeHtml(result.message)}</p></section>`;
  const r = result.report;
  const summary = '<section aria-labelledby="health-summary"><h2 id="health-summary">Observations</h2><table><tbody>' +
    `<tr><th scope="row">Live</th><td>${r.observations.live}</td></tr><tr><th scope="row">Deleted</th><td>${r.observations.deleted}</td></tr>` +
    `</tbody></table><p class="note">Report generated at ${escapeHtml(r.generatedAt)}.</p></section>`;
  const types = r.byType.top.map(row => `<tr><td>${escapeHtml(row.type)}</td><td>${row.count}</td></tr>`).join('');
  const other = r.byType.otherTypes > 0 ? `<p class="note">${r.byType.otherTypes} more types hold ${r.byType.otherCount} observations.</p>` : '';
  const byType = '<section aria-labelledby="health-types"><h2 id="health-types">By type</h2><table><thead><tr><th scope="col">Type</th><th scope="col">Live observations</th></tr></thead>' +
    `<tbody>${types}</tbody></table>${other}</section>`;
  const relations = r.pendingRelations === null
    ? '<tr><th scope="row">Pending relations</th><td colspan="2">not tracked by this Engram version</td></tr>'
    : sampled('Pending relations', r.pendingRelations);
  const findings = '<section aria-labelledby="health-findings"><h2 id="health-findings">Findings</h2><table><thead><tr><th scope="col">Finding</th><th scope="col">Count</th><th scope="col"><span class="note">Sample</span></th></tr></thead><tbody>' +
    `<tr><th scope="row">Noise (${escapeHtml(r.noise.types.join(', '))})</th><td>${r.noise.count}</td><td>${percent(r.noise.share)} of live observations</td></tr>` +
    `<tr><th scope="row">Duplicate titles</th><td>${r.duplicateTitles.excessRows}</td><td>${r.duplicateTitles.rows} observations share ${r.duplicateTitles.groups} titles</td></tr>` +
    `${relations}${sampled('Past their review date', r.pastReviewAfter)}` +
    `<tr><th scope="row">Wiki</th><td colspan="2">${escapeHtml(r.wiki.reason)}</td></tr>` +
    `<tr><th scope="row">Semantic index</th><td colspan="2">${escapeHtml(r.semanticIndex.reason)}</td></tr>` +
    '</tbody></table></section>';
  return `${title}${summary}${byType}${findings}`;
}
