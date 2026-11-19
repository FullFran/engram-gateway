/**
 * The one tool-call pipeline every `tools/call` goes through:
 *
 *   authorize (#6) -> drop host paths -> redact (#9) -> forward to Engram -> attribute (#21) -> audit (#8) -> wrap result (#19)
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
import { ToolCallDeniedError, createAuthorizeStage, filterToolList } from './authorize.js';
import type { ToolAccessCheck, ToolListContext } from './authorize.js';
import { stripHostPaths } from './host-paths.js';
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
  /** Who made the call (from the validated token); absent when auth is off. */
  caller?: ToolCaller;
  /** The brain (slug) the call was routed to; null when not tied to a brain. */
  brain: string | null;
  /** The caller's effective role on the brain, set by the authorize stage; absent when auth is off. */
  role?: string;
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

/**
 * How the call ended: a result (which may be a tool error), a thrown error,
 * or a refusal by the authorize stage (never forwarded).
 */
export type ToolCallOutcome =
  | { ok: true; result: ToolCallResult }
  | { ok: false; error: unknown }
  | { ok: false; denied: ToolCallDeniedError };

export type RequestStage = (ctx: ToolCallContext) => ToolCallContext | Promise<ToolCallContext>;
export type ResultStage = (ctx: ToolCallContext, result: ToolCallResult) => ToolCallResult | Promise<ToolCallResult>;
/** Records the call; it sees the outcome but never changes the result. */
export type AuditStage = (ctx: ToolCallContext, outcome: ToolCallOutcome, call: ToolCallInfo) => void | Promise<void>;
/** Sends the (authorized, cleaned) request on; `ctx` says who calls and on which brain. */
export type Forward = (request: ToolCallRequest, ctx: ToolCallContext) => Promise<ToolCallResult>;

/** Narrows a `tools/list` result to what the caller may call; same access check as `authorize`. */
export type ToolListStage = <T extends { name: string }>(ctx: ToolListContext, tools: readonly T[]) => T[];

export interface ToolCallPipeline {
  authorize: RequestStage;
  /** Drops host path arguments (`cwd`, `directory`) before anything else reads them. */
  hostPaths: RequestStage;
  redact: RequestStage;
  /** Records and shows observation authors (#21); runs before audit so its counts reach the audit row. */
  attribute: ResultStage;
  audit: AuditStage;
  wrap: ResultStage;
  listTools: ToolListStage;
}

export interface ToolCallPipelineOptions extends Partial<ToolCallPipeline> {
  /**
   * Per-brain access (#6): sets both `authorize` and `listTools` from one
   * check, so the list never shows a tool the call would refuse. Default:
   * everything is allowed (authentication off).
   */
  access?: ToolAccessCheck;
  /** Secret redaction of write-tool arguments (#9). Default on. */
  redactSecrets?: boolean;
}

/** Every call is allowed: the default when authentication is off (loopback). */
export const allowAll: RequestStage = ctx => ctx;
/** No audit log (tests, or a gateway without a database). */
export const noAudit: AuditStage = () => {};
/** Every tool is listed. */
export const listAll: ToolListStage = (_ctx, tools) => [...tools];
/** Identity result stage (e.g. to turn wrapping off in tests). */
export const passResult: ResultStage = (_ctx, result) => result;

export function createToolCallPipeline(opts: ToolCallPipelineOptions = {}): ToolCallPipeline {
  return {
    authorize: opts.authorize ?? (opts.access ? createAuthorizeStage(opts.access) : allowAll),
    hostPaths: opts.hostPaths ?? stripHostPaths,
    redact: opts.redact ?? createRedactStage({ enabled: opts.redactSecrets ?? true }),
    attribute: opts.attribute ?? passResult,
    audit: opts.audit ?? noAudit,
    wrap: opts.wrap ?? createWrapStage(),
    listTools: opts.listTools ?? (opts.access ? withAccess(opts.access) : listAll)
  };
}

function withAccess(access: ToolAccessCheck): ToolListStage {
  return (ctx, tools) => filterToolList(access, ctx, tools);
}

export interface RunToolCallOptions {
  caller?: ToolCaller;
  brain?: string | null;
  /** Clock for the call's start time; defaults to `Date.now`. */
  nowMs?: () => number;
}

/**
 * Runs one call through the stages in the fixed order. Audit runs for every
 * call: refused by authorize (then `ToolCallDeniedError` is rethrown and
 * nothing is forwarded), forwarded, or failed in the forward step (then the
 * original error is rethrown).
 */
export async function runToolCall(pipeline: ToolCallPipeline, request: ToolCallRequest, forward: Forward, opts: RunToolCallOptions = {}): Promise<ToolCallResult> {
  const brain = opts.brain ?? null;
  let ctx: ToolCallContext = { request, ...(opts.caller ? { caller: opts.caller } : {}), brain, meta: {} };
  const call: ToolCallInfo = {
    ...(opts.caller ? { caller: opts.caller } : {}),
    brain,
    startedAtMs: (opts.nowMs ?? Date.now)()
  };
  try {
    ctx = await pipeline.authorize(ctx);
  } catch (error) {
    if (error instanceof ToolCallDeniedError) await pipeline.audit(ctx, { ok: false, denied: error }, call);
    throw error;
  }
  ctx = await pipeline.hostPaths(ctx);
  ctx = await pipeline.redact(ctx);
  let result: ToolCallResult;
  try {
    result = await forward(ctx.request, ctx);
  } catch (error) {
    await pipeline.audit(ctx, { ok: false, error }, call);
    throw error;
  }
  result = await pipeline.attribute(ctx, result);
  await pipeline.audit(ctx, { ok: true, result }, call);
  return pipeline.wrap(ctx, result);
}
