import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { immediateTransaction, openSqliteDatabase } from '../../shared/sqlite-database.js';
import type { ItemState, PageKind, ProposalItem, ProposalStatus } from '../domain/wiki.js';
import type { PageSummary, StoredItem, StoredProposal, WikiStore } from '../application/ports.js';
import { WIKI_MIGRATIONS } from './wiki-migrations.js';

export const WIKI_DB_FILE = 'wiki.db';

/**
 * Opens `<dataDir>/wiki.db` (WAL, 0600, migrated), next to the brain's
 * `engram.db`: the brain directory stays the isolation and backup unit.
 * With `create: false`, a brain without a wiki yet gives undefined and no file is made.
 */
export function openSqliteWikiStore(dataDir: string, opts: { create: boolean }): WikiStore | undefined {
  const path = join(dataDir, WIKI_DB_FILE);
  if (!opts.create && !existsSync(path)) return undefined;
  return new SqliteWikiStore(openSqliteDatabase(path, WIKI_MIGRATIONS));
}

const LIVE_PAGE = `pages p JOIN page_revisions r ON r.id = p.current_revision_id`;

class SqliteWikiStore implements WikiStore {
  constructor(private readonly db: DatabaseSync) {}

  transaction<T>(work: () => T): T {
    return immediateTransaction(this.db, work);
  }

  meta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row === undefined ? undefined : String(row.value);
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  insertProposal(input: { summary: string; proposer: string | null; atMs: number; items: readonly ProposalItem[] }): number {
    const id = Number(this.db
      .prepare("INSERT INTO proposals (revision, status, proposer, summary, created_at_ms, updated_at_ms) VALUES (1, 'open', ?, ?, ?, ?)")
      .run(input.proposer, input.summary, input.atMs, input.atMs).lastInsertRowid);
    this.insertItems(id, input.items, 0);
    return id;
  }

  reviseProposal(id: number, input: { summary: string; atMs: number; items: readonly ProposalItem[] }): void {
    this.db.prepare("DELETE FROM proposal_items WHERE proposal_id = ? AND state = 'pending'").run(id);
    const last = Number(this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM proposal_items WHERE proposal_id = ?').get(id)?.n ?? 0);
    this.insertItems(id, input.items, last);
    this.db.prepare("UPDATE proposals SET revision = revision + 1, status = 'open', summary = ?, updated_at_ms = ? WHERE id = ?").run(input.summary, input.atMs, id);
  }

  private insertItems(proposalId: number, items: readonly ProposalItem[], afterSeq: number): void {
    const insert = this.db.prepare("INSERT INTO proposal_items (proposal_id, seq, op, payload, page_slug, other_slug, state) VALUES (?, ?, ?, ?, ?, ?, 'pending')");
    items.forEach((item, index) => {
      const [page, other] = item.op === 'upsert_page' ? [item.slug, null] : [item.from, item.to];
      insert.run(proposalId, afterSeq + index + 1, item.op, JSON.stringify(item), page, other);
    });
  }

  proposal(id: number): StoredProposal | undefined {
    const row = this.db.prepare('SELECT * FROM proposals WHERE id = ?').get(id);
    if (!row) return undefined;
    const items: StoredItem[] = this.db
      .prepare('SELECT id, payload, state FROM proposal_items WHERE proposal_id = ? ORDER BY seq')
      .all(id)
      .map(item => ({ id: Number(item.id), item: JSON.parse(String(item.payload)) as ProposalItem, state: String(item.state) as ItemState }));
    return {
      id,
      revision: Number(row.revision),
      status: String(row.status) as ProposalStatus,
      proposer: row.proposer === null ? null : String(row.proposer),
      summary: String(row.summary),
      createdAtMs: Number(row.created_at_ms),
      updatedAtMs: Number(row.updated_at_ms),
      items
    };
  }

  page(slug: string): PageSummary | undefined {
    const row = this.db.prepare(`SELECT p.slug, r.kind, r.title, r.rev_no FROM ${LIVE_PAGE} WHERE p.slug = ?`).get(slug);
    return row ? toSummary(row) : undefined;
  }

  pagesTitled(title: string): string[] {
    return this.db
      .prepare(`SELECT p.slug FROM ${LIVE_PAGE} WHERE lower(trim(r.title)) = lower(trim(?)) ORDER BY p.slug`)
      .all(title)
      .map(row => String(row.slug));
  }

  hasLiveLink(from: string, to: string, type: string): boolean {
    return this.db.prepare(
      `SELECT 1 AS found FROM links l JOIN pages f ON f.id = l.from_page JOIN pages t ON t.id = l.to_page
       WHERE f.slug = ? AND t.slug = ? AND l.type = ? AND l.removed_by_decision IS NULL`
    ).get(from, to, type) !== undefined;
  }

  otherProposalsTouching(slug: string, proposalId: number): number[] {
    return this.db.prepare(
      `SELECT DISTINCT i.proposal_id AS id FROM proposal_items i JOIN proposals p ON p.id = i.proposal_id
       WHERE i.state = 'pending' AND p.status IN ('open', 'returned') AND i.proposal_id <> ? AND (i.page_slug = ? OR i.other_slug = ?)
       ORDER BY i.proposal_id`
    ).all(proposalId, slug, slug).map(row => Number(row.id));
  }

  pages(limit: number): { pages: PageSummary[]; total: number } {
    const total = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM ${LIVE_PAGE}`).get()?.n ?? 0);
    const pages = this.db.prepare(`SELECT p.slug, r.kind, r.title, r.rev_no FROM ${LIVE_PAGE} ORDER BY p.slug LIMIT ?`).all(limit).map(toSummary);
    return { pages, total };
  }

  close(): void {
    this.db.close();
  }
}

function toSummary(row: Record<string, SQLInputValue>): PageSummary {
  return { slug: String(row.slug), kind: String(row.kind) as PageKind, title: String(row.title), revision: Number(row.rev_no) };
}
