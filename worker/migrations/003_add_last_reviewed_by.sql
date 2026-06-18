-- Phase B migration 003: add actor field to the review-tracking trail.
--
-- Apply to a remote D1 database with:
--   wrangler d1 execute onlyphiles --remote --file=worker/migrations/003_add_last_reviewed_by.sql
--
-- Apply to staging D1 with:
--   wrangler d1 execute onlyphiles-staging --remote --file=worker/migrations/003_add_last_reviewed_by.sql
--
-- Pairs with migration 001's last_reviewed_at column. The worker auto-fills
-- last_reviewed_by from the verified CF Access JWT's `email` claim on every
-- successful admin PATCH (or the literal string 'shared-secret' when the
-- request used the X-Admin-Secret fallback).
--
-- Re-applying this migration is NOT safe — D1 returns "duplicate column
-- name" if the column already exists. Apply once.

ALTER TABLE people ADD COLUMN last_reviewed_by TEXT;

CREATE INDEX IF NOT EXISTS idx_people_last_reviewed_by ON people(last_reviewed_by);
