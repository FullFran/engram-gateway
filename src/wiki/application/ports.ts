import type { ItemState, LinkItem, PageKind, ProposalItem, ProposalStatus, UpsertPageItem } from '../domain/wiki.js';

export interface StoredItem {
  id: number;
  item: ProposalItem;
  state: ItemState;
}

export interface StoredProposal {
  id: number;
  revision: number;
  status: ProposalStatus;
  proposer: string | null;
  summary: string;
  createdAtMs: number;
  updatedAtMs: number;
  /** In proposal order. */
  items: StoredItem[];
}

export interface ProposalListing {
  id: number;
  revision: number;
  status: ProposalStatus;
  proposer: string | null;
  summary: string;
  pendingItems: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface DecisionRecord {
  id: number;
  action: 'approve' | 'return' | 'reject' | 'undo';
  proposalRevision: number;
  itemIds: number[];
  decidedBy: string | null;
  comment: string | null;
  decidedAtMs: number;
  undoneBy: number | null;
}

export interface PageSummary {
  slug: string;
  kind: PageKind;
  title: string;
  revision: number;
}

/**
 * One open handle on a brain's `wiki.db`. Synchronous: a use case runs as one
 * transaction inside one event-loop turn, so it cannot interleave with a
 * restore swapping the brain's files.
 */
export interface WikiStore {
  /** Runs `work` in a write transaction taken up front (serialises gateways sharing the file). */
  transaction<T>(work: () => T): T;
  meta(key: string): string | undefined;
  setMeta(key: string, value: string): void;
  insertProposal(input: { summary: string; proposer: string | null; atMs: number; items: readonly ProposalItem[] }): number;
  /** Replaces the pending items and summary, bumps the revision and reopens the proposal. */
  reviseProposal(id: number, input: { summary: string; atMs: number; items: readonly ProposalItem[] }): void;
  proposal(id: number): StoredProposal | undefined;
  page(slug: string): PageSummary | undefined;
  /** Slugs of live pages with this title, case-insensitive. */
  pagesTitled(title: string): string[];
  hasLiveLink(from: string, to: string, type: string): boolean;
  /** Ids of other open or returned proposals with a pending item touching `slug`. */
  otherProposalsTouching(slug: string, proposalId: number): number[];
  /** Newest first, at most `limit`. */
  proposals(filter: { status?: ProposalStatus }, limit: number): ProposalListing[];
  /** The decisions on a proposal, oldest first. */
  decisions(proposalId: number): DecisionRecord[];
  insertDecision(decision: { proposalId: number; proposalRevision: number; action: DecisionRecord['action']; itemIds: readonly number[]; fingerprint: string | null; decidedBy: string | null; comment: string | null; atMs: number }): number;
  /** Appends a revision to the page (created when missing) and makes it current; returns its revision number. */
  appendRevision(item: UpsertPageItem, by: { decisionId: number; createdBy: string | null; atMs: number }): number;
  /** The id of a page with a current revision. */
  livePageId(slug: string): number | undefined;
  liveLinkId(item: LinkItem): number | undefined;
  insertLink(item: LinkItem, fromId: number, toId: number, decisionId: number): void;
  removeLink(linkId: number, decisionId: number): void;
  setItemsState(itemIds: readonly number[], state: ItemState, decisionId: number): void;
  setProposalStatus(id: number, status: ProposalStatus, atMs: number): void;
  /** Live pages by slug, at most `limit`, and how many there are. */
  pages(limit: number): { pages: PageSummary[]; total: number };
  close(): void;
}

export interface JournalEntry {
  id: number;
  syncId: string | null;
  type: string;
  title: string;
  content: string;
  /** The content was cut at the pack's `maxChars`. */
  truncated: boolean;
  project: string | null;
  topicKey: string | null;
  createdAt: string;
}

export interface JournalQuery {
  afterId: number;
  limit: number;
  maxChars: number;
  excludeTypes: readonly string[];
  project?: string;
}

/** Read-only access to a brain's journal (its `engram.db`). */
export interface JournalReader {
  /** Live observations after `afterId`, oldest first; `more` when the limit cut the list. */
  entries(query: JournalQuery): { entries: JournalEntry[]; more: boolean };
  /** For each sync_id engram has: its observation id and whether it is still live. */
  citations(syncIds: readonly string[]): Map<string, { id: number; live: boolean }>;
  close(): void;
}

export interface WikiServiceDeps {
  /** The brain's data directory; undefined for a brain the gateway does not serve. */
  dataDirOf(brain: string): string | undefined;
  /** Opens `<dataDir>/wiki.db`; with `create: false`, undefined when it does not exist yet. */
  openWiki(dataDir: string, opts: { create: boolean }): WikiStore | undefined;
  /** Opens `<dataDir>/engram.db` read-only; undefined when it does not exist yet. */
  openJournal(dataDir: string): JournalReader | undefined;
  /** True while the brain is quiesced for a restore: wiki calls are refused, never raced. */
  isQuiesced(brain: string): boolean;
  nowMs(): number;
}
