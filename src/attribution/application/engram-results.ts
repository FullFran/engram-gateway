/**
 * Reads observation ids out of `engram mcp` tool results (checked against
 * engram 3.7.2). Engram returns one text item holding a JSON object:
 *
 * - `mem_save`, `mem_session_summary`: `{ "id": 2, "sync_id": "obs-…", … }`
 *   (a `topic_key` revision returns the revised observation's id).
 * - `mem_update`: `{ "result": "Memory updated: #1 \"T\" (…)" }`, no sync_id.
 * - `mem_capture_passive`: counts only, no id.
 * - `mem_delete`: plain text `Memory #4 soft-deleted` / `Memory #3 permanently deleted`.
 * - `mem_search`: `{ "results": [{ "id": 1, "sync_id": … }, …] }`.
 * - `mem_get_observation`: no id field; the id is the request's `id`.
 * - `mem_context`: no ids at all, so it cannot be annotated.
 *
 * Anything that does not match yields nothing: attribution is skipped, never guessed.
 */

/** The parts of a tool result this module reads; structural, so it does not import the pipeline. */
export interface ToolResultLike {
  content?: unknown[];
  isError?: boolean;
}

export interface WrittenObservation {
  id: number;
  syncId?: string;
}

const isObservationId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

function texts(result: ToolResultLike): string[] {
  if (!Array.isArray(result.content)) return [];
  return result.content.flatMap(item => {
    const text = (item as { type?: unknown; text?: unknown } | null)?.text;
    return (item as { type?: unknown } | null)?.type === 'text' && typeof text === 'string' ? [text] : [];
  });
}

function jsonObject(result: ToolResultLike): Record<string, unknown> | undefined {
  for (const text of texts(result)) {
    if (!text.trimStart().startsWith('{')) continue;
    try {
      const value: unknown = JSON.parse(text);
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
      // not JSON: try the next item
    }
  }
  return undefined;
}

/** The observation a successful write created or revised, if its result names it. */
export function writtenObservation(kind: 'save' | 'update', result: ToolResultLike): WrittenObservation | undefined {
  if (result.isError === true) return undefined;
  const json = jsonObject(result);
  if (!json) return undefined;
  if (kind === 'save') {
    if (!isObservationId(json.id)) return undefined;
    return typeof json.sync_id === 'string' && json.sync_id !== '' ? { id: json.id, syncId: json.sync_id } : { id: json.id };
  }
  const match = typeof json.result === 'string' ? /^Memory updated: #(\d+)\b/.exec(json.result) : null;
  const id = match ? Number(match[1]) : NaN;
  return isObservationId(id) ? { id } : undefined;
}

/** The observation a successful `mem_delete` removed (soft or hard). */
export function deletedObservation(result: ToolResultLike): number | undefined {
  if (result.isError === true) return undefined;
  for (const text of texts(result)) {
    const match = /^Memory #(\d+) (?:soft-deleted|permanently deleted)\b/.exec(text.trim());
    const id = match ? Number(match[1]) : NaN;
    if (isObservationId(id)) return id;
  }
  return undefined;
}

/** Observation ids shown by a successful read, in result order, without repeats. */
export function readObservationIds(tool: string, args: Record<string, unknown> | undefined, result: ToolResultLike): number[] {
  if (result.isError === true) return [];
  if (tool === 'mem_get_observation') return isObservationId(args?.id) ? [args.id] : [];
  if (tool !== 'mem_search') return [];
  const results = jsonObject(result)?.results;
  if (!Array.isArray(results)) return [];
  const ids = results.map(item => (item as { id?: unknown } | null)?.id).filter(isObservationId);
  return [...new Set(ids)];
}
