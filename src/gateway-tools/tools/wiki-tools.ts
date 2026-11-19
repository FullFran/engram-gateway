import { isRole } from '../../authz/domain/role.js';
import { DECISION_ACTIONS, LINK_TYPES, PACK_LIMITS, PAGE_KINDS, PROPOSALS_LIMITS, READ_LIMITS, WIKI_LIMITS, WIKI_TOOLS, WikiError, type WikiActor, type WikiService } from '../../wiki/index.js';
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
    },
    {
      definition: {
        name: WIKI_TOOLS.proposals,
        description: 'Wiki proposals of this brain, newest first, with their status (open, returned, rejected, closed) and number of pending items.',
        inputSchema: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['open', 'returned', 'rejected', 'closed'] },
            limit: { type: 'integer', minimum: 1, description: `Proposals returned (default ${PROPOSALS_LIMITS.defaultLimit}, at most ${PROPOSALS_LIMITS.maxLimit}).` }
          },
          additionalProperties: false
        },
        annotations: { title: 'Wiki: proposals', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      call: async (args, ctx) => run(ctx, (actor, brain) => wiki.proposals(actor, brain, args))
    },
    {
      definition: {
        name: WIKI_TOOLS.review,
        description:
          'Read one proposal for review: its pending items, the current revision of every page they touch, warnings, past decisions, and a fingerprint of the selection ' +
          `(itemIds, default every pending item). ${WIKI_TOOLS.decide} approves only with that fingerprint, so a proposal or page that changed since is never approved unread.`,
        inputSchema: {
          type: 'object',
          properties: {
            proposalId: { type: 'integer', minimum: 1 },
            itemIds: { type: 'array', items: { type: 'integer', minimum: 1 }, minItems: 1, description: 'The items you intend to approve (default: every pending item).' }
          },
          required: ['proposalId'],
          additionalProperties: false
        },
        annotations: { title: 'Wiki: review a proposal', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      call: async (args, ctx) => run(ctx, (actor, brain) => wiki.review(actor, brain, args))
    },
    {
      definition: {
        name: WIKI_TOOLS.decide,
        description:
          `Decide on a proposal (brain owners). approve: apply the selected items (itemIds, default every pending item) with the fingerprint ${WIKI_TOOLS.review} returned for that selection; ` +
          'all of them or none, and the rest stay pending. return: send it back to its proposer with a comment. reject: close it.',
        inputSchema: {
          type: 'object',
          properties: {
            proposalId: { type: 'integer', minimum: 1 },
            action: { type: 'string', enum: [...DECISION_ACTIONS] },
            itemIds: { type: 'array', items: { type: 'integer', minimum: 1 }, minItems: 1, description: 'approve only: the items to apply.' },
            fingerprint: { type: 'string', description: `approve: the fingerprint ${WIKI_TOOLS.review} returned for this selection.` },
            comment: { type: 'string', maxLength: WIKI_LIMITS.maxCommentChars }
          },
          required: ['proposalId', 'action'],
          additionalProperties: false
        },
        annotations: { title: 'Wiki: decide', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
      },
      call: async (args, ctx) => run(ctx, (actor, brain) => wiki.decide(actor, brain, args))
    },
    {
      definition: {
        name: WIKI_TOOLS.page,
        description: `Read one approved wiki page: its current revision (or an older one), citations, and its revision history (newest first, at most ${READ_LIMITS.maxHistory}).`,
        inputSchema: {
          type: 'object',
          properties: {
            slug: { type: 'string' },
            revision: { type: 'integer', minimum: 1, description: 'An older revision number (default: the current one).' }
          },
          required: ['slug'],
          additionalProperties: false
        },
        annotations: { title: 'Wiki: page', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      call: async (args, ctx) => run(ctx, (actor, brain) => wiki.page(actor, brain, args))
    },
    {
      definition: {
        name: WIKI_TOOLS.pages,
        description: 'List approved wiki pages by slug, optionally only those whose slug or title contains query, or of one kind; returns how many match.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', maxLength: READ_LIMITS.maxQueryChars, description: 'Text the slug or title contains (case-insensitive).' },
            kind: { type: 'string', enum: [...PAGE_KINDS] },
            limit: { type: 'integer', minimum: 1, description: `Pages returned (default ${READ_LIMITS.defaultLimit}, at most ${READ_LIMITS.maxLimit}).` }
          },
          additionalProperties: false
        },
        annotations: { title: 'Wiki: pages', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      call: async (args, ctx) => run(ctx, (actor, brain) => wiki.pages(actor, brain, args))
    },
    {
      definition: {
        name: WIKI_TOOLS.neighbors,
        description: 'The typed links of an approved page, one hop: outgoing (direction out) then incoming (direction in), with the linked page title.',
        inputSchema: {
          type: 'object',
          properties: {
            slug: { type: 'string' },
            types: { type: 'array', items: { type: 'string', enum: [...LINK_TYPES] }, minItems: 1, description: 'Only these link types.' },
            limit: { type: 'integer', minimum: 1, description: `Links returned (default ${READ_LIMITS.defaultLimit}, at most ${READ_LIMITS.maxLimit}); more tells whether there are others.` }
          },
          required: ['slug'],
          additionalProperties: false
        },
        annotations: { title: 'Wiki: neighbors', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      call: async (args, ctx) => run(ctx, (actor, brain) => wiki.neighbors(actor, brain, args))
    },
    {
      definition: {
        name: WIKI_TOOLS.undo,
        description:
          'Undo one approval (brain owners), all or nothing: pages it wrote go back to their previous revision (or out of the wiki if it created them), links it added are removed and links it removed come back. ' +
          'Refused when something it touched changed afterwards; undo the later decision first. History is kept.',
        inputSchema: {
          type: 'object',
          properties: { decisionId: { type: 'integer', minimum: 1, description: 'The approval to undo (decisionId from brain_decide, or decisions in brain_review).' } },
          required: ['decisionId'],
          additionalProperties: false
        },
        annotations: { title: 'Wiki: undo a decision', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
      },
      call: async (args, ctx) => run(ctx, (actor, brain) => wiki.undo(actor, brain, args))
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
