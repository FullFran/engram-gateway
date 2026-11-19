/**
 * Host path arguments (#6 follow-up). Some Engram tools take `cwd` or
 * `directory`: a path on the machine that runs `engram`, which behind the
 * gateway is the gateway host, not the client's. Engram reads that directory
 * and its git remote to detect a project, so any caller (a reader through
 * `mem_current_project`) could probe the host filesystem. The client's own
 * paths mean nothing there either, so both arguments are dropped from every
 * tool call before it is forwarded; the brain's child then uses its own
 * project settings. The audit row counts how many were dropped.
 */
import type { RequestStage } from './tool-call-pipeline.js';

export const HOST_PATH_ARGUMENTS: ReadonlySet<string> = new Set(['cwd', 'directory']);

export const stripHostPaths: RequestStage = ctx => {
  const args = ctx.request.arguments;
  if (!args) return ctx;
  const kept: Record<string, unknown> = {};
  let dropped = 0;
  for (const [key, value] of Object.entries(args)) {
    if (HOST_PATH_ARGUMENTS.has(key)) dropped += 1;
    else kept[key] = value;
  }
  if (dropped === 0) return ctx;
  return { ...ctx, request: { ...ctx.request, arguments: kept }, meta: { ...ctx.meta, hostPathArguments: dropped } };
};
