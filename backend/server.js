const BREVO_API_URL = "https://api.brevo.com/v3/smtp/email";
const MAX_CV_SIZE = 4 * 1024 * 1024;
const RATE_LIMIT_SECONDS = 60;

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
        const url = new URL(request.url);

        if (request.method === "OPTIONS") {
            if (!allowedOrigins.has(origin)) {
                return jsonResponse({ success: false, message: "Origin not allowed." }, 403);
            }

            return new Response(null, { status: 204, headers: corsHeaders });
        }

        if (request.method !== "POST" || !["/api/enquiry", "/api/submit-form"].includes(url.pathname)) {
            return jsonResponse({ success: false, message: "Not found." }, 404, corsHeaders);
        }

        if (!allowedOrigins.has(origin)) {
            return jsonResponse({ success: false, message: "Origin not allowed." }, 403);
        }

        if (!env.BREVO_API_KEY) {
            console.error("BREVO_API_KEY is not configured.");
            return jsonResponse({ success: false, message: "The enquiry service is not configured yet." }, 503, corsHeaders);
        }

        const contentType = request.headers.get("Content-Type") || "";
        if (!contentType.startsWith("multipart/form-data") && !contentType.startsWith("application/x-www-form-urlencoded")) {
            return jsonResponse({ success: false, message: "Unsupported form format." }, 415, corsHeaders);
        }

        const contentLength = Number(request.headers.get("Content-Length") || 0);
        if (contentLength > MAX_CV_SIZE + 100000) {
            return jsonResponse({ success: false, message: "The uploaded CV must be 4 MB or smaller." }, 413, corsHeaders);
        }

        let formData;
        try {
            formData = await request.formData();
        } catch {
            return jsonResponse({ success: false, message: "We could not read the form. Please try again." }, 400, corsHeaders);
        }

        // A hidden field catches basic form bots without inconveniencing visitors.
        if (cleanText(formData.get("website"), 200)) {
            return jsonResponse({ success: true, message: "Thanks — your details have been sent." }, 200, corsHeaders);
        }

        const formType = cleanText(formData.get("formType"), 80);
        const schema = FORM_SCHEMAS[formType];
        if (!schema) {
            return jsonResponse({ success: false, message: "Unknown form type." }, 400, corsHeaders);
        }

        const values = {};
        for (const [field] of schema) {
            values[field] = cleanText(formData.get(field), FIELD_LIMITS[field]);
        }

        const missingField = REQUIRED_FIELDS[formType].find((field) => !values[field]);
        if (missingField) {
            return jsonResponse({ success: false, message: "Please complete all required fields." }, 400, corsHeaders);
        }

        if (!isValidEmail(values.email)) {
            return jsonResponse({ success: false, message: "Please enter a valid email address." }, 400, corsHeaders);
        }

        const cvResult = await readCvAttachment(formData.get("cv"));
        if (cvResult.error) {
            return jsonResponse({ success: false, message: cvResult.error }, 400, corsHeaders);
        }

        if (await isRateLimited(request)) {
            return jsonResponse({ success: false, message: "Please wait a minute before sending another enquiry." }, 429, corsHeaders);
        }

        const submissionId = crypto.randomUUID();
        const fromEmail = env.FROM_EMAIL || "askus@dystil.ai";
        const adminEmail = env.ADMIN_EMAIL || "askus@dystil.ai";
        const submittedAt = new Date().toLocaleString("en-GB", {
            dateStyle: "long",
            timeStyle: "short",
            timeZone: "Europe/London"
        });

        const adminEmailPayload = {
            sender: { name: "Dystil Website", email: fromEmail },
            to: [{ email: adminEmail, name: "Dystil" }],
            replyTo: { email: values.email, name: values.fullName },
            subject: `New ${formType} — ${values.fullName}`,
            htmlContent: buildAdminHtml(formType, schema, values, cvResult.attachment, submittedAt),
            textContent: buildAdminText(formType, schema, values, cvResult.attachment, submittedAt)
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
            subject: "We’ve received your enquiry | Dystil",
            htmlContent: buildConfirmationHtml(values.fullName, formType),
            textContent: buildConfirmationText(values.fullName, formType)
        };

        const [adminResult, confirmationResult] = await Promise.all([
            sendEmail(env.BREVO_API_KEY, adminEmailPayload, `admin-${submissionId}`),
            sendEmail(env.BREVO_API_KEY, confirmationEmailPayload, `confirmation-${submissionId}`)
        ]);

        if (!adminResult.ok || !confirmationResult.ok) {
            console.error("Email delivery request failed.", {
                adminStatus: adminResult.status,
                confirmationStatus: confirmationResult.status
            });

            return jsonResponse({
                success: false,
                message: "We could not send your enquiry right now. Please email askus@dystil.ai directly."
            }, 502, corsHeaders);
        }

        return jsonResponse({
            success: true,
            message: "Thanks — your details have been sent. Please check your inbox for confirmation."
        }, 200, corsHeaders);
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
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
        "Content-Type": "application/json; charset=utf-8",
        "Vary": "Origin"
    };

    if (allowedOrigins.has(origin)) {
        headers["Access-Control-Allow-Origin"] = origin;
    }

    return headers;
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

async function isRateLimited(request) {
    if (typeof caches === "undefined" || !caches.default) return false;

    const ipAddress = request.headers.get("CF-Connecting-IP") || "unknown";
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ipAddress));
    const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const cacheKey = new Request(`https://rate-limit.invalid/${hash}`);
    const cached = await caches.default.match(cacheKey);

    if (cached) return true;

    await caches.default.put(cacheKey, new Response("1", {
        headers: { "Cache-Control": `public, max-age=${RATE_LIMIT_SECONDS}` }
    }));

    return false;
}

async function sendEmail(apiKey, payload, idempotencyKey) {
    try {
        const response = await fetch(BREVO_API_URL, {
            method: "POST",
            headers: {
                "accept": "application/json",
                "api-key": apiKey,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                ...payload,
                headers: {
                    ...payload.headers,
                    "Idempotency-Key": idempotencyKey
                }
            })
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

function buildAdminHtml(formType, schema, values, attachment, submittedAt) {
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
                    <table style="border-collapse:collapse;width:100%;font-size:14px;">${rows}${cvRow}</table>
                </div>
            </div>
        </body></html>`;
}

function buildAdminText(formType, schema, values, attachment, submittedAt) {
    const lines = schema.map(([field, label]) => `${label}: ${values[field] || "—"}`);
    if (attachment) lines.push(`CV: ${attachment.filename} (${formatFileSize(attachment.size)}) — attached`);
    return [`New ${formType}`, `Submitted ${submittedAt}`, "", ...lines].join("\n");
}

function buildConfirmationHtml(fullName, formType) {
    return `<!doctype html>
        <html><body style="margin:0;background:#f4f7f6;font-family:Arial,sans-serif;color:#16221d;">
            <div style="max-width:620px;margin:0 auto;padding:32px 16px;">
                <div style="background:#123f31;color:#fff;padding:24px;border-radius:12px 12px 0 0;">
                    <h1 style="font-size:24px;margin:0;">Thank you, ${escapeHtml(fullName)}.</h1>
                </div>
                <div style="background:#fff;padding:24px;border-radius:0 0 12px 12px;line-height:1.6;">
                    <p style="margin-top:0;">Your enquiry has been sent successfully and received by Dystil.</p>
                    <p>We’ve recorded it as <strong>${escapeHtml(formType)}</strong>. A member of our team will review your details and contact you shortly.</p>
                    <p>If you need to add anything, reply to this email or contact us at <a href="mailto:askus@dystil.ai" style="color:#147a59;">askus@dystil.ai</a>.</p>
                    <p style="margin-bottom:0;">Kind regards,<br><strong>The Dystil Team</strong></p>
                </div>
            </div>
        </body></html>`;
}

function buildConfirmationText(fullName, formType) {
    return `Thank you, ${fullName}.\n\nYour enquiry has been sent successfully and received by Dystil.\n\nWe’ve recorded it as ${formType}. A member of our team will review your details and contact you shortly.\n\nIf you need to add anything, reply to this email or contact askus@dystil.ai.\n\nKind regards,\nThe Dystil Team`;
}

function formatFileSize(bytes) {
    if (!Number.isFinite(bytes)) return "unknown size";
    if (bytes < 1024) return `${bytes} B`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
