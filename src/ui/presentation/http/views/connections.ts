import { escapeHtml } from '../../../../auth/index.js';
import { ROLES } from '../../../../authz/index.js';
import type { OwnConnectionView } from '../../../../connections/index.js';
import { alertBox, csrfField } from '../layout.js';

export interface ConnectionsView {
  csrf: string;
  connections: OwnConnectionView[];
  error?: string;
}

function brainRows(connection: OwnConnectionView, csrf: string): string {
  return connection.brains.map(({ brain, role, effectiveRole }) => {
    const isDefault = connection.defaultBrain === brain ? 'yes' : '';
    const detach = `<form class="inline" method="post" action="/ui/connections/${connection.id}/detach">${csrfField(csrf)}` +
      `<input type="hidden" name="brain" value="${escapeHtml(brain)}">` +
      `<button class="danger" type="submit" aria-label="Detach ${escapeHtml(brain)} from ${escapeHtml(connection.name)}">Detach</button></form>`;
    return `<tr><td><code>${escapeHtml(brain)}</code></td><td>${escapeHtml(role)}</td><td>${escapeHtml(effectiveRole)}</td><td>${isDefault}</td><td>${detach}</td></tr>`;
  }).join('');
}

function attachForm(connection: OwnConnectionView, csrf: string): string {
  if (connection.attachable.length === 0) return '';
  const id = `c${connection.id}`;
  const brains = connection.attachable.map(({ brain, maxRole, attached }) =>
    `<option value="${escapeHtml(brain)}">${escapeHtml(brain)} (up to ${escapeHtml(maxRole)}${attached ? `, now ${escapeHtml(attached)}` : ''})</option>`).join('');
  const roles = ROLES.map(role => `<option value="${role}">${role}</option>`).join('');
  return `<form method="post" action="/ui/connections/${connection.id}/attach">${csrfField(csrf)}
    <label for="${id}-brain">Brain</label> <select id="${id}-brain" name="brain">${brains}</select>
    <label for="${id}-role">Role</label> <select id="${id}-role" name="role">${roles}</select>
    <label><input type="checkbox" name="default"> Make it the default brain</label>
    <button type="submit">Attach or change role</button>
  </form>`;
}

function connectionSection(connection: OwnConnectionView, csrf: string): string {
  const heading = `conn-${connection.id}`;
  const table = connection.brains.length === 0
    ? '<p>No brain is attached: this connection can use nothing.</p>'
    : '<table><thead><tr><th scope="col">Brain</th><th scope="col">Role</th><th scope="col">Effective role</th><th scope="col">Default</th>' +
      `<th scope="col"><span class="note">Actions</span></th></tr></thead><tbody>${brainRows(connection, csrf)}</tbody></table>`;
  const client = connection.clientId ? `<p class="note">OAuth client <code>${escapeHtml(connection.clientId)}</code></p>` : '';
  return `<section aria-labelledby="${heading}"><h2 id="${heading}">${escapeHtml(connection.name)}</h2>${client}${table}${attachForm(connection, csrf)}</section>`;
}

/** "My connections": the user's OAuth connections (#27), their brains and roles. */
export function connectionsContent(view: ConnectionsView): string {
  const intro = '<p class="note">Each MCP client you approve gets its own connection. It can use only the brains attached here, ' +
    'with the weaker of its role and your own grant. Personal access tokens are under My tokens.</p>';
  const body = view.connections.length === 0
    ? '<section><p>You have no connections. One is made when you approve an MCP client on the consent page.</p></section>'
    : view.connections.map(connection => connectionSection(connection, view.csrf)).join('');
  return `<h1>My connections</h1>${intro}${view.error ? alertBox(view.error) : ''}${body}`;
}
