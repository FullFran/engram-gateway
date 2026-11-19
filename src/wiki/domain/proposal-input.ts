import { LINK_TYPES, PAGE_KINDS, PAGE_SLUG, WIKI_LIMITS, WikiError, type LinkType, type PageKind, type ProposalItem } from './wiki.js';

/** `brain_propose` arguments once checked. */
export interface ProposeInput {
  summary: string;
  items: ProposalItem[];
  /** Revises this proposal instead of opening a new one. */
  proposalId?: number;
}

type Raw = Record<string, unknown>;

const isObject = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);

function invalid(message: string): never {
  throw new WikiError('invalid', `invalid arguments: ${message}`);
}

function onlyKeys(value: Raw, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) invalid(`${where}: unknown field ${key}`);
}

function text(value: unknown, where: string, max: number, { allowEmpty = false } = {}): string {
  if (typeof value !== 'string') invalid(`${where} must be a string`);
  if (!allowEmpty && value.trim() === '') invalid(`${where} must not be empty`);
  if (value.length > max) invalid(`${where} is longer than ${max} characters`);
  return value;
}

export function parseSlug(value: unknown, where: string): string {
  const slug = text(value, where, WIKI_LIMITS.maxSlugChars);
  if (!PAGE_SLUG.test(slug)) invalid(`${where} must be lowercase letters, digits and dashes`);
  return slug;
}

/** A positive integer id (a proposal, item, decision or revision number). */
export function parseId(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) invalid(`${where} must be a positive integer`);
  return value;
}

function citations(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.length === 0) invalid(`${where}.citations must list at least one observation sync_id`);
  if (value.length > WIKI_LIMITS.maxCitations) invalid(`${where}.citations has more than ${WIKI_LIMITS.maxCitations} entries`);
  return [...new Set(value.map((id, index) => text(id, `${where}.citations[${index}]`, WIKI_LIMITS.maxCitationChars)))];
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], where: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) invalid(`${where} must be one of ${allowed.join(', ')}`);
  return value as T;
}

function parseItem(raw: unknown, index: number): ProposalItem {
  const where = `items[${index}]`;
  if (!isObject(raw)) invalid(`${where} must be an object`);
  const op = oneOf(raw.op, ['upsert_page', 'link', 'unlink'] as const, `${where}.op`);
  if (op === 'upsert_page') {
    onlyKeys(raw, ['op', 'slug', 'kind', 'title', 'body', 'citations', 'baseRevision'], where);
    const base = raw.baseRevision;
    return {
      op,
      slug: parseSlug(raw.slug, `${where}.slug`),
      kind: oneOf<PageKind>(raw.kind, PAGE_KINDS, `${where}.kind`),
      title: text(raw.title, `${where}.title`, WIKI_LIMITS.maxTitleChars),
      body: text(raw.body, `${where}.body`, WIKI_LIMITS.maxBodyChars),
      citations: citations(raw.citations, where),
      baseRevision: base === undefined || base === null ? null : parseId(base, `${where}.baseRevision`)
    };
  }
  onlyKeys(raw, ['op', 'from', 'to', 'type', 'citations'], where);
  const from = parseSlug(raw.from, `${where}.from`);
  const to = parseSlug(raw.to, `${where}.to`);
  if (from === to) invalid(`${where}: a page cannot link to itself`);
  return { op, from, to, type: oneOf<LinkType>(raw.type, LINK_TYPES, `${where}.type`), citations: citations(raw.citations, where) };
}

/** Checks `brain_propose` arguments; throws `WikiError('invalid')` naming the first problem. */
export function parseProposeInput(args: unknown): ProposeInput {
  if (!isObject(args)) invalid('expected an object');
  onlyKeys(args, ['summary', 'items', 'proposalId'], 'arguments');
  const summary = text(args.summary, 'summary', WIKI_LIMITS.maxSummaryChars);
  if (!Array.isArray(args.items) || args.items.length === 0) invalid('items must list at least one item');
  if (args.items.length > WIKI_LIMITS.maxItems) invalid(`items has more than ${WIKI_LIMITS.maxItems} entries`);
  const items = args.items.map(parseItem);
  const pages = new Set<string>();
  const links = new Set<string>();
  items.forEach((item, index) => {
    const key = item.op === 'upsert_page' ? item.slug : `${item.from} ${item.type} ${item.to}`;
    const seen = item.op === 'upsert_page' ? pages : links;
    if (seen.has(key)) invalid(`items[${index}] repeats ${item.op === 'upsert_page' ? `page ${key}` : `link ${key}`}`);
    seen.add(key);
  });
  return { summary, items, ...(args.proposalId !== undefined ? { proposalId: parseId(args.proposalId, 'proposalId') } : {}) };
}
