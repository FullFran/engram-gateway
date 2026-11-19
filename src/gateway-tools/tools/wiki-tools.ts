import { isRole } from '../../authz/domain/role.js';
import { LINK_TYPES, PACK_LIMITS, PAGE_KINDS, WIKI_LIMITS, WIKI_TOOLS, WikiError, type WikiActor, type WikiService } from '../../wiki/index.js';
import { toolError, type GatewayTool, type GatewayToolContext, type GatewayToolResult } from '../domain/gateway-tool.js';

/**
 * The wiki tools (#16). Each is a thin adapter over one `WikiService` use
 * case: the service checks the role again and does the work; the tool turns
 * the outcome into a result. Results go through the pipeline's wrap stage, so
 * journal entries, page text and warnings reach the agent as delimited data.
 */
export function createWikiTools(wiki: WikiService): GatewayTool[] {
  return [
    {
      definition: {
        name: WIKI_TOOLS.compilePack,
        description:
          `A bounded pack of this brain's journal (engram observations, oldest first) for you to compile into wiki pages with ${WIKI_TOOLS.propose}. ` +
          'Automatic noise rows (checkpoint, passive, task-state) and deleted rows are skipped; contents are cut at maxChars. ' +
          `Continues after the highest observation any proposal cited unless afterId is given; pass nextAfterId to read on. Also lists existing pages to link to.`,
        inputSchema: {
          type: 'object',
          properties: {
            afterId: { type: 'integer', minimum: 0, description: 'Return observations with a larger id.' },
            limit: { type: 'integer', minimum: 1, description: `Observations returned (default ${PACK_LIMITS.defaultLimit}, at most ${PACK_LIMITS.maxLimit}).` },
            maxChars: { type: 'integer', minimum: 0, description: `Characters of content per observation (default ${PACK_LIMITS.defaultMaxChars}, ${PACK_LIMITS.minMaxChars} to ${PACK_LIMITS.maxMaxChars}).` },
            project: { type: 'string', description: 'Only observations of this engram project.' }
          },
          additionalProperties: false
        },
        annotations: { title: 'Wiki: compile pack', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      call: async (args, ctx) => run(ctx, (actor, brain) => wiki.compilePack(actor, brain, args))
    },
    {
      definition: {
        name: WIKI_TOOLS.propose,
        description:
          'Propose wiki changes for a brain owner to review: typed pages and typed links, each citing the sync_ids of the observations it comes from. ' +
          'Nothing changes the wiki until an owner approves. Pass proposalId to revise your open or returned proposal (its pending items are replaced). ' +
          'Returns the item ids and warnings (duplicate title, broken link, stale page, open conflict, missing citation); warnings never block.',
        inputSchema: {
          type: 'object',
          properties: {
            summary: { type: 'string', maxLength: WIKI_LIMITS.maxSummaryChars, description: 'What this proposal changes and why.' },
            proposalId: { type: 'integer', minimum: 1, description: 'Revise this proposal instead of opening a new one.' },
            items: {
              type: 'array',
              minItems: 1,
              maxItems: WIKI_LIMITS.maxItems,
              items: {
                type: 'object',
                properties: {
                  op: { type: 'string', enum: ['upsert_page', 'link', 'unlink'] },
                  slug: { type: 'string', description: 'upsert_page: the page id (lowercase letters, digits, dashes).' },
                  kind: { type: 'string', enum: [...PAGE_KINDS], description: 'upsert_page: the page type.' },
                  title: { type: 'string', maxLength: WIKI_LIMITS.maxTitleChars },
                  body: { type: 'string', maxLength: WIKI_LIMITS.maxBodyChars, description: 'upsert_page: the page content (markdown).' },
                  baseRevision: { type: ['integer', 'null'], description: 'upsert_page: the page revision you read; null or absent for a new page.' },
                  from: { type: 'string', description: 'link/unlink: source page slug.' },
                  to: { type: 'string', description: 'link/unlink: target page slug.' },
                  type: { type: 'string', enum: [...LINK_TYPES], description: 'link/unlink: the link type.' },
                  citations: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: WIKI_LIMITS.maxCitations, description: 'Observation sync_ids this item is based on.' }
                },
                required: ['op', 'citations']
              }
            }
          },
          required: ['summary', 'items'],
          additionalProperties: false
        },
        annotations: { title: 'Wiki: propose', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
      },
      call: async (args, ctx) => run(ctx, (actor, brain) => wiki.propose(actor, brain, args))
    }
  ];
}

/** The caller as the wiki sees it: login and the role the pipeline's authorize stage decided. */
export function wikiActor(ctx: GatewayToolContext): WikiActor {
  const role = ctx.caller?.role;
  return { ...(ctx.caller?.login !== undefined ? { login: ctx.caller.login } : {}), ...(isRole(role) ? { role } : {}) };
}

/** Runs a use case; a `WikiError` or a busy database becomes a tool error, anything else is thrown (and audited as an error). */
export function run(ctx: GatewayToolContext, work: (actor: WikiActor, brain: string) => unknown): GatewayToolResult {
  if (ctx.brain === null) return toolError('the wiki tools need a brain: call them on /mcp/<brain>, or pass "brain" on /mcp');
  try {
    return { content: [{ type: 'text', text: JSON.stringify(work(wikiActor(ctx), ctx.brain)) }] };
  } catch (error) {
    if (error instanceof WikiError) return toolError(error.message);
    if (isBusy(error)) return toolError(`brain ${ctx.brain} wiki is busy; retry shortly`);
    throw error;
  }
}

function isBusy(error: unknown): boolean {
  const code = (error as { errcode?: unknown })?.errcode;
  return typeof code === 'number' && ((code & 0xff) === 5 || (code & 0xff) === 6);
}
