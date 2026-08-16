import test from "node:test";
import assert from "node:assert/strict";
import worker from "./server.js";

const env = {
    BREVO_API_KEY: "xkeysib-test-key",
    ALLOWED_ORIGINS: "https://dystil.ai,https://www.dystil.ai",
    ADMIN_EMAIL: "askus@dystil.ai",
    FROM_EMAIL: "askus@dystil.ai"
};

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
