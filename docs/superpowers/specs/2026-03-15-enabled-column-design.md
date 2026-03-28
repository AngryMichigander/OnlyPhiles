# Enabled Column Design Spec

**Date:** 2026-03-15
**Status:** Approved

## Problem

Some records in the database have data quality issues that need investigation before being shown publicly. There's no way to temporarily hide a record from the public frontend without deleting it from the database or removing it from `people.json` and reseeding.

**Immediate need:** Hide `aaron-bruns` while investigating a data issue.

## Design

### Core Concept

Add an `enabled` column to the `people` table that controls public visibility. This is **operational state** managed via the DB/admin API, not source data — it does not belong in `people.json`.

### Schema Change

Add to `people` table:
```sql
enabled INTEGER NOT NULL DEFAULT 1 -- 0 = hidden, 1 = visible
```

Default is `1` so all existing and newly seeded records are visible unless explicitly disabled.

### Migration Path

The schema uses `CREATE TABLE IF NOT EXISTS`, which will not add new columns to an existing table. For existing production and staging D1 databases, run an explicit migration:

```bash
# Production
npx wrangler d1 execute onlyphiles --remote --command="ALTER TABLE people ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;"

# Staging
npx wrangler d1 execute onlyphiles-staging --remote --command="ALTER TABLE people ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;" --env=preview
```

**Order of operations:** Run the `ALTER TABLE` first, then reseed if needed. The schema.sql file should also include the column for fresh databases.

### Seed Script Refactor (Upsert)

The current `seed-d1.js` deletes all rows then re-inserts from `people.json`. This would reset `enabled` on every reseed, defeating the purpose.

**Change:** Refactor to use `INSERT ... ON CONFLICT(id) DO UPDATE SET ...` (upsert) for the `people` table. The upsert updates all data columns from `people.json` but does **not** touch `enabled`, preserving admin overrides across reseeds.

For `crime_types` and `sources`, delete-and-reinsert per person (scoped to `WHERE person_id = ?`) rather than global `DELETE FROM`.

**Orphan cleanup:** After processing all people from JSON, add a cleanup step that removes rows from `people`, `crime_types`, and `sources` where the `id`/`person_id` is not in `people.json`. This handles the case where a person is removed from the JSON source entirely.

### Public API Changes

All public-facing queries add `enabled = 1` to their WHERE clause:

- **`GET /api/people`** — add `p.enabled = 1` to WHERE
- **`GET /api/people/:id`** — add `AND enabled = 1` to the SELECT; return 404 for disabled records
- **`GET /api/stats`** — add `WHERE enabled = 1` so counts reflect only visible records. The `crime_types` distinct query must also be filtered: `SELECT DISTINCT crime_type FROM crime_types WHERE person_id IN (SELECT id FROM people WHERE enabled = 1)`

### Admin API Changes

- **`GET /api/admin/people`** and **`GET /api/admin/people/:id`** — no `enabled` filter; admin sees all records
- **`PATCH /api/admin/people/:id`** — add `enabled` to the allowed fields list so admin can toggle visibility. Validate that `enabled` is one of `0`, `1`, `true`, or `false` (convert booleans to integers before storing).
- **`formatPerson`** — include `enabled` in the JSON response (as boolean)

### Distinguishing Public vs Admin Queries

`handlePeopleList` and `handlePersonById` are shared between public and admin routes. To add the `enabled` filter only for public requests, pass a parameter (e.g., `{ publicOnly: true }`) from the route handler, or add the WHERE clause conditionally based on whether the request came from an admin route.

**Chosen approach:** Add an optional `publicOnly` parameter to `handlePeopleList` and `handlePersonById`. Public routes pass `true`, admin routes pass `false` (or omit it).

### Cache Behavior

Public endpoints return `Cache-Control` headers with `max-age=300` (people list) and `max-age=3600` (single person, stats). When a record is disabled via admin API, cached responses may continue serving the record for up to an hour. This latency is acceptable for the use case (hiding records during data investigation, not emergency takedowns).

## Out of Scope

- No frontend UI changes (admin panel already uses PATCH; public frontend just won't see disabled records)
- No `enabled` field in `people.json`
- No bulk enable/disable endpoint
- No admin-specific stats endpoint

## Verification

- Existing tests updated to account for `enabled` column
- New test: disabled record returns 404 on public endpoint but 200 on admin endpoint
- New test: stats exclude disabled records
- New test: seed script upsert preserves `enabled` state
- `npm test` passes
