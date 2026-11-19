/**
 * The `brain` argument a connection's tools take on the bare MCP endpoint
 * (#27): which brain a call goes to. Pure.
 */

/** Name of the argument added to every tool's input schema. */
export const BRAIN_ARGUMENT = 'brain';

/** `brain` value that fans a read tool out to every brain of the connection. */
export const ALL_BRAINS = '*';

/**
 * Read tools whose results from several brains can be shown side by side.
 * Not `mem_get_observation`: observation ids are per brain.
 */
export const FAN_OUT_TOOLS: ReadonlySet<string> = new Set([
  'mem_search', 'mem_context', 'mem_search_prompts', 'mem_timeline', 'mem_list_projects', 'mem_stats'
]);

interface ToolLike {
  name: string;
  inputSchema: { type: 'object'; properties?: Record<string, unknown>; [key: string]: unknown };
}

/** `tool` with an optional `brain` property naming `brains` (plus `"*"` for fan-out tools). */
export function withBrainArgument<T extends ToolLike>(tool: T, brains: readonly string[], defaultBrain: string | undefined): T {
  const fanOut = FAN_OUT_TOOLS.has(tool.name);
  const values = fanOut ? [...brains, ALL_BRAINS] : [...brains];
  const description = `Brain to use, one of this connection's brains${defaultBrain ? ` (default: ${defaultBrain})` : ' (required: this connection has no default brain)'}.` +
    (fanOut ? ` "${ALL_BRAINS}" searches every brain and labels each result with its brain.` : '');
  // A fan-out result is `{ results: [...] }`, not the tool's own output shape.
  const { outputSchema: _ignored, ...rest } = tool as T & { outputSchema?: unknown };
  return {
    ...(fanOut ? rest : tool) as T,
    inputSchema: {
      ...tool.inputSchema,
      properties: { ...(tool.inputSchema.properties ?? {}), [BRAIN_ARGUMENT]: { type: 'string', enum: values, description } }
    }
  };
}

export type BrainTarget =
  | { kind: 'one'; brain: string; arguments: Record<string, unknown> }
  | { kind: 'all'; brains: string[]; arguments: Record<string, unknown> }
  | { kind: 'invalid'; message: string };

/**
 * Where a call goes: the `brain` argument (removed from the forwarded
 * arguments), else `defaultBrain`. A brain outside `brains` is still a
 * target: the access check refuses it, so the refusal is audited. `"*"`
 * names every brain, for fan-out tools only.
 */
export function resolveTarget(
  tool: string,
  args: Record<string, unknown> | undefined,
  brains: readonly string[],
  defaultBrain: string | undefined
): BrainTarget {
  const { [BRAIN_ARGUMENT]: named, ...rest } = args ?? {};
  if (named === undefined) {
    if (defaultBrain) return { kind: 'one', brain: defaultBrain, arguments: rest };
    return { kind: 'invalid', message: `This connection has no default brain: pass "${BRAIN_ARGUMENT}" (one of: ${brains.join(', ') || 'none'}).` };
  }
  if (typeof named !== 'string' || named === '') return { kind: 'invalid', message: `"${BRAIN_ARGUMENT}" must be a brain name.` };
  if (named === ALL_BRAINS) {
    if (!FAN_OUT_TOOLS.has(tool)) return { kind: 'invalid', message: `"${BRAIN_ARGUMENT}": "${ALL_BRAINS}" is only for ${[...FAN_OUT_TOOLS].join(', ')}.` };
    return { kind: 'all', brains: [...brains], arguments: rest };
  }
  return { kind: 'one', brain: named, arguments: rest };
}

interface ResultLike {
  content?: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
}

export type BrainOutcome = { brain: string; result: ResultLike } | { brain: string; error: string };

/**
 * One result for a fan-out call: per brain, a gateway-authored
 * `brain: <slug>` text item followed by that brain's items (or its error),
 * and `structuredContent.results` with one entry per brain. An error only
 * when every brain failed.
 */
export function mergeFanOut(outcomes: readonly BrainOutcome[]): { content: unknown[]; structuredContent: { results: unknown[] }; isError?: true } {
  const content: unknown[] = [];
  const results: unknown[] = [];
  let failed = 0;
  for (const outcome of outcomes) {
    const error = 'error' in outcome ? outcome.error : outcome.result.isError === true ? 'the tool reported an error' : undefined;
    if (error !== undefined) failed += 1;
    if ('error' in outcome) {
      content.push({ type: 'text', text: `brain: ${outcome.brain} (error: ${outcome.error})` });
      results.push({ brain: outcome.brain, error: outcome.error });
      continue;
    }
    content.push({ type: 'text', text: `brain: ${outcome.brain}` }, ...(outcome.result.content ?? []));
    results.push({
      brain: outcome.brain,
      ...(outcome.result.structuredContent !== undefined ? { structuredContent: outcome.result.structuredContent } : {}),
      ...(error !== undefined ? { error } : {})
    });
  }
  return { content, structuredContent: { results }, ...(outcomes.length > 0 && failed === outcomes.length ? { isError: true as const } : {}) };
}
