# Brain health report

A per-brain report computed from the brain's `engram.db` (`src/health`).

## Guarantees

- **Read-only.** The database is opened with `node:sqlite` `readOnly: true`
  and `PRAGMA query_only = ON`, directly, never through the brain's
  `engram mcp` child. A WAL database that a running child holds open is read
  at a consistent snapshot. A brain with no `engram.db` raises
  `BrainHealthUnavailableError`; no file is created.
- **Bounded.** The report carries counts and at most `sampleSize` ids per
  finding (default 5, clamped to 0-50, lowest ids first) and at most
  `maxTypes` type rows (default 50, clamped to 0-200). It never carries
  titles or contents. On a real 13k-observation brain it is about 1.6 KB of
  JSON.

## Findings

All observation findings count live rows only (`deleted_at IS NULL`).

| Field | Meaning |
|-------|---------|
| `observations.live`, `observations.deleted` | Live and soft-deleted observations. |
| `byType.top` | Live observations per type, count descending then type ascending, capped at `maxTypes`. `otherTypes` / `otherCount` sum what the cap left out. |
| `noise` | Live rows of the automatic types `checkpoint`, `passive`, `task-state`; `share` is `count / live`, rounded to 4 decimals. |
| `duplicateTitles` | Titles shared by two or more live rows (exact match): `groups`, `rows` in those groups, and `excessRows = rows - groups`. |
| `pendingRelations` | `memory_relations` rows with `judgment_status = 'pending'` that are not superseded. `null` when the brain's Engram has no relations table. |
| `pastReviewAfter` | Live rows whose `review_after` is before the report time. Unparseable dates are skipped. |
| `wiki` | Extension point, always `{ status: 'unavailable' }` until the curated wiki (#16). |
| `semanticIndex` | Extension point, always `{ status: 'unavailable' }` until the vector index (#14). |

## Extending

A new finding is one method on the `BrainHealthSource` port
(`src/health/application/ports.ts`), its SQL in the adapter
(`src/health/infrastructure/engram-db-source.ts`) and one field in
`buildHealthReport`. Wiki staleness and index lag will read their own SQLite
files (`wiki.db`, `vectors.db`) through new sources and replace the
`unavailable` placeholders.

## Exposure

- MCP tool `brain_health` (a gateway tool, see
  [gateway-tools.md](gateway-tools.md)): role `owner` on the brain. The
  report is returned as JSON text, delimited as data by the wrap stage (#19),
  since observation type names are chosen by writers.
- `GET /admin/brains/<slug>/health?sampleSize=&maxTypes=`: instance admins
  only. `401` without credentials, `403` for a non-admin, `400
  {"error":"invalid_request"}` for bad options, `404` for an unknown brain or
  `{"error":"no_data"}` for a brain without `engram.db`.

Both add `brain` (the slug) to the report and go through one
`BrainHealthService` (`src/health/application/brain-health-service.ts`).
