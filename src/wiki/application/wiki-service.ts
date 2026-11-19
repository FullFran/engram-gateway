import { atLeast, type Role } from '../../authz/domain/role.js';
import { requiredRole } from '../../authz/domain/tool-roles.js';
import { NOISE_TYPES } from '../../health/domain/report.js';
import { parseProposeInput } from '../domain/proposal-input.js';
import { computeWarnings, type WikiWarning } from '../domain/warnings.js';
import { WikiError, touchedSlugs, type ProposalItem } from '../domain/wiki.js';
import type { JournalEntry, JournalReader, PageSummary, StoredProposal, WikiServiceDeps, WikiStore } from './ports.js';

/** The tools (and use cases) of the wiki; their roles live in GATEWAY_TOOL_ROLES (src/authz). */
export const WIKI_TOOLS = Object.freeze({
  compilePack: 'brain_compile_pack',
  propose: 'brain_propose'
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
