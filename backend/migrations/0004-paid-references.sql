-- Paid registrations are renumbered on the day the money arrives.
--
-- Apply with:
--   npx wrangler d1 execute dystil-submissions --remote --file=migrations/0004-paid-references.sql
--
-- A registration is held under DYS-BOT-26-0007 and recorded under
-- DYS-BOT-26-3108001, so the reference says when somebody actually joined. That
-- means the reference can no longer be what stops a retried webhook writing the
-- record twice, because a retry would draw a new number. The Stripe session is
-- the thing that is genuinely once-per-payment, so it takes that job.

CREATE UNIQUE INDEX IF NOT EXISTS submissions_stripe_session
    ON submissions (stripe_session_id)
    WHERE stripe_session_id IS NOT NULL;

-- The number the registration was held under, kept on the lead so a payment can
-- still be traced back to the form it came from.
ALTER TABLE registration_leads ADD COLUMN paid_reference TEXT;
