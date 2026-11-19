import { relative, resolve, sep } from 'node:path';
import { parseBrainSlug } from '../domain/brain.js';

/** `<root>/<slug>`, refusing anything that would resolve outside `root`. */
export function brainDataDir(root: string, slug: string): string {
  const check = parseBrainSlug(slug);
  if (!check.ok) throw new Error(`invalid brain slug ${JSON.stringify(slug)}: ${check.reason}`);
  const base = resolve(root);
  const dir = resolve(base, slug);
  const rel = relative(base, dir);
  if (rel === '' || rel.startsWith('..') || rel.includes(sep)) throw new Error(`brain directory escapes the brains root: ${JSON.stringify(slug)}`);
  return dir;
}
