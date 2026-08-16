-- Dystil website form submissions.
--
-- Apply with:
--   npx wrangler d1 execute dystil-submissions --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS submissions (
    reference TEXT PRIMARY KEY,
    form_type TEXT NOT NULL,
    full_name TEXT NOT NULL,
    email TEXT NOT NULL,
    details TEXT NOT NULL,
    cv_filename TEXT,
    submitted_at TEXT NOT NULL,
    delivery_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE INDEX IF NOT EXISTS submissions_email ON submissions (email);
CREATE INDEX IF NOT EXISTS submissions_submitted_at ON submissions (submitted_at);
CREATE INDEX IF NOT EXISTS submissions_form_type ON submissions (form_type);

-- One counter per form per year, so each form numbers from 0001 every January.
-- The upsert in server.js increments and returns in a single atomic statement.
CREATE TABLE IF NOT EXISTS reference_counters (
    form_type TEXT NOT NULL,
    year TEXT NOT NULL,
    next_number INTEGER NOT NULL,
    PRIMARY KEY (form_type, year)
);
