import type { Role } from './role.js';

/**
 * The minimum role for every tool `engram mcp` serves (engram 3.7.2, profile
 * `all`). The single source of tool permissions: `tools/list` shows a caller
 * only the tools allowed here, and `tools/call` refuses the rest.
 *
 * Deny by default: a tool missing from this table is refused for every role.
 * scripts/check-bridge.mjs compares this table with the live `tools/list` of
 * the engram binary, so a new engram tool fails CI until it gets a role here.
 *
 * - reader: reads memory and diagnostics without changing anything.
 * - writer: adds or changes memory (saves, sessions, judgments, pins, reviews).
 * - owner: destructive or brain-wide changes (deletes, merges, consolidation)
 *   and operational diagnostics of the instance.
 */
export const TOOL_ROLES: Readonly<Record<string, Role>> = Object.freeze(Object.assign(Object.create(null) as Record<string, Role>, {
  mem_context: 'reader',
  mem_current_project: 'reader',
  mem_get_observation: 'reader',
  mem_list_projects: 'reader',
  mem_search: 'reader',
  mem_search_prompts: 'reader',
  mem_stats: 'reader',
  mem_suggest_topic_key: 'reader',
  mem_timeline: 'reader',

  mem_capture_passive: 'writer',
  mem_compare: 'writer',
  mem_judge: 'writer',
  mem_judge_many: 'writer',
  mem_pin: 'writer',
  mem_review: 'writer',
  mem_save: 'writer',
  mem_save_prompt: 'writer',
  mem_session_end: 'writer',
  mem_session_finalize: 'writer',
  mem_session_start: 'writer',
  mem_session_summary: 'writer',
  mem_unpin: 'writer',
  mem_update: 'writer',

  mem_consolidate: 'owner',
  mem_delete: 'owner',
  mem_doctor: 'owner',
  mem_merge_projects: 'owner'
} satisfies Record<string, Role>));

/**
 * The minimum role for every tool the gateway serves itself (src/gateway-tools).
 * Kept apart from TOOL_ROLES, which mirrors engram's own tools exactly.
 *
 * - brain_health: owner (instance admins own every brain).
 */
export const GATEWAY_TOOL_ROLES: Readonly<Record<string, Role>> = Object.freeze(Object.assign(Object.create(null) as Record<string, Role>, {
  brain_health: 'owner'
} satisfies Record<string, Role>));

/** The minimum role for `tool` (engram's or the gateway's); undefined for a tool neither table knows (denied). */
export function requiredRole(tool: string): Role | undefined {
  if (Object.hasOwn(GATEWAY_TOOL_ROLES, tool)) return GATEWAY_TOOL_ROLES[tool];
  return Object.hasOwn(TOOL_ROLES, tool) ? TOOL_ROLES[tool] : undefined;
}
