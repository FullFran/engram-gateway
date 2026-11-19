import { escapeHtml } from '../../../../auth/index.js';
import type { patJson } from '../../../../connections/index.js';
import { PAT_LIFETIME_DAYS, PAT_SCOPES } from '../../../../connections/index.js';
import { alertBox, csrfField } from '../layout.js';

export type TokenRow = ReturnType<typeof patJson>;

/** What the "My tokens" page shows. */
export interface TokensView {
  csrf: string;
  tokens: TokenRow[];
  /** Brains the user holds a grant on, with that grant: a token can use only these. */
  brains: { brain: string; role: string }[];
  /** The token just created: its secret is shown this once. */
  created?: { name: string; token: string };
  error?: string;
  /** The submitted form, refilled after a refusal. */
  form?: { name: string; brains: string[]; scope: string; expires: string };
}

const day = (iso: string | null): string => (iso ? escapeHtml(iso.slice(0, 10)) : '-');

function tokenRow(row: TokenRow, csrf: string): string {
  const brains = row.brains.map(brain => `<code>${escapeHtml(brain)}</code>`).join(', ');
  const revoke = row.status === 'active'
    ? `<form class="inline" method="post" action="/ui/tokens/${row.id}/revoke">${csrfField(csrf)}` +
      `<button class="danger" type="submit" aria-label="Revoke token ${escapeHtml(row.name)}">Revoke</button></form>`
    : '';
  return `<tr><td>${escapeHtml(row.name)}</td><td>${brains}</td><td>${escapeHtml(row.scope)}</td><td>${escapeHtml(row.status)}</td>` +
    `<td>${day(row.createdAt)}</td><td>${day(row.expiresAt)}</td><td>${day(row.lastUsedAt)}</td><td>${revoke}</td></tr>`;
}

function createForm(view: TokensView): string {
  const form = view.form ?? { name: '', brains: [], scope: 'read', expires: '90' };
  if (view.brains.length === 0) return '<p>You hold no grant on any brain yet, so you cannot create a token. Ask an admin for access.</p>';
  const brains = view.brains.map(({ brain, role }) => {
    const checked = form.brains.includes(brain) ? ' checked' : '';
    return `<label><input type="checkbox" name="brains" value="${escapeHtml(brain)}"${checked}> <code>${escapeHtml(brain)}</code> (${escapeHtml(role)})</label>`;
  }).join('');
  const scopes = PAT_SCOPES.map(scope => `<option value="${scope}"${form.scope === scope ? ' selected' : ''}>${scope}</option>`).join('');
  const lifetimes = PAT_LIFETIME_DAYS.map(days => `<option value="${days}"${form.expires === String(days) ? ' selected' : ''}>${days} days</option>`).join('');
  return `<form method="post" action="/ui/tokens">${csrfField(view.csrf)}
    <label>Name <input type="text" name="name" value="${escapeHtml(form.name)}" maxlength="64" required></label>
    <fieldset><legend>Brains</legend>${brains}</fieldset>
    <label>Scope <select name="scope">${scopes}</select></label>
    <label>Expires in <select name="expires">${lifetimes}</select></label>
    <p><button class="primary" type="submit">Create token</button></p>
  </form>
  <p class="note">A token never exceeds your own grants: read+write only works on brains where you are a writer or owner.</p>`;
}

/** "My tokens": the user's personal access tokens (#7), a creation form, and the new secret once. */
export function tokensContent(view: TokensView): string {
  const created = view.created
    ? `<section aria-labelledby="new-token-title"><h2 id="new-token-title">Token ${escapeHtml(view.created.name)} created</h2>` +
      '<p>Copy it now: it is not shown again.</p>' +
      `<code class="secret" id="new-token">${escapeHtml(view.created.token)}</code></section>`
    : '';
  const rows = view.tokens.map(row => tokenRow(row, view.csrf)).join('');
  const list = view.tokens.length === 0
    ? '<p>You have no tokens.</p>'
    : '<table><caption class="note">Your personal access tokens</caption><thead><tr><th scope="col">Name</th><th scope="col">Brains</th><th scope="col">Scope</th><th scope="col">Status</th>' +
      `<th scope="col">Created</th><th scope="col">Expires</th><th scope="col">Last used</th><th scope="col"><span class="note">Actions</span></th></tr></thead><tbody>${rows}</tbody></table>`;
  return `<h1>My tokens</h1>${created}
    <section aria-labelledby="create-title"><h2 id="create-title">Create a token</h2>${view.error ? alertBox(view.error) : ''}${createForm(view)}</section>
    <section aria-labelledby="list-title"><h2 id="list-title">Tokens</h2>${list}</section>`;
}
