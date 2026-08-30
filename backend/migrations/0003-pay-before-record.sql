-- Only a paid bootcamp registration becomes a record.
--
-- Apply with:
--   npx wrangler d1 execute dystil-submissions --remote --file=migrations/0003-pay-before-record.sql
--
-- A registration now waits here between the form and the payment, and is moved
-- into submissions only when Stripe confirms the fee was paid. The CV waits in
-- R2 rather than in this table, because a 4 MB file does not fit D1's 2 MB row.

CREATE TABLE IF NOT EXISTS pending_registrations (
    token TEXT PRIMARY KEY,
    reference TEXT NOT NULL,
    form_type TEXT NOT NULL,
    details TEXT NOT NULL,
    cv_filename TEXT,
    cv_key TEXT,
    source_channel TEXT,
    source_detail TEXT,
    source_landing TEXT,
    submitted_at TEXT NOT NULL,
    fee INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS pending_registrations_created_at ON pending_registrations (created_at);

-- Everybody who reached the payment page, whether or not they paid. Name and
-- email only: enough to follow up somebody who hesitated, without keeping the
-- details or the CV of a registration that never happened.
CREATE TABLE IF NOT EXISTS registration_leads (
    reference TEXT PRIMARY KEY,
    form_type TEXT NOT NULL,
    full_name TEXT NOT NULL,
    email TEXT NOT NULL,
    package TEXT,
    fee INTEGER,
    started_at TEXT NOT NULL,
    paid_at TEXT
);

CREATE INDEX IF NOT EXISTS registration_leads_paid_at ON registration_leads (paid_at);
CREATE INDEX IF NOT EXISTS registration_leads_email ON registration_leads (email);
