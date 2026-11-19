/**
 * Git remote -> brain mapping (#12), used by `brain_resolve`. Pure (brain
 * names are checked with the brains module's own rule).
 *
 * A remote is compared by its key: `host/path`, lowercase, without scheme,
 * credentials, port, trailing slash or `.git`, so the https, ssh and
 * scp-like (`git@host:org/repo.git`) forms of one repository are the same.
 */

import { parseBrainSlug } from '../../brains/domain/brain.js';

/** One mapping entry: an exact remote key, or `host/org/*` for every repository under it. */
export interface RemoteRule {
  pattern: string;
  brain: string;
}

const WILDCARD = '/*';

/** The key of a git remote URL, or `undefined` when it is not a remote with a host and a path. */
export function normalizeRemote(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  let rest = raw.trim();
  if (!rest || /\s/.test(rest)) return undefined;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(rest);
  if (scheme) {
    if (!['http', 'https', 'ssh', 'git', 'git+ssh', 'ssh+git'].includes(scheme[1]!.toLowerCase())) return undefined;
    rest = rest.slice(scheme[0].length);
  } else if (/^[^/:]+:[^/]/.test(rest) && !/^[a-z]:[\\/]/i.test(rest)) {
    // scp-like: [user@]host:path
    rest = rest.replace(':', '/');
  }
  const slash = rest.indexOf('/');
  if (slash <= 0) return undefined;
  let host = rest.slice(0, slash);
  host = host.slice(host.lastIndexOf('@') + 1).replace(/:\d*$/, '').toLowerCase();
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host) || !host.includes('.') && host !== 'localhost') return undefined;
  const path = rest.slice(slash + 1).replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '').toLowerCase();
  const segments = path.split('/');
  if (!path || segments.some(segment => !segment || segment === '.' || segment === '..')) return undefined;
  return `${host}/${segments.join('/')}`;
}

/**
 * Parses `remote=brain[,remote=brain...]` (the `BRAIN_REMOTES` setting).
 * `remote` is any remote form, or `host/org/*` for every repository under
 * `host/org`. Throws on a bad entry, so a typo stops startup.
 */
export function parseRemoteMapping(raw: string | undefined): RemoteRule[] {
  const rules: RemoteRule[] = [];
  const seen = new Set<string>();
  for (const entry of (raw ?? '').split(',').map(part => part.trim()).filter(Boolean)) {
    const at = entry.lastIndexOf('=');
    const remote = at > 0 ? entry.slice(0, at).trim() : '';
    const brain = at > 0 ? entry.slice(at + 1).trim() : '';
    if (!remote || !brain) throw new Error(`"${entry}": use remote=brain, e.g. github.com/my-org/*=work`);
    const slug = parseBrainSlug(brain);
    if (!slug.ok) throw new Error(`"${entry}": ${JSON.stringify(brain)} is not a brain name (${slug.reason})`);
    const wide = remote.endsWith(WILDCARD);
    const base = wide ? remote.slice(0, -WILDCARD.length) : remote;
    if (base.includes('*')) throw new Error(`"${entry}": "*" is only allowed as the last path segment (host/org/*)`);
    // `host/*` is allowed too: normalize a path under the base, then drop it.
    const key = wide ? normalizeRemote(`${base}/_`)?.slice(0, -2) : normalizeRemote(base);
    if (!key) throw new Error(`"${entry}": ${JSON.stringify(remote)} is not a git remote (host/path)`);
    const pattern = wide ? `${key}${WILDCARD}` : key;
    if (seen.has(pattern)) throw new Error(`"${entry}": ${pattern} is mapped twice`);
    seen.add(pattern);
    rules.push({ pattern, brain });
  }
  return rules;
}

/** The brain mapped to remote key `remote`: an exact rule first, else the longest matching `/*` rule. */
export function matchRemote(rules: readonly RemoteRule[], remote: string): string | undefined {
  const exact = rules.find(rule => rule.pattern === remote);
  if (exact) return exact.brain;
  let best: RemoteRule | undefined;
  for (const rule of rules) {
    if (!rule.pattern.endsWith(WILDCARD)) continue;
    const prefix = rule.pattern.slice(0, -1); // keeps the trailing slash: whole segments only
    if (remote.startsWith(prefix) && remote.length > prefix.length && (!best || rule.pattern.length > best.pattern.length)) best = rule;
  }
  return best?.brain;
}
