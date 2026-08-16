# Dystil form email backend

The website remains hosted on GitHub Pages. A free Cloudflare Worker receives the
four website forms and uses Brevo to send:

1. the complete submission to `askus@dystil.ai`; and
2. a confirmation to the visitor from `askus@dystil.ai`.

The bootcamp registration email includes an uploaded PDF, DOC or DOCX CV (up to
4 MB). Email/API secrets stay in Cloudflare and are never exposed in the public
GitHub Pages JavaScript.

## Why Brevo instead of Resend?

Resend requires an MX record on a subdomain such as `send.dystil.ai`. Wix DNS
does not support that record, so Resend cannot authenticate `dystil.ai` while
Wix manages its DNS.

Brevo officially supports Wix and authenticates with a Brevo-code TXT record,
DKIM (TXT or CNAME), and DMARC TXT. It does not require an MX or SPF record for
domain authentication, so the existing GitHub Pages and Microsoft 365 records
remain untouched.

## Free-tier capacity

- [Cloudflare Workers Free](https://developers.cloudflare.com/workers/platform/limits/)
  includes 100,000 requests per day.
- [Brevo Free](https://help.brevo.com/hc/en-us/articles/208589409-About-Brevo-s-pricing-plans)
  includes 300 email sends per day, including transactional email.

Each successful form submission sends two emails, so the Brevo daily limit
allows up to 150 complete submissions per day at no charge.

## One-time setup

### 1. Authenticate `dystil.ai` in Brevo

1. Create a free account at [Brevo](https://www.brevo.com/).
2. Open **Settings > Senders, Domains & Dedicated IPs > Domains**.
3. Add `dystil.ai` and choose manual authentication.
4. Brevo will display three or four records: a Brevo-code TXT record, DKIM
   record(s) (TXT or CNAME), and one DMARC TXT record.
5. In Wix, open **Domains > dystil.ai > Manage DNS records** and add the exact
   records displayed by Brevo.
6. Return to Brevo and click **Authenticate this email domain**. DNS changes may
   take up to 48 hours, although they are often visible sooner.
7. In **Senders**, add `askus@dystil.ai` as the sender if Brevo has not created
   it automatically.

Important:

- Do not add, remove, or replace any MX record.
- Do not remove the Microsoft 365 MX record
  `dystil-ai.mail.protection.outlook.com`.
- Do not remove the GitHub Pages A records.
- A domain must have only one DMARC record. If `_dmarc.dystil.ai` already exists,
  edit that record according to Brevo's instructions instead of creating a
  second one.

Brevo provides [Wix-specific authentication instructions](https://help.brevo.com/hc/en-us/articles/12163873383186-Authenticate-your-domain-with-Brevo-Brevo-code-DKIM-DMARC#h_01H6ERXMFM7DF9B9A1R6V2S3MG).

### 2. Create a Brevo API key

1. In Brevo, open **SMTP & API > API Keys**.
2. Create an API key named `Dystil website forms`.
3. Copy it once and keep it private.

### 3. Deploy the free Cloudflare Worker

Install [Node.js](https://nodejs.org/) if it is not already installed, then run
these commands from the `backend` directory:

```powershell
npx wrangler login
npx wrangler secret put BREVO_API_KEY
npx wrangler deploy
```

Paste the Brevo API key when `wrangler secret put` prompts for it. Do not put
the key in `form-config.js`, `wrangler.toml`, a commit, or a chat message.

The deployed Worker URL is:

```text
https://dystil-contact.dystil-ai.workers.dev
```

### 4. Connect GitHub Pages to the Worker

The live endpoint is configured in `assets/js/form-config.js` as:

For example:

```javascript
window.DYSTIL_FORM_ENDPOINT = "https://dystil-contact.dystil-ai.workers.dev/api/enquiry";
```

Commit and push that change to the branch used by GitHub Pages. No email secret
is included in the website or repository.

Each of the four forms also carries the same URL in its `action` attribute, so a
visitor whose JavaScript fails to load still submits successfully and gets a
result page back instead of raw JSON. If the Worker URL ever changes, update
`assets/js/form-config.js` and all four form pages together:

```text
students/contact.html
students/register.html
students/taster.html
corporate/contact.html
```

## Submission records and reference numbers

Every submission is written to the `dystil-submissions` D1 database before the
emails are sent, and is given a reference number that names the form and the
year:

| Form | Reference |
| --- | --- |
| Student Enquiry | `DYS-STU-26-0001` |
| Corporate Enquiry | `DYS-COR-26-0001` |
| Bootcamp Registration | `DYS-BOT-26-0001` |
| Free Taster Registration | `DYS-TAS-26-0001` |

Each form counts from `0001` again every January. The reference appears in the
subject line of the notification to `askus@dystil.ai`, in the visitor's
confirmation, and in the message shown on the website.

The record holds the form type, name, email, every field the visitor filled in,
the CV filename, the submission time, and whether the emails were delivered
(`pending`, `sent` or `failed`). **The CV file itself is not stored** — it stays
an email attachment.

Because the reference cannot exist without the record, a database failure stops
the submission and asks the visitor to try again rather than sending an enquiry
that cannot be traced.

### Reading the records

```powershell
npx wrangler d1 execute dystil-submissions --remote --command "SELECT reference, form_type, full_name, email, submitted_at, delivery_status FROM submissions ORDER BY submitted_at DESC LIMIT 20"
```

Anything that never reached the inbox:

```powershell
npx wrangler d1 execute dystil-submissions --remote --command "SELECT * FROM submissions WHERE delivery_status <> 'sent'"
```

### The submissions page

`https://dystil.ai/students/database` shows the same records in the browser:
counts per form, a search box, and a CSV download. Nothing on the website links
to it, so it is only reachable by typing the address.

The page is useless without the password. It sends whatever is typed to
`POST /api/submissions` in the `X-Admin-Key` header, and the Worker returns
nothing at all unless it matches. Set the password once:

```powershell
npx wrangler secret put ADMIN_KEY
```

Then redeploy with `npm run deploy`. To change it later, run the same command
again with a new value; anyone still holding the old one loses access
immediately.

What protects the data:

- the password is compared as a digest, so its length and its characters cannot
  be worked out from how long the answer takes;
- five wrong guesses from one address lock that address out for fifteen minutes,
  and the lockout holds even if the next guess is correct;
- the request must come from `dystil.ai`, so another website cannot read the
  records even with the password;
- the password is never written to disk. It lives in the tab until it is closed,
  and it travels in a header rather than the address bar, so it stays out of
  browser history, referrer headers and access logs;
- the page asks search engines not to index it, though that is a courtesy rather
  than a protection.

Treat the password like the mailbox password: an unlisted address is not a lock,
and everybody who has it can read every enquiry the site has ever received.

### Data protection

The database holds personal data that visitors typed, so it needs the same care
as the mailbox: say in the website privacy policy that enquiry details are
stored, decide how long records are kept, and delete a person's rows on request.

```powershell
npx wrangler d1 execute dystil-submissions --remote --command "DELETE FROM submissions WHERE email = 'person@example.com'"
```

## Verify the live flow

1. Open `https://dystil.ai/students/contact` in a private browser
   window and send a test enquiry.
2. Confirm that `askus@dystil.ai` receives the full details.
3. Confirm that the test visitor receives the acknowledgement from
   `askus@dystil.ai`.
4. Repeat once from the bootcamp registration page with a small test PDF to
   verify the CV attachment.
5. If mail is delayed, inspect the **Transactional > Logs** page in Brevo and
   check the spam folders in both mailboxes.

## Local checks

Run the backend tests with:

```powershell
npm.cmd test
```

The endpoint accepts requests only from `https://dystil.ai` and
`https://www.dystil.ai`, validates known form fields and attachments, escapes
visitor content, and uses a spam honeypot.

Rate limiting has to allow for a university or office where every visitor shares
one address, so it works on two levels:

- the same person sending the same form twice is asked to wait 60 seconds; and
- any single address is capped at 10 submissions per 10 minutes.

That is the same 60 submissions an hour the earlier one-per-minute rule allowed,
without visitors on a shared network blocking each other. Neither limit is spent
until the emails are actually sent, so a provider failure never blocks the retry
the error message invites.
