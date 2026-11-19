/**
 * The curated wiki of a brain (#16): pages and typed links compiled by agents
 * from the brain's journal (engram observations), proposed, then approved by a
 * brain owner. Pure: no I/O.
 */

export const PAGE_KINDS = ['concept', 'decision', 'component', 'procedure'] as const;
export type PageKind = (typeof PAGE_KINDS)[number];

export const LINK_TYPES = ['depends_on', 'part_of', 'supersedes', 'contradicts'] as const;
export type LinkType = (typeof LINK_TYPES)[number];

/** Size bounds of a proposal; larger input is refused, never truncated. */
export const WIKI_LIMITS = Object.freeze({
  maxItems: 50,
  maxSlugChars: 80,
  maxTitleChars: 200,
  maxBodyChars: 20_000,
  maxSummaryChars: 2_000,
  maxCitations: 50,
  maxCitationChars: 200,
  maxCommentChars: 2_000
});

/** A page id: lowercase letters, digits and inner dashes. */
export const PAGE_SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** Creates a page or replaces its content with a new revision. */
export interface UpsertPageItem {
  op: 'upsert_page';
  slug: string;
  kind: PageKind;
  title: string;
  body: string;
  /** Engram observation `sync_id`s this content comes from. */
  citations: string[];
  /** The page revision the proposal was written against; null for a page the agent believes is new. */
  baseRevision: number | null;
}

/** Adds (`link`) or removes (`unlink`) a typed link between two pages. */
export interface LinkItem {
  op: 'link' | 'unlink';
  from: string;
  to: string;
  type: LinkType;
  citations: string[];
}

export type ProposalItem = UpsertPageItem | LinkItem;

/** The pages an item touches (created, revised, or linked). */
export function touchedSlugs(item: ProposalItem): string[] {
  return item.op === 'upsert_page' ? [item.slug] : [item.from, item.to];
}

export type ProposalStatus = 'open' | 'returned' | 'rejected' | 'closed';
export type ItemState = 'pending' | 'applied' | 'rejected';

export type WikiErrorCode = 'invalid' | 'not_found' | 'forbidden' | 'conflict' | 'stale' | 'unavailable';

/**
 * A refusal a caller can act on. Its message may name slugs or titles: it is
 * returned to the caller as a (wrapped) tool error and never logged.
 */
export class WikiError extends Error {
  constructor(readonly code: WikiErrorCode, message: string) {
    super(message);
    this.name = 'WikiError';
  }
}
