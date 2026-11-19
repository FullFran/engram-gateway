import type { Migration } from '../../shared/sqlite-database.js';

/**
 * Schema of a brain's `wiki.db` (#16). Kept in code (not `.sql` files) so the
 * build needs no copy step. Append new migrations; never edit applied ones.
 *
 * - pages / page_revisions: append-only history; a page shows its current revision.
 * - links: typed links between pages; removing one marks it, never deletes it.
 * - proposals / proposal_items: what agents proposed; `revision` grows on every change.
 * - decisions: every review decision with the fingerprint it was bound to.
 */
export const WIKI_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'wiki',
    sql: `
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE proposals (
  id            INTEGER PRIMARY KEY,
  revision      INTEGER NOT NULL DEFAULT 1,
  status        TEXT    NOT NULL CHECK (status IN ('open', 'returned', 'rejected', 'closed')),
  proposer      TEXT,
  summary       TEXT    NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE decisions (
  id                INTEGER PRIMARY KEY,
  proposal_id       INTEGER NOT NULL REFERENCES proposals(id),
  proposal_revision INTEGER NOT NULL,
  action            TEXT    NOT NULL CHECK (action IN ('approve', 'return', 'reject', 'undo')),
  item_ids          TEXT    NOT NULL,
  fingerprint       TEXT,
  decided_by        TEXT,
  comment           TEXT,
  decided_at_ms     INTEGER NOT NULL,
  undoes            INTEGER REFERENCES decisions(id),
  undone_by         INTEGER REFERENCES decisions(id)
);

CREATE TABLE proposal_items (
  -- AUTOINCREMENT: a revised proposal never reuses the id of a replaced item.
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id INTEGER NOT NULL REFERENCES proposals(id),
  seq         INTEGER NOT NULL,
  op          TEXT    NOT NULL CHECK (op IN ('upsert_page', 'link', 'unlink')),
  payload     TEXT    NOT NULL,
  page_slug   TEXT    NOT NULL,
  other_slug  TEXT,
  state       TEXT    NOT NULL CHECK (state IN ('pending', 'applied', 'rejected')),
  decision_id INTEGER REFERENCES decisions(id)
);
CREATE INDEX proposal_items_by_proposal ON proposal_items (proposal_id, seq);
CREATE INDEX proposal_items_pending_page ON proposal_items (page_slug) WHERE state = 'pending';
CREATE INDEX proposal_items_pending_other ON proposal_items (other_slug) WHERE state = 'pending';

CREATE TABLE pages (
  id                  INTEGER PRIMARY KEY,
  slug                TEXT    NOT NULL UNIQUE,
  current_revision_id INTEGER
);

CREATE TABLE page_revisions (
  id            INTEGER PRIMARY KEY,
  page_id       INTEGER NOT NULL REFERENCES pages(id),
  rev_no        INTEGER NOT NULL,
  kind          TEXT    NOT NULL,
  title         TEXT    NOT NULL,
  body          TEXT    NOT NULL,
  citations     TEXT    NOT NULL,
  decision_id   INTEGER REFERENCES decisions(id),
  created_by    TEXT,
  created_at_ms INTEGER NOT NULL,
  UNIQUE (page_id, rev_no)
);

CREATE TABLE links (
  id                  INTEGER PRIMARY KEY,
  from_page           INTEGER NOT NULL REFERENCES pages(id),
  to_page             INTEGER NOT NULL REFERENCES pages(id),
  type                TEXT    NOT NULL,
  citations           TEXT    NOT NULL,
  added_by_decision   INTEGER REFERENCES decisions(id),
  removed_by_decision INTEGER REFERENCES decisions(id)
);
CREATE UNIQUE INDEX links_live ON links (from_page, to_page, type) WHERE removed_by_decision IS NULL;
CREATE INDEX links_to ON links (to_page) WHERE removed_by_decision IS NULL;
`
  }
];
