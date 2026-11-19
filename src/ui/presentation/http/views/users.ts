import { escapeHtml } from '../../../../auth/index.js';
import type { GrantView, UserView } from '../../../../admin/index.js';
import { ROLES } from '../../../../authz/index.js';
import { alertBox, csrfField } from '../layout.js';

export interface UsersView {
  csrf: string;
  users: UserView[];
  error?: string;
  /** The login typed into the invite form, kept after a refusal. */
  login?: string;
}

export interface UserGrantsView {
  csrf: string;
  user: UserView;
  grants: GrantView[];
  /** Active brains a grant may be set on. */
  brains: string[];
  error?: string;
}

const userPath = (login: string) => `/ui/users/${encodeURIComponent(login)}`;
const KIND = { human: 'person', service: 'service account' } as const;

function statusForm(user: UserView, csrf: string): string {
  if (user.isAdmin) return '';
  const [action, label, style] = user.status === 'disabled' ? ['enable', 'Enable', ''] : ['disable', 'Disable', ' class="danger"'];
  return `<form class="inline" method="post" action="${userPath(user.login)}/${action}">${csrfField(csrf)}` +
    `<button${style} type="submit" aria-label="${label} ${escapeHtml(user.login)}">${label}</button></form>`;
}

/** Users (#10): every user, their status, invite, disable and enable. */
export function usersContent(view: UsersView): string {
  const rows = view.users.map(user =>
    `<tr><th scope="row"><a href="${userPath(user.login)}"><code>${escapeHtml(user.login)}</code></a></th><td>${escapeHtml(user.status)}</td>` +
    `<td>${KIND[user.kind]}</td><td>${user.isAdmin ? 'instance admin' : ''}</td><td>${statusForm(user, view.csrf)}</td></tr>`).join('');
  const table = '<section aria-labelledby="users-list"><h2 id="users-list">All users</h2><table><thead><tr>' +
    '<th scope="col">Login</th><th scope="col">Status</th><th scope="col">Kind</th><th scope="col">Role</th>' +
    `<th scope="col"><span class="note">Actions</span></th></tr></thead><tbody>${rows}</tbody></table>` +
    '<p class="note">A disabled user cannot sign in and their tokens stop working. Instance admins come from ALLOWED_GITHUB_LOGINS and are changed there. Open a user to manage their grants.</p></section>';
  const invite = '<section aria-labelledby="users-invite"><h2 id="users-invite">Invite a user</h2>' +
    `<form method="post" action="/ui/users">${csrfField(view.csrf)}` +
    `<label for="invite-login">GitHub login</label> <input type="text" id="invite-login" name="login" required maxlength="39" value="${escapeHtml(view.login ?? '')}"> ` +
    '<button class="primary" type="submit">Invite</button></form>' +
    '<p class="note">The user is active from their first sign-in. Give them a grant so they can use a brain.</p></section>';
  return `<h1>Users</h1>${view.error ? alertBox(view.error) : ''}${table}${invite}`;
}

function grantRow(view: UserGrantsView, grant: GrantView): string {
  const base = `${userPath(view.user.login)}/grants/${encodeURIComponent(grant.brain)}`;
  const revoke = grant.source === 'api'
    ? `<form class="inline" method="post" action="${base}/revoke">${csrfField(view.csrf)}` +
      `<button class="danger" type="submit" aria-label="Revoke the grant on ${escapeHtml(grant.brain)}">Revoke</button></form>`
    : '';
  return `<tr><th scope="row"><code>${escapeHtml(grant.brain)}</code></th><td>${escapeHtml(grant.role)}</td>` +
    `<td>${grant.source === 'api' ? 'panel or API' : 'configuration'}</td><td>${revoke}</td></tr>`;
}

/** One user's grants (#10): set or change a role on a brain, revoke one. */
export function userGrantsContent(view: UserGrantsView): string {
  const { user } = view;
  const heading = `<h1>User <code>${escapeHtml(user.login)}</code></h1><p><a href="/ui/users">Back to users</a></p>` +
    `<p>${escapeHtml(user.status)}, ${KIND[user.kind]}${user.isAdmin ? ', instance admin' : ''}.</p>`;
  const table = view.grants.length === 0
    ? '<p>No grants: this user can use no brain.</p>'
    : '<table><thead><tr><th scope="col">Brain</th><th scope="col">Role</th><th scope="col">Source</th>' +
      `<th scope="col"><span class="note">Actions</span></th></tr></thead><tbody>${view.grants.map(grant => grantRow(view, grant)).join('')}</tbody></table>`;
  const form = user.isAdmin
    ? '<p class="note">An instance admin owns every brain.</p>'
    : `<form method="post" action="${userPath(user.login)}/grants">${csrfField(view.csrf)}` +
      `<label for="grant-brain">Brain</label> <select id="grant-brain" name="brain">${view.brains.map(brain => `<option value="${escapeHtml(brain)}">${escapeHtml(brain)}</option>`).join('')}</select> ` +
      `<label for="grant-role">Role</label> <select id="grant-role" name="role">${ROLES.map(role => `<option value="${role}">${role}</option>`).join('')}</select> ` +
      '<button class="primary" type="submit">Set grant</button></form>' +
      '<p class="note">Setting a grant on a brain the user already has changes its role. Grants from BRAIN_GRANTS are changed there.</p>';
  const grants = `<section aria-labelledby="user-grants"><h2 id="user-grants">Grants</h2>${table}${form}</section>`;
  return `${heading}${view.error ? alertBox(view.error) : ''}${grants}`;
}
