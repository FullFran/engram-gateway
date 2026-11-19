import { parseId } from './proposal-input.js';
import { WIKI_LIMITS, WikiError, touchedSlugs, type ProposalItem, type ProposalStatus } from './wiki.js';

export const DECISION_ACTIONS = ['approve', 'return', 'reject'] as const;
export type DecisionAction = (typeof DECISION_ACTIONS)[number];

const PROPOSAL_STATUSES: readonly ProposalStatus[] = ['open', 'returned', 'rejected', 'closed'];
const FINGERPRINT = /^[0-9a-f]{64}$/;

export interface ReviewInput {
  proposalId: number;
  /** Sorted, unique; undefined selects every pending item. */
  itemIds?: number[];
}

export interface DecideInput extends ReviewInput {
  action: DecisionAction;
  fingerprint?: string;
  comment?: string;
}

export interface ProposalsInput {
  status?: ProposalStatus;
  limit: number;
}

export const PROPOSALS_LIMITS = Object.freeze({ defaultLimit: 20, maxLimit: 100 });

type Raw = Record<string, unknown>;

function invalid(message: string): never {
  throw new WikiError('invalid', `invalid arguments: ${message}`);
}

function object(args: unknown, allowed: readonly string[]): Raw {
  const raw = args ?? {};
  if (typeof raw !== 'object' || Array.isArray(raw)) invalid('expected an object');
  for (const key of Object.keys(raw)) if (!allowed.includes(key)) invalid(`unknown field ${key}`);
  return raw as Raw;
}

function itemIds(value: unknown): number[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) invalid('itemIds must list at least one item id');
  if (value.length > WIKI_LIMITS.maxItems) invalid(`itemIds has more than ${WIKI_LIMITS.maxItems} entries`);
  return [...new Set(value.map((id, index) => parseId(id, `itemIds[${index}]`)))].sort((a, b) => a - b);
}

export function parseReviewInput(args: unknown): ReviewInput {
  const raw = object(args, ['proposalId', 'itemIds']);
  const ids = itemIds(raw.itemIds);
  return { proposalId: parseId(raw.proposalId, 'proposalId'), ...(ids ? { itemIds: ids } : {}) };
}

export function parseDecideInput(args: unknown): DecideInput {
  const raw = object(args, ['proposalId', 'action', 'itemIds', 'fingerprint', 'comment']);
  const action = raw.action;
  if (typeof action !== 'string' || !(DECISION_ACTIONS as readonly string[]).includes(action)) invalid(`action must be one of ${DECISION_ACTIONS.join(', ')}`);
  const ids = itemIds(raw.itemIds);
  if (ids && action !== 'approve') invalid('itemIds selects items to approve; return and reject act on the whole proposal');
  let fingerprint: string | undefined;
  if (raw.fingerprint !== undefined) {
    if (typeof raw.fingerprint !== 'string' || !FINGERPRINT.test(raw.fingerprint)) invalid('fingerprint must be the 64-character hex value brain_review returned');
    fingerprint = raw.fingerprint;
  }
  if (action === 'approve' && fingerprint === undefined) invalid('approving needs the fingerprint brain_review returned for this selection');
  let comment: string | undefined;
  if (raw.comment !== undefined) {
    if (typeof raw.comment !== 'string' || raw.comment.length > WIKI_LIMITS.maxCommentChars) invalid(`comment must be a string of at most ${WIKI_LIMITS.maxCommentChars} characters`);
    comment = raw.comment;
  }
  return {
    proposalId: parseId(raw.proposalId, 'proposalId'),
    action: action as DecisionAction,
    ...(ids ? { itemIds: ids } : {}),
    ...(fingerprint !== undefined ? { fingerprint } : {}),
    ...(comment !== undefined ? { comment } : {})
  };
}

export function parseProposalsInput(args: unknown): ProposalsInput {
  const raw = object(args, ['status', 'limit']);
  const out: ProposalsInput = { limit: PROPOSALS_LIMITS.defaultLimit };
  if (raw.status !== undefined) {
    if (typeof raw.status !== 'string' || !(PROPOSAL_STATUSES as readonly string[]).includes(raw.status)) invalid(`status must be one of ${PROPOSAL_STATUSES.join(', ')}`);
    out.status = raw.status as ProposalStatus;
  }
  if (raw.limit !== undefined) out.limit = Math.min(PROPOSALS_LIMITS.maxLimit, parseId(raw.limit, 'limit'));
  return out;
}

/** What a reviewer saw of the wiki for one selection: each touched page's revision and each link's presence. */
export interface ReviewState {
  page(slug: string): number | null;
  hasLiveLink(from: string, to: string, type: string): boolean;
}

/**
 * The text a review fingerprint hashes: the proposal id and revision (any
 * revision of the proposal changes it), the selected item ids, and the state
 * of everything the selection touches (each page's current revision, each
 * link's presence). Approving checks it again inside the transaction, so a
 * decision applies exactly what the reviewer saw, or nothing.
 */
export function fingerprintMaterial(proposalId: number, revision: number, selected: ReadonlyArray<{ id: number; item: ProposalItem }>, state: ReviewState): string {
  const ids = selected.map(entry => entry.id).sort((a, b) => a - b);
  const slugs = [...new Set(selected.flatMap(entry => touchedSlugs(entry.item)))].sort();
  const links = selected
    .flatMap(({ item }) => (item.op === 'upsert_page' ? [] : [[item.from, item.to, item.type, state.hasLiveLink(item.from, item.to, item.type)] as const]))
    .sort((a, b) => a.join(' ').localeCompare(b.join(' ')));
  return JSON.stringify({ v: 1, proposal: proposalId, revision, items: ids, pages: slugs.map(slug => [slug, state.page(slug)]), links });
}
