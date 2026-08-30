# Dystil form email backend

The website remains hosted on GitHub Pages. A free Cloudflare Worker receives the
four website forms and uses Brevo to send:

1. the complete submission to `askus@dystil.ai`; and
2. a confirmation to the visitor from `askus@dystil.ai`.

Email and API secrets stay in Cloudflare and are never exposed in the public
GitHub Pages JavaScript. The Worker still accepts a PDF, DOC or DOCX attachment
(up to 4 MB) on the unpaid forms, though none of them currently asks for one.

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

## Bootcamp payments

The bootcamp registration form takes the programme fee through Stripe Checkout.
Card details are typed on Stripe's own page and never reach this Worker, the
website, or the database.

**A bootcamp registration is not recorded until the fee is paid.** Everything
else on the site still records first and emails immediately; only the paid form
waits.

Nothing about payments happens until `STRIPE_SECRET_KEY` is set. Without it the
registration form records and emails straight away, exactly as it did before
payments existed, so this can be deployed while the Stripe account is still
being verified.

### What happens when somebody registers

1. The Worker validates the form, allocates the reference, and puts the whole
   submission in `pending_registrations`. No row is written to `submissions` and
   no email is sent.
2. The name and email are written to `registration_leads`, so somebody who stops
   at the payment page can still be followed up.
3. The visitor is sent to a Stripe payment page for the chosen package.
4. Stripe collects the fee and returns them to
   `https://dystil.ai/students/payment-complete`.
5. Stripe calls `POST /api/stripe-webhook`. The Worker checks the signature,
   moves the held registration into `submissions` as paid, sends the
   notification and the confirmation, marks the lead paid, and deletes the hold.

If Stripe cannot be reached at step 3 the hold is thrown away and the visitor is
asked to try again, because a registration waiting on a payment page that never
opened is worse than none at all.

**Only the webhook records a registration.** Coming back from the payment page
proves nothing, since anybody can type that address. A repeated webhook is
harmless: the reference is a primary key, so the second delivery inserts
nothing, sends nothing, and answers 200.

**And only `payment_status: "paid"` counts as paid.** A completed checkout is
not necessarily a paid one: Klarna, bank debits and anything else that settles
later complete the session first and pay afterwards. A completed session that
has not been paid is acknowledged, logged, and left alone, with its hold intact;
the `checkout.session.async_payment_succeeded` event that follows is what
finishes the registration. That is what stops anybody being told their payment
arrived before it did.

Anything still held 24 hours later was never paid for. It is deleted by the next
registration that comes through.

The bootcamp form asks for typed answers only. It no longer takes a CV upload,
so nothing large ever waits for a payment and no file store is involved. Ask a
paid student for a CV by replying to their registration email.

### The prices

| Package | Fee |
| --- | --- |
| Foundation Bootcamp | £399 |
| Advanced Bootcamp | £899 |

They are set in `BOOTCAMP_PRICES` in `server.js`, in pence. The form sends only
which package was chosen; the amount is never taken from the browser, because a
figure that arrives from a browser is a figure anybody can change. Change a
price there and on `students/services.html` together.

### One-time setup

1. Create a Stripe account and complete business verification. Payouts do not
   run until that finishes, which usually takes one to three working days.
2. In the Stripe dashboard open **Developers > Webhooks** and add a destination
   for `https://dystil-contact.dystil-ai.workers.dev/api/stripe-webhook`,
   payload style **Snapshot**, subscribed to `checkout.session.completed`. Add
   `checkout.session.async_payment_succeeded` and `checkout.session.expired` as
   well if you ever enable a payment method that settles later, such as Klarna
   or a bank debit. Stripe then shows a signing secret beginning `whsec_`.
3. From the `backend` directory:

```powershell
npx wrangler d1 execute dystil-submissions --remote --file=migrations/0002-add-payment-columns.sql
npx wrangler d1 execute dystil-submissions --remote --file=migrations/0003-pay-before-record.sql
npx wrangler d1 execute dystil-submissions --remote --file=migrations/0004-paid-references.sql
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
npm run deploy
```

Paste the keys when prompted. Do not put either one in `wrangler.toml`, a
commit, or a chat message.

A sandbox has its own keys and its own webhook destination, so the test pair and
the live pair are different values. Test with card `4242 4242 4242 4242`, any
future expiry and any CVC, then run the two `secret put` commands again with the
live values and redeploy.

### Reading who has paid

`https://dystil.ai/students/database` shows a **Fee** column on the submissions
table. Under it, on the bootcamp view and the full list, are two more panels:
**Paid registrations**, everybody who paid and the reference they were given on
the day, and **Started, not paid**, everybody who reached the payment page and
did not.

```powershell
npx wrangler d1 execute dystil-submissions --remote --command "SELECT reference, full_name, email, package, started_at FROM registration_leads WHERE paid_at IS NULL ORDER BY started_at DESC"
```

Refunds are made in the Stripe dashboard. Nothing here reverses a row
automatically, so update the record by hand if you refund somebody:

```powershell
npx wrangler d1 execute dystil-submissions --remote --command "UPDATE submissions SET payment_status = 'refunded' WHERE reference = 'DYS-BOT-26-0001'"
```

### Two kinds of reference

A registration is **held** under the ordinary four-digit reference,
`DYS-BOT-26-0007`, which is what Stripe is given and what the admin page shows
under **Started, not paid**.

When the fee arrives it is **renumbered** by the day the money came in:
`DYS-BOT-26-3108001` is the first payment taken on 31 August, `3108002` the
second, and the count starts again at 001 the next morning. That is the number
in both emails and in the **Paid registrations** table, so a reference says when
somebody actually joined rather than when they filled a form in.

The two are linked by `registration_leads.paid_reference`, and a payment can be
traced from Stripe by its session id, which is stored on the row.

Because a paid registration draws a fresh number, the reference can no longer be
what stops a retried webhook writing the record twice. The Stripe session does
that job instead: it is unique per payment, it is checked before anything is
allocated, and a unique index on `stripe_session_id` is the backstop.

Holding references skip a number whenever somebody starts a registration and
does not pay. The gap is not a lost record: the reference it was given is in
`registration_leads`.

### Before taking real money

- Publish a refund and cancellation policy. Stripe disputes go badly without
  one, and a disputed payment costs about £20 whichever way it ends.
- Get VAT advice on whether the training is exempt or standard-rated. If it is
  standard-rated, £399 has to be £399 including VAT or the price on the site is
  wrong.
- Say in the privacy policy that Stripe processes payments, and that the details
  of an unpaid registration are deleted within 24 hours.

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
the submission time, and whether the emails were delivered (`pending`, `sent` or
`failed`). Where an attachment is sent, only its filename is recorded: **the file
itself is not stored** and stays an email attachment.

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
