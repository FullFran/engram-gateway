import type { ItemState, PageKind, ProposalItem, ProposalStatus } from '../domain/wiki.js';

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
