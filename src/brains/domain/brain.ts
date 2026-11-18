/**
 * A brain is one Engram data directory: one `engram.db`, served by its own
 * `engram mcp` child. Isolation between brains comes from the file, never
 * from Engram's `project` parameter.
 */
export interface Brain {
  /** URL-safe name: the brain is served at `/mcp/<slug>`. */
  slug: string;
  /** Absolute path of the brain's Engram data directory (`ENGRAM_DATA_DIR`). */
  dataDir: string;
  /** Whether the gateway's `ENGRAM_CLOUD_*` settings reach this brain's child. */
  cloudSync: boolean;
}

/** The brain `/mcp` serves, so single-brain deployments keep working. */
export const DEFAULT_BRAIN = 'default';

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Names that would read as gateway endpoints or roles rather than brains. */
const RESERVED_SLUGS: ReadonlySet<string> = new Set(['admin', 'api', 'health', 'mcp', 'oauth', 'well-known', 'static', 'login', 'logout']);

export type SlugCheck = { ok: true; slug: string } | { ok: false; reason: string };

/** Lowercase letters, digits and dashes, 1-40 characters, not starting with a dash, not reserved. */
export function parseBrainSlug(raw: string): SlugCheck {
  if (!SLUG_PATTERN.test(raw)) return { ok: false, reason: 'use 1-40 lowercase letters, digits or dashes, not starting with a dash' };
  if (RESERVED_SLUGS.has(raw)) return { ok: false, reason: 'the name is reserved' };
  return { ok: true, slug: raw };
}
