import test from "node:test";
import assert from "node:assert/strict";
import worker from "./server.js";

const env = {
    BREVO_API_KEY: "xkeysib-test-key",
    ALLOWED_ORIGINS: "https://dystil.ai,https://www.dystil.ai",
    ADMIN_EMAIL: "askus@dystil.ai",
    FROM_EMAIL: "askus@dystil.ai"
};

function makeRequest(fields, origin = "https://dystil.ai") {
    const body = new FormData();
    Object.entries(fields).forEach(([key, value]) => body.set(key, value));

    return new Request("https://dystil-contact.example/api/enquiry", {
        method: "POST",
        headers: { Origin: origin },
        body
    });
}

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
