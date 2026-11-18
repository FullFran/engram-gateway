/**
 * The one tool-call pipeline every `tools/call` goes through:
 *
 *   authorize (#6) -> redact (#9) -> forward to Engram -> audit (#8) -> wrap result (#19)
 *
 * Each stage is a plain function so stages compose and can be tested alone.
 * Request stages see (and may replace) the call before it is forwarded; result
 * stages see the context and the result after it. `meta` carries facts between
 * stages (for example redaction counts for the audit row). Stages never put
 * secret values in `meta`.
 *
 * This module knows nothing about the MCP SDK, the HTTP layer or auth.
 */
import { createRedactStage } from './redact.js';

export interface ToolCallRequest {
  name: string;
  arguments?: Record<string, unknown>;
}

/** A `tools/call` result as the pipeline sees it; unknown fields pass through. */
export interface ToolCallResult {
  content?: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
  [key: string]: unknown;
}

export interface ToolCallContext {
  request: ToolCallRequest;
  /** Facts for later stages, e.g. `redactions: { github: 1 }`. Never secret values. */
  meta: Record<string, unknown>;
}

export type RequestStage = (ctx: ToolCallContext) => ToolCallContext | Promise<ToolCallContext>;
export type ResultStage = (ctx: ToolCallContext, result: ToolCallResult) => ToolCallResult | Promise<ToolCallResult>;
export type Forward = (request: ToolCallRequest) => Promise<ToolCallResult>;

export interface ToolCallPipeline {
  authorize: RequestStage;
  redact: RequestStage;
  audit: ResultStage;
  wrap: ResultStage;
}

export interface ToolCallPipelineOptions extends Partial<ToolCallPipeline> {
  /** Secret redaction of write-tool arguments (#9). Default on. */
  redactSecrets?: boolean;
}

/** Placeholder until #6 adds roles and grants: every call is allowed. */
export const allowAll: RequestStage = ctx => ctx;
/** Placeholder until #8 adds the append-only audit log. */
export const noAudit: ResultStage = (_ctx, result) => result;
/** Identity result stage. */
export const passResult: ResultStage = (_ctx, result) => result;

export function createToolCallPipeline(opts: ToolCallPipelineOptions = {}): ToolCallPipeline {
  return {
    authorize: opts.authorize ?? allowAll,
    redact: opts.redact ?? createRedactStage({ enabled: opts.redactSecrets ?? true }),
    audit: opts.audit ?? noAudit,
    wrap: opts.wrap ?? passResult
  };
}

/** Runs one call through the stages in the fixed order. */
export async function runToolCall(pipeline: ToolCallPipeline, request: ToolCallRequest, forward: Forward): Promise<ToolCallResult> {
  let ctx: ToolCallContext = { request, meta: {} };
  ctx = await pipeline.authorize(ctx);
  ctx = await pipeline.redact(ctx);
  const result = await forward(ctx.request);
  const audited = await pipeline.audit(ctx, result);
  return pipeline.wrap(ctx, audited);
}
