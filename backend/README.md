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
