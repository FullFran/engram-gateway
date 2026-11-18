import { toAuditMeta, type AuditActor, type AuditErrorKind, type AuditOutcome } from '../domain/audit-event.js';
import type { AuditClock, AuditLog } from './ports.js';

export const TOOL_CALL_ACTION = 'tool_call';

export interface ToolCallAudit {
  actor: AuditActor;
  brain: string | null;
  tool: string;
  startedAtMs: number;
  outcome: AuditOutcome;
  errorKind?: AuditErrorKind;
  /** Pipeline facts (e.g. `redactions`); only counts and ids are kept. */
  meta?: Record<string, unknown>;
}

/**
 * Writes the one audit row of a tool call, after the forward (a tool call
 * cannot share a transaction with the brain's own database). Returns its id.
 */
export function recordToolCall(log: AuditLog, clock: AuditClock, call: ToolCallAudit): number {
  const meta = toAuditMeta(call.meta ?? {});
  if (call.errorKind) meta.errorKind = call.errorKind;
  if (call.actor.kind === 'user' && call.actor.clientId !== undefined) Object.assign(meta, toAuditMeta({ clientId: call.actor.clientId }));
  return log.append({
    atMs: call.startedAtMs,
    actor: call.actor,
    brain: call.brain,
    action: TOOL_CALL_ACTION,
    target: call.tool,
    outcome: call.outcome,
    durationMs: Math.max(0, Math.round(clock.nowMs() - call.startedAtMs)),
    meta
  });
}
