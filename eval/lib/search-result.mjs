/**
 * Ranked observation ids from a `mem_search` tool result.
 *
 * Accepts every shape the evaluation meets: the JSON envelope of current
 * engram (`{"results":[{"id":...}]}`), the legacy plain-text listing
 * (`[1] #123 (type) — title`), and either one wrapped in the gateway's
 * `<memory-data nonce="...">` blocks (#19).
 */

const OPEN_TAG = /^<memory-data nonce="[^"]*">\n?/;
const CLOSE_TAG = /\n?<\/memory-data nonce="[^"]*">$/;

/** Text of a tool result: a string, or the text items of an MCP content array. */
export function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(item => item && item.type === 'text' && typeof item.text === 'string')
    .map(item => item.text)
    .join('\n');
}

/** Removes one level of gateway data delimiters, if present. */
export function unwrapMemoryData(text) {
  const trimmed = text.trim();
  return OPEN_TAG.test(trimmed) && CLOSE_TAG.test(trimmed) ? trimmed.replace(OPEN_TAG, '').replace(CLOSE_TAG, '') : trimmed;
}

/** Unwraps every string leaf of a parsed JSON value. */
function unwrapLeaves(value) {
  if (typeof value === 'string') return unwrapMemoryData(value);
  if (Array.isArray(value)) return value.map(unwrapLeaves);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, unwrapLeaves(v)]));
  }
  return value;
}

/**
 * Parses a search result into `{ ids, project, error }`.
 * `ids` keeps engine rank order without duplicates; `project` is the project
 * the engine resolved (empty string when it searched across projects).
 */
export function parseSearchResult(content, { isError = false } = {}) {
  const text = unwrapMemoryData(resultText(content));
  if (isError) return { ids: [], project: undefined, error: true };
  let parsed;
  try {
    parsed = unwrapLeaves(JSON.parse(text));
  } catch {
    parsed = undefined;
  }
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.results)) {
    const ids = parsed.results.map(r => Number(r && r.id)).filter(Number.isInteger);
    return { ids: [...new Set(ids)], project: typeof parsed.project === 'string' ? parsed.project : undefined, error: false };
  }
  const legacy = text.match(/\[\d+\] #(\d+)/g) ?? [];
  const ids = legacy.map(m => Number(m.slice(m.indexOf('#') + 1)));
  return { ids: [...new Set(ids)], project: undefined, error: false };
}
