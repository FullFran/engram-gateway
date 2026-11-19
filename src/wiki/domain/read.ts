import { parseId, parseSlug } from './proposal-input.js';
import { LINK_TYPES, PAGE_KINDS, WikiError, type LinkType, type PageKind } from './wiki.js';

/** Bounds on what the read tools return: one call never dumps the whole wiki. */
export const READ_LIMITS = Object.freeze({ defaultLimit: 50, maxLimit: 200, maxHistory: 50, maxQueryChars: 200 });

export interface PageInput { slug: string; revision?: number }
export interface PagesInput { query?: string; kind?: PageKind; limit: number }
export interface NeighborsInput { slug: string; types?: LinkType[]; limit: number }
export interface UndoInput { decisionId: number }

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

function limit(value: unknown): number {
  return value === undefined ? READ_LIMITS.defaultLimit : Math.min(READ_LIMITS.maxLimit, parseId(value, 'limit'));
}

export function parsePageInput(args: unknown): PageInput {
  const raw = object(args, ['slug', 'revision']);
  return { slug: parseSlug(raw.slug, 'slug'), ...(raw.revision !== undefined ? { revision: parseId(raw.revision, 'revision') } : {}) };
}

export function parsePagesInput(args: unknown): PagesInput {
  const raw = object(args, ['query', 'kind', 'limit']);
  const out: PagesInput = { limit: limit(raw.limit) };
  if (raw.query !== undefined) {
    if (typeof raw.query !== 'string' || raw.query.trim() === '' || raw.query.length > READ_LIMITS.maxQueryChars) invalid(`query must be non-empty text of at most ${READ_LIMITS.maxQueryChars} characters`);
    out.query = raw.query.trim();
  }
  if (raw.kind !== undefined) {
    if (typeof raw.kind !== 'string' || !(PAGE_KINDS as readonly string[]).includes(raw.kind)) invalid(`kind must be one of ${PAGE_KINDS.join(', ')}`);
    out.kind = raw.kind as PageKind;
  }
  return out;
}

export function parseNeighborsInput(args: unknown): NeighborsInput {
  const raw = object(args, ['slug', 'types', 'limit']);
  const out: NeighborsInput = { slug: parseSlug(raw.slug, 'slug'), limit: limit(raw.limit) };
  if (raw.types !== undefined) {
    if (!Array.isArray(raw.types) || raw.types.length === 0) invalid('types must list at least one link type');
    for (const type of raw.types) if (typeof type !== 'string' || !(LINK_TYPES as readonly string[]).includes(type)) invalid(`types must be among ${LINK_TYPES.join(', ')}`);
    out.types = [...new Set(raw.types as LinkType[])];
  }
  return out;
}

export function parseUndoInput(args: unknown): UndoInput {
  const raw = object(args, ['decisionId']);
  return { decisionId: parseId(raw.decisionId, 'decisionId') };
}
