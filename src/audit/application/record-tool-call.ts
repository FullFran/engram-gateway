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

/** A finished tool call as the pipeline's audit stage describes it (structurally; audit does not import the pipeline). */
export interface ToolCallFacts {
  caller?: { login?: string; clientId?: string };
  brain: string | null;
  tool: string;
  startedAtMs: number;
  outcome: AuditOutcome;
  errorKind?: AuditErrorKind;
  meta: Record<string, unknown>;
}

/** The system actor for calls without a signed-in user (auth turned off). */
export const ANONYMOUS_ACTOR: AuditActor = { kind: 'system', id: 'anonymous' };

/** Turns pipeline facts into audit rows: a signed-in caller is a user actor, anyone else the anonymous actor. */
export function toolCallRecorder(log: AuditLog, clock: AuditClock): (facts: ToolCallFacts) => number {
  return facts => {
    const login = facts.caller?.login;
    const actor: AuditActor = login
      ? { kind: 'user', login, ...(facts.caller?.clientId !== undefined ? { clientId: facts.caller.clientId } : {}) }
      : ANONYMOUS_ACTOR;
    return recordToolCall(log, clock, {
      actor, brain: facts.brain, tool: facts.tool, startedAtMs: facts.startedAtMs, outcome: facts.outcome,
      ...(facts.errorKind ? { errorKind: facts.errorKind } : {}), meta: facts.meta
    });
  };
}
