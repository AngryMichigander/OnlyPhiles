-- Phase B migration: add review-tracking fields to the `people` table.
--
-- Apply to a remote D1 database with:
--   wrangler d1 execute onlyphiles --remote --file=worker/migrations/001_add_review_fields.sql
--
-- Apply to a local D1 database (development) with:
--   wrangler d1 execute onlyphiles --local --file=worker/migrations/001_add_review_fields.sql
--
-- Notes:
-- * SQLite's `ALTER TABLE ... ADD COLUMN` is additive and non-blocking.
-- * Both columns are nullable; existing rows get NULL automatically.
-- * The partial index on `flagged_reason` only stores rows where the
--   column is non-null, keeping the index small even after the
--   bulk-import of audit findings (migration 002).
-- * Re-applying this migration is NOT safe — D1 returns an error
--   ("duplicate column name") if the columns already exist. Apply once.

ALTER TABLE people ADD COLUMN last_reviewed_at TEXT;
ALTER TABLE people ADD COLUMN flagged_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_people_flagged
  ON people(flagged_reason)
  WHERE flagged_reason IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_people_last_reviewed
  ON people(last_reviewed_at);
