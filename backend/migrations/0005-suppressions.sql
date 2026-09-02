-- Somebody who asks not to be emailed again is not emailed again.
--
-- Apply with:
--   npx wrangler d1 execute dystil-submissions --remote --file=migrations/0005-suppressions.sql
--
-- The rosters are built from the submissions table, so an address is held here
-- rather than by deleting the row it came from. The registration still
-- happened, the business record of it is kept, and the person is left alone.
-- Deleting the submission would lose the record and would not even work: they
-- could register again tomorrow and be back on the list.
--
-- This stops broadcasts only. A confirmation for a form somebody fills in
-- afterwards is a reply to them, not a mailing, and still sends.
CREATE TABLE IF NOT EXISTS suppressions (
    email TEXT PRIMARY KEY,
    reason TEXT,
    added_at TEXT NOT NULL
);
