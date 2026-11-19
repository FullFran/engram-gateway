import { createHash } from 'node:crypto';
import { atLeast, type Role } from '../../authz/domain/role.js';
import { requiredRole } from '../../authz/domain/tool-roles.js';
import { NOISE_TYPES } from '../../health/domain/report.js';
import { parseProposeInput } from '../domain/proposal-input.js';
import { READ_LIMITS, parseNeighborsInput, parsePageInput, parsePagesInput, parseUndoInput } from '../domain/read.js';
import { fingerprintMaterial, parseDecideInput, parseProposalsInput, parseReviewInput, type DecisionAction } from '../domain/review.js';
import { computeWarnings, type WikiWarning } from '../domain/warnings.js';
import { WikiError, touchedSlugs, type ProposalItem, type ProposalStatus } from '../domain/wiki.js';
import type { DecisionRecord, NeighborLink, PageRevision, RevisionEntry, JournalEntry, JournalReader, PageSummary, ProposalListing, StoredItem, StoredProposal, WikiServiceDeps, WikiStore } from './ports.js';

/** The tools (and use cases) of the wiki; their roles live in GATEWAY_TOOL_ROLES (src/authz). */
export const WIKI_TOOLS = Object.freeze({
  compilePack: 'brain_compile_pack',
  propose: 'brain_propose',
  proposals: 'brain_proposals',
  review: 'brain_review',
  decide: 'brain_decide',
  page: 'brain_page',
  pages: 'brain_pages',
  neighbors: 'brain_neighbors',
  undo: 'brain_undo'
});

/**
 * Who runs a use case. `role` is the caller's effective role on the brain,
 * decided by the same grants for every entry point (the MCP pipeline's
 * authorize stage, or the review UI, #17). Undefined only when authentication
 * is off (loopback), where the pipeline allows every call.
 */
export interface WikiActor {
  login?: string;
  role?: Role;
}

export const PACK_LIMITS = Object.freeze({ defaultLimit: 50, maxLimit: 200, defaultMaxChars: 2_000, minMaxChars: 100, maxMaxChars: 8_000, maxPages: 200 });

/** Where `brain_compile_pack` resumes by default: past the highest observation any proposal cited. */
const PACK_CURSOR = 'pack_cursor';

export interface CompilePack {
  brain: string;
  afterId: number;
  entries: JournalEntry[];
  more: boolean;
  /** Pass as `afterId` to continue. */
  nextAfterId: number;
  skippedTypes: string[];
  /** Existing pages, so proposals can link to them (at most PACK_LIMITS.maxPages). */
  pages: PageSummary[];
  totalPages: number;
}

export interface ProposalReceipt {
  proposalId: number;
  revision: number;
  items: Array<{ id: number; op: ProposalItem['op']; slugs: string[] }>;
  warnings: WikiWarning[];
}

export interface ProposalReview {
  proposalId: number;
  revision: number;
  status: ProposalStatus;
  proposer: string | null;
  summary: string;
  /** Pending items, each with the current revision (null: no page) of the pages it touches. */
  items: Array<{ id: number; item: ProposalItem; current: Array<{ slug: string; revision: number | null }> }>;
  warnings: WikiWarning[];
  /** The item ids the fingerprint covers. */
  selected: number[];
  /** Pass to brain_decide to approve exactly this selection, as it is now. */
  fingerprint: string;
  decisions: DecisionRecord[];
}

export interface DecisionReceipt {
  decisionId: number;
  proposalId: number;
  action: DecisionAction;
  status: ProposalStatus;
  applied: number[];
  pending: number[];
}

export interface PageRead extends PageRevision {
  /** The page's current revision number. */
  current: number;
  /** Newest first, at most READ_LIMITS.maxHistory. */
  history: RevisionEntry[];
  historyTotal: number;
}

export interface UndoReceipt {
  decisionId: number;
  undone: number;
  pagesRemoved: string[];
  pagesRestored: string[];
  linksRemoved: number;
  linksRestored: number;
}

/**
 * The wiki use cases. Every entry point (MCP gateway tools, the review UI)
 * calls these, so authorization is checked here once, against the same role
 * table the pipeline uses. Messages never reach the logs.
 */
export class WikiService {
  constructor(private readonly deps: WikiServiceDeps) {}

  compilePack(actor: WikiActor, brain: string, args: unknown): CompilePack {
    authorize(actor, WIKI_TOOLS.compilePack);
    const query = parsePackArgs(args);
    const dataDir = this.dataDir(brain);
    const wiki = this.deps.openWiki(dataDir, { create: false });
    try {
      const afterId = query.afterId ?? Number(wiki?.meta(PACK_CURSOR) ?? 0);
      const journal = this.journal(dataDir, brain);
      let found: { entries: JournalEntry[]; more: boolean };
      try {
        found = journal.entries({ afterId, limit: query.limit, maxChars: query.maxChars, excludeTypes: NOISE_TYPES, ...(query.project !== undefined ? { project: query.project } : {}) });
      } finally {
        journal.close();
      }
      const listed = wiki?.pages(PACK_LIMITS.maxPages) ?? { pages: [], total: 0 };
      return {
        brain,
        afterId,
        entries: found.entries,
        more: found.more,
        nextAfterId: found.entries.at(-1)?.id ?? afterId,
        skippedTypes: [...NOISE_TYPES],
        pages: listed.pages,
        totalPages: listed.total
      };
    } finally {
      wiki?.close();
    }
  }

  /** Opens a proposal, or revises one (its proposer or an owner) when `proposalId` is given. */
  propose(actor: WikiActor, brain: string, args: unknown): ProposalReceipt {
    authorize(actor, WIKI_TOOLS.propose);
    const input = parseProposeInput(args);
    const dataDir = this.dataDir(brain);
    const cited = this.citations(dataDir, input.items);
    const wiki = this.deps.openWiki(dataDir, { create: true })!;
    try {
      return wiki.transaction(() => {
        const atMs = this.deps.nowMs();
        let id: number;
        if (input.proposalId === undefined) {
          id = wiki.insertProposal({ summary: input.summary, proposer: actor.login ?? null, atMs, items: input.items });
        } else {
          id = input.proposalId;
          const existing = wiki.proposal(id);
          if (!existing) throw new WikiError('not_found', `no proposal ${id}`);
          if (existing.status !== 'open' && existing.status !== 'returned') throw new WikiError('conflict', `proposal ${id} is ${existing.status}; open a new one`);
          if (!mayRevise(actor, existing)) throw new WikiError('forbidden', `only the proposer of proposal ${id} or a brain owner can revise it`);
          wiki.reviseProposal(id, { summary: input.summary, atMs, items: input.items });
        }
        const highest = Math.max(0, ...[...cited.values()].map(c => c.id));
        if (highest > Number(wiki.meta(PACK_CURSOR) ?? 0)) wiki.setMeta(PACK_CURSOR, String(highest));
        const stored = wiki.proposal(id)!;
        const pending = stored.items.filter(entry => entry.state === 'pending');
        return {
          proposalId: id,
          revision: stored.revision,
          items: pending.map(({ id: itemId, item }) => ({ id: itemId, op: item.op, slugs: touchedSlugs(item) })),
          warnings: warningsFor(wiki, stored, cited)
        };
      });
    } finally {
      wiki.close();
    }
  }

  proposals(actor: WikiActor, brain: string, args: unknown): { proposals: ProposalListing[] } {
    authorize(actor, WIKI_TOOLS.proposals);
    const input = parseProposalsInput(args);
    const wiki = this.deps.openWiki(this.dataDir(brain), { create: false });
    try {
      return { proposals: wiki?.proposals(input.status !== undefined ? { status: input.status } : {}, input.limit) ?? [] };
    } finally {
      wiki?.close();
    }
  }

  /** A proposal as a reviewer reads it, with the fingerprint that binds an approval to this reading. */
  review(actor: WikiActor, brain: string, args: unknown): ProposalReview {
    authorize(actor, WIKI_TOOLS.review);
    const input = parseReviewInput(args);
    const dataDir = this.dataDir(brain);
    const wiki = this.deps.openWiki(dataDir, { create: false });
    if (!wiki) throw new WikiError('not_found', `no proposal ${input.proposalId}`);
    try {
      return wiki.transaction(() => {
        const proposal = findProposal(wiki, input.proposalId);
        const pending = proposal.items.filter(entry => entry.state === 'pending');
        const selected = selectItems(proposal, input.itemIds);
        const cited = this.citations(dataDir, pending.map(entry => entry.item));
        return {
          proposalId: proposal.id,
          revision: proposal.revision,
          status: proposal.status,
          proposer: proposal.proposer,
          summary: proposal.summary,
          items: pending.map(({ id, item }) => ({ id, item, current: touchedSlugs(item).map(slug => ({ slug, revision: wiki.page(slug)?.revision ?? null })) })),
          warnings: warningsFor(wiki, proposal, cited),
          selected: selected.map(entry => entry.id),
          fingerprint: fingerprint(wiki, proposal, selected),
          decisions: wiki.decisions(proposal.id)
        };
      });
    } finally {
      wiki.close();
    }
  }

  /**
   * An owner's decision. `approve` applies the selected items (default: every
   * pending one) in proposal order, in one transaction, only when the
   * fingerprint still matches what was reviewed; any item that cannot be
   * applied rolls the whole decision back. Unselected items stay pending.
   * `return` sends the proposal back to its proposer; `reject` closes it.
   */
  decide(actor: WikiActor, brain: string, args: unknown): DecisionReceipt {
    authorize(actor, WIKI_TOOLS.decide);
    const input = parseDecideInput(args);
    const wiki = this.deps.openWiki(this.dataDir(brain), { create: false });
    if (!wiki) throw new WikiError('not_found', `no proposal ${input.proposalId}`);
    try {
      return wiki.transaction(() => {
        const proposal = findProposal(wiki, input.proposalId);
        if (proposal.status !== 'open') throw new WikiError('conflict', `proposal ${proposal.id} is ${proposal.status}${proposal.status === 'returned' ? '; its proposer revises it first' : ''}`);
        const atMs = this.deps.nowMs();
        const pendingIds = proposal.items.filter(entry => entry.state === 'pending').map(entry => entry.id);
        const record = (action: DecisionAction, itemIds: number[], print: string | null) => wiki.insertDecision({
          proposalId: proposal.id, proposalRevision: proposal.revision, action, itemIds, fingerprint: print, decidedBy: actor.login ?? null, comment: input.comment ?? null, atMs
        });
        if (input.action === 'return') {
          const decisionId = record('return', [], null);
          wiki.setProposalStatus(proposal.id, 'returned', atMs);
          return { decisionId, proposalId: proposal.id, action: input.action, status: 'returned', applied: [], pending: pendingIds };
        }
        if (input.action === 'reject') {
          const decisionId = record('reject', pendingIds, null);
          wiki.setItemsState(pendingIds, 'rejected', decisionId);
          wiki.setProposalStatus(proposal.id, 'rejected', atMs);
          return { decisionId, proposalId: proposal.id, action: input.action, status: 'rejected', applied: [], pending: [] };
        }
        const selected = selectItems(proposal, input.itemIds);
        if (fingerprint(wiki, proposal, selected) !== input.fingerprint) {
          throw new WikiError('stale', `proposal ${proposal.id} or the pages it touches changed since it was reviewed; review it again`);
        }
        const applied = selected.map(entry => entry.id);
        const decisionId = record('approve', applied, input.fingerprint!);
        for (const entry of selected) applyItem(wiki, entry, { decisionId, createdBy: proposal.proposer, atMs });
        wiki.setItemsState(applied, 'applied', decisionId);
        const pending = pendingIds.filter(id => !applied.includes(id));
        const status: ProposalStatus = pending.length === 0 ? 'closed' : 'open';
        wiki.setProposalStatus(proposal.id, status, atMs);
        return { decisionId, proposalId: proposal.id, action: input.action, status, applied, pending };
      });
    } finally {
      wiki.close();
    }
  }

  /** One approved page: a revision (default current) with its history. */
  page(actor: WikiActor, brain: string, args: unknown): PageRead {
    authorize(actor, WIKI_TOOLS.page);
    const input = parsePageInput(args);
    return this.read(brain, wiki => {
      const current = wiki?.page(input.slug);
      if (!wiki || !current) throw new WikiError('not_found', `no page ${input.slug}`);
      const revision = wiki.pageRevision(input.slug, input.revision);
      if (!revision) throw new WikiError('not_found', `no revision ${input.revision} of page ${input.slug}`);
      const { history, total } = wiki.pageHistory(input.slug, READ_LIMITS.maxHistory);
      return { ...revision, current: current.revision, history, historyTotal: total };
    });
  }

  /** Approved pages by slug, optionally filtered by text (slug or title) and kind; bounded. */
  pages(actor: WikiActor, brain: string, args: unknown): { pages: PageSummary[]; total: number } {
    authorize(actor, WIKI_TOOLS.pages);
    const input = parsePagesInput(args);
    return this.read(brain, wiki => wiki?.pages(input.limit, {
      ...(input.query !== undefined ? { query: input.query } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {})
    }) ?? { pages: [], total: 0 });
  }

  /** The live links of a page, one hop, both directions; bounded. */
  neighbors(actor: WikiActor, brain: string, args: unknown): { slug: string; links: NeighborLink[]; more: boolean } {
    authorize(actor, WIKI_TOOLS.neighbors);
    const input = parseNeighborsInput(args);
    return this.read(brain, wiki => {
      if (!wiki?.page(input.slug)) throw new WikiError('not_found', `no page ${input.slug}`);
      return { slug: input.slug, ...wiki.neighbors(input.slug, input.types, input.limit) };
    });
  }

  /**
   * Reverts one approval, all or nothing, as a new decision: each page it
   * wrote goes back to its previous revision (copied as a new revision) or out
   * of the wiki if the approval created it; links it added are removed and
   * links it removed come back. Refused when anything it touched changed
   * after it (undo the later decision first), or when a removed page would
   * leave links behind. Revisions and decisions stay as history.
   */
  undo(actor: WikiActor, brain: string, args: unknown): UndoReceipt {
    authorize(actor, WIKI_TOOLS.undo);
    const input = parseUndoInput(args);
    const wiki = this.deps.openWiki(this.dataDir(brain), { create: false });
    if (!wiki) throw new WikiError('not_found', `no decision ${input.decisionId}`);
    try {
      return wiki.transaction(() => {
        const decision = wiki.decision(input.decisionId);
        if (!decision) throw new WikiError('not_found', `no decision ${input.decisionId}`);
        if (decision.action !== 'approve') throw new WikiError('conflict', `decision ${decision.id} is a ${decision.action}; only an approval can be undone`);
        if (decision.undoneBy !== null) throw new WikiError('conflict', `decision ${decision.id} was already undone by decision ${decision.undoneBy}`);
        const effects = wiki.decisionEffects(decision.id);
        for (const revision of effects.revisions) {
          if (revision.currentRevisionId !== revision.revisionId) throw new WikiError('conflict', `page ${revision.slug} changed after decision ${decision.id}; undo the later decision first`);
        }
        for (const added of effects.linksAdded) {
          if (added.removedBy !== null) throw new WikiError('conflict', `link ${added.from} ${added.type} ${added.to} was removed after decision ${decision.id}; undo the later decision first`);
        }
        const atMs = this.deps.nowMs();
        const undoId = wiki.insertDecision({
          proposalId: decision.proposalId, proposalRevision: decision.proposalRevision, action: 'undo', itemIds: decision.itemIds,
          fingerprint: null, decidedBy: actor.login ?? null, comment: null, atMs, undoes: decision.id
        });
        wiki.markUndone(decision.id, undoId);
        for (const added of effects.linksAdded) wiki.removeLink(added.id, undoId);
        const by = { decisionId: undoId, createdBy: actor.login ?? null, atMs };
        const pagesRemoved: string[] = [];
        const pagesRestored: string[] = [];
        for (const revision of effects.revisions) {
          if (revision.previousRevisionId === null) {
            if (wiki.liveLinksTouching(revision.pageId, decision.id).length > 0) {
              throw new WikiError('conflict', `page ${revision.slug} still has links from later decisions; undo or unlink them first`);
            }
            wiki.clearCurrentRevision(revision.pageId);
            pagesRemoved.push(revision.slug);
          } else {
            wiki.copyRevision(revision.pageId, revision.previousRevisionId, by);
            pagesRestored.push(revision.slug);
          }
        }
        for (const removed of effects.linksRemoved) {
          const item = { op: 'link' as const, from: removed.from, to: removed.to, type: removed.type, citations: [] };
          if (wiki.livePageId(removed.from) === undefined || wiki.livePageId(removed.to) === undefined) {
            throw new WikiError('conflict', `link ${removed.from} ${removed.type} ${removed.to} cannot come back: one of its pages is no longer in the wiki`);
          }
          if (wiki.liveLinkId(item) !== undefined) throw new WikiError('conflict', `link ${removed.from} ${removed.type} ${removed.to} exists again since decision ${decision.id}`);
          wiki.restoreLink(removed.id, undoId);
        }
        return { decisionId: undoId, undone: decision.id, pagesRemoved, pagesRestored, linksRemoved: effects.linksAdded.length, linksRestored: effects.linksRemoved.length };
      });
    } finally {
      wiki.close();
    }
  }

  /** Runs a read on the brain's wiki (undefined when it has none yet, and no file is made). */
  private read<T>(brain: string, work: (wiki: WikiStore | undefined) => T): T {
    const wiki = this.deps.openWiki(this.dataDir(brain), { create: false });
    try {
      return work(wiki);
    } finally {
      wiki?.close();
    }
  }

  private dataDir(brain: string): string {
    const dataDir = this.deps.dataDirOf(brain);
    if (dataDir === undefined) throw new WikiError('not_found', `unknown brain ${JSON.stringify(brain)}`);
    if (this.deps.isQuiesced(brain)) throw new WikiError('unavailable', `brain ${brain} is being restored; retry shortly`);
    return dataDir;
  }

  private journal(dataDir: string, brain: string): JournalReader {
    const journal = this.deps.openJournal(dataDir);
    if (!journal) throw new WikiError('unavailable', `brain ${brain} has no engram.db yet (nothing saved)`);
    return journal;
  }

  /** Cited sync_ids as engram knows them; an empty map when the brain has no journal yet. */
  private citations(dataDir: string, items: readonly ProposalItem[]): Map<string, { id: number; live: boolean }> {
    const journal = this.deps.openJournal(dataDir);
    if (!journal) return new Map();
    try {
      return journal.citations([...new Set(items.flatMap(item => item.citations))]);
    } finally {
      journal.close();
    }
  }
}

/** The use case's own check, so a caller other than the pipeline (the review UI) cannot skip it. */
function authorize(actor: WikiActor, tool: string): void {
  if (actor.role === undefined) return;
  const need = requiredRole(tool);
  if (need === undefined || !atLeast(actor.role, need)) throw new WikiError('forbidden', `${tool} needs the ${need ?? 'unknown'} role on this brain`);
}

function findProposal(wiki: WikiStore, id: number): StoredProposal {
  const proposal = wiki.proposal(id);
  if (!proposal) throw new WikiError('not_found', `no proposal ${id}`);
  return proposal;
}

/** The selected pending items in proposal order; every pending item when `itemIds` is undefined. */
function selectItems(proposal: StoredProposal, itemIds: readonly number[] | undefined): StoredItem[] {
  const pending = proposal.items.filter(entry => entry.state === 'pending');
  if (itemIds === undefined) return pending;
  const byId = new Map(pending.map(entry => [entry.id, entry]));
  for (const id of itemIds) if (!byId.has(id)) throw new WikiError('invalid', `invalid arguments: item ${id} is not a pending item of proposal ${proposal.id}`);
  return pending.filter(entry => itemIds.includes(entry.id));
}

function fingerprint(wiki: WikiStore, proposal: StoredProposal, selected: readonly StoredItem[]): string {
  const material = fingerprintMaterial(proposal.id, proposal.revision, selected, {
    page: slug => wiki.page(slug)?.revision ?? null,
    hasLiveLink: (from, to, type) => wiki.hasLiveLink(from, to, type)
  });
  return createHash('sha256').update(material).digest('hex');
}

/** Applies one approved item; throws (rolling the decision back) when it cannot apply as a whole. */
function applyItem(wiki: WikiStore, { id, item }: StoredItem, by: { decisionId: number; createdBy: string | null; atMs: number }): void {
  if (item.op === 'upsert_page') {
    wiki.appendRevision(item, by);
    return;
  }
  const fromId = wiki.livePageId(item.from);
  const toId = wiki.livePageId(item.to);
  for (const [slug, pageId] of [[item.from, fromId], [item.to, toId]] as const) {
    if (pageId === undefined) throw new WikiError('conflict', `item ${id}: page ${slug} does not exist (approve it in the same decision); nothing was applied`);
  }
  const existing = wiki.liveLinkId(item);
  if (item.op === 'link') {
    if (existing !== undefined) throw new WikiError('conflict', `item ${id}: ${item.from} already has a ${item.type} link to ${item.to}; nothing was applied`);
    wiki.insertLink(item, fromId!, toId!, by.decisionId);
  } else {
    if (existing === undefined) throw new WikiError('conflict', `item ${id}: there is no ${item.type} link from ${item.from} to ${item.to}; nothing was applied`);
    wiki.removeLink(existing, by.decisionId);
  }
}

function mayRevise(actor: WikiActor, proposal: StoredProposal): boolean {
  if (actor.role === undefined || actor.role === 'owner') return true;
  return actor.login !== undefined && actor.login === proposal.proposer;
}

function warningsFor(wiki: WikiStore, proposal: StoredProposal, cited: Map<string, { id: number; live: boolean }>): WikiWarning[] {
  const pending = proposal.items.filter(entry => entry.state === 'pending');
  return computeWarnings(proposal.id, pending, {
    page: slug => wiki.page(slug),
    pagesTitled: title => wiki.pagesTitled(title),
    hasLiveLink: (from, to, type) => wiki.hasLiveLink(from, to, type),
    otherProposalsTouching: (slug, id) => wiki.otherProposalsTouching(slug, id),
    citation: syncId => {
      const found = cited.get(syncId);
      return found === undefined ? undefined : found.live ? 'live' : 'deleted';
    }
  });
}

interface PackArgs {
  afterId?: number;
  limit: number;
  maxChars: number;
  project?: string;
}

function parsePackArgs(args: unknown): PackArgs {
  const raw = args ?? {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new WikiError('invalid', 'invalid arguments: expected an object');
  const out: PackArgs = { limit: PACK_LIMITS.defaultLimit, maxChars: PACK_LIMITS.defaultMaxChars };
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'project') {
      if (typeof value !== 'string' || value === '') throw new WikiError('invalid', 'invalid arguments: project must be a non-empty string');
      out.project = value;
      continue;
    }
    if (key !== 'afterId' && key !== 'limit' && key !== 'maxChars') throw new WikiError('invalid', `invalid arguments: unknown field ${key}`);
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new WikiError('invalid', `invalid arguments: ${key} must be a non-negative integer`);
    if (key === 'afterId') out.afterId = value;
    if (key === 'limit') out.limit = clamp(value, 1, PACK_LIMITS.maxLimit);
    if (key === 'maxChars') out.maxChars = clamp(value, PACK_LIMITS.minMaxChars, PACK_LIMITS.maxMaxChars);
  }
  return out;
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
