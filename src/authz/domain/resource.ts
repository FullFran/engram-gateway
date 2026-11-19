/** The brain plain `/mcp` serves. */
const DEFAULT_BRAIN = 'default';

/**
 * The brain an OAuth resource (RFC 8707 audience) is for: `${base}` and
 * `${base}/default` are the default brain, `${base}/<slug>` brain `<slug>`.
 * Undefined for anything else.
 */
export function brainOfResource(resource: string, base: string): string | undefined {
  if (resource === base) return DEFAULT_BRAIN;
  if (!resource.startsWith(`${base}/`)) return undefined;
  const slug = resource.slice(base.length + 1);
  return slug && !slug.includes('/') ? slug : undefined;
}
