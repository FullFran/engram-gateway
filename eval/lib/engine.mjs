/**
 * Engine-agnostic search client: any MCP endpoint exposing a search tool with
 * the `mem_search` argument and result shape. Today that is `engram mcp`
 * over stdio; the gateway's Streamable HTTP `/mcp` and a future
 * `mem_search_hybrid` (#15) plug in through the same options.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { parseSearchResult, resultText, unwrapMemoryData } from './search-result.mjs';

/**
 * @param {object} opts
 * @param {'stdio'|'http'} opts.transport
 * @param {string} [opts.command] stdio: executable (default `engram`)
 * @param {string[]} [opts.args] stdio: arguments (default `['mcp']`)
 * @param {Record<string,string>} [opts.env] stdio: extra environment
 * @param {string} [opts.cwd] stdio: working directory of the child
 * @param {string} [opts.url] http: endpoint URL
 * @param {string} [opts.token] http: bearer token
 * @param {string} [opts.tool] search tool name (default `mem_search`)
 * @param {object} [opts.searchArgs] extra arguments on every search (e.g. `{ match_mode: 'any' }`)
 * @param {number} [opts.limit] results per search (default 10)
 */
export async function createMcpEngine(opts) {
  const client = new Client({ name: 'engram-gateway-eval', version: '1' });
  let transport;
  if (opts.transport === 'http') {
    if (!opts.url) throw new Error('http engine needs a url');
    const headers = opts.token ? { Authorization: `Bearer ${opts.token}` } : {};
    transport = new StreamableHTTPClientTransport(new URL(opts.url), { requestInit: { headers } });
  } else {
    transport = new StdioClientTransport({
      command: opts.command ?? 'engram',
      args: opts.args ?? ['mcp'],
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stderr: 'ignore',
    });
  }
  await client.connect(transport);
  const tool = opts.tool ?? 'mem_search';
  const limit = opts.limit ?? 10;

  return {
    /** Ranked ids for `query` within `scope` (project / all_projects / type). */
    async search(query, scope = {}) {
      const result = await client.callTool({ name: tool, arguments: { ...scope, ...(opts.searchArgs ?? {}), query, limit } });
      const parsed = parseSearchResult(result.content, { isError: result.isError === true });
      if (parsed.error) return { ids: [], error: resultText(result.content).slice(0, 200) };
      return { ids: parsed.ids.slice(0, limit) };
    },
    /** Full observation text, or undefined when the engine reports an error. */
    async getObservation(id) {
      const result = await client.callTool({ name: 'mem_get_observation', arguments: { id } });
      if (result.isError) return undefined;
      const text = unwrapMemoryData(resultText(result.content));
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed.result === 'string') return unwrapMemoryData(parsed.result);
      } catch {
        // Plain-text engines return the observation directly.
      }
      return text;
    },
    close: () => client.close(),
  };
}
