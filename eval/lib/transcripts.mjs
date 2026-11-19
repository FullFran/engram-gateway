/**
 * Search episodes from Claude Code transcripts (JSONL).
 *
 * A transcript is reduced to an ordered list of steps: every tool call
 * (with its result joined by `tool_use_id`) and every assistant text block.
 * `labelSearches` then derives implicit relevance labels:
 *
 * - A chain is a run of `mem_search` calls with no `mem_get_observation`
 *   between them and at most `window` tool calls between consecutive ones.
 * - An observation id is relevant to every search of the chain when the agent
 *   fetched it with `mem_get_observation`, or cited it as `#<id>` in its own
 *   text (only ids some search of the chain returned), within the `window`
 *   tool calls after the chain's last search.
 * - A chain member followed by another search is `reformulated`; the last
 *   one is `fetched` when labels exist and `abandoned` otherwise; a search
 *   whose original result was empty is also flagged `zeroResult`.
 *
 * The labels only contain what the agent saw, so they are biased towards the
 * engine that produced the original results. See eval/RUBRIC.md.
 */
import { parseSearchResult } from './search-result.mjs';

export const SEARCH_TOOL = 'mem_search';
export const FETCH_TOOL = 'mem_get_observation';
export const DEFAULT_WINDOW = 6;

/** `mcp__engram__mem_search` and `mcp__plugin_engram_engram__mem_search` → `mem_search`. */
export function engramToolName(name) {
  if (typeof name !== 'string' || !name.startsWith('mcp__')) return undefined;
  const [, server, ...rest] = name.split('__');
  if (!server || !/engram/.test(server)) return undefined;
  return rest.join('__');
}

/** Ordered steps of one transcript. Lines that are not JSON are skipped. */
export function transcriptSteps(lines) {
  const steps = [];
  const byUseId = new Map();
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const content = entry && entry.message && entry.message.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (!item || typeof item !== 'object') continue;
      if (item.type === 'tool_use') {
        const step = {
          kind: 'tool',
          id: item.id,
          name: item.name,
          engramTool: engramToolName(item.name),
          input: item.input ?? {},
          sessionId: entry.sessionId,
          timestamp: entry.timestamp,
          cwd: entry.cwd,
          result: undefined,
        };
        steps.push(step);
        if (item.id) byUseId.set(item.id, step);
      } else if (item.type === 'tool_result' && byUseId.has(item.tool_use_id)) {
        byUseId.get(item.tool_use_id).result = { content: item.content, isError: item.is_error === true };
      } else if (item.type === 'text' && entry.message.role === 'assistant' && typeof item.text === 'string') {
        steps.push({ kind: 'text', text: item.text });
      }
    }
  }
  return steps;
}

/** Observation id of a `mem_get_observation` call, if any. */
function fetchedId(step) {
  const id = Number(step.input && step.input.id);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

function citedIds(text) {
  return new Set([...text.matchAll(/#(\d{1,9})\b/g)].map(m => Number(m[1])));
}

/**
 * Search records with implicit labels for one transcript.
 * Each record: `{ query, args, sessionId, timestamp, originalIds, originalProject,
 * zeroResult, error, status, relevant }` where `relevant` is a sorted id list.
 */
export function labelSearches(steps, { window = DEFAULT_WINDOW } = {}) {
  const tools = [];
  steps.forEach((step, index) => {
    if (step.kind === 'tool') tools.push({ step, index });
  });
  const records = [];
  let chain = [];
  let toolsSinceSearch = Infinity;

  const closeChain = (labels, status) => {
    chain.forEach((record, i) => {
      record.relevant = [...labels].sort((a, b) => a - b);
      record.status = i < chain.length - 1 ? 'reformulated' : status;
    });
    chain = [];
  };

  for (let t = 0; t < tools.length; t++) {
    const { step } = tools[t];
    if (step.engramTool !== SEARCH_TOOL) continue;
    if (chain.length > 0 && toolsSinceSearch > window) closeChain(new Set(), 'abandoned');
    const parsed = step.result ? parseSearchResult(step.result.content, { isError: step.result.isError }) : { ids: [], error: true };
    const record = {
      query: typeof step.input.query === 'string' ? step.input.query : '',
      args: step.input,
      sessionId: step.sessionId,
      timestamp: step.timestamp,
      originalIds: parsed.ids,
      originalProject: parsed.project,
      zeroResult: !parsed.error && parsed.ids.length === 0,
      error: parsed.error === true,
      status: 'abandoned',
      relevant: [],
    };
    records.push(record);
    chain.push(record);
    toolsSinceSearch = 0;

    // Look ahead from this search to the next search or the window end.
    const labels = new Set();
    const shown = new Set(chain.flatMap(r => r.originalIds));
    let nextSearch = false;
    let seen = 0;
    for (let i = tools[t].index + 1; i < steps.length; i++) {
      const next = steps[i];
      if (next.kind === 'text') {
        for (const id of citedIds(next.text)) if (shown.has(id)) labels.add(id);
        continue;
      }
      if (next.engramTool === SEARCH_TOOL) {
        nextSearch = true;
        break;
      }
      seen++;
      if (seen > window) break;
      if (next.engramTool === FETCH_TOOL) {
        const id = fetchedId(next);
        if (id !== undefined) labels.add(id);
      }
    }
    toolsSinceSearch = seen;
    if (labels.size > 0) {
      closeChain(labels, 'fetched');
    } else if (!nextSearch) {
      closeChain(labels, 'abandoned');
    }
  }
  if (chain.length > 0) closeChain(new Set(), 'abandoned');
  return records;
}
