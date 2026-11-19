import type { Response } from 'express';
import { escapeHtml } from '../../../auth/index.js';

/** A page of the panel in the navigation. */
export interface NavItem {
  path: string;
  label: string;
}

/** Pages every signed-in user has: their own connections and tokens. */
export const ACCOUNT_NAV: readonly NavItem[] = [
  { path: '/ui/connections', label: 'My connections' },
  { path: '/ui/tokens', label: 'My tokens' }
];

/** Pages for instance admins only; the services refuse anyone else anyway. */
export const ADMIN_NAV: readonly NavItem[] = [
  { path: '/ui/brains', label: 'Brains' }
];

/** What every page shows around its content. */
export interface PageFrame {
  title: string;
  login: string;
  isAdmin: boolean;
  /** Path of the current page, marked in the navigation. */
  current: string;
}

const STYLE = `
  :root { color-scheme: light dark; --bg: #f7f7f8; --fg: #1d1d1f; --card: #fff; --muted: #55595e; --accent: #4f4bc4; --border: #c9c9cf; --danger: #b3261e; }
  @media (prefers-color-scheme: dark) { :root { --bg: #121214; --fg: #ececf1; --card: #1e1e22; --muted: #b4b4bd; --accent: #b3b0ff; --border: #44444b; --danger: #ff8a80; } }
  body { margin: 0; font: 16px/1.5 system-ui, sans-serif; background: var(--bg); color: var(--fg); }
  header { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 24px; padding: 12px 24px; border-bottom: 1px solid var(--border); background: var(--card); }
  header .who { margin-left: auto; display: flex; align-items: center; gap: 12px; }
  nav ul { display: flex; flex-wrap: wrap; gap: 4px 16px; list-style: none; margin: 0; padding: 0; }
  nav h2 { font-size: .75rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 0; }
  nav a[aria-current=page] { font-weight: 600; }
  main { max-width: 64rem; margin: 24px auto; padding: 0 16px; }
  section { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 20px 24px; margin-bottom: 24px; }
  h1 { font-size: 1.4rem; margin: 0 0 16px; } h2 { font-size: 1.1rem; margin: 0 0 12px; }
  a { color: var(--accent); }
  table { width: 100%; border-collapse: collapse; } th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
  fieldset { border: 1px solid var(--border); border-radius: 8px; margin: 12px 0; padding: 8px 12px; }
  label { display: inline-block; margin: 4px 16px 4px 0; }
  input[type=text], select { font: inherit; padding: 4px 6px; border-radius: 6px; border: 1px solid var(--border); background: transparent; color: var(--fg); }
  button { font: inherit; padding: 6px 14px; border-radius: 8px; border: 1px solid var(--border); background: transparent; color: var(--fg); cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: var(--bg); }
  button.danger { color: var(--danger); border-color: var(--danger); }
  .note { color: var(--muted); font-size: .9rem; }
  .alert { border-left: 4px solid var(--danger); padding: 8px 12px; border-radius: 4px; }
  .secret { display: block; font: 600 1rem/1.4 ui-monospace, monospace; padding: 12px; border: 1px dashed var(--border); border-radius: 8px; overflow-wrap: anywhere; }
  form.inline { display: inline; }
`;

const CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

function navList(heading: string, items: readonly NavItem[], current: string): string {
  if (items.length === 0) return '';
  const links = items.map(item => {
    const here = item.path === current ? ' aria-current="page"' : '';
    return `<li><a href="${escapeHtml(item.path)}"${here}>${escapeHtml(item.label)}</a></li>`;
  }).join('');
  return `<h2>${escapeHtml(heading)}</h2><ul>${links}</ul>`;
}

/** The whole document: header with the navigation and sign-out, then `content`. */
export function renderPage(frame: PageFrame, content: string): string {
  const nav = navList('My account', ACCOUNT_NAV, frame.current) + (frame.isAdmin ? navList('Administration', ADMIN_NAV, frame.current) : '');
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${escapeHtml(frame.title)} · Engram gateway</title><style>${STYLE}</style></head><body>` +
    `<header><nav aria-label="Main">${nav}</nav>` +
    `<div class="who"><span>Signed in as <strong>${escapeHtml(frame.login)}</strong></span>` +
    '<form method="post" action="/oauth/logout"><button type="submit">Sign out</button></form></div></header>' +
    `<main>${content}</main></body></html>`;
}

/** A page with no session behind it (sign in again, or a refused form). */
export function renderBarePage(title: string, message: string, link?: { href: string; label: string }): string {
  const more = link ? `<p><a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a></p>` : '';
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${escapeHtml(title)} · Engram gateway</title><style>${STYLE}</style></head><body><main><section>` +
    `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${more}</section></main></body></html>`;
}

/** Security headers of every panel response. */
export function securityHeaders(res: Response): void {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Frame-Options', 'DENY');
  // Not no-referrer: the same-origin check falls back to Referer when a browser sends no Origin.
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

/** The hidden CSRF field every form of the panel carries. */
export function csrfField(token: string): string {
  return `<input type="hidden" name="csrf" value="${escapeHtml(token)}">`;
}

/** An error message from a service, announced to screen readers. */
export function alertBox(message: string): string {
  return `<p class="alert" role="alert">${escapeHtml(message)}</p>`;
}
