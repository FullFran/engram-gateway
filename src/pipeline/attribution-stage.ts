/**
 * The attribution stage (#21): runs after the forward and before the audit,
 * so its counts reach the audit row. It records who wrote each observation
 * and may add the known authors to read results (before `wrap`, so they are
 * delimited as data with the rest of the result).
 *
 * It never fails the call: the forward already happened. A failure of
 * `attribute` returns the forwarded result unchanged, counts `failed` and
 * calls `onError` with the tool name only.
 *
 * The pipeline knows nothing about where authors are stored: `attribute` is
 * wired in the composition root (main.ts) to `createAttributor` from
 * src/attribution.
 */
import type { ResultStage, ToolCaller, ToolCallRequest, ToolCallResult } from './tool-call-pipeline.js';

export interface AttributionStageOptions {
  attribute: (input: { caller?: ToolCaller; brain: string | null; request: ToolCallRequest; result: ToolCallResult })
    => { result: ToolCallResult; counts: Record<string, number> };
  onError?: (error: unknown, tool: string) => void;
}

export function createAttributionStage(opts: AttributionStageOptions): ResultStage {
  return (ctx, result) => {
    const tool = ctx.request.name;
    try {
      const out = opts.attribute({ ...(ctx.caller ? { caller: ctx.caller } : {}), brain: ctx.brain, request: ctx.request, result });
      if (Object.keys(out.counts).length > 0) ctx.meta.attribution = out.counts;
      return out.result;
    } catch (error) {
      ctx.meta.attribution = { failed: 1 };
      opts.onError?.(error, tool);
      return result;
    }
  };
}
