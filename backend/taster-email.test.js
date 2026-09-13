import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import worker from "./server.js";

const ORIGIN = "https://dystil.ai";
const ADMIN_KEY = "taster-email-test-admin";
const PREFIX = "taster-2026-09-13";
const SENDERS = { frank: "frank@dystil.ai", askus: "askus@dystil.ai" };
const TYPES = ["calendar", "joining"];

// Run the actual roster and ledger SQL against an isolated SQLite database.
// This preserves D1's grouping/filtering semantics without a live binding.
function makeDatabase() {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`
        CREATE TABLE submissions (
            reference TEXT PRIMARY KEY,
            form_type TEXT NOT NULL,
            full_name TEXT,
            email TEXT,
            payment_status TEXT
        );
        CREATE TABLE suppressions (email TEXT PRIMARY KEY);
        CREATE TABLE broadcast_sends (
            campaign TEXT,
            email TEXT,
            sent_at TEXT,
            PRIMARY KEY (campaign, email)
        );
        CREATE TABLE registration_leads (
            reference TEXT PRIMARY KEY,
            form_type TEXT NOT NULL,
            full_name TEXT NOT NULL,
            email TEXT NOT NULL,
            package TEXT,
            fee INTEGER,
            started_at TEXT NOT NULL,
            paid_at TEXT
        );
    `);

    const insert = sqlite.prepare("INSERT INTO submissions VALUES (?, ?, ?, ?, NULL)");
    insert.run("TASTER-001", "Free Taster Registration", "Alice Adams", " ALICE@example.com ");
    insert.run("TASTER-002", "Second Taster Registration", "Alice Adams", "alice@example.com");
    insert.run("TASTER-003", "Second Taster Registration", "Bob Brown", "bob@example.com");
    insert.run("TASTER-004", "Free Taster Registration", "Carol Clark", "carol@example.com");
    insert.run("TASTER-005", "Free Taster Registration", "Opted Out", " STOP@example.com ");
    insert.run("OTHER-001", "Enquiry", "Unrelated Person", "other@example.com");
    sqlite.prepare("INSERT INTO suppressions VALUES (?)").run("stop@example.com");

    // Three ways of not needing to be chased and one way of needing it, so the
    // roster behind the abandoned-checkout campaign is tested rather than
    // merely present: paid at the till, paid under another reference, opted
    // out, and the one person who actually stopped at the payment page.
    const lead = sqlite.prepare("INSERT INTO registration_leads VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    lead.run("LEAD-001", "Bootcamp Registration", "Dave Dunn", "dave@example.com", "Advanced Bootcamp", 49900, "2026-09-10T09:00:00Z", null);
    lead.run("LEAD-002", "Bootcamp Registration", "Erin East", "erin@example.com", "Foundation Bootcamp", 29900, "2026-09-10T09:05:00Z", "2026-09-10T09:20:00Z");
    lead.run("LEAD-003", "Bootcamp Registration", "Finn Ford", "finn@example.com", "Foundation Bootcamp", 29900, "2026-09-10T09:10:00Z", null);
    lead.run("LEAD-004", "Bootcamp Registration", "Opted Out", "stop@example.com", "Foundation Bootcamp", 29900, "2026-09-10T09:15:00Z", null);
    // A team member testing the payment page, in capitals the way a form
    // might store it: unpaid, and still never to be chased.
    lead.run("LEAD-005", "Bootcamp Registration", "Bilal Ahmad", " MailboxForBilal@gmail.com ", "Advanced Bootcamp", 89900, "2026-09-10T09:25:00Z", null);
    sqlite.prepare("INSERT INTO submissions VALUES (?, ?, ?, ?, ?)")
        .run("PAID-001", "Bootcamp Registration", "Finn Ford", "finn@example.com", "paid");

    function statement(sql, args = []) {
        return {
            bind(...bound) { return statement(sql, bound); },
            async all() { return { results: sqlite.prepare(sql).all(...args) }; },
            async first() { return sqlite.prepare(sql).get(...args) || null; },
            async run() {
                const result = sqlite.prepare(sql).run(...args);
                return { success: true, meta: { changes: result.changes } };
            }
        };
    }

    return {
        sqlite,
        prepare: statement,
        ledger() { return sqlite.prepare("SELECT campaign, email FROM broadcast_sends ORDER BY campaign, email").all(); },
        close() { sqlite.close(); }
    };
}

function makeEnv(db) {
    return {
        DB: db,
        ADMIN_KEY,
        BREVO_API_KEY: "taster-test-key-never-used-live",
        ALLOWED_ORIGINS: ORIGIN,
        ADMIN_EMAIL: "askus@dystil.ai",
        FROM_EMAIL: "askus@dystil.ai"
    };
}

async function broadcast(env, body) {
    const response = await worker.fetch(new Request(`${ORIGIN}/api/broadcast`, {
        method: "POST",
        headers: { Origin: ORIGIN, "Content-Type": "application/json", "X-Admin-Key": ADMIN_KEY },
        body: JSON.stringify(body)
    }), env);
    return { status: response.status, body: await response.json() };
}

function captureEmail(t) {
    const deliveries = [];
    t.mock.method(globalThis, "fetch", async (url, options) => {
        assert.equal(url, "https://api.brevo.com/v3/smtp/email");
        assert.equal(options.method, "POST");
        assert.equal(options.headers["api-key"], "taster-test-key-never-used-live");
        deliveries.push(JSON.parse(options.body));
        return new Response(null, { status: 201 });
    });
    return deliveries;
}

function assertSimpleSessionEmail(payload) {
    assert.match(payload.subject, /taster/i);
    assert.doesNotMatch(payload.subject, /you.re in|different|🔥|!|offer/i);
    assert.match(payload.textContent, /registered/i);
    assert.match(payload.textContent, /Sunday/i);
    assert.match(payload.textContent, /13(?:th)? September(?: 2026)?/i);
    assert.match(payload.textContent, /2(?::00)?\s*(?:PM|pm)?\s*(?:-|–|to)\s*3(?::00)?\s*(?:PM|pm)?/);
    assert.match(payload.textContent, /UK/i);
    assert.doesNotMatch(payload.textContent, /follow us|tell a friend|share it|career edge|your seat is waiting|don.t be the one|facebook|instagram|tiktok/i);
    const links = payload.textContent.match(/https?:\/\/\S+/g) || [];
    assert.equal(links.length, 1, "The message should contain one joining link.");
    assert.match(links[0], /^https:\/\/teams\.microsoft\.com\//);
    if (payload.htmlContent) {
        assert.doesNotMatch(payload.htmlContent, /<img\b|<table\b|<button\b|border-radius/i);
        const backgrounds = [...payload.htmlContent.matchAll(/background(?:-color)?:\s*([^;"']+)/gi)];
        assert.ok(backgrounds.every(([, color]) => /^(?:white|#fff|#ffffff)$/i.test(color.trim())), "Use a plain white background.");
        assert.equal((payload.htmlContent.match(/<a\s/gi) || []).length, 1);
    }
}

function readCalendar(payload) {
    assert.equal(payload.attachment?.length, 1);
    const attachment = payload.attachment[0];
    assert.match(attachment.name, /\.ics$/);
    assert.equal(attachment.url, undefined, "The invitation should carry its calendar file directly.");
    assert.equal(typeof attachment.content, "string");
    const ics = Buffer.from(attachment.content, "base64").toString("utf8");
    assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
    assert.match(ics, /\r\nEND:VCALENDAR(?:\r\n)?$/);
    assert.equal(ics.replaceAll("\r\n", "").includes("\n"), false, "Calendar lines must use CRLF.");
    for (const line of ics.split("\r\n")) {
        assert.ok(Buffer.byteLength(line, "utf8") <= 75, "Calendar content lines must be folded at 75 octets.");
    }
    const unfolded = ics.replace(/\r\n[ \t]/g, "");
    assert.match(unfolded, /\r\nVERSION:2\.0\r\n/);
    assert.match(unfolded, /\r\nMETHOD:REQUEST\r\n/);
    assert.match(unfolded, /\r\nDTSTART:20260913T130000Z\r\n/);
    assert.match(unfolded, /\r\nDTEND:20260913T140000Z\r\n/);
    assert.match(unfolded, /\r\nSUMMARY:.*[Tt]aster/);
    assert.match(unfolded, /https:\/\/teams\.microsoft\.com\//);
    assert.match(unfolded, /\r\nBEGIN:VALARM\r\n/);
    assert.match(unfolded, /\r\nTRIGGER:-PT30M\r\n/);
    const organizer = unfolded.split("\r\n").find((line) => line.startsWith("ORGANIZER"));
    assert.ok(organizer?.endsWith(`mailto:${payload.sender.email}`));
    const attendees = unfolded.split("\r\n").filter((line) => line.startsWith("ATTENDEE"));
    assert.equal(attendees.length, 1, "A recipient must not receive other registrants' addresses.");
    assert.ok(attendees[0].endsWith(`mailto:${payload.to[0].email}`));
    const uid = unfolded.match(/\r\nUID:([^\r\n]+)/)?.[1];
    assert.ok(uid, "The event needs a stable UID for calendar deduplication.");
    return { unfolded, uid };
}

test("a campaign the Worker has never heard of is refused", async (t) => {
    const db = makeDatabase();
    t.after(() => db.close());
    const env = makeEnv(db);
    const deliveries = captureEmail(t);
    const unknown = ["taster-calendar-frank", "taster-2026-09-13-joining", "unknown-campaign"];

    for (const campaign of unknown) {
        for (const action of ["list", "test", "send"]) {
            const response = await broadcast(env, { action, campaign, emails: ["alice@example.com"] });
            assert.equal(response.status, 400, `${campaign} ${action}`);
            assert.equal(response.body.message, "Unknown campaign.");
        }
    }

    assert.equal(deliveries.length, 0);
    assert.deepEqual(db.ledger(), []);
});

// The Emails tab offers the two taster messages and nothing else. These are
// not on it, and are still here: the Career Accelerator starts on 26 September
// with registration open until the 15th, so the campaign that chases a payment
// someone abandoned halfway is the one thing that must not be deleted while
// the window is open. Listing them costs nothing and sends nothing; putting a
// row back on the page is one line.
test("the bootcamp campaigns are still reachable while that programme is open", async (t) => {
    const db = makeDatabase();
    t.after(() => db.close());
    const env = makeEnv(db);
    const deliveries = captureEmail(t);
    const offPage = [
        "bootcamp-checkout-abandoned-frank",
        "bootcamp-checkout-abandoned-askus",
        "bootcamp-checkout-abandoned-round2-frank",
        "bootcamp-checkout-abandoned-round2-askus",
        "bootcamp-confirm-place-2026-09-frank",
        "bootcamp-2026-09-26-rich-taster1-frank",
        "bootcamp-2026-09-26-rich-taster2-askus",
        "bootcamp-2026-09-26-reminder-taster1-frank",
        "bootcamp-2026-09-26-reminder-taster2-askus"
    ];

    for (const campaign of offPage) {
        const response = await broadcast(env, { action: "list", campaign });
        assert.equal(response.status, 200, campaign);
        assert.ok(Array.isArray(response.body.recipients), campaign);
    }

    // Not merely answering: both rounds pick the right people. Dave stopped at
    // the payment page. Erin paid, Finn paid under another reference, the
    // fourth asked not to be emailed, and the fifth is the team testing the
    // checkout - chasing any of those would be the worst thing this could do.
    for (const campaign of ["bootcamp-checkout-abandoned-frank", "bootcamp-checkout-abandoned-round2-askus"]) {
        const chase = await broadcast(env, { action: "list", campaign });
        assert.deepEqual(chase.body.recipients.map((person) => person.email), ["dave@example.com"], campaign);
        assert.equal(chase.body.recipients[0].package, "Advanced Bootcamp");
    }

    // Reading a roster is not sending to it.
    assert.equal(deliveries.length, 0);
    assert.deepEqual(db.ledger(), []);
});

// The second round is a second approach, not a repeat of the first send's
// bookkeeping: somebody the first round reached is reached again, once, and
// the team address stays refused even when named directly.
test("the second chase reaches people the first one already did, and never the team", async (t) => {
    const db = makeDatabase();
    t.after(() => db.close());
    const env = makeEnv(db);
    const deliveries = captureEmail(t);

    const first = await broadcast(env, {
        action: "send", campaign: "bootcamp-checkout-abandoned-frank",
        emails: ["dave@example.com", "mailboxforbilal@gmail.com"]
    });
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.results.map((r) => [r.email, r.status]), [
        ["dave@example.com", "sent"],
        ["mailboxforbilal@gmail.com", "skipped"]
    ]);

    const second = await broadcast(env, {
        action: "send", campaign: "bootcamp-checkout-abandoned-round2-askus",
        emails: ["dave@example.com", "mailboxforbilal@gmail.com"]
    });
    assert.deepEqual(second.body.results.map((r) => [r.email, r.status]), [
        ["dave@example.com", "sent"],
        ["mailboxforbilal@gmail.com", "skipped"]
    ]);

    const again = await broadcast(env, {
        action: "send", campaign: "bootcamp-checkout-abandoned-round2-frank",
        emails: ["dave@example.com"]
    });
    assert.equal(again.body.results[0].reason, "Already sent.");

    assert.deepEqual(deliveries.map((payload) => payload.to[0].email), ["dave@example.com", "dave@example.com"]);
    // SQLite hands rows back without a prototype; copy them before comparing.
    assert.deepEqual(db.ledger().map((row) => ({ ...row })), [
        { campaign: "bootcamp-checkout-abandoned", email: "dave@example.com" },
        { campaign: "bootcamp-checkout-abandoned-round2", email: "dave@example.com" }
    ]);
});

test("both emails and sender variants target all taster registers once and retain opt-outs", async (t) => {
    const db = makeDatabase();
    t.after(() => db.close());
    const env = makeEnv(db);
    for (const type of TYPES) {
        for (const sender of Object.keys(SENDERS)) {
            const response = await broadcast(env, { action: "list", campaign: `${PREFIX}-${type}-${sender}` });
            assert.equal(response.status, 200);
            assert.equal(response.body.route, "brevo");
            assert.deepEqual(response.body.recipients.map((person) => person.email), [
                "alice@example.com", "bob@example.com", "carol@example.com"
            ]);
            assert.ok(response.body.testRecipients.length > 0, "Both emails must have test recipients.");
        }
    }
});

test("joining sends preserve prior history and calendar sends use an independent shared ledger", async (t) => {
    const db = makeDatabase();
    t.after(() => db.close());
    const env = makeEnv(db);
    const deliveries = captureEmail(t);
    db.sqlite.prepare("INSERT INTO broadcast_sends VALUES (?, ?, ?)").run(`${PREFIX}-joining`, "alice@example.com", "2026-09-11T12:00:00Z");

    const joining = await broadcast(env, {
        action: "send", campaign: `${PREFIX}-joining-frank`,
        emails: [" ALICE@example.com ", "bob@example.com", "stop@example.com", "other@example.com"]
    });
    assert.equal(joining.status, 200);
    assert.deepEqual(joining.body.results.map(({ email, status }) => ({ email, status })), [
        { email: "alice@example.com", status: "skipped" },
        { email: "bob@example.com", status: "sent" },
        { email: "stop@example.com", status: "skipped" },
        { email: "other@example.com", status: "skipped" }
    ]);
    const secondSender = await broadcast(env, { action: "send", campaign: `${PREFIX}-joining-askus`, emails: ["bob@example.com"] });
    assert.equal(secondSender.body.results[0].status, "skipped");
    assert.equal(deliveries.length, 1);

    const calendar = await broadcast(env, { action: "send", campaign: `${PREFIX}-calendar-askus`, emails: ["alice@example.com", "bob@example.com"] });
    assert.equal(calendar.status, 200);
    assert.deepEqual(calendar.body.results.map((result) => result.status), ["sent", "sent"]);
    const repeatCalendar = await broadcast(env, { action: "send", campaign: `${PREFIX}-calendar-frank`, emails: ["bob@example.com"] });
    assert.equal(repeatCalendar.body.results[0].status, "skipped");
    assert.equal(deliveries.length, 3);
    assert.equal(db.ledger().length, 4);
});

test("calendar and joining tests match live messages from both senders without recording sends", async (t) => {
    const db = makeDatabase();
    t.after(() => db.close());
    const env = makeEnv(db);
    const deliveries = captureEmail(t);
    let eventUid;

    for (const type of TYPES) {
        for (const [sender, senderEmail] of Object.entries(SENDERS)) {
            const campaign = `${PREFIX}-${type}-${sender}`;
            const list = await broadcast(env, { action: "list", campaign });
            assert.equal(list.status, 200);
            const person = list.body.testRecipients[0];
            db.sqlite.prepare("INSERT OR REPLACE INTO submissions VALUES (?, ?, ?, ?, NULL)").run("TEST-001", "Free Taster Registration", person.fullName, person.email);
            db.sqlite.prepare("DELETE FROM broadcast_sends").run();

            const preview = await broadcast(env, { action: "test", campaign, email: person.email });
            assert.equal(preview.status, 200);
            assert.equal(preview.body.results.length, 1);
            assert.equal(preview.body.results[0].status, "sent");
            assert.deepEqual(db.ledger(), [], "Tests must not mark registrants as sent.");
            const testPayload = deliveries.at(-1);
            assert.equal(testPayload.sender.email, senderEmail);
            assert.equal(testPayload.replyTo.email, senderEmail);
            assertSimpleSessionEmail(testPayload);

            const actual = await broadcast(env, { action: "send", campaign, emails: [person.email] });
            assert.equal(actual.body.results[0].status, "sent");
            const actualPayload = deliveries.at(-1);
            assert.equal(actualPayload.subject, testPayload.subject);
            assert.equal(actualPayload.textContent, testPayload.textContent);
            assert.equal(actualPayload.htmlContent, testPayload.htmlContent);
            assert.deepEqual(actualPayload.sender, testPayload.sender);
            assert.deepEqual(actualPayload.to, testPayload.to);

            if (type === "calendar") {
                const previewCalendar = readCalendar(testPayload);
                const actualCalendar = readCalendar(actualPayload);
                assert.equal(actualCalendar.uid, previewCalendar.uid);
                assert.equal(actualCalendar.unfolded.replace(/DTSTAMP:[^\r\n]*/g, ""), previewCalendar.unfolded.replace(/DTSTAMP:[^\r\n]*/g, ""));
                eventUid ??= actualCalendar.uid;
                assert.equal(actualCalendar.uid, eventUid, "Changing the sender must not create a different calendar event.");
            } else {
                assert.equal(testPayload.attachment, undefined);
                assert.equal(actualPayload.attachment, undefined);
            }
        }
    }
});

test("test sends reject an address outside the existing team test list", async (t) => {
    const db = makeDatabase();
    t.after(() => db.close());
    const deliveries = captureEmail(t);
    for (const type of TYPES) {
        const response = await broadcast(makeEnv(db), { action: "test", campaign: `${PREFIX}-${type}-frank`, email: "stranger@example.com" });
        assert.equal(response.status, 400);
        assert.equal(response.body.message, "That address is not on the test list.");
    }
    assert.equal(deliveries.length, 0);
    assert.deepEqual(db.ledger(), []);
});

test("both whole-team test actions reach only the configured test recipients", async (t) => {
    const db = makeDatabase();
    t.after(() => db.close());
    const env = makeEnv(db);
    const deliveries = captureEmail(t);
    for (const type of TYPES) {
        const campaign = `${PREFIX}-${type}-frank`;
        const list = await broadcast(env, { action: "list", campaign });
        assert.equal(list.status, 200);
        const expected = list.body.testRecipients.map((person) => person.email).sort();
        const before = deliveries.length;
        const response = await broadcast(env, { action: "test", campaign });
        assert.equal(response.status, 200);
        const messages = deliveries.slice(before);
        assert.deepEqual(messages.map((payload) => payload.to[0].email).sort(), expected);
        assert.ok(response.body.results.every((result) => result.status === "sent"));
        for (const payload of messages) {
            assert.equal(payload.to.length, 1);
            assert.equal(payload.cc, undefined);
            assert.equal(payload.bcc, undefined);
            if (type === "calendar") readCalendar(payload);
        }
    }
    assert.deepEqual(db.ledger(), []);
});
