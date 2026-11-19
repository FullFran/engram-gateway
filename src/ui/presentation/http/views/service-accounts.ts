import { escapeHtml } from '../../../../auth/index.js';
import type { ServiceAccountView } from '../../../../admin/index.js';
import { alertBox, csrfField } from '../layout.js';

export interface ServiceAccountsView {
  csrf: string;
  accounts: ServiceAccountView[];
  error?: string;
  /** The login typed into the create form, kept after a refusal. */
  login?: string;
}

/** Service accounts (#7): non-human principals owned by an admin; they never sign in and use tokens. */
export function serviceAccountsContent(view: ServiceAccountsView): string {
  const rows = view.accounts.map(account => {
    const path = `/ui/service-accounts/${encodeURIComponent(account.login)}`;
    const owner = account.owner ? `<code>${escapeHtml(account.owner)}</code>` : 'none';
    return `<tr><th scope="row"><a href="${path}"><code>${escapeHtml(account.login)}</code></a></th><td>${escapeHtml(account.status)}</td><td>${owner}</td></tr>`;
  }).join('');
  const list = view.accounts.length === 0
    ? '<p>There are no service accounts.</p>'
    : '<table><thead><tr><th scope="col">Login</th><th scope="col">Status</th><th scope="col">Owner</th></tr></thead>' +
      `<tbody>${rows}</tbody></table>`;
  const create = '<section aria-labelledby="accounts-create"><h2 id="accounts-create">Create a service account</h2>' +
    `<form method="post" action="/ui/service-accounts">${csrfField(view.csrf)}` +
    `<label for="account-login">Login</label> <input type="text" id="account-login" name="login" required maxlength="39" value="${escapeHtml(view.login ?? '')}"> ` +
    '<button class="primary" type="submit">Create</button></form>' +
    '<p class="note">You become its owner. Give it grants on its user page, then create its tokens on its page. If its owner stops being an instance admin, it is disabled.</p></section>';
  return `<h1>Service accounts</h1>${view.error ? alertBox(view.error) : ''}` +
    `<section aria-labelledby="accounts-list"><h2 id="accounts-list">All service accounts</h2>${list}</section>${create}`;
}
