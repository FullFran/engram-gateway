import { WRITE_TOOLS, describeAuthors } from '../domain/authorship.js';
import { deletedObservation, readObservationIds, writtenObservation } from './engram-results.js';
import type { AttributionClock, AuthorshipRepository } from './ports.js';

/** `_meta` key of the structured authors map added to read results: `{ "<id>": { savedBy, lastUpdatedBy } }`. */
export const AUTHORS_META_KEY = 'engram-gateway/authors';

/** One forwarded call as the pipeline's attribution stage describes it (structurally; this module does not import the pipeline). */
export interface AttributionInput<R extends AttributedResult> {
  caller?: { login?: string };
  brain: string | null;
  request: { name: string; arguments?: Record<string, unknown> };
  result: R;
}

export interface AttributedResult {
  content?: unknown[];
  isError?: boolean;
  _meta?: unknown;
  [key: string]: unknown;
}

export interface AttributionOutput<R extends AttributedResult> {
  result: R;
  /** What happened, as counts for the audit row (e.g. `{ skipped_no_id: 1 }`); empty when the tool is not attributed. */
  counts: Record<string, number>;
}

export interface AttributorOptions {
  authors: AuthorshipRepository;
  clock: AttributionClock;
}

/**
 * Records the author of each successful write and annotates read results
 * with the authors the gateway knows (#21). Writes: `mem_save`,
 * `mem_session_summary`, `mem_capture_passive`, `mem_update`; a result
 * without an id is counted as `skipped_no_id` and the call is unaffected.
 * `mem_delete` removes the row. Reads (`mem_search`, `mem_get_observation`)
 * get one extra text item and a `_meta` map; Engram's own text is not changed.
 */
export function createAttributor(opts: AttributorOptions) {
  return <R extends AttributedResult>(input: AttributionInput<R>): AttributionOutput<R> => {
    const { brain, request, result } = input;
    const tool = request.name;
    if (result.isError === true) return { result, counts: {} };

    const kind = WRITE_TOOLS[tool];
    if (kind) {
      if (brain === null) return { result, counts: { skipped_no_brain: 1 } };
      const login = input.caller?.login;
      if (!login) return { result, counts: { skipped_no_caller: 1 } };
      const written = writtenObservation(kind, result);
      if (!written) return { result, counts: { skipped_no_id: 1 } };
      opts.authors.recordWrite({
        brain, observationId: written.id, ...(written.syncId ? { syncId: written.syncId } : {}), login, kind, atMs: opts.clock.nowMs()
      });
      return { result, counts: { recorded: 1 } };
    }

    if (tool === 'mem_delete') {
      const id = deletedObservation(result);
      if (brain === null || id === undefined) return { result, counts: {} };
      opts.authors.remove(brain, id);
      return { result, counts: { removed: 1 } };
    }

    if (brain === null) return { result, counts: {} };
    const ids = readObservationIds(tool, request.arguments, result);
    if (ids.length === 0) return { result, counts: {} };
    const authors = opts.authors.find(brain, ids);
    if (authors.length === 0) return { result, counts: {} };
    const map = Object.fromEntries(authors.map(a => [String(a.observationId), { savedBy: a.savedBy, lastUpdatedBy: a.lastUpdatedBy }]));
    const meta = result._meta !== null && typeof result._meta === 'object' ? result._meta : {};
    return {
      result: {
        ...result,
        content: [...(Array.isArray(result.content) ? result.content : []), { type: 'text', text: describeAuthors(authors) }],
        _meta: { ...meta, [AUTHORS_META_KEY]: map }
      },
      counts: { annotated: authors.length }
    };
  };
}
