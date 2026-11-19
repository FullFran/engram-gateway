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
 * Defaults: redaction (#9) on, memory text wrapped as data (#19).
 */
import { createRedactStage } from './redact.js';
import { createWrapStage } from './wrap-data.js';

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

/** Who made the call, from the validated access token; absent when auth is off. */
export interface ToolCaller {
  login?: string;
  clientId?: string;
}

/** Facts about one call that are not part of the request: who, which brain, when it started. */
export interface ToolCallInfo {
  caller?: ToolCaller;
  /** Opaque brain key (the slug the call was routed to); null when not tied to a brain. */
  brain: string | null;
  startedAtMs: number;
}

/** How the forward ended: a result (which may be a tool error) or a thrown error. */
export type ToolCallOutcome = { ok: true; result: ToolCallResult } | { ok: false; error: unknown };

export type RequestStage = (ctx: ToolCallContext) => ToolCallContext | Promise<ToolCallContext>;
export type ResultStage = (ctx: ToolCallContext, result: ToolCallResult) => ToolCallResult | Promise<ToolCallResult>;
/** Records the call; it sees the outcome but never changes the result. */
export type AuditStage = (ctx: ToolCallContext, outcome: ToolCallOutcome, call: ToolCallInfo) => void | Promise<void>;
export type Forward = (request: ToolCallRequest) => Promise<ToolCallResult>;

export interface ToolCallPipeline {
  authorize: RequestStage;
  redact: RequestStage;
  audit: AuditStage;
  wrap: ResultStage;
}

export interface ToolCallPipelineOptions extends Partial<ToolCallPipeline> {
  /** Secret redaction of write-tool arguments (#9). Default on. */
  redactSecrets?: boolean;
}

/** Placeholder until #6 adds roles and grants: every call is allowed. */
export const allowAll: RequestStage = ctx => ctx;
/** No audit log (tests, or a gateway without a database). */
export const noAudit: AuditStage = () => {};
/** Identity result stage (e.g. to turn wrapping off in tests). */
export const passResult: ResultStage = (_ctx, result) => result;

export function createToolCallPipeline(opts: ToolCallPipelineOptions = {}): ToolCallPipeline {
  return {
    authorize: opts.authorize ?? allowAll,
    redact: opts.redact ?? createRedactStage({ enabled: opts.redactSecrets ?? true }),
    audit: opts.audit ?? noAudit,
    wrap: opts.wrap ?? createWrapStage()
  };
}

export interface RunToolCallOptions {
  caller?: ToolCaller;
  brain?: string | null;
  /** Clock for the call's start time; defaults to `Date.now`. */
  nowMs?: () => number;
}

/**
 * Runs one call through the stages in the fixed order. Audit runs for every
 * call that reaches the forward step, also when the forward throws; then the
 * original error is rethrown.
 */
export async function runToolCall(pipeline: ToolCallPipeline, request: ToolCallRequest, forward: Forward, opts: RunToolCallOptions = {}): Promise<ToolCallResult> {
  let ctx: ToolCallContext = { request, meta: {} };
  ctx = await pipeline.authorize(ctx);
  ctx = await pipeline.redact(ctx);
  const call: ToolCallInfo = {
    ...(opts.caller ? { caller: opts.caller } : {}),
    brain: opts.brain ?? null,
    startedAtMs: (opts.nowMs ?? Date.now)()
  };
  let result: ToolCallResult;
  try {
    result = await forward(ctx.request);
  } catch (error) {
    await pipeline.audit(ctx, { ok: false, error }, call);
    throw error;
  }
  await pipeline.audit(ctx, { ok: true, result }, call);
  return pipeline.wrap(ctx, result);
}
