const BREVO_API_URL = "https://api.brevo.com/v3/smtp/email";
const MAX_CV_SIZE = 4 * 1024 * 1024;
const DUPLICATE_WINDOW_SECONDS = 60;
const BURST_WINDOW_SECONDS = 600;
const BURST_LIMIT = 10;

// The submissions view is unlisted, so the password is the only thing standing
// between a stranger and everybody's contact details. Wrong guesses are capped
// hard enough that guessing is not worth attempting.
const ADMIN_ATTEMPT_LIMIT = 5;
const ADMIN_ATTEMPT_WINDOW_SECONDS = 900;
const ADMIN_PAGE_SIZE = 500;

// The reference number tells us at a glance which form was filled in, and each
// form counts from 0001 again every January: DYS-TAS-26-0001.
const FORM_CODES = {
    "Student Enquiry": "STU",
    "Corporate Enquiry": "COR",
    "Bootcamp Registration": "BOT",
    "Free Taster Registration": "TAS"
};

const NEXT_REFERENCE_SQL = `
    INSERT INTO reference_counters (form_type, year, next_number) VALUES (?, ?, 1)
    ON CONFLICT (form_type, year) DO UPDATE SET next_number = next_number + 1
    RETURNING next_number`;

const SAVE_SUBMISSION_SQL = `
    INSERT INTO submissions
        (reference, form_type, full_name, email, details, cv_filename, submitted_at, delivery_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`;

const MARK_DELIVERY_SQL = "UPDATE submissions SET delivery_status = ? WHERE reference = ?";

const LIST_SUBMISSIONS_SQL = `
    SELECT reference, form_type, full_name, email, details, cv_filename, submitted_at, delivery_status
    FROM submissions
    ORDER BY submitted_at DESC
    LIMIT ?`;

const FORM_SCHEMAS = {
    "Student Enquiry": [
        ["fullName", "Full name"],
        ["email", "Email"],
        ["phone", "Phone"],
        ["interest", "Area of interest"],
        ["message", "Message"]
    ],
    "Corporate Enquiry": [
        ["fullName", "Full name"],
        ["email", "Email"],
        ["company", "Company"],
        ["focusArea", "Primary focus area"],
        ["challenge", "Biggest challenge"]
    ],
    "Bootcamp Registration": [
        ["fullName", "Full name"],
        ["email", "Email"],
        ["phone", "Phone"],
        ["universityDegree", "University / degree"],
        ["careerGoal", "Career goal"],
        ["techSkills", "Previous tech skills"],
        ["experience", "Past experience"],
        ["package", "Package"]
    ],
    "Free Taster Registration": [
        ["fullName", "Full name"],
        ["email", "Email"],
        ["phone", "Phone"],
        ["currentStatus", "Current status"],
        ["areaOfInterest", "Area of interest"],
        ["message", "Message"]
    ]
};

const REQUIRED_FIELDS = {
    "Student Enquiry": ["fullName", "email", "phone", "interest"],
    "Corporate Enquiry": ["fullName", "email", "company", "focusArea"],
    "Bootcamp Registration": ["fullName", "email", "phone", "package"],
    "Free Taster Registration": ["fullName", "email", "currentStatus", "areaOfInterest"]
};

const FIELD_LIMITS = {
    fullName: 120,
    email: 254,
    phone: 40,
    interest: 120,
    company: 160,
    focusArea: 120,
    universityDegree: 250,
    package: 120,
    currentStatus: 120,
    areaOfInterest: 120,
    message: 4000,
    challenge: 4000,
    careerGoal: 4000,
    techSkills: 4000,
    experience: 4000
};

export default {
    async fetch(request, env) {
        const origin = request.headers.get("Origin") || "";
        const allowedOrigins = getAllowedOrigins(env);
        const corsHeaders = buildCorsHeaders(origin, allowedOrigins);
        const respond = buildResponder(request, corsHeaders);
        const url = new URL(request.url);

        if (request.method === "OPTIONS") {
            if (!allowedOrigins.has(origin)) {
                return jsonResponse({ success: false, message: "Origin not allowed." }, 403);
            }

            return new Response(null, { status: 204, headers: corsHeaders });
        }

        if (request.method === "POST" && url.pathname === "/api/submissions") {
            if (!allowedOrigins.has(origin)) {
                return jsonResponse({ success: false, message: "Origin not allowed." }, 403);
            }

            return listSubmissions(request, env, corsHeaders);
        }

        if (request.method !== "POST" || !["/api/enquiry", "/api/submit-form"].includes(url.pathname)) {
            return respond({ success: false, message: "Not found." }, 404);
        }

        if (!allowedOrigins.has(origin)) {
            return jsonResponse({ success: false, message: "Origin not allowed." }, 403);
        }

        if (!env.BREVO_API_KEY) {
            console.error("BREVO_API_KEY is not configured.");
            return respond({ success: false, message: "The enquiry service is not configured yet." }, 503);
        }

        const contentType = request.headers.get("Content-Type") || "";
        if (!contentType.startsWith("multipart/form-data") && !contentType.startsWith("application/x-www-form-urlencoded")) {
            return respond({ success: false, message: "Unsupported form format." }, 415);
        }

        const contentLength = Number(request.headers.get("Content-Length") || 0);
        if (contentLength > MAX_CV_SIZE + 100000) {
            return respond({ success: false, message: "The uploaded CV must be 4 MB or smaller." }, 413);
        }

        let formData;
        try {
            formData = await request.formData();
        } catch {
            return respond({ success: false, message: "We could not read the form. Please try again." }, 400);
        }

        // A hidden field catches basic form bots without inconveniencing visitors.
        if (cleanText(formData.get("website"), 200)) {
            return respond({ success: true, message: "Thanks — your details have been sent." }, 200);
        }

        const formType = cleanText(formData.get("formType"), 80);
        const schema = FORM_SCHEMAS[formType];
        if (!schema) {
            return respond({ success: false, message: "Unknown form type." }, 400);
        }

        const values = {};
        for (const [field] of schema) {
            values[field] = cleanText(formData.get(field), FIELD_LIMITS[field]);
        }

        const missingField = REQUIRED_FIELDS[formType].find((field) => !values[field]);
        if (missingField) {
            return respond({ success: false, message: "Please complete all required fields." }, 400);
        }

        if (!isValidEmail(values.email)) {
            return respond({ success: false, message: "Please enter a valid email address." }, 400);
        }

        const cvResult = await readCvAttachment(formData.get("cv"));
        if (cvResult.error) {
            return respond({ success: false, message: cvResult.error }, 400);
        }

        const rateLimit = await checkRateLimit(request, formType, values.email);
        if (rateLimit.blocked) {
            return respond({ success: false, message: rateLimit.message }, 429);
        }

        const fromEmail = env.FROM_EMAIL || "askus@dystil.ai";
        const adminEmail = env.ADMIN_EMAIL || "askus@dystil.ai";
        const submittedAt = new Date().toLocaleString("en-GB", {
            dateStyle: "long",
            timeStyle: "short",
            timeZone: "Europe/London"
        });

        // Every enquiry is recorded before it is sent, so nothing is lost if the
        // email provider fails. Without that record there is no reference number
        // to quote, so a storage failure stops the submission.
        let reference;
        try {
            reference = await allocateReference(env.DB, formType);
            await saveSubmission(env.DB, reference, formType, values, cvResult.attachment, submittedAt);
        } catch (error) {
            console.error("Could not record the submission.", error instanceof Error ? error.message : "Unknown error");

            return respond({
                success: false,
                message: "We could not record your enquiry right now. Please try again shortly or email askus@dystil.ai."
            }, 503);
        }

        const adminEmailPayload = {
            sender: { name: "Dystil Website", email: fromEmail },
            to: [{ email: adminEmail, name: "Dystil" }],
            replyTo: { email: values.email, name: values.fullName },
            subject: `[${reference}] New ${formType} — ${values.fullName}`,
            htmlContent: buildAdminHtml(formType, schema, values, cvResult.attachment, submittedAt, reference),
            textContent: buildAdminText(formType, schema, values, cvResult.attachment, submittedAt, reference)
        };

        if (cvResult.attachment) {
            adminEmailPayload.attachment = [{
                name: cvResult.attachment.filename,
                content: cvResult.attachment.content
            }];
        }

        const confirmationEmailPayload = {
            sender: { name: "Dystil", email: fromEmail },
            to: [{ email: values.email, name: values.fullName }],
            replyTo: { email: adminEmail, name: "Dystil" },
            subject: `We’ve received your enquiry | ${reference}`,
            htmlContent: buildConfirmationHtml(values.fullName, formType, reference),
            textContent: buildConfirmationText(values.fullName, formType, reference)
        };

        const [adminResult, confirmationResult] = await Promise.all([
            sendEmail(env.BREVO_API_KEY, adminEmailPayload, crypto.randomUUID()),
            sendEmail(env.BREVO_API_KEY, confirmationEmailPayload, crypto.randomUUID())
        ]);

        const delivered = adminResult.ok && confirmationResult.ok;
        await markDelivery(env.DB, reference, delivered ? "sent" : "failed");

        if (!delivered) {
            console.error("Email delivery request failed.", {
                reference,
                adminStatus: adminResult.status,
                confirmationStatus: confirmationResult.status
            });

            return respond({
                success: false,
                message: "We could not send your enquiry right now. Please email askus@dystil.ai directly."
            }, 502);
        }

        await recordSubmission(rateLimit);

        return respond({
            success: true,
            reference,
            message: `Thanks — your details have been sent. Your reference is ${reference}. Please check your inbox for confirmation.`
        }, 200);
    }
};

function getAllowedOrigins(env) {
    return new Set(
        (env.ALLOWED_ORIGINS || "https://dystil.ai,https://www.dystil.ai")
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean)
    );
}

function buildCorsHeaders(origin, allowedOrigins) {
    const headers = {
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-Admin-Key",
        "Access-Control-Max-Age": "86400",
        "Content-Type": "application/json; charset=utf-8",
        "Vary": "Origin"
    };

    if (allowedOrigins.has(origin)) {
        headers["Access-Control-Allow-Origin"] = origin;
    }

    return headers;
}

// Visitors whose JavaScript failed to load post straight to this endpoint, and
// a browser left showing raw JSON would look broken, so they get a page back.
// The website's own fetch call sends "Accept: */*" and still receives JSON.
function buildResponder(request, corsHeaders) {
    const wantsHtml = (request.headers.get("Accept") || "").includes("text/html");

    return function(body, status) {
        return wantsHtml
            ? htmlResponse(body, status, corsHeaders)
            : jsonResponse(body, status, corsHeaders);
    };
}

function htmlResponse(body, status, extraHeaders = {}) {
    return new Response(buildResultPage(body), {
        status,
        headers: {
            ...extraHeaders,
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store"
        }
    });
}

function buildResultPage(body) {
    const heading = body.success ? "Thank you" : "We could not send your details";

    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(heading)} | Dystil</title>
</head>
<body style="margin:0;background:#f4f7f6;font-family:Arial,sans-serif;color:#16221d;">
    <div style="max-width:620px;margin:0 auto;padding:48px 16px;">
        <div style="background:#123f31;color:#fff;padding:24px;border-radius:12px 12px 0 0;">
            <h1 style="font-size:24px;margin:0;">${escapeHtml(heading)}</h1>
        </div>
        <div style="background:#fff;padding:24px;border-radius:0 0 12px 12px;line-height:1.6;">
            <p style="margin-top:0;">${escapeHtml(body.message)}</p>
            <p style="margin-bottom:0;"><a href="https://dystil.ai" style="color:#147a59;">Return to dystil.ai</a></p>
        </div>
    </div>
</body>
</html>`;
}

function jsonResponse(body, status, extraHeaders = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            ...extraHeaders
        }
    });
}

function cleanText(value, maximumLength) {
    if (typeof value !== "string") return "";
    return value.replace(/\0/g, "").trim().slice(0, maximumLength);
}

function isValidEmail(email) {
    return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function readCvAttachment(value) {
    if (!(value instanceof File) || value.size === 0) {
        return { attachment: null };
    }

    if (value.size > MAX_CV_SIZE) {
        return { error: "The uploaded CV must be 4 MB or smaller." };
    }

    const extension = value.name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] || "";
    if (![".pdf", ".doc", ".docx"].includes(extension)) {
        return { error: "Please upload the CV as a PDF, DOC or DOCX file." };
    }

    const safeFilename = value.name.replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 150) || `cv${extension}`;
    const bytes = new Uint8Array(await value.arrayBuffer());

    return {
        attachment: {
            filename: safeFilename,
            content: bytesToBase64(bytes),
            size: value.size
        }
    };
}

function bytesToBase64(bytes) {
    if (typeof bytes.toBase64 === "function") {
        return bytes.toBase64();
    }

    let binary = "";
    const chunkSize = 0x8000;
    for (let index = 0; index < bytes.length; index += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
    }

    return btoa(binary);
}

// A whole university or office can share one address, so limiting purely by
// address makes visitors block each other. The short window instead catches the
// same person sending the same form twice, and a per-address burst cap still
// bounds automated flooding to the same 60 submissions an hour as before.
async function checkRateLimit(request, formType, email) {
    if (typeof caches === "undefined" || !caches.default) return { blocked: false, keys: [] };

    const address = request.headers.get("CF-Connecting-IP") || "unknown";
    const duplicateKey = await buildLimitKey("duplicate", address, formType, email.toLowerCase());

    if (await caches.default.match(duplicateKey)) {
        return {
            blocked: true,
            message: "You have just sent this form. Please wait a minute before sending it again."
        };
    }

    const burstKey = await findFreeBurstKey(address);
    if (!burstKey) {
        return {
            blocked: true,
            message: "Too many enquiries have come from this network. Please try again shortly or email askus@dystil.ai."
        };
    }

    return {
        blocked: false,
        keys: [
            { key: duplicateKey, seconds: DUPLICATE_WINDOW_SECONDS },
            { key: burstKey, seconds: BURST_WINDOW_SECONDS }
        ]
    };
}

// Reads the submissions for the unlisted /students/database page. The password
// travels in a header rather than the URL so it never reaches a browser history,
// a referrer, or an access log.
async function listSubmissions(request, env, corsHeaders) {
    if (!env.ADMIN_KEY) {
        console.error("ADMIN_KEY is not configured.");
        return jsonResponse({ success: false, message: "The submissions view is not configured yet." }, 503, corsHeaders);
    }

    const address = request.headers.get("CF-Connecting-IP") || "unknown";

    if (await adminAttemptsExhausted(address)) {
        return jsonResponse({
            success: false,
            message: "Too many incorrect passwords. Please wait fifteen minutes and try again."
        }, 429, corsHeaders);
    }

    if (!(await secretsMatch(request.headers.get("X-Admin-Key"), env.ADMIN_KEY))) {
        await recordFailedAdminAttempt(address);
        return jsonResponse({ success: false, message: "That password was not recognised." }, 401, corsHeaders);
    }

    if (!env.DB) {
        return jsonResponse({ success: false, message: "No database is connected." }, 503, corsHeaders);
    }

    try {
        const { results } = await env.DB.prepare(LIST_SUBMISSIONS_SQL).bind(ADMIN_PAGE_SIZE).all();

        return jsonResponse({ success: true, submissions: results || [] }, 200, corsHeaders);
    } catch (error) {
        console.error("Could not read the submissions.", error);
        return jsonResponse({ success: false, message: "Could not read the submissions." }, 500, corsHeaders);
    }
}

// Compares digests rather than the strings themselves, so neither the length of
// the password nor the position of the first wrong character can be timed.
async function secretsMatch(candidate, expected) {
    if (typeof candidate !== "string" || typeof expected !== "string" || !candidate) return false;

    const encoder = new TextEncoder();
    const [candidateDigest, expectedDigest] = await Promise.all([
        crypto.subtle.digest("SHA-256", encoder.encode(candidate)),
        crypto.subtle.digest("SHA-256", encoder.encode(expected))
    ]);

    const left = new Uint8Array(candidateDigest);
    const right = new Uint8Array(expectedDigest);
    let difference = 0;

    for (let index = 0; index < left.length; index += 1) {
        difference |= left[index] ^ right[index];
    }

    return difference === 0;
}

async function adminAttemptsExhausted(address) {
    if (typeof caches === "undefined" || !caches.default) return false;

    return (await findFreeAdminAttemptKey(address)) === null;
}

async function recordFailedAdminAttempt(address) {
    if (typeof caches === "undefined" || !caches.default) return;

    const key = await findFreeAdminAttemptKey(address);
    if (!key) return;

    await caches.default.put(key, new Response("1", {
        headers: { "Cache-Control": `public, max-age=${ADMIN_ATTEMPT_WINDOW_SECONDS}` }
    }));
}

async function findFreeAdminAttemptKey(address) {
    for (let slot = 0; slot < ADMIN_ATTEMPT_LIMIT; slot += 1) {
        const key = await buildLimitKey("admin", address, String(slot));
        if (!(await caches.default.match(key))) return key;
    }

    return null;
}

async function findFreeBurstKey(address) {
    for (let slot = 0; slot < BURST_LIMIT; slot += 1) {
        const key = await buildLimitKey("burst", address, String(slot));
        if (!(await caches.default.match(key))) return key;
    }

    return null;
}

async function buildLimitKey(...parts) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("|")));
    const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");

    return new Request(`https://rate-limit.invalid/${hash}`);
}

// Recorded only once the emails are away, so a provider failure never blocks
// the retry the error message invites.
async function recordSubmission(rateLimit) {
    if (typeof caches === "undefined" || !caches.default) return;

    await Promise.all(rateLimit.keys.map(({ key, seconds }) => caches.default.put(key, new Response("1", {
        headers: { "Cache-Control": `public, max-age=${seconds}` }
    }))));
}

// One statement, so two submissions arriving together cannot take the same
// number. A gap appears if the row insert then fails, which is harmless.
async function allocateReference(db, formType) {
    if (!db) throw new Error("No database binding is configured.");

    const year = new Date().toLocaleDateString("en-GB", { year: "2-digit", timeZone: "Europe/London" });
    const row = await db.prepare(NEXT_REFERENCE_SQL).bind(formType, year).first();

    if (!row) throw new Error("The reference counter returned nothing.");

    return `DYS-${FORM_CODES[formType]}-${year}-${String(row.next_number).padStart(4, "0")}`;
}

// The CV is kept out of the database and stays an email attachment, so only its
// filename is recorded here.
async function saveSubmission(db, reference, formType, values, attachment, submittedAt) {
    await db.prepare(SAVE_SUBMISSION_SQL).bind(
        reference,
        formType,
        values.fullName,
        values.email,
        JSON.stringify(values),
        attachment ? attachment.filename : null,
        submittedAt
    ).run();
}

// A failure here leaves the row saying "pending" while the emails are already
// away, which is worth a log but not worth failing the visitor's submission.
async function markDelivery(db, reference, status) {
    try {
        await db.prepare(MARK_DELIVERY_SQL).bind(status, reference).run();
    } catch (error) {
        console.error("Could not update the delivery status.", {
            reference,
            message: error instanceof Error ? error.message : "Unknown error"
        });
    }
}

// Brevo takes the idempotency key as a request header holding a bare UUID, and
// remembers it for 30 minutes. Putting it in the body instead only stamps a
// custom header onto the email that gets delivered, which is what this used to
// do. The two emails are separate calls and so need separate keys.
async function sendEmail(apiKey, payload, idempotencyKey) {
    try {
        const response = await fetch(BREVO_API_URL, {
            method: "POST",
            headers: {
                "accept": "application/json",
                "api-key": apiKey,
                "idempotencyKey": idempotencyKey,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            await response.text();
        } else if (response.body) {
            await response.body.cancel();
        }

        return { ok: response.ok, status: response.status };
    } catch (error) {
        console.error("Could not reach the email provider.", error instanceof Error ? error.message : "Unknown error");
        return { ok: false, status: 0 };
    }
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function formatHtmlValue(value) {
    return escapeHtml(value || "—").replace(/\r?\n/g, "<br>");
}

function buildAdminHtml(formType, schema, values, attachment, submittedAt, reference) {
    const referenceRow = `
        <tr>
            <td style="padding:10px;border:1px solid #e5e7eb;font-weight:700;vertical-align:top;width:34%;">Reference</td>
            <td style="padding:10px;border:1px solid #e5e7eb;vertical-align:top;"><strong>${escapeHtml(reference)}</strong></td>
        </tr>`;

    const rows = schema.map(([field, label]) => `
        <tr>
            <td style="padding:10px;border:1px solid #e5e7eb;font-weight:700;vertical-align:top;width:34%;">${escapeHtml(label)}</td>
            <td style="padding:10px;border:1px solid #e5e7eb;vertical-align:top;">${formatHtmlValue(values[field])}</td>
        </tr>`).join("");

    const cvRow = attachment ? `
        <tr>
            <td style="padding:10px;border:1px solid #e5e7eb;font-weight:700;vertical-align:top;">CV</td>
            <td style="padding:10px;border:1px solid #e5e7eb;vertical-align:top;">${escapeHtml(attachment.filename)} (${formatFileSize(attachment.size)}) — attached</td>
        </tr>` : "";

    return `<!doctype html>
        <html><body style="margin:0;background:#f4f7f6;font-family:Arial,sans-serif;color:#16221d;">
            <div style="max-width:680px;margin:0 auto;padding:32px 16px;">
                <div style="background:#123f31;color:#fff;padding:24px;border-radius:12px 12px 0 0;">
                    <h1 style="font-size:24px;margin:0;">New ${escapeHtml(formType)}</h1>
                    <p style="margin:8px 0 0;color:#d8ede5;">Submitted ${escapeHtml(submittedAt)}</p>
                </div>
                <div style="background:#fff;padding:24px;border-radius:0 0 12px 12px;">
                    <p style="margin-top:0;">Reply to this email to contact <strong>${escapeHtml(values.fullName)}</strong>.</p>
                    <table style="border-collapse:collapse;width:100%;font-size:14px;">${referenceRow}${rows}${cvRow}</table>
                </div>
            </div>
        </body></html>`;
}

function buildAdminText(formType, schema, values, attachment, submittedAt, reference) {
    const lines = schema.map(([field, label]) => `${label}: ${values[field] || "—"}`);
    if (attachment) lines.push(`CV: ${attachment.filename} (${formatFileSize(attachment.size)}) — attached`);
    return [`New ${formType}`, `Reference ${reference}`, `Submitted ${submittedAt}`, "", ...lines].join("\n");
}

function buildConfirmationHtml(fullName, formType, reference) {
    return `<!doctype html>
        <html><body style="margin:0;background:#f4f7f6;font-family:Arial,sans-serif;color:#16221d;">
            <div style="max-width:620px;margin:0 auto;padding:32px 16px;">
                <div style="background:#123f31;color:#fff;padding:24px;border-radius:12px 12px 0 0;">
                    <h1 style="font-size:24px;margin:0;">Thank you, ${escapeHtml(fullName)}.</h1>
                </div>
                <div style="background:#fff;padding:24px;border-radius:0 0 12px 12px;line-height:1.6;">
                    <p style="margin-top:0;">Your enquiry has been sent successfully and received by Dystil.</p>
                    <p style="background:#f4f7f6;border-left:4px solid #147a59;padding:12px 16px;">Your reference is <strong>${escapeHtml(reference)}</strong>. Please quote it if you contact us about this enquiry.</p>
                    <p>We’ve recorded it as <strong>${escapeHtml(formType)}</strong>. A member of our team will review your details and contact you shortly.</p>
                    <p>If you need to add anything, reply to this email or contact us at <a href="mailto:askus@dystil.ai" style="color:#147a59;">askus@dystil.ai</a>.</p>
                    <p style="margin-bottom:0;">Kind regards,<br><strong>The Dystil Team</strong></p>
                </div>
            </div>
        </body></html>`;
}

function buildConfirmationText(fullName, formType, reference) {
    return `Thank you, ${fullName}.\n\nYour enquiry has been sent successfully and received by Dystil.\n\nYour reference is ${reference}. Please quote it if you contact us about this enquiry.\n\nWe’ve recorded it as ${formType}. A member of our team will review your details and contact you shortly.\n\nIf you need to add anything, reply to this email or contact askus@dystil.ai.\n\nKind regards,\nThe Dystil Team`;
}

function formatFileSize(bytes) {
    if (!Number.isFinite(bytes)) return "unknown size";
    if (bytes < 1024) return `${bytes} B`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
