import test from "node:test";
import assert from "node:assert/strict";
import worker from "./server.js";

// Enough of the D1 binding for the statements the Worker runs. Counters carry
// across tests, so assertions compare consecutive numbers rather than expecting
// any particular one.
function makeFakeDatabase() {
    const counters = new Map();
    const rows = [];
    const pending = [];
    const leads = [];

    function run(sql, args) {
        if (sql.includes("INSERT OR IGNORE INTO submissions")) {
            // The reference is the primary key, so a repeat inserts nothing.
            if (rows.some((row) => row.reference === args[0])) {
                return { success: true, meta: { changes: 0 } };
            }

            rows.push({
                reference: args[0],
                form_type: args[1],
                full_name: args[2],
                email: args[3],
                details: args[4],
                cv_filename: args[5],
                submitted_at: args[6],
                delivery_status: "pending",
                source_channel: args[7],
                source_detail: args[8],
                source_landing: args[9],
                payment_status: "paid",
                payment_amount: args[10],
                stripe_session_id: args[11]
            });

            return { success: true, meta: { changes: 1 } };
        }

        if (sql.includes("INSERT INTO submissions")) {
            rows.push({
                reference: args[0],
                form_type: args[1],
                full_name: args[2],
                email: args[3],
                details: args[4],
                cv_filename: args[5],
                submitted_at: args[6],
                delivery_status: "pending",
                source_channel: args[7],
                source_detail: args[8],
                source_landing: args[9],
                payment_status: args[10],
                payment_amount: args[11]
            });

            return { success: true, meta: { changes: 1 } };
        }

        if (sql.includes("INSERT INTO pending_registrations")) {
            pending.push({
                token: args[0],
                reference: args[1],
                form_type: args[2],
                details: args[3],
                source_channel: args[4],
                source_detail: args[5],
                source_landing: args[6],
                submitted_at: args[7],
                fee: args[8],
                created_at: args[9]
            });

            return { success: true, meta: { changes: 1 } };
        }

        if (sql.includes("DELETE FROM pending_registrations")) {
            const index = pending.findIndex((row) => row.token === args[0]);
            if (index !== -1) pending.splice(index, 1);

            return { success: true, meta: { changes: index === -1 ? 0 : 1 } };
        }

        if (sql.includes("INSERT INTO registration_leads")) {
            if (!leads.some((lead) => lead.reference === args[0])) {
                leads.push({
                    reference: args[0],
                    form_type: args[1],
                    full_name: args[2],
                    email: args[3],
                    package: args[4],
                    fee: args[5],
                    started_at: args[6],
                    paid_at: null
                });
            }

            return { success: true, meta: { changes: 1 } };
        }

        if (sql.includes("UPDATE registration_leads")) {
            const lead = leads.find((candidate) => candidate.reference === args[1]);
            if (lead) lead.paid_at = args[0];

            return { success: true, meta: { changes: lead ? 1 : 0 } };
        }

        if (sql.includes("payment_status = 'paid'")) {
            const row = rows.find((candidate) => candidate.reference === args[2]);

            // The statement only touches a row that was expecting a fee.
            if (row && row.payment_status) {
                row.payment_status = "paid";
                row.payment_amount = args[0];
                row.stripe_session_id = args[1];
            }

            return { success: true, meta: { changes: row ? 1 : 0 } };
        }

        if (sql.includes("UPDATE submissions")) {
            const row = rows.find((candidate) => candidate.reference === args[1]);
            if (row) row.delivery_status = args[0];

            return { success: true, meta: { changes: row ? 1 : 0 } };
        }

        throw new Error(`Unexpected statement: ${sql}`);
    }

    return {
        rows,
        pending,
        leads,
        prepare(sql) {
            return {
                bind(...args) {
                    return {
                        async first() {
                            if (sql.includes("reference_counters")) {
                                const key = `${args[0]}|${args[1]}`;
                                const next = (counters.get(key) || 0) + 1;
                                counters.set(key, next);

                                return { next_number: next };
                            }

                            if (sql.includes("FROM pending_registrations")) {
                                return pending.find((row) => row.token === args[0]) || null;
                            }

                            throw new Error(`Unexpected statement: ${sql}`);
                        },
                        async all() {
                            if (sql.includes("SELECT token FROM pending_registrations")) {
                                return { results: pending.filter((row) => row.created_at < args[0]) };
                            }

                            if (sql.includes("FROM registration_leads")) {
                                return { results: leads.filter((lead) => !lead.paid_at) };
                            }

                            if (sql.includes("FROM submissions")) {
                                return { results: rows.slice(0, args[0]) };
                            }

                            throw new Error(`Unexpected statement: ${sql}`);
                        },
                        async run() {
                            return run(sql, args);
                        }
                    };
                }
            };
        }
    };
}

const env = {
    BREVO_API_KEY: "xkeysib-test-key",
    ALLOWED_ORIGINS: "https://dystil.ai,https://www.dystil.ai",
    ADMIN_EMAIL: "askus@dystil.ai",
    FROM_EMAIL: "askus@dystil.ai",
    DB: makeFakeDatabase()
};

function referenceNumber(reference) {
    return Number(reference.split("-").at(-1));
}

function makeRequest(fields, origin = "https://dystil.ai", ipAddress = "") {
    const body = new FormData();
    Object.entries(fields).forEach(([key, value]) => body.set(key, value));

    const headers = { Origin: origin };
    if (ipAddress) headers["CF-Connecting-IP"] = ipAddress;

    return new Request("https://dystil-contact.example/api/enquiry", {
        method: "POST",
        headers,
        body
    });
}

// The Worker only rate-limits where a cache is available, so these stand in for
// the Cloudflare one. Expiry is not simulated; each test stays inside a window.
async function withFakeCache(callback) {
    const store = new Map();

    globalThis.caches = {
        default: {
            async match(request) {
                return store.get(request.url);
            },
            async put(request, response) {
                store.set(request.url, response);
            }
        }
    };

    try {
        await callback();
    } finally {
        delete globalThis.caches;
    }
}

const studentEnquiry = {
    formType: "Student Enquiry",
    fullName: "Sam Student",
    email: "sam@example.com",
    phone: "07123 456789",
    interest: "Foundation Bootcamp",
    message: "Please send more details."
};

async function withMockedEmailApi(callback, responseStatus = 201) {
    const originalFetch = globalThis.fetch;
    const calls = [];

    globalThis.fetch = async function(url, options) {
        calls.push({ url, options, body: JSON.parse(options.body) });
        return Response.json(responseStatus < 300 ? { id: crypto.randomUUID() } : { message: "failed" }, {
            status: responseStatus
        });
    };

    try {
        await callback(calls);
    } finally {
        globalThis.fetch = originalFetch;
    }
}

test("sends the admin notification and visitor confirmation", async function() {
    await withMockedEmailApi(async function(calls) {
        const response = await worker.fetch(makeRequest({
            formType: "Student Enquiry",
            fullName: "Sam Student",
            email: "sam@example.com",
            phone: "07123 456789",
            interest: "Foundation Bootcamp",
            message: "Please send more details.",
            website: ""
        }), env);

        assert.equal(response.status, 200);
        assert.equal((await response.json()).success, true);
        assert.equal(calls.length, 2);
        assert.equal(calls[0].url, "https://api.brevo.com/v3/smtp/email");
        assert.equal(calls[0].options.headers["api-key"], "xkeysib-test-key");
        assert.equal(calls[0].body.to[0].email, "askus@dystil.ai");
        assert.equal(calls[0].body.replyTo.email, "sam@example.com");
        assert.equal(calls[0].body.sender.email, "askus@dystil.ai");
        assert.equal(calls[1].body.to[0].email, "sam@example.com");
        assert.equal(calls[1].body.replyTo.email, "askus@dystil.ai");
        assert.match(calls[1].body.textContent, /enquiry has been sent successfully/i);
    });
});

test("includes a valid CV attachment on a bootcamp registration", async function() {
    await withMockedEmailApi(async function(calls) {
        const request = makeRequest({
            formType: "Bootcamp Registration",
            fullName: "Alex Graduate",
            email: "alex@example.com",
            phone: "07000 000000",
            universityDegree: "Example University",
            careerGoal: "Data analyst",
            techSkills: "Excel",
            experience: "Student project",
            package: "Foundation Bootcamp",
            cv: new File(["sample cv"], "Alex CV.pdf", { type: "application/pdf" }),
            website: ""
        });

        const response = await worker.fetch(request, env);
        assert.equal(response.status, 200);
        assert.equal(calls.length, 2);
        assert.equal(calls[0].body.attachment[0].name, "Alex CV.pdf");
        assert.equal(calls[0].body.attachment[0].content, "c2FtcGxlIGN2");
        assert.equal("size" in calls[0].body.attachment[0], false);
        assert.equal("attachment" in calls[1].body, false);
    });
});

test("rejects requests from an unapproved website", async function() {
    await withMockedEmailApi(async function(calls) {
        const response = await worker.fetch(makeRequest({
            formType: "Student Enquiry"
        }, "https://malicious.example"), env);

        assert.equal(response.status, 403);
        assert.equal(calls.length, 0);
    });
});

test("rejects incomplete submissions before sending email", async function() {
    await withMockedEmailApi(async function(calls) {
        const response = await worker.fetch(makeRequest({
            formType: "Corporate Enquiry",
            fullName: "Taylor",
            email: "not-an-email",
            company: "",
            focusArea: "AI Upskilling"
        }), env);

        assert.equal(response.status, 400);
        assert.equal(calls.length, 0);
    });
});

test("escapes visitor content in the HTML email", async function() {
    await withMockedEmailApi(async function(calls) {
        const response = await worker.fetch(makeRequest({
            formType: "Student Enquiry",
            fullName: "<script>alert(1)</script>",
            email: "safe@example.com",
            phone: "07123",
            interest: "Career Pathways",
            message: "<img src=x onerror=alert(1)>"
        }), env);

        assert.equal(response.status, 200);
        assert.doesNotMatch(calls[0].body.htmlContent, /<script>/);
        assert.doesNotMatch(calls[0].body.htmlContent, /<img src=x/);
        assert.match(calls[0].body.htmlContent, /&lt;script&gt;/);
    });
});

test("sends a distinct idempotency key as a request header", async function() {
    await withMockedEmailApi(async function(calls) {
        await worker.fetch(makeRequest(studentEnquiry), env);

        const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
        const adminKey = calls[0].options.headers.idempotencyKey;
        const confirmationKey = calls[1].options.headers.idempotencyKey;

        assert.match(adminKey, uuid);
        assert.match(confirmationKey, uuid);
        assert.notEqual(adminKey, confirmationKey);

        // The key belongs on the request, never on the delivered email.
        assert.equal("headers" in calls[0].body, false);
        assert.equal("headers" in calls[1].body, false);
    });
});

test("gives each form its own reference prefix", async function() {
    await withMockedEmailApi(async function() {
        const taster = await worker.fetch(makeRequest({
            formType: "Free Taster Registration",
            fullName: "Jamie",
            email: "jamie@example.com",
            currentStatus: "Student",
            areaOfInterest: "Cloud"
        }), env);

        const corporate = await worker.fetch(makeRequest({
            formType: "Corporate Enquiry",
            fullName: "Taylor",
            email: "taylor@example.com",
            company: "Example Ltd",
            focusArea: "AI Upskilling"
        }), env);

        assert.match((await taster.json()).reference, /^DYS-TAS-\d{2}-\d{4}$/);
        assert.match((await corporate.json()).reference, /^DYS-COR-\d{2}-\d{4}$/);
    });
});

test("counts each form separately and in order", async function() {
    await withMockedEmailApi(async function() {
        const first = await worker.fetch(makeRequest(studentEnquiry), env);
        const second = await worker.fetch(makeRequest({ ...studentEnquiry, email: "other@example.com" }), env);

        const firstReference = (await first.json()).reference;
        const secondReference = (await second.json()).reference;

        assert.equal(referenceNumber(secondReference), referenceNumber(firstReference) + 1);
    });
});

test("stores the whole submission and marks it sent", async function() {
    await withMockedEmailApi(async function() {
        const response = await worker.fetch(makeRequest(studentEnquiry), env);
        const { reference } = await response.json();
        const row = env.DB.rows.find((candidate) => candidate.reference === reference);

        assert.equal(row.form_type, "Student Enquiry");
        assert.equal(row.email, "sam@example.com");
        assert.equal(row.cv_filename, null);
        assert.equal(row.delivery_status, "sent");
        assert.equal(JSON.parse(row.details).interest, "Foundation Bootcamp");
    });
});

test("records the CV filename without storing the file", async function() {
    await withMockedEmailApi(async function() {
        const response = await worker.fetch(makeRequest({
            formType: "Bootcamp Registration",
            fullName: "Alex Graduate",
            email: "alex@example.com",
            phone: "07000 000000",
            package: "Foundation Bootcamp",
            cv: new File(["sample cv"], "Alex CV.pdf", { type: "application/pdf" })
        }), env);

        const { reference } = await response.json();
        const row = env.DB.rows.find((candidate) => candidate.reference === reference);

        assert.match(reference, /^DYS-BOT-\d{2}-\d{4}$/);
        assert.equal(row.cv_filename, "Alex CV.pdf");
        assert.equal("cv" in JSON.parse(row.details), false);
    });
});

const tasterFeedback = {
    formType: "Taster Session Feedback",
    fullName: "Priya Attendee",
    email: "priya@example.com",
    attended: "Yes, I joined the whole session",
    rating: "4 — Good",
    mostUseful: "The live demo on my own job role.",
    improvement: "Less time on the intro.",
    nextStep: "Ready to start a pathway",
    message: ""
};

test("records taster feedback under its own reference", async function() {
    await withMockedEmailApi(async function() {
        const response = await worker.fetch(makeRequest(tasterFeedback), env);
        const { reference } = await response.json();
        const row = env.DB.rows.find((candidate) => candidate.reference === reference);
        const details = JSON.parse(row.details);

        assert.ok(reference.startsWith("DYS-FBK-"));
        assert.equal(row.form_type, "Taster Session Feedback");
        assert.equal(row.delivery_status, "sent");
        assert.equal(details.rating, "4 — Good");
        assert.equal(details.attended, "Yes, I joined the whole session");
        assert.equal(details.nextStep, "Ready to start a pathway");
        assert.equal(details.mostUseful, "The live demo on my own job role.");
    });
});

// The two open questions are the ones people skip, and losing a rating over a
// blank box would be the wrong trade.
test("takes feedback with the open questions left blank", async function() {
    await withMockedEmailApi(async function() {
        const response = await worker.fetch(makeRequest({
            ...tasterFeedback,
            email: "quiet@example.com",
            mostUseful: "",
            improvement: ""
        }), env);

        assert.equal((await response.json()).success, true);
    });
});

test("does not promise a feedback sender that somebody will be in touch", async function() {
    await withMockedEmailApi(async function(calls) {
        await worker.fetch(makeRequest({ ...tasterFeedback, email: "receipt@example.com" }), env);

        assert.match(calls[1].body.textContent, /feedback has been sent successfully/i);
        assert.equal(calls[1].body.textContent.includes("contact you shortly"), false);
    });
});

// The two sessions have to stay apart in the record, or a broadcast aimed at
// the first register would reach people who signed up for the second.
test("gives the second taster session its own reference series", async function() {
    await withMockedEmailApi(async function() {
        const response = await worker.fetch(makeRequest({
            formType: "Second Taster Registration",
            fullName: "Nadia Second",
            email: "nadia@example.com",
            currentStatus: "Student",
            areaOfInterest: "Engineering"
        }), env);

        const { reference } = await response.json();
        const row = env.DB.rows.find((candidate) => candidate.reference === reference);

        assert.ok(reference.startsWith("DYS-TS2-"));
        assert.equal(row.form_type, "Second Taster Registration");
        assert.equal(row.delivery_status, "sent");
    });
});

test("puts the reference in both emails", async function() {
    await withMockedEmailApi(async function(calls) {
        const response = await worker.fetch(makeRequest(studentEnquiry), env);
        const { reference } = await response.json();

        assert.equal(calls[0].body.subject, `[${reference}] New Student Enquiry — Sam Student`);
        assert.match(calls[0].body.htmlContent, new RegExp(reference));
        assert.match(calls[1].body.subject, new RegExp(reference));
        assert.match(calls[1].body.textContent, new RegExp(reference));
    });
});

test("marks the record failed when the provider fails", async function() {
    await withMockedEmailApi(async function() {
        const response = await worker.fetch(makeRequest(studentEnquiry), env);

        assert.equal(response.status, 502);
        assert.equal(env.DB.rows.at(-1).delivery_status, "failed");
    }, 500);
});

test("blocks the submission when the database is unavailable", async function() {
    await withMockedEmailApi(async function(calls) {
        const brokenEnv = {
            ...env,
            DB: {
                prepare() {
                    return { bind() {
                        return {
                            async first() { throw new Error("D1 is unavailable."); },
                            async run() { throw new Error("D1 is unavailable."); }
                        };
                    } };
                }
            }
        };

        const response = await worker.fetch(makeRequest(studentEnquiry), brokenEnv);

        assert.equal(response.status, 503);
        assert.equal(calls.length, 0);
        assert.match((await response.json()).message, /could not record your enquiry/i);
    });
});

test("answers a browser form post with a page rather than JSON", async function() {
    await withMockedEmailApi(async function(calls) {
        const request = makeRequest(studentEnquiry);
        request.headers.set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");

        const response = await worker.fetch(request, env);
        const page = await response.text();

        assert.equal(response.status, 200);
        assert.equal(calls.length, 2);
        assert.match(response.headers.get("Content-Type"), /text\/html/);
        assert.match(page, /^<!doctype html>/);
        assert.match(page, /Thank you/);
        assert.match(page, /https:\/\/dystil\.ai/);
    });
});

test("shows a browser the reason a submission was rejected", async function() {
    await withMockedEmailApi(async function(calls) {
        const request = makeRequest({ ...studentEnquiry, email: "not-an-email" });
        request.headers.set("Accept", "text/html");

        const response = await worker.fetch(request, env);

        assert.equal(response.status, 400);
        assert.equal(calls.length, 0);
        assert.match(await response.text(), /valid email address/);
    });
});

test("still answers the website's own fetch call with JSON", async function() {
    await withMockedEmailApi(async function() {
        const request = makeRequest(studentEnquiry);
        request.headers.set("Accept", "*/*");

        const response = await worker.fetch(request, env);

        assert.match(response.headers.get("Content-Type"), /application\/json/);
        assert.equal((await response.json()).success, true);
    });
});

test("lets two visitors sharing one address both send a form", async function() {
    await withFakeCache(async function() {
        await withMockedEmailApi(async function(calls) {
            const first = await worker.fetch(makeRequest(studentEnquiry, "https://dystil.ai", "203.0.113.7"), env);
            const second = await worker.fetch(
                makeRequest({ ...studentEnquiry, email: "jo@example.com" }, "https://dystil.ai", "203.0.113.7"),
                env
            );

            assert.equal(first.status, 200);
            assert.equal(second.status, 200);
            assert.equal(calls.length, 4);
        });
    });
});

test("blocks an immediate repeat of the same form by the same visitor", async function() {
    await withFakeCache(async function() {
        await withMockedEmailApi(async function(calls) {
            const first = await worker.fetch(makeRequest(studentEnquiry, "https://dystil.ai", "203.0.113.8"), env);
            const repeat = await worker.fetch(makeRequest(studentEnquiry, "https://dystil.ai", "203.0.113.8"), env);

            assert.equal(first.status, 200);
            assert.equal(repeat.status, 429);
            assert.match((await repeat.json()).message, /wait a minute/i);
            assert.equal(calls.length, 2);
        });
    });
});

test("lets the same visitor send a different form straight away", async function() {
    await withFakeCache(async function() {
        await withMockedEmailApi(async function(calls) {
            const enquiry = await worker.fetch(makeRequest(studentEnquiry, "https://dystil.ai", "203.0.113.9"), env);
            const taster = await worker.fetch(makeRequest({
                formType: "Free Taster Registration",
                fullName: "Sam Student",
                email: "sam@example.com",
                currentStatus: "Student",
                areaOfInterest: "Cloud"
            }, "https://dystil.ai", "203.0.113.9"), env);

            assert.equal(enquiry.status, 200);
            assert.equal(taster.status, 200);
            assert.equal(calls.length, 4);
        });
    });
});

test("still caps a burst of submissions from one address", async function() {
    await withFakeCache(async function() {
        await withMockedEmailApi(async function() {
            for (let attempt = 0; attempt < 10; attempt += 1) {
                const response = await worker.fetch(
                    makeRequest({ ...studentEnquiry, email: `visitor${attempt}@example.com` }, "https://dystil.ai", "203.0.113.10"),
                    env
                );

                assert.equal(response.status, 200);
            }

            const blocked = await worker.fetch(
                makeRequest({ ...studentEnquiry, email: "visitor10@example.com" }, "https://dystil.ai", "203.0.113.10"),
                env
            );

            assert.equal(blocked.status, 429);
            assert.match((await blocked.json()).message, /too many enquiries/i);
        });
    });
});

test("does not spend the limit when the email provider fails", async function() {
    await withFakeCache(async function() {
        await withMockedEmailApi(async function() {
            const failed = await worker.fetch(makeRequest(studentEnquiry, "https://dystil.ai", "203.0.113.11"), env);
            assert.equal(failed.status, 502);
        }, 500);

        await withMockedEmailApi(async function(calls) {
            const retry = await worker.fetch(makeRequest(studentEnquiry, "https://dystil.ai", "203.0.113.11"), env);

            assert.equal(retry.status, 200);
            assert.equal(calls.length, 2);
        });
    });
});

test("returns a useful error if the email provider fails", async function() {
    await withMockedEmailApi(async function(calls) {
        const response = await worker.fetch(makeRequest({
            formType: "Free Taster Registration",
            fullName: "Jamie",
            email: "jamie@example.com",
            phone: "",
            currentStatus: "Graduate",
            areaOfInterest: "Cloud",
            message: ""
        }), env);

        const result = await response.json();
        assert.equal(response.status, 502);
        assert.equal(result.success, false);
        assert.match(result.message, /askus@dystil\.ai/);
        assert.equal(calls.length, 2);
    }, 500);
});

// ---------------------------------------------------------------------------
// The unlisted submissions view at /students/database
// ---------------------------------------------------------------------------

function makeReadableDatabase(rows) {
    return {
        prepare(sql) {
            return {
                bind(limit) {
                    return {
                        async all() {
                            if (!sql.includes("FROM submissions")) throw new Error(`Unexpected statement: ${sql}`);
                            return { results: rows.slice(0, limit) };
                        }
                    };
                }
            };
        }
    };
}

const storedRows = [
    {
        reference: "DYS-TAS-26-0002",
        form_type: "Free Taster Registration",
        full_name: "Jamie Graduate",
        email: "jamie@example.com",
        details: "Current status: Graduate",
        cv_filename: null,
        submitted_at: "2026-08-16T10:00:00.000Z",
        delivery_status: "sent"
    },
    {
        reference: "DYS-TAS-26-0001",
        form_type: "Free Taster Registration",
        full_name: "Sam Student",
        email: "sam@example.com",
        details: "Current status: Student",
        cv_filename: null,
        submitted_at: "2026-08-15T10:00:00.000Z",
        delivery_status: "sent"
    }
];

function makeListRequest(password, origin = "https://dystil.ai", ipAddress = "") {
    const headers = { Origin: origin };
    if (password !== null) headers["X-Admin-Key"] = password;
    if (ipAddress) headers["CF-Connecting-IP"] = ipAddress;

    return new Request("https://dystil-contact.example/api/submissions", { method: "POST", headers });
}

const adminEnv = { ...env, ADMIN_KEY: "correct horse battery", DB: makeReadableDatabase(storedRows) };

test("returns the submissions when the password is right", async function() {
    const response = await worker.fetch(makeListRequest("correct horse battery"), adminEnv);
    const result = await response.json();

    assert.equal(response.status, 200);
    assert.equal(result.success, true);
    assert.equal(result.submissions.length, 2);
    assert.equal(result.submissions[0].reference, "DYS-TAS-26-0002");
});

test("refuses the wrong password and sends back no data", async function() {
    const response = await worker.fetch(makeListRequest("guess"), adminEnv);
    const result = await response.json();

    assert.equal(response.status, 401);
    assert.equal(result.success, false);
    assert.equal(result.submissions, undefined);
});

test("refuses a request carrying no password at all", async function() {
    const response = await worker.fetch(makeListRequest(null), adminEnv);

    assert.equal(response.status, 401);
    assert.equal((await response.json()).submissions, undefined);
});

test("refuses to read the submissions from another website", async function() {
    const response = await worker.fetch(makeListRequest("correct horse battery", "https://not-dystil.example"), adminEnv);

    assert.equal(response.status, 403);
    assert.equal((await response.json()).submissions, undefined);
});

test("stays shut when no password has been configured", async function() {
    const response = await worker.fetch(makeListRequest("anything"), { ...adminEnv, ADMIN_KEY: "" });

    assert.equal(response.status, 503);
    assert.equal((await response.json()).submissions, undefined);
});

test("stops guessing after five wrong passwords from one address", async function() {
    await withFakeCache(async function() {
        for (let attempt = 0; attempt < 5; attempt += 1) {
            const response = await worker.fetch(makeListRequest("wrong", "https://dystil.ai", "203.0.113.9"), adminEnv);
            assert.equal(response.status, 401);
        }

        const blocked = await worker.fetch(makeListRequest("wrong", "https://dystil.ai", "203.0.113.9"), adminEnv);
        assert.equal(blocked.status, 429);

        // The lockout holds even once the right password turns up.
        const withRightPassword = await worker.fetch(
            makeListRequest("correct horse battery", "https://dystil.ai", "203.0.113.9"),
            adminEnv
        );
        assert.equal(withRightPassword.status, 429);

        // A different visitor is unaffected.
        const elsewhere = await worker.fetch(
            makeListRequest("correct horse battery", "https://dystil.ai", "198.51.100.4"),
            adminEnv
        );
        assert.equal(elsewhere.status, 200);
    });
});


// ---------- WHERE THE SUBMISSION CAME FROM ----------

// The browser sends back what it recorded when the person first arrived, so
// these build that payload the same way script.js does.
function arrival({ referrer = "", landing = "/students/taster", tag = "" } = {}) {
    return JSON.stringify({ referrer, landing, tag, at: new Date().toISOString() });
}

async function submitWithSource(fields) {
    let stored;

    await withMockedEmailApi(async function() {
        await worker.fetch(makeRequest({ ...studentEnquiry, ...fields }), env);
        stored = env.DB.rows.at(-1);
    });

    return stored;
}

test("credits the channel a visitor arrived from", async function() {
    const row = await submitWithSource({ sourceFirst: arrival({ referrer: "https://l.instagram.com/?u=x" }) });

    assert.equal(row.source_channel, "Instagram");
    assert.equal(row.source_detail, "l.instagram.com");
    assert.equal(row.source_landing, "/students/taster");
});

// The in-app browsers strip referrers, so a tagged link is often the only
// evidence a post produced the registration.
test("trusts a ref tag ahead of the referring host", async function() {
    const row = await submitWithSource({
        sourceFirst: arrival({ referrer: "https://www.google.com/", tag: "instagram" })
    });

    assert.equal(row.source_channel, "Instagram");
    assert.equal(row.source_detail, "instagram");
});

test("calls an arrival with no referrer and no tag direct", async function() {
    const row = await submitWithSource({ sourceFirst: arrival() });

    assert.equal(row.source_channel, "Direct");
    assert.equal(row.source_detail, "");
});

test("does not treat our own pages as a source", async function() {
    const row = await submitWithSource({ sourceFirst: arrival({ referrer: "https://dystil.ai/students/home" }) });

    assert.equal(row.source_channel, "Direct");
});

// Somebody who found us on Instagram still counts as Instagram when they come
// back a week later and register.
test("prefers the first visit over the one the form was sent from", async function() {
    const row = await submitWithSource({
        sourceFirst: arrival({ referrer: "https://www.tiktok.com/" }),
        sourceVisit: arrival({ referrer: "https://www.google.com/" })
    });

    assert.equal(row.source_channel, "TikTok");
});

test("falls back to the current visit when nothing was stored first", async function() {
    const row = await submitWithSource({ sourceVisit: arrival({ referrer: "https://www.linkedin.com/" }) });

    assert.equal(row.source_channel, "LinkedIn");
});

test("keeps an unfamiliar referring host readable rather than hiding it", async function() {
    const row = await submitWithSource({ sourceFirst: arrival({ referrer: "https://news.example.org/piece" }) });

    assert.equal(row.source_channel, "news.example.org");
});

// A tampered or truncated payload must never cost somebody their registration.
test("still records the submission when the source payload is broken", async function() {
    const row = await submitWithSource({ sourceFirst: "not json at all" });

    assert.equal(row.source_channel, "Unknown");
    assert.equal(row.reference.startsWith("DYS-STU-"), true);
});

test("records nothing rather than guessing when the browser sends no source", async function() {
    const row = await submitWithSource({});

    assert.equal(row.source_channel, "Unknown");
});


// ---------- VISITOR FIGURES ----------

const analyticsEnv = {
    ...adminEnv,
    CF_ACCOUNT_ID: "account-tag-123",
    CF_ANALYTICS_TOKEN: "secret-analytics-token",
    CF_SITE_TAG: "9cea9d84df65490881d2fc85d295ee0e"
};

function makeAnalyticsRequest(password, body = null, origin = "https://dystil.ai") {
    const headers = { Origin: origin, "Content-Type": "application/json" };
    if (password !== null) headers["X-Admin-Key"] = password;

    return new Request("https://dystil-contact.example/api/analytics", {
        method: "POST",
        headers,
        body: body === null ? undefined : JSON.stringify(body)
    });
}

// Shapes a group the way the Cloudflare RUM dataset returns one.
function group(dimensions, count, visits, sampleInterval = 1) {
    return { count, sum: { visits }, avg: { sampleInterval }, dimensions };
}

// Stands in for the Cloudflare GraphQL API, and records what it was asked so a
// test can assert on the query the Worker actually sends.
async function withMockedAnalyticsApi(payload, callback) {
    const originalFetch = globalThis.fetch;
    const calls = [];

    globalThis.fetch = async function(url, options) {
        calls.push({ url, options, body: JSON.parse(options.body) });

        return Response.json(payload, { status: 200 });
    };

    try {
        await callback(calls);
    } finally {
        globalThis.fetch = originalFetch;
    }
}

const sampleVisitorPayload = {
    data: {
        viewer: {
            accounts: [{
                totals: [group({}, 120, 80)],
                daily: [group({ date: "2026-08-27" }, 70, 45), group({ date: "2026-08-28" }, 50, 35)],
                referrers: [
                    group({ refererHost: "l.instagram.com" }, 30, 25),
                    group({ refererHost: "www.instagram.com" }, 10, 8),
                    group({ refererHost: "" }, 60, 40),
                    group({ refererHost: "www.google.com" }, 20, 7)
                ],
                pages: [group({ requestPath: "/students/taster" }, 45, 30)],
                countries: [group({ countryName: "United Kingdom" }, 100, 70)]
            }]
        }
    }
};

test("refuses the visitor figures without the password", async function() {
    const response = await worker.fetch(makeAnalyticsRequest("guess"), analyticsEnv);

    assert.equal(response.status, 401);
    assert.equal((await response.json()).totals, undefined);
});

test("refuses the visitor figures from another website", async function() {
    const response = await worker.fetch(
        makeAnalyticsRequest("correct horse battery", null, "https://not-dystil.example"),
        analyticsEnv
    );

    assert.equal(response.status, 403);
});

// Setup is done by hand, so the page has to say which piece is still missing.
test("names the configuration that is still missing", async function() {
    const response = await worker.fetch(makeAnalyticsRequest("correct horse battery"), {
        ...analyticsEnv,
        CF_ANALYTICS_TOKEN: ""
    });
    const result = await response.json();

    assert.equal(response.status, 503);
    assert.equal(result.success, false);
    assert.match(result.message, /CF_ANALYTICS_TOKEN/);
});

test("reports the visitor totals for the window", async function() {
    await withMockedAnalyticsApi(sampleVisitorPayload, async function() {
        const response = await worker.fetch(makeAnalyticsRequest("correct horse battery"), analyticsEnv);
        const result = await response.json();

        assert.equal(response.status, 200);
        assert.equal(result.success, true);
        assert.equal(result.totals.views, 120);
        assert.equal(result.totals.visits, 80);
        assert.equal(result.daily.length, 2);
        assert.equal(result.daily[0].date, "2026-08-27");
        assert.equal(result.pages[0].path, "/students/taster");
        assert.equal(result.countries[0].country, "United Kingdom");
    });
});

// Two Instagram hosts are one channel, and an absent referrer is a direct visit.
test("folds referring hosts into channels and adds equal ones together", async function() {
    await withMockedAnalyticsApi(sampleVisitorPayload, async function() {
        const response = await worker.fetch(makeAnalyticsRequest("correct horse battery"), analyticsEnv);
        const result = await response.json();
        const byChannel = Object.fromEntries(result.referrers.map((row) => [row.channel, row.views]));

        assert.equal(byChannel.Instagram, 40);
        assert.equal(byChannel.Direct, 60);
        assert.equal(byChannel.Google, 20);

        // Ordered by size, so the biggest source reads first.
        assert.equal(result.referrers[0].channel, "Direct");
    });
});

// A sampled site records one event in place of several, so the figures have to
// be multiplied back out or a busy week reads as a quiet one.
test("scales sampled counts back up to real ones", async function() {
    const sampled = {
        data: {
            viewer: {
                accounts: [{
                    totals: [group({}, 100, 60, 10)],
                    daily: [],
                    referrers: [group({ refererHost: "www.tiktok.com" }, 25, 20, 10)],
                    pages: [],
                    countries: []
                }]
            }
        }
    };

    await withMockedAnalyticsApi(sampled, async function() {
        const response = await worker.fetch(makeAnalyticsRequest("correct horse battery"), analyticsEnv);
        const result = await response.json();

        assert.equal(result.totals.views, 1000);
        assert.equal(result.totals.visits, 600);
        assert.equal(result.referrers[0].channel, "TikTok");
        assert.equal(result.referrers[0].views, 250);
    });
});

// A rejected token or a renamed field comes back as a 200 with an errors array,
// which would otherwise read as "no visitors" rather than "this is broken".
test("passes a rejected analytics query through as an error", async function() {
    await withMockedAnalyticsApi({ errors: [{ message: "Authentication error" }] }, async function() {
        const response = await worker.fetch(makeAnalyticsRequest("correct horse battery"), analyticsEnv);
        const result = await response.json();

        assert.equal(response.status, 502);
        assert.equal(result.success, false);
        assert.match(result.message, /Authentication error/);
        assert.equal(result.totals, undefined);
    });
});

test("asks Cloudflare for the window the page requested", async function() {
    await withMockedAnalyticsApi(sampleVisitorPayload, async function(calls) {
        await worker.fetch(makeAnalyticsRequest("correct horse battery", { days: 7 }), analyticsEnv);

        const asked = calls[0].body.variables;
        const spanDays = (new Date(asked.end) - new Date(asked.start)) / (24 * 60 * 60 * 1000);

        assert.equal(Math.round(spanDays), 7);
        assert.equal(asked.siteTag, "9cea9d84df65490881d2fc85d295ee0e");
        assert.equal(asked.accountTag, "account-tag-123");
    });
});

// An unbounded window would let one click ask Cloudflare for years of data.
test("clamps an absurd window to the maximum", async function() {
    await withMockedAnalyticsApi(sampleVisitorPayload, async function(calls) {
        await worker.fetch(makeAnalyticsRequest("correct horse battery", { days: 5000 }), analyticsEnv);

        const asked = calls[0].body.variables;
        const spanDays = (new Date(asked.end) - new Date(asked.start)) / (24 * 60 * 60 * 1000);

        assert.equal(Math.round(spanDays), 90);
    });
});

// The token is the whole reason this endpoint exists rather than the page
// calling Cloudflare itself.
test("never sends the analytics token back to the browser", async function() {
    await withMockedAnalyticsApi(sampleVisitorPayload, async function(calls) {
        const response = await worker.fetch(makeAnalyticsRequest("correct horse battery"), analyticsEnv);
        const text = await response.text();

        assert.equal(text.includes("secret-analytics-token"), false);
        assert.equal(calls[0].options.headers.Authorization, "Bearer secret-analytics-token");
    });
});


// ---------- FINDING THE RIGHT SITE TAG ----------

// The beacon publishes the site token while the GraphQL API filters on the site
// tag. They are different values, and the wrong one returns an empty window
// rather than an error, so these cover the recovery.

const emptyWindow = {
    data: { viewer: { accounts: [{ totals: [], daily: [], referrers: [], pages: [], countries: [] }] } }
};

const filledWindow = {
    data: {
        viewer: {
            accounts: [{
                totals: [group({}, 240, 160)],
                daily: [group({ date: "2026-08-28" }, 240, 160)],
                referrers: [group({ refererHost: "l.instagram.com" }, 90, 60)],
                pages: [group({ requestPath: "/students/taster" }, 120, 80)],
                countries: [group({ countryName: "United Kingdom" }, 200, 140)]
            }]
        }
    }
};

// Answers the GraphQL endpoint per site tag, and the site list endpoint
// separately, so a test can say which tag actually holds the data.
async function withMockedCloudflare({ byTag, sites, sitesStatus = 200 }, callback) {
    const originalFetch = globalThis.fetch;
    const calls = [];

    globalThis.fetch = async function(url, options) {
        const target = String(url);

        if (target.includes("/rum/site_info/list")) {
            calls.push({ kind: "sites", url: target });

            return Response.json(
                sitesStatus === 200 ? { success: true, result: sites || [] } : { success: false, errors: [] },
                { status: sitesStatus }
            );
        }

        const asked = JSON.parse(options.body).variables.siteTag;
        calls.push({ kind: "graphql", siteTag: asked });

        return Response.json(byTag[asked] || emptyWindow, { status: 200 });
    };

    try {
        await callback(calls);
    } finally {
        globalThis.fetch = originalFetch;
    }
}

test("finds the real site tag when the beacon token returns nothing", async function() {
    await withMockedCloudflare({
        byTag: { "real-site-tag": filledWindow },
        sites: [
            { site_tag: "someone-elses-tag", site_token: "another-token" },
            { site_tag: "real-site-tag", site_token: "9cea9d84df65490881d2fc85d295ee0e" }
        ]
    }, async function(calls) {
        const response = await worker.fetch(makeAnalyticsRequest("correct horse battery"), analyticsEnv);
        const result = await response.json();

        assert.equal(response.status, 200);
        assert.equal(result.success, true);
        assert.equal(result.siteTag, "real-site-tag");
        assert.equal(result.totals.views, 240);
        assert.equal(result.referrers[0].channel, "Instagram");

        // Configured tag first, then the list, then the tag that works.
        assert.deepEqual(calls.map((call) => call.kind), ["graphql", "sites", "graphql"]);
    });
});

test("uses the only site there is when no token matches", async function() {
    await withMockedCloudflare({
        byTag: { "the-only-tag": filledWindow },
        sites: [{ site_tag: "the-only-tag", site_token: "some-other-token" }]
    }, async function() {
        const response = await worker.fetch(makeAnalyticsRequest("correct horse battery"), analyticsEnv);
        const result = await response.json();

        assert.equal(result.siteTag, "the-only-tag");
        assert.equal(result.totals.visits, 160);
    });
});

// A token scoped only to analytics may not be allowed to list sites. That is a
// reason to show an empty week, never a reason to fail.
test("still answers when the site list is refused", async function() {
    await withMockedCloudflare({ byTag: {}, sites: [], sitesStatus: 403 }, async function() {
        const response = await worker.fetch(makeAnalyticsRequest("correct horse battery"), analyticsEnv);
        const result = await response.json();

        assert.equal(response.status, 200);
        assert.equal(result.success, true);
        assert.equal(result.totals.views, 0);
        assert.equal(result.siteTag, "9cea9d84df65490881d2fc85d295ee0e");
    });
});

test("keeps the empty result when no other tag has data either", async function() {
    await withMockedCloudflare({
        byTag: {},
        sites: [{ site_tag: "also-empty", site_token: "9cea9d84df65490881d2fc85d295ee0e" }]
    }, async function() {
        const response = await worker.fetch(makeAnalyticsRequest("correct horse battery"), analyticsEnv);
        const result = await response.json();

        assert.equal(result.success, true);
        assert.equal(result.totals.views, 0);
        assert.equal(result.siteTag, "9cea9d84df65490881d2fc85d295ee0e");
    });
});

// A genuinely quiet week is the normal case; it must not cost a lookup every
// time somebody opens the page.
test("does not go looking when the configured tag already has data", async function() {
    await withMockedCloudflare({
        byTag: { "9cea9d84df65490881d2fc85d295ee0e": filledWindow },
        sites: []
    }, async function(calls) {
        const response = await worker.fetch(makeAnalyticsRequest("correct horse battery"), analyticsEnv);
        const result = await response.json();

        assert.equal(result.siteTag, "9cea9d84df65490881d2fc85d295ee0e");
        assert.equal(calls.length, 1);
        assert.equal(calls[0].kind, "graphql");
    });
});

// A sampled window turns a handful of events into round hundreds, so the page
// has to be told when to stop presenting them as a measurement.
test("says when Cloudflare sampled the window", async function() {
    const sampled = {
        data: {
            viewer: {
                accounts: [{
                    totals: [group({}, 3, 3, 100)],
                    daily: [], referrers: [], pages: [], countries: []
                }]
            }
        }
    };

    await withMockedAnalyticsApi(sampled, async function() {
        const response = await worker.fetch(makeAnalyticsRequest("correct horse battery"), analyticsEnv);
        const result = await response.json();

        assert.equal(result.sampled, true);
        assert.equal(result.totals.views, 300);
    });
});

test("does not cry sampling over a directly measured window", async function() {
    await withMockedAnalyticsApi(sampleVisitorPayload, async function() {
        const response = await worker.fetch(makeAnalyticsRequest("correct horse battery"), analyticsEnv);

        assert.equal((await response.json()).sampled, false);
    });
});

// ---------- PAYMENTS ----------

const STRIPE_WEBHOOK_SECRET = "whsec_test_secret";

function makePaidEnv() {
    return {
        ...env,
        DB: makeFakeDatabase(),
        STRIPE_SECRET_KEY: "sk_test_key",
        STRIPE_WEBHOOK_SECRET
    };
}

let paidEnv = makePaidEnv();

const bootcampRegistration = {
    formType: "Bootcamp Registration",
    fullName: "Priya Graduate",
    email: "priya@example.com",
    phone: "07000 111222",
    universityDegree: "Example University",
    careerGoal: "Data analyst",
    techSkills: "Python",
    experience: "Placement year",
    package: "Foundation Bootcamp",
    website: ""
};

// Brevo and Stripe are both reached with fetch, so the stub answers each by the
// address it was called on and keeps the two apart. Almost every assertion here
// is about which of them was called, and when.
async function withMockedApis(callback, options = {}) {
    const originalFetch = globalThis.fetch;
    const stripeCalls = [];
    const emailCalls = [];

    globalThis.fetch = async function(url, requestOptions) {
        if (String(url).startsWith("https://api.stripe.com/")) {
            stripeCalls.push({
                url: String(url),
                headers: requestOptions.headers,
                fields: new URLSearchParams(requestOptions.body)
            });

            if (options.stripeFails) {
                return Response.json({ error: { message: "no" } }, { status: 402 });
            }

            return Response.json({
                id: "cs_test_123",
                url: "https://checkout.stripe.com/c/pay/cs_test_123"
            }, { status: 200 });
        }

        emailCalls.push({ url: String(url), body: JSON.parse(requestOptions.body) });
        return Response.json({ id: crypto.randomUUID() }, { status: 201 });
    };

    try {
        await callback({ stripeCalls, emailCalls });
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function signedWebhook(event, { secret = STRIPE_WEBHOOK_SECRET, timestamp = Math.floor(Date.now() / 1000) } = {}) {
    const payload = JSON.stringify(event);
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    );

    const signed = await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${payload}`));
    const signature = [...new Uint8Array(signed)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

    return new Request("https://dystil-contact.example/api/stripe-webhook", {
        method: "POST",
        headers: { "Stripe-Signature": `t=${timestamp},v1=${signature}` },
        body: payload
    });
}

// The event Stripe sends for the session the Worker just opened. The token is
// what ties it back to the held registration.
function completedEvent(token, reference, amount = 39900) {
    return {
        type: "checkout.session.completed",
        data: {
            object: {
                id: "cs_test_123",
                client_reference_id: reference,
                amount_total: amount,
                metadata: { reference, token }
            }
        }
    };
}

function rowFor(database, reference) {
    return database.rows.find((row) => row.reference === reference);
}

// Fills in the form and stops at the payment page, which is as far as a
// registration gets on its own.
async function startRegistration(fields = bootcampRegistration) {
    let started;

    await withMockedApis(async function(calls) {
        const response = await worker.fetch(makeRequest(fields), paidEnv);
        const result = await response.json();

        started = {
            result,
            status: response.status,
            token: calls.stripeCalls[0]?.fields.get("metadata[token]") || "",
            stripeCalls: calls.stripeCalls,
            emailCalls: calls.emailCalls
        };
    });

    return started;
}

// Stripe confirming the fee is what turns a held registration into a record.
async function payFor(started, amount = 39900) {
    let calls;

    await withMockedApis(async function(mocked) {
        const request = await signedWebhook(completedEvent(started.token, started.result.reference, amount));
        calls = { ...mocked, response: await worker.fetch(request, paidEnv) };
    });

    return calls;
}

test("holds a bootcamp registration instead of recording it", async function() {
    paidEnv = makePaidEnv();
    const started = await startRegistration();

    assert.equal(started.status, 200);
    assert.equal(started.result.success, true);
    assert.equal(started.result.paymentUrl, "https://checkout.stripe.com/c/pay/cs_test_123");

    // Nothing recorded, nothing emailed. Only the hold and the lead exist.
    assert.equal(paidEnv.DB.rows.length, 0);
    assert.equal(started.emailCalls.length, 0);
    assert.equal(paidEnv.DB.pending.length, 1);
    assert.equal(paidEnv.DB.pending[0].reference, started.result.reference);
    assert.equal(paidEnv.DB.leads.length, 1);
    assert.equal(paidEnv.DB.leads[0].email, "priya@example.com");
    assert.equal(paidEnv.DB.leads[0].paid_at, null);

    assert.equal(started.stripeCalls.length, 1);
    assert.equal(started.stripeCalls[0].fields.get("client_reference_id"), started.result.reference);
    assert.equal(started.stripeCalls[0].fields.get("line_items[0][price_data][unit_amount]"), "39900");
});

test("records the registration and sends the emails once the fee is paid", async function() {
    paidEnv = makePaidEnv();
    const started = await startRegistration();
    const paid = await payFor(started);

    assert.equal(paid.response.status, 200);

    const row = rowFor(paidEnv.DB, started.result.reference);
    assert.equal(row.payment_status, "paid");
    assert.equal(row.payment_amount, 39900);
    assert.equal(row.stripe_session_id, "cs_test_123");
    assert.equal(row.full_name, "Priya Graduate");
    assert.equal(row.delivery_status, "sent");

    // The notification and the confirmation, neither of which was sent earlier.
    assert.equal(paid.emailCalls.length, 2);
    assert.equal(paid.emailCalls[0].body.to[0].email, "askus@dystil.ai");
    assert.equal(paid.emailCalls[1].body.to[0].email, "priya@example.com");

    // The hold is released and the lead is no longer waiting on anybody.
    assert.equal(paidEnv.DB.pending.length, 0);
    assert.ok(paidEnv.DB.leads[0].paid_at);
});

// The bootcamp form no longer asks for one, and a stale copy of the old page
// sending a file anyway must not stop somebody registering.
test("ignores a CV sent to a paid registration", async function() {
    paidEnv = makePaidEnv();

    const started = await startRegistration({
        ...bootcampRegistration,
        cv: new File(["a sample cv"], "Priya CV.pdf", { type: "application/pdf" })
    });

    assert.equal(started.status, 200);
    assert.equal(paidEnv.DB.pending.length, 1);
    assert.equal(started.emailCalls.length, 0);

    const paid = await payFor(started);

    assert.equal(rowFor(paidEnv.DB, started.result.reference).cv_filename, null);
    assert.equal(paid.emailCalls[0].body.attachment, undefined);
});

// The whole point of the change: an unpaid registration is not a registration.
test("never records a registration that was not paid for", async function() {
    paidEnv = makePaidEnv();
    await startRegistration();

    assert.equal(paidEnv.DB.rows.length, 0);
    assert.equal(paidEnv.DB.pending.length, 1);
});

test("keeps the name and email of somebody who stopped at the payment page", async function() {
    paidEnv = makePaidEnv();
    const started = await startRegistration();

    assert.deepEqual(paidEnv.DB.leads.map((lead) => [lead.full_name, lead.email, lead.paid_at]), [
        ["Priya Graduate", "priya@example.com", null]
    ]);
    assert.equal(paidEnv.DB.leads[0].reference, started.result.reference);
});

// Stripe retries anything it did not get a 200 for, and a retry must not mean a
// second record or a second pair of emails.
test("ignores a webhook it has already acted on", async function() {
    paidEnv = makePaidEnv();
    const started = await startRegistration();

    await payFor(started);
    const again = await payFor(started);

    assert.equal(again.response.status, 200);
    assert.equal(again.emailCalls.length, 0);
    assert.equal(paidEnv.DB.rows.length, 1);
});

test("prices the package on the server, not from the form", async function() {
    paidEnv = makePaidEnv();

    const started = await startRegistration({
        ...bootcampRegistration,
        package: "Advanced Bootcamp",
        unit_amount: "1",
        amount: "1"
    });

    assert.equal(started.stripeCalls[0].fields.get("line_items[0][price_data][unit_amount]"), "89900");

    await payFor(started, 89900);
    assert.equal(rowFor(paidEnv.DB, started.result.reference).payment_amount, 89900);
});

// A hold with no payment page to wait on is worse than no hold at all.
test("throws the hold away when Stripe cannot be reached", async function() {
    paidEnv = makePaidEnv();

    await withMockedApis(async function(calls) {
        const response = await worker.fetch(makeRequest(bootcampRegistration), paidEnv);
        const result = await response.json();

        assert.equal(response.status, 502);
        assert.equal(result.success, false);
        assert.match(result.message, /payment link/i);
        assert.equal(calls.emailCalls.length, 0);
    }, { stripeFails: true });

    assert.equal(paidEnv.DB.pending.length, 0);
    assert.equal(paidEnv.DB.rows.length, 0);
});

test("charges nothing for a package it does not recognise", async function() {
    paidEnv = makePaidEnv();

    await withMockedApis(async function(calls) {
        const response = await worker.fetch(makeRequest({
            ...bootcampRegistration,
            package: "Free Bootcamp"
        }), paidEnv);

        const result = await response.json();

        assert.equal(calls.stripeCalls.length, 0);
        assert.equal(result.paymentUrl, undefined);

        // No fee to wait for, so it is recorded and emailed straight away.
        assert.equal(paidEnv.DB.rows.length, 1);
        assert.equal(calls.emailCalls.length, 2);
    });
});

test("leaves the enquiry forms alone when Stripe is configured", async function() {
    paidEnv = makePaidEnv();

    await withMockedApis(async function(calls) {
        const response = await worker.fetch(makeRequest(studentEnquiry), paidEnv);
        const result = await response.json();

        assert.equal(calls.stripeCalls.length, 0);
        assert.equal(result.paymentUrl, undefined);
        assert.equal(calls.emailCalls.length, 2);
        assert.equal(paidEnv.DB.rows.length, 1);
        assert.equal(paidEnv.DB.pending.length, 0);
    });
});

// Without the secret the site behaves exactly as it did before payments
// existed, which is what makes this safe to deploy before Stripe is ready.
test("takes no payment until Stripe is configured", async function() {
    await withMockedApis(async function(calls) {
        const response = await worker.fetch(makeRequest(bootcampRegistration), env);
        const result = await response.json();

        assert.equal(result.success, true);
        assert.equal(result.paymentUrl, undefined);
        assert.equal(calls.stripeCalls.length, 0);
        assert.equal(calls.emailCalls.length, 2);
        assert.match(result.message, /check your inbox/i);
    });
});

test("refuses a webhook signed with the wrong secret", async function() {
    paidEnv = makePaidEnv();
    const started = await startRegistration();

    const request = await signedWebhook(completedEvent(started.token, started.result.reference), {
        secret: "whsec_not_the_secret"
    });

    const response = await worker.fetch(request, paidEnv);

    assert.equal(response.status, 400);
    assert.equal(paidEnv.DB.rows.length, 0);
    assert.equal(paidEnv.DB.pending.length, 1);
});

// A signature stays valid forever unless the timestamp it covers is checked, so
// a captured webhook could otherwise be replayed months later.
test("refuses a webhook whose signature is stale", async function() {
    paidEnv = makePaidEnv();
    const started = await startRegistration();

    const request = await signedWebhook(completedEvent(started.token, started.result.reference), {
        timestamp: Math.floor(Date.now() / 1000) - 3600
    });

    const response = await worker.fetch(request, paidEnv);

    assert.equal(response.status, 400);
    assert.equal(paidEnv.DB.rows.length, 0);
});

test("refuses a webhook carrying no signature at all", async function() {
    paidEnv = makePaidEnv();

    const request = new Request("https://dystil-contact.example/api/stripe-webhook", {
        method: "POST",
        body: JSON.stringify(completedEvent("some-token", "DYS-BOT-26-0001"))
    });

    assert.equal((await worker.fetch(request, paidEnv)).status, 400);
});

// Stripe sends far more than the one event we act on, and retries for days
// anything that does not answer 200.
test("acknowledges an event it does not act on", async function() {
    paidEnv = makePaidEnv();
    const request = await signedWebhook({ type: "payment_intent.created", data: { object: {} } });

    assert.equal((await worker.fetch(request, paidEnv)).status, 200);
});

test("acknowledges a payment for a hold that has already expired", async function() {
    paidEnv = makePaidEnv();
    const request = await signedWebhook(completedEvent("a-token-nobody-held", "DYS-BOT-26-9999"));
    const response = await worker.fetch(request, paidEnv);

    assert.equal(response.status, 200);
    assert.equal(paidEnv.DB.rows.length, 0);
});

test("shows the unpaid starts to the submissions page", async function() {
    paidEnv = makePaidEnv();
    const started = await startRegistration();

    const response = await worker.fetch(
        makeListRequest("correct horse battery"),
        { ...paidEnv, ADMIN_KEY: "correct horse battery" }
    );

    const result = await response.json();

    assert.equal(response.status, 200);
    assert.equal(result.leads.length, 1);
    assert.equal(result.leads[0].email, "priya@example.com");
    assert.equal(result.submissions.length, 0);

    // And it drops off the list once the fee is paid.
    await payFor(started);

    const after = await worker.fetch(
        makeListRequest("correct horse battery"),
        { ...paidEnv, ADMIN_KEY: "correct horse battery" }
    );

    assert.equal((await after.json()).leads.length, 0);
});

// The emails only go out once the money has arrived, so they should say so
// rather than describing the registration as an enquiry awaiting a reply.
test("says the payment was received in both emails", async function() {
    paidEnv = makePaidEnv();
    const started = await startRegistration();
    const paid = await payFor(started);

    const [notification, confirmation] = paid.emailCalls;

    // What lands in the Dystil inbox.
    assert.match(notification.body.subject, /^\[DYS-BOT-26-\d{4}\] PAID £399\.00 — Bootcamp Registration — Priya Graduate$/);
    assert.match(notification.body.htmlContent, /Payment received/);
    assert.match(notification.body.htmlContent, /£399\.00 received/);
    assert.match(notification.body.textContent, /^Payment received — Bootcamp Registration/);
    assert.match(notification.body.textContent, /Payment: £399\.00 received on /);

    // What lands in the student's inbox.
    assert.match(confirmation.body.subject, /^Payment received \| DYS-BOT-26-\d{4}$/);
    assert.match(confirmation.body.htmlContent, /Payment received\. Your bootcamp registration is complete and your place is confirmed\./);
    assert.match(confirmation.body.htmlContent, /Amount paid: <strong>£399\.00<\/strong>/);
    assert.match(confirmation.body.htmlContent, /joining details before the programme starts/);
    assert.match(confirmation.body.textContent, /Amount paid: £399\.00/);
    assert.match(confirmation.body.textContent, /Stripe emails a receipt separately\./);
});

test("shows the amount Stripe charged, not the amount we asked for", async function() {
    paidEnv = makePaidEnv();
    const started = await startRegistration({ ...bootcampRegistration, package: "Advanced Bootcamp" });
    const paid = await payFor(started, 89900);

    assert.match(paid.emailCalls[0].body.subject, /PAID £899\.00/);
    assert.match(paid.emailCalls[1].body.htmlContent, /Amount paid: <strong>£899\.00<\/strong>/);
});

// An enquiry nobody paid for must not start claiming a payment arrived.
test("leaves the unpaid forms saying what they always said", async function() {
    await withMockedApis(async function(calls) {
        await worker.fetch(makeRequest(studentEnquiry), env);

        const [notification, confirmation] = calls.emailCalls;

        assert.match(notification.body.subject, /^\[DYS-STU-26-\d{4}\] New Student Enquiry — Sam Student$/);
        assert.doesNotMatch(notification.body.htmlContent, /Payment/);
        assert.match(confirmation.body.subject, /^We’ve received your enquiry \| /);
        assert.match(confirmation.body.textContent, /enquiry has been sent successfully/);
        assert.doesNotMatch(confirmation.body.htmlContent, /Amount paid/);
    });
});
