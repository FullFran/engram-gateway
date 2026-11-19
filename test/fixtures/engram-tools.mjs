// Every tool `engram mcp` (3.7.2, profile `all`) lists. scripts/check-bridge.mjs
// compares the live list against TOOL_ROLES, so a new engram tool fails CI.
export const ENGRAM_TOOLS = [
  'mem_capture_passive', 'mem_compare', 'mem_consolidate', 'mem_context', 'mem_current_project', 'mem_delete', 'mem_doctor',
  'mem_get_observation', 'mem_judge', 'mem_judge_many', 'mem_list_projects', 'mem_merge_projects', 'mem_pin', 'mem_review',
  'mem_save', 'mem_save_prompt', 'mem_search', 'mem_search_prompts', 'mem_session_end', 'mem_session_finalize',
  'mem_session_start', 'mem_session_summary', 'mem_stats', 'mem_suggest_topic_key', 'mem_timeline', 'mem_unpin', 'mem_update'
];
