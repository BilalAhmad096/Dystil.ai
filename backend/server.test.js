import test from "node:test";
import assert from "node:assert/strict";
import worker from "./server.js";

// Enough of the D1 binding for the three statements the Worker runs. Counters
// carry across tests, so assertions compare consecutive numbers rather than
// expecting any particular one.
function makeFakeDatabase() {
    const counters = new Map();
    const rows = [];

    return {
        rows,
        prepare(sql) {
            return {
                bind(...args) {
                    return {
                        async first() {
                            if (!sql.includes("reference_counters")) throw new Error(`Unexpected statement: ${sql}`);

                            const key = `${args[0]}|${args[1]}`;
                            const next = (counters.get(key) || 0) + 1;
                            counters.set(key, next);

                            return { next_number: next };
                        },
                        async run() {
                            if (sql.includes("INSERT INTO submissions")) {
                                rows.push({
                                    reference: args[0],
                                    form_type: args[1],
                                    full_name: args[2],
                                    email: args[3],
                                    details: args[4],
                                    cv_filename: args[5],
                                    submitted_at: args[6],
                                    delivery_status: "pending"
                                });

                                return { success: true };
                            }

                            if (sql.includes("UPDATE submissions")) {
                                const row = rows.find((candidate) => candidate.reference === args[1]);
                                if (row) row.delivery_status = args[0];

                                return { success: true };
                            }

                            throw new Error(`Unexpected statement: ${sql}`);
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
