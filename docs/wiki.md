# Curated wiki

An engram brain is a flat journal: every observation an agent saves, about a
third of them short automatic rows. The wiki (#16) is a second layer per
brain: pages and typed links that agents compile from the journal and a
brain owner approves. The gateway runs no model: the calling agent compiles
and proposes; the gateway validates, stores and enforces review.

## Storage

Each brain has its own `wiki.db` next to its `engram.db`
(`<BRAINS_ROOT>/<slug>/wiki.db`), never inside `engram.db` and never in the
gateway database. The brain directory stays the isolation unit, and backups
already include `wiki.db` with the brain's other databases. The file is
created by the first proposal; reading a brain without one returns an empty
wiki. The schema lives in `src/wiki/infrastructure/wiki-migrations.ts`
(versioned with `PRAGMA user_version`, like the gateway database).

| Table | Holds |
| --- | --- |
| `proposals`, `proposal_items` | What agents proposed; `revision` grows on every change. |
| `decisions` | Every review decision, with the fingerprint it was bound to. |
| `pages`, `page_revisions` | Pages and their append-only history. |
| `links` | Typed links between pages; a removed link is marked, never deleted. |

The wiki is opened per call and every use case runs as one SQLite
transaction (`BEGIN IMMEDIATE`, so two gateways sharing the file during a
deploy take turns). While a restore holds the brain, wiki calls are refused
with "being restored; retry shortly", so a decision never races the file swap.

## Flow

1. **`brain_compile_pack`** (writer): a bounded pack of the brain's journal,
   read from `engram.db` opened read-only (never through the `engram mcp`
   child). Live observations oldest first, skipping the automatic noise types
   (`checkpoint`, `passive`, `task-state`) and deleted rows. Arguments:
   `afterId` (default: the highest observation any proposal cited, so
   repeated calls move forward), `limit` (default 50, at most 200),
   `maxChars` per content (default 2000, 100 to 8000; cut rows say
   `truncated`), `project`. Returns `nextAfterId` and `more` to read on, and
   up to 200 existing pages to link to.
2. **`brain_propose`** (writer): typed pages and typed links, each citing the
   `sync_id`s of the observations it comes from.
   - `upsert_page`: `slug` (lowercase letters, digits, dashes), `kind`
     (`concept`, `decision`, `component`, `procedure`), `title`, `body`
     (markdown, up to 20,000 characters), `citations`, and `baseRevision`
     (the revision read; absent for a new page).
   - `link` / `unlink`: `from`, `to`, `type` (`depends_on`, `part_of`,
     `supersedes`, `contradicts`), `citations`.
   - At most 50 items. `proposalId` revises an open or returned proposal
     (its proposer or an owner): its pending items are replaced, item ids are
     never reused, and the revision grows.

   Nothing changes the wiki until an owner approves.

## Warnings

Returned with every proposal; they never block it or its approval.

| Code | When |
| --- | --- |
| `duplicate_title` | Another page (or item) has the same title, case-insensitive. |
| `broken_link` | A link end is neither a page nor proposed here; an `unlink` names no live link. |
| `stale_page` | The page's current revision is not the item's `baseRevision`. |
| `open_conflict` | A `contradicts` link, or another open proposal touches the same page. |
| `missing_citation` | A cited `sync_id` is deleted or not in this brain. |

## Security

- **Roles** come from `GATEWAY_TOOL_ROLES` (`src/authz`). The use cases in
  `src/wiki/application/wiki-service.ts` check the caller's role themselves,
  against the same table, so any entry point (the MCP tools, the review UI of
  #17) gets the same rule.
- **Redaction (#9):** `brain_propose` arguments go through the redact stage
  before they are stored, like any write tool.
- **Data, not instructions (#19):** every wiki result (journal entries, page
  text, warnings, errors) is wrapped as `memory-data` by the wrap stage.
- **Audit (#8):** every call is in the audit log. Page text and proposal
  text never reach the logs.
- **Connections (#27):** on `/mcp`, the wiki tools take the `brain` argument
  like any brain tool. None fans out: page slugs and ids are per brain.
