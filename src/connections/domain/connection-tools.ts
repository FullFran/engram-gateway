import { isRole } from '../../authz/domain/role.js';
import type { Role } from '../../authz/domain/role.js';

/**
 * The arguments of a connection tool (#27), checked before anything runs.
 * `brain` here is the brain the tool acts on (attach, detach), not a routing
 * choice; brain_list, connection_brains and brain_resolve act on the whole
 * connection (brain_resolve checks its own `remote` and never fails).
 */
export type ConnectionToolArguments =
  | { tool: 'brain_list' | 'connection_brains' | 'brain_resolve' }
  | { tool: 'connection_attach'; brain: string; role: Role; makeDefault: boolean }
  | { tool: 'connection_detach'; brain: string };

export type ParsedConnectionTool = { ok: true; args: ConnectionToolArguments } | { ok: false; message: string };

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Parses a connection tool's arguments; pure. Unknown tools and bad arguments are refused with a message. */
export function parseConnectionTool(tool: string, args: unknown): ParsedConnectionTool {
  const input = args === undefined ? {} : args;
  if (!isObject(input)) return { ok: false, message: 'Arguments must be an object.' };
  switch (tool) {
    case 'brain_list':
    case 'connection_brains':
    case 'brain_resolve':
      return { ok: true, args: { tool } };
    case 'connection_attach': {
      const { brain, role } = input;
      const makeDefault = input.default ?? false;
      if (typeof brain !== 'string' || brain === '') return { ok: false, message: '`brain` must name a brain.' };
      if (!isRole(role)) return { ok: false, message: '`role` must be reader, writer or owner.' };
      if (typeof makeDefault !== 'boolean') return { ok: false, message: '`default` must be true or false.' };
      return { ok: true, args: { tool, brain, role, makeDefault } };
    }
    case 'connection_detach': {
      const { brain } = input;
      if (typeof brain !== 'string' || brain === '') return { ok: false, message: '`brain` must name a brain.' };
      return { ok: true, args: { tool, brain } };
    }
    default:
      return { ok: false, message: `${tool} is not a connection tool.` };
  }
}
