import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { immediateTransaction, openSqliteDatabase } from '../../shared/sqlite-database.js';
import type { ItemState, LinkItem, PageKind, ProposalItem, ProposalStatus, UpsertPageItem } from '../domain/wiki.js';
import type { DecisionRecord, PageSummary, ProposalListing, StoredItem, StoredProposal, WikiStore } from '../application/ports.js';
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

  proposals(filter: { status?: ProposalStatus }, limit: number): ProposalListing[] {
    const where = filter.status !== undefined ? 'WHERE p.status = ?' : '';
    const params: SQLInputValue[] = filter.status !== undefined ? [filter.status, limit] : [limit];
    return this.db.prepare(
      `SELECT p.*, (SELECT COUNT(*) FROM proposal_items i WHERE i.proposal_id = p.id AND i.state = 'pending') AS pending
       FROM proposals p ${where} ORDER BY p.id DESC LIMIT ?`
    ).all(...params).map(row => ({
      id: Number(row.id),
      revision: Number(row.revision),
      status: String(row.status) as ProposalStatus,
      proposer: row.proposer === null ? null : String(row.proposer),
      summary: String(row.summary),
      pendingItems: Number(row.pending),
      createdAtMs: Number(row.created_at_ms),
      updatedAtMs: Number(row.updated_at_ms)
    }));
  }

  decisions(proposalId: number): DecisionRecord[] {
    return this.db.prepare('SELECT * FROM decisions WHERE proposal_id = ? ORDER BY id').all(proposalId).map(row => ({
      id: Number(row.id),
      action: String(row.action) as DecisionRecord['action'],
      proposalRevision: Number(row.proposal_revision),
      itemIds: JSON.parse(String(row.item_ids)) as number[],
      decidedBy: row.decided_by === null ? null : String(row.decided_by),
      comment: row.comment === null ? null : String(row.comment),
      decidedAtMs: Number(row.decided_at_ms),
      undoneBy: row.undone_by === null ? null : Number(row.undone_by)
    }));
  }

  insertDecision(d: { proposalId: number; proposalRevision: number; action: DecisionRecord['action']; itemIds: readonly number[]; fingerprint: string | null; decidedBy: string | null; comment: string | null; atMs: number }): number {
    return Number(this.db.prepare(
      'INSERT INTO decisions (proposal_id, proposal_revision, action, item_ids, fingerprint, decided_by, comment, decided_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(d.proposalId, d.proposalRevision, d.action, JSON.stringify(d.itemIds), d.fingerprint, d.decidedBy, d.comment, d.atMs).lastInsertRowid);
  }

  appendRevision(item: UpsertPageItem, by: { decisionId: number; createdBy: string | null; atMs: number }): number {
    this.db.prepare('INSERT INTO pages (slug) VALUES (?) ON CONFLICT (slug) DO NOTHING').run(item.slug);
    const pageId = Number(this.db.prepare('SELECT id FROM pages WHERE slug = ?').get(item.slug)!.id);
    const revNo = Number(this.db.prepare('SELECT COALESCE(MAX(rev_no), 0) + 1 AS n FROM page_revisions WHERE page_id = ?').get(pageId)!.n);
    const revisionId = this.db.prepare(
      'INSERT INTO page_revisions (page_id, rev_no, kind, title, body, citations, decision_id, created_by, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(pageId, revNo, item.kind, item.title, item.body, JSON.stringify(item.citations), by.decisionId, by.createdBy, by.atMs).lastInsertRowid;
    this.db.prepare('UPDATE pages SET current_revision_id = ? WHERE id = ?').run(revisionId, pageId);
    return revNo;
  }

  livePageId(slug: string): number | undefined {
    const row = this.db.prepare('SELECT id FROM pages WHERE slug = ? AND current_revision_id IS NOT NULL').get(slug);
    return row === undefined ? undefined : Number(row.id);
  }

  liveLinkId(item: LinkItem): number | undefined {
    const row = this.db.prepare(
      `SELECT l.id FROM links l JOIN pages f ON f.id = l.from_page JOIN pages t ON t.id = l.to_page
       WHERE f.slug = ? AND t.slug = ? AND l.type = ? AND l.removed_by_decision IS NULL`
    ).get(item.from, item.to, item.type);
    return row === undefined ? undefined : Number(row.id);
  }

  insertLink(item: LinkItem, fromId: number, toId: number, decisionId: number): void {
    this.db.prepare('INSERT INTO links (from_page, to_page, type, citations, added_by_decision) VALUES (?, ?, ?, ?, ?)')
      .run(fromId, toId, item.type, JSON.stringify(item.citations), decisionId);
  }

  removeLink(linkId: number, decisionId: number): void {
    this.db.prepare('UPDATE links SET removed_by_decision = ? WHERE id = ?').run(decisionId, linkId);
  }

  setItemsState(itemIds: readonly number[], state: ItemState, decisionId: number): void {
    const update = this.db.prepare('UPDATE proposal_items SET state = ?, decision_id = ? WHERE id = ?');
    for (const id of itemIds) update.run(state, decisionId, id);
  }

  setProposalStatus(id: number, status: ProposalStatus, atMs: number): void {
    this.db.prepare('UPDATE proposals SET status = ?, updated_at_ms = ? WHERE id = ?').run(status, atMs, id);
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
