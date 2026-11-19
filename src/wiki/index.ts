/**
 * Curated wiki (#16): per-brain `wiki.db` with pages, typed links, proposals
 * and review decisions, compiled by agents from the brain's journal.
 */
import type { WikiServiceDeps } from './application/ports.js';
import { WikiService } from './application/wiki-service.js';
import { openEngramJournal } from './infrastructure/engram-journal.js';
import { openSqliteWikiStore } from './infrastructure/sqlite-wiki-store.js';

export { LINK_TYPES, PAGE_KINDS, PAGE_SLUG, WIKI_LIMITS, WikiError } from './domain/wiki.js';
export type { LinkItem, LinkType, PageKind, ProposalItem, UpsertPageItem, WikiErrorCode } from './domain/wiki.js';
export { computeWarnings } from './domain/warnings.js';
export type { WarningCode, WarningView, WikiWarning } from './domain/warnings.js';
export { parseProposeInput } from './domain/proposal-input.js';
export { DECISION_ACTIONS, PROPOSALS_LIMITS, fingerprintMaterial, parseDecideInput, parseProposalsInput, parseReviewInput } from './domain/review.js';
export type { DecideInput, DecisionAction, ProposalsInput, ReviewInput, ReviewState } from './domain/review.js';
export type { DecisionRecord, JournalEntry, JournalReader, PageSummary, ProposalListing, StoredItem, StoredProposal, WikiServiceDeps, WikiStore } from './application/ports.js';
export { PACK_LIMITS, WIKI_TOOLS, WikiService } from './application/wiki-service.js';
export type { CompilePack, DecisionReceipt, ProposalReceipt, ProposalReview, WikiActor } from './application/wiki-service.js';
export { openEngramJournal } from './infrastructure/engram-journal.js';
export { WIKI_DB_FILE, openSqliteWikiStore } from './infrastructure/sqlite-wiki-store.js';

/** The service over each brain's `wiki.db` and read-only `engram.db`, opened per call. */
export function createSqliteWikiService(deps: Pick<WikiServiceDeps, 'dataDirOf' | 'isQuiesced'> & { nowMs?: () => number }): WikiService {
  return new WikiService({ ...deps, openWiki: openSqliteWikiStore, openJournal: openEngramJournal, nowMs: deps.nowMs ?? Date.now });
}
