-- Payment columns for the bootcamp registration fee.
--
-- Apply with:
--   npx wrangler d1 execute dystil-submissions --remote --file=migrations/0002-add-payment-columns.sql
--
-- Rows that predate payments, and the forms that were never paid for, keep NULL
-- here. Only a registration that owes a fee is given a status, so "unpaid" on
-- the submissions page always means somebody still owes money.

ALTER TABLE submissions ADD COLUMN payment_status TEXT;
ALTER TABLE submissions ADD COLUMN payment_amount INTEGER;
ALTER TABLE submissions ADD COLUMN stripe_session_id TEXT;

CREATE INDEX IF NOT EXISTS submissions_payment_status ON submissions (payment_status);
