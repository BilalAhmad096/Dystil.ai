-- Records where each submission came from: Instagram, TikTok, a search, or a
-- direct visit. Run once against the existing database.
--
-- Apply with:
--   npx wrangler d1 execute dystil-submissions --remote --file=migrations/0001-add-source-columns.sql
--
-- SQLite has no "ADD COLUMN IF NOT EXISTS", so a second run reports a duplicate
-- column and changes nothing. That error is safe to ignore.

ALTER TABLE submissions ADD COLUMN source_channel TEXT;
ALTER TABLE submissions ADD COLUMN source_detail TEXT;
ALTER TABLE submissions ADD COLUMN source_landing TEXT;

CREATE INDEX IF NOT EXISTS submissions_source_channel ON submissions (source_channel);
