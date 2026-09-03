-- Put the submissions list back in the order things actually happened.
--
-- Apply with:
--   npx wrangler d1 execute dystil-submissions --remote --file=migrations/0006-sortable-timestamps.sql
--
-- submitted_at holds the sentence the page prints, "3 September 2026 at 22:04",
-- and ORDER BY was sorting it as text. "3 September" lands below "31 August",
-- because the space after the 3 sorts before the 1, so the list was in
-- alphabetical order wearing the shape of a date one: every month, the 1st to
-- the 9th sank underneath the 10th to the 31st of every month before it.
--
-- So the same instant is kept a second time in a form that sorts, London local
-- time as "2026-09-03 22:04", which is the same clock the sentence shows. It
-- is there to be ordered by and nothing else. The sentence stays the thing on
-- show, and no existing column changes.
--
-- registration_leads.started_at is written from the same value and its list is
-- ordered the same way, so it has the same column for the same reason.

ALTER TABLE submissions ADD COLUMN submitted_sort TEXT;
ALTER TABLE pending_registrations ADD COLUMN submitted_sort TEXT;
ALTER TABLE registration_leads ADD COLUMN started_sort TEXT;

-- Every existing row was written as "D MMMM YYYY at HH:MM". The clock is the
-- last five characters, the date is what remains once " at HH:MM" comes off,
-- and the day and the month name fall either side of its first space.
UPDATE submissions
SET submitted_sort = parsed.sortable
FROM (
    SELECT reference, printf('%s-%s-%02d %s', year, month, CAST(day AS INTEGER), clock) AS sortable
    FROM (
        SELECT reference, clock,
               substr(datepart, 1, instr(datepart, ' ') - 1) AS day,
               substr(rest, instr(rest, ' ') + 1) AS year,
               CASE substr(rest, 1, instr(rest, ' ') - 1)
                   WHEN 'January' THEN '01' WHEN 'February' THEN '02'
                   WHEN 'March' THEN '03' WHEN 'April' THEN '04'
                   WHEN 'May' THEN '05' WHEN 'June' THEN '06'
                   WHEN 'July' THEN '07' WHEN 'August' THEN '08'
                   WHEN 'September' THEN '09' WHEN 'October' THEN '10'
                   WHEN 'November' THEN '11' WHEN 'December' THEN '12'
               END AS month
        FROM (
            SELECT reference, datepart, clock,
                   substr(datepart, instr(datepart, ' ') + 1) AS rest
            FROM (
                SELECT reference,
                       substr(submitted_at, 1, length(submitted_at) - 9) AS datepart,
                       substr(submitted_at, length(submitted_at) - 4) AS clock
                FROM submissions
            )
        )
    )
) AS parsed
WHERE submissions.reference = parsed.reference
  AND submissions.submitted_sort IS NULL;

UPDATE registration_leads
SET started_sort = parsed.sortable
FROM (
    SELECT reference, printf('%s-%s-%02d %s', year, month, CAST(day AS INTEGER), clock) AS sortable
    FROM (
        SELECT reference, clock,
               substr(datepart, 1, instr(datepart, ' ') - 1) AS day,
               substr(rest, instr(rest, ' ') + 1) AS year,
               CASE substr(rest, 1, instr(rest, ' ') - 1)
                   WHEN 'January' THEN '01' WHEN 'February' THEN '02'
                   WHEN 'March' THEN '03' WHEN 'April' THEN '04'
                   WHEN 'May' THEN '05' WHEN 'June' THEN '06'
                   WHEN 'July' THEN '07' WHEN 'August' THEN '08'
                   WHEN 'September' THEN '09' WHEN 'October' THEN '10'
                   WHEN 'November' THEN '11' WHEN 'December' THEN '12'
               END AS month
        FROM (
            SELECT reference, datepart, clock,
                   substr(datepart, instr(datepart, ' ') + 1) AS rest
            FROM (
                SELECT reference,
                       substr(started_at, 1, length(started_at) - 9) AS datepart,
                       substr(started_at, length(started_at) - 4) AS clock
                FROM registration_leads
            )
        )
    )
) AS parsed
WHERE registration_leads.reference = parsed.reference
  AND registration_leads.started_sort IS NULL;

CREATE INDEX IF NOT EXISTS submissions_submitted_sort ON submissions (submitted_sort);
CREATE INDEX IF NOT EXISTS registration_leads_started_sort ON registration_leads (started_sort);
