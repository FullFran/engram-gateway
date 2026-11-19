/**
 * The audit stage (#8): one record per call, refused by the authorize stage
 * (`denied`, #6) or forwarded, with the outcome, the caller, the brain and the pipeline facts in `meta`
 * (redaction counts). It passes no argument values and no error messages;
 * the recorder keeps counts and ids only.
 *
 * The pipeline knows nothing about the audit log's storage: `record` is
 * wired in the composition root (main.ts) to `toolCallRecorder` from
 * src/audit.
 */
import type { AuditStage, ToolCaller } from './tool-call-pipeline.js';

/** What the stage hands to the recorder for one call. */
export interface AuditedToolCall {
  caller?: ToolCaller;
  brain: string | null;
  tool: string;
  startedAtMs: number;
  outcome: 'ok' | 'error' | 'denied';
  /** `forward_failed` when the forward threw, `tool_error` for an `isError` result. */
  errorKind?: 'forward_failed' | 'tool_error';
  meta: Record<string, unknown>;
}

export interface AuditStageOptions {
  record: (call: AuditedToolCall) => unknown;
  /**
   * Called when `record` fails. The call itself still succeeds (or fails with
   * its own error): the forward already happened, so failing the call would
   * only invite a retry that repeats it.
   */
  onError?: (error: unknown, tool: string) => void;
}

export function createAuditStage(opts: AuditStageOptions): AuditStage {
  return async (ctx, outcome, call) => {
    const tool = ctx.request.name;
    const denied = !outcome.ok && 'denied' in outcome;
    const failed = !outcome.ok || outcome.result.isError === true;
    const errorKind = denied ? undefined : !outcome.ok ? 'forward_failed' : outcome.result.isError === true ? 'tool_error' : undefined;
    try {
      await opts.record({
        ...(call.caller ? { caller: call.caller } : {}),
        brain: call.brain,
        tool,
        startedAtMs: call.startedAtMs,
        outcome: denied ? 'denied' : failed ? 'error' : 'ok',
        ...(errorKind ? { errorKind } : {}),
        meta: ctx.meta
      });
    } catch (error) {
      opts.onError?.(error, tool);
    }
  };
}
