import { touchedSlugs, type ProposalItem } from './wiki.js';

export type WarningCode = 'duplicate_title' | 'broken_link' | 'stale_page' | 'open_conflict' | 'missing_citation';

/** Something a reviewer should look at; warnings never block a proposal or a decision. */
export interface WikiWarning {
  /** The proposal item it is about. */
  itemId: number;
  code: WarningCode;
  message: string;
}

/** What the warnings need to know about the wiki and the journal, read in one transaction. */
export interface WarningView {
  /** The page's current revision number and title; undefined when there is no such page. */
  page(slug: string): { revision: number; title: string } | undefined;
  /** Slugs of other pages with this title (case-insensitive). */
  pagesTitled(title: string): string[];
  hasLiveLink(from: string, to: string, type: string): boolean;
  /** Ids of other open or returned proposals with a pending item touching `slug`. */
  otherProposalsTouching(slug: string, proposalId: number): number[];
  /** Per cited sync_id: `live`, `deleted`, or undefined when engram has no such observation. */
  citation(syncId: string): 'live' | 'deleted' | undefined;
}

/** Warnings for the pending items of one proposal, in item order. */
export function computeWarnings(proposalId: number, items: ReadonlyArray<{ id: number; item: ProposalItem }>, view: WarningView): WikiWarning[] {
  const warnings: WikiWarning[] = [];
  const proposedPages = new Set(items.flatMap(({ item }) => (item.op === 'upsert_page' ? [item.slug] : [])));
  const titles = new Map<string, string>();
  for (const { id, item } of items) {
    const warn = (code: WarningCode, message: string) => warnings.push({ itemId: id, code, message });
    if (item.op === 'upsert_page') {
      const current = view.page(item.slug);
      const currentRevision = current?.revision ?? null;
      if (currentRevision !== item.baseRevision) {
        warn('stale_page', currentRevision === null
          ? `page ${item.slug} does not exist (the proposal was based on revision ${item.baseRevision})`
          : `page ${item.slug} is at revision ${currentRevision}; the proposal was based on ${item.baseRevision === null ? 'no revision (a new page)' : `revision ${item.baseRevision}`}`);
      }
      const key = item.title.trim().toLowerCase();
      const others = view.pagesTitled(item.title).filter(slug => slug !== item.slug);
      const inProposal = titles.get(key);
      if (inProposal !== undefined && inProposal !== item.slug) others.push(inProposal);
      if (others.length > 0) warn('duplicate_title', `another page has this title: ${[...new Set(others)].join(', ')}`);
      titles.set(key, item.slug);
    } else {
      for (const end of [item.from, item.to]) {
        if (!proposedPages.has(end) && view.page(end) === undefined) warn('broken_link', `page ${end} does not exist and is not proposed here`);
      }
      if (item.op === 'unlink' && !view.hasLiveLink(item.from, item.to, item.type)) warn('broken_link', `there is no ${item.type} link from ${item.from} to ${item.to}`);
      if (item.op === 'link' && item.type === 'contradicts') warn('open_conflict', `${item.from} contradicts ${item.to}: resolve or keep both deliberately`);
    }
    const contested = new Set(touchedSlugs(item).flatMap(slug => view.otherProposalsTouching(slug, proposalId)));
    if (contested.size > 0) warn('open_conflict', `other open proposals touch the same pages: ${[...contested].sort((a, b) => a - b).join(', ')}`);
    for (const syncId of item.citations) {
      const state = view.citation(syncId);
      if (state !== 'live') warn('missing_citation', `cited observation ${syncId} ${state === 'deleted' ? 'was deleted' : 'is not in this brain'}`);
    }
  }
  return warnings;
}

