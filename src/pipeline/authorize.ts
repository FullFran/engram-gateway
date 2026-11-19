/**
 * The authorize stage (#6): the first stage of every `tools/call`, and the
 * filter `tools/list` uses, both backed by the same access check. Hiding a
 * tool from the list is a convenience; refusing the call is the boundary.
 *
 * The pipeline does not know where access comes from: `access` is wired in
 * the composition root (main.ts) to the grants (src/authz).
 */
import type { RequestStage, ToolCaller } from './tool-call-pipeline.js';

export type AccessVerdict = { allowed: true } | { allowed: false; reason: string };

export interface ToolAccessCheck {
  check(caller: ToolCaller | undefined, brain: string | null | undefined, tool: string): AccessVerdict;
}

/** Who asks and on which brain, for `tools/list`. */
export interface ToolListContext {
  caller?: ToolCaller;
  brain: string | null;
}

/** A call the caller may not make. Thrown by the authorize stage; the call is audited as `denied` and never forwarded. */
export class ToolCallDeniedError extends Error {
  constructor(readonly tool: string, readonly reason: string) {
    super(`Not allowed to call ${tool} on this brain (${reason.replace(/_/g, ' ')})`);
    this.name = 'ToolCallDeniedError';
  }
}

export function createAuthorizeStage(access: ToolAccessCheck): RequestStage {
  return ctx => {
    const verdict = access.check(ctx.caller, ctx.brain, ctx.request.name);
    if (!verdict.allowed) {
      // The audit stage records this context; the reason is one of a closed set (see src/audit).
      ctx.meta.denyReason = verdict.reason;
      throw new ToolCallDeniedError(ctx.request.name, verdict.reason);
    }
    return ctx;
  };
}

/** The tools of a `tools/list` result the caller may call, in their original order. */
export function filterToolList<T extends { name: string }>(access: ToolAccessCheck, ctx: ToolListContext, tools: readonly T[]): T[] {
  return tools.filter(tool => access.check(ctx.caller, ctx.brain, tool.name).allowed);
}
