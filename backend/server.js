const BREVO_API_URL = "https://api.brevo.com/v3/smtp/email";
const STRIPE_SESSIONS_API = "https://api.stripe.com/v1/checkout/sessions";
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

// Programme fees in pence. They are priced here rather than in the form because
// the page may say which package somebody chose, but never what it costs: a
// figure that arrives from a browser is a figure anybody can change.
const BOOTCAMP_PRICES = {
    "Foundation Bootcamp": 39900,
    "Advanced Bootcamp": 89900
};

// The bootcamp is the only form anybody pays for. The rest are enquiries.
const PAID_FORM = "Bootcamp Registration";

// Stripe retries a webhook it never got a 200 from, so an old signature has to
// be refused rather than trusted. Five minutes is Stripe's own tolerance.
const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300;

// How long a registration waits for its fee before it is thrown away. Long
// enough for somebody to fetch their card from another room, short enough that
// the details of a registration that never happened are not kept.
const PENDING_LIFETIME_MS = 24 * 60 * 60 * 1000;

// The reference number tells us at a glance which form was filled in, and each
// form counts from 0001 again every January: DYS-TAS-26-0001.
const FORM_CODES = {
    "Student Enquiry": "STU",
    "Corporate Enquiry": "COR",
    "Bootcamp Registration": "BOT",
    "Free Taster Registration": "TAS",
    "Second Taster Registration": "TS2",
    "Taster Session Feedback": "FBK"
};

// Feedback is the one form nobody is waiting on a reply to, so the receipt it
// sends back says something different from the other four.
const FEEDBACK_FORM = "Taster Session Feedback";

// A referring host or a ?ref= tag is turned into a channel name. The tag wins,
// because the in-app browsers on Instagram and TikTok routinely strip referrers
// and a tagged link is then the only thing that still says where someone came
// from. Matching is on a fragment, so l.instagram.com counts as Instagram.
const ANALYTICS_API = "https://api.cloudflare.com/client/v4/graphql";
const RUM_SITES_API = "https://api.cloudflare.com/client/v4/accounts/%s/rum/site_info/list";
const ANALYTICS_DEFAULT_DAYS = 30;
const ANALYTICS_MAX_DAYS = 90;
const ANALYTICS_TOP_LIMIT = 12;

// One round trip for every panel on the submissions page. Cloudflare samples
// busy sites, so each group also carries the interval it was sampled at and the
// counts are scaled back up before anybody reads them.
const VISITORS_QUERY = `
query Visitors($accountTag: string!, $siteTag: string!, $start: Time!, $end: Time!, $top: Int!) {
    viewer {
        accounts(filter: { accountTag: $accountTag }) {
            totals: rumPageloadEventsAdaptiveGroups(
                filter: { siteTag: $siteTag, datetime_geq: $start, datetime_leq: $end }
                limit: 1
            ) { count sum { visits } avg { sampleInterval } }

            daily: rumPageloadEventsAdaptiveGroups(
                filter: { siteTag: $siteTag, datetime_geq: $start, datetime_leq: $end }
                limit: 100
                orderBy: [date_ASC]
            ) { count sum { visits } avg { sampleInterval } dimensions { date } }

            referrers: rumPageloadEventsAdaptiveGroups(
                filter: { siteTag: $siteTag, datetime_geq: $start, datetime_leq: $end }
                limit: $top
                orderBy: [count_DESC]
            ) { count sum { visits } avg { sampleInterval } dimensions { refererHost } }

            pages: rumPageloadEventsAdaptiveGroups(
                filter: { siteTag: $siteTag, datetime_geq: $start, datetime_leq: $end }
                limit: $top
                orderBy: [count_DESC]
            ) { count sum { visits } avg { sampleInterval } dimensions { requestPath } }

            countries: rumPageloadEventsAdaptiveGroups(
                filter: { siteTag: $siteTag, datetime_geq: $start, datetime_leq: $end }
                limit: $top
                orderBy: [count_DESC]
            ) { count sum { visits } avg { sampleInterval } dimensions { countryName } }
        }
    }
}`;

const SOURCE_LABELS = [
    ["instagram", "Instagram"],
    ["ig.me", "Instagram"],
    ["tiktok", "TikTok"],
    ["facebook", "Facebook"],
    ["fb.com", "Facebook"],
    ["fb.me", "Facebook"],
    ["linkedin", "LinkedIn"],
    ["lnkd.in", "LinkedIn"],
    ["youtube", "YouTube"],
    ["youtu.be", "YouTube"],
    ["google", "Google"],
    ["bing", "Bing"],
    ["duckduckgo", "DuckDuckGo"],
    ["yahoo", "Yahoo"],
    ["twitter", "X"],
    ["x.com", "X"],
    ["t.co", "X"],
    ["whatsapp", "WhatsApp"],
    ["reddit", "Reddit"]
];

const NEXT_REFERENCE_SQL = `
    INSERT INTO reference_counters (form_type, year, next_number) VALUES (?, ?, 1)
    ON CONFLICT (form_type, year) DO UPDATE SET next_number = next_number + 1
    RETURNING next_number`;

const SAVE_SUBMISSION_SQL = `
    INSERT INTO submissions
        (reference, form_type, full_name, email, details, cv_filename, submitted_at, delivery_status,
         source_channel, source_detail, source_landing, payment_status, payment_amount)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`;

const MARK_DELIVERY_SQL = "UPDATE submissions SET delivery_status = ? WHERE reference = ?";

// Only a row that was expecting a fee can be marked paid, so a webhook naming a
// reference that never owed anything changes nothing. Kept for the rows written
// before payment came first, which could exist as unpaid.
const MARK_PAID_SQL = `
    UPDATE submissions
    SET payment_status = 'paid', payment_amount = ?, stripe_session_id = ?
    WHERE reference = ? AND payment_status IS NOT NULL`;

// A paid registration becomes a record here. OR IGNORE against the reference
// primary key is what makes a repeated webhook harmless: the second delivery
// inserts nothing, reports no change, and so sends no second email.
const SAVE_PAID_SUBMISSION_SQL = `
    INSERT OR IGNORE INTO submissions
        (reference, form_type, full_name, email, details, cv_filename, submitted_at, delivery_status,
         source_channel, source_detail, source_landing, payment_status, payment_amount, stripe_session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, 'paid', ?, ?)`;

const SAVE_PENDING_SQL = `
    INSERT INTO pending_registrations
        (token, reference, form_type, details,
         source_channel, source_detail, source_landing, submitted_at, fee, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const READ_PENDING_SQL = "SELECT * FROM pending_registrations WHERE token = ?";

const DELETE_PENDING_SQL = "DELETE FROM pending_registrations WHERE token = ?";

// Anything still waiting a day later was never paid for.
const STALE_PENDING_SQL = "SELECT token FROM pending_registrations WHERE created_at < ? LIMIT 20";

const SAVE_LEAD_SQL = `
    INSERT INTO registration_leads (reference, form_type, full_name, email, package, fee, started_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (reference) DO NOTHING`;

const MARK_LEAD_PAID_SQL =
    "UPDATE registration_leads SET paid_at = ?, paid_reference = ? WHERE reference = ?";

// The Stripe session is once per payment, so it is what tells us a webhook has
// already been acted on. The reference cannot do that job any more: a paid
// registration is renumbered on arrival, so a retry would draw a fresh number.
const PAID_ALREADY_SQL = "SELECT reference FROM submissions WHERE stripe_session_id = ?";

// The people who reached the payment page and never came back.
const LIST_LEADS_SQL = `
    SELECT reference, full_name, email, package, fee, started_at
    FROM registration_leads
    WHERE paid_at IS NULL
    ORDER BY started_at DESC
    LIMIT ?`;

// Every payment, newest first, for the paid table on the submissions page.
const LIST_PAID_SQL = `
    SELECT reference, form_type, full_name, email, details, submitted_at,
           payment_amount, stripe_session_id
    FROM submissions
    WHERE payment_status = 'paid'
    ORDER BY reference DESC
    LIMIT ?`;

const LIST_SUBMISSIONS_SQL = `
    SELECT reference, form_type, full_name, email, details, cv_filename, submitted_at, delivery_status,
           source_channel, source_detail, source_landing, payment_status, payment_amount
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
    ],
    // The same questions as the first session, so a row from either reads the
    // same way in the table and in the notification email.
    "Second Taster Registration": [
        ["fullName", "Full name"],
        ["email", "Email"],
        ["phone", "Phone"],
        ["currentStatus", "Current status"],
        ["areaOfInterest", "Area of interest"],
        ["message", "Message"]
    ],
    "Taster Session Feedback": [
        ["fullName", "Full name"],
        ["email", "Email"],
        ["attended", "Attended"],
        ["rating", "Rating"],
        ["mostUseful", "Most useful part, or what got in the way"],
        ["improvement", "What was missing or would change"],
        ["nextStep", "Where they are now"],
        ["message", "Anything else"]
    ]
};

const REQUIRED_FIELDS = {
    "Student Enquiry": ["fullName", "email", "phone", "interest"],
    "Corporate Enquiry": ["fullName", "email", "company", "focusArea"],
    "Bootcamp Registration": ["fullName", "email", "phone", "package"],
    "Free Taster Registration": ["fullName", "email", "currentStatus", "areaOfInterest"],
    "Second Taster Registration": ["fullName", "email", "currentStatus", "areaOfInterest"],
    "Taster Session Feedback": ["fullName", "email", "attended", "rating", "nextStep"]
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
    attended: 60,
    rating: 60,
    nextStep: 120,
    mostUseful: 4000,
    improvement: 4000,
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

        // Stripe is not a browser and sends no Origin header, so this route is
        // checked before the origin rules the website's own calls go through.
        // Its own signature is what proves the caller is Stripe.
        if (request.method === "POST" && url.pathname === "/api/stripe-webhook") {
            return handleStripeWebhook(request, env);
        }

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

        if (request.method === "POST" && url.pathname === "/api/analytics") {
            if (!allowedOrigins.has(origin)) {
                return jsonResponse({ success: false, message: "Origin not allowed." }, 403);
            }

            return siteVisitors(request, env, corsHeaders);
        }

        if (request.method === "POST" && url.pathname === "/api/broadcast") {
            if (!allowedOrigins.has(origin)) {
                return jsonResponse({ success: false, message: "Origin not allowed." }, 403);
            }

            return handleBroadcast(request, env, corsHeaders);
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

        const source = describeSource(formData.get("sourceFirst"), formData.get("sourceVisit"));
        const submittedAt = new Date().toLocaleString("en-GB", {
            dateStyle: "long",
            timeStyle: "short",
            timeZone: "Europe/London"
        });

        // What this registration owes, if anything.
        const fee = feeFor(env, formType, values);

        // A registration with a fee to pay is not a record yet. It waits in the
        // holding table until Stripe says the money arrived, so the submissions
        // list only ever contains people who actually paid.
        // The bootcamp form asks for typed answers only, so there is no file to
        // hold. A CV arriving from a cached copy of the old page is ignored
        // rather than refused: the registration is what matters.
        if (fee) {
            return startPaidRegistration(env, respond, {
                formType, values, source, submittedAt, fee, rateLimit
            });
        }

        // Every enquiry is recorded before it is sent, so nothing is lost if the
        // email provider fails. Without that record there is no reference number
        // to quote, so a storage failure stops the submission.
        let reference;
        try {
            reference = await allocateReference(env.DB, formType);
            await saveSubmission(env.DB, reference, formType, values, cvResult.attachment, submittedAt, source, 0);
        } catch (error) {
            console.error("Could not record the submission.", error instanceof Error ? error.message : "Unknown error");

            return respond({
                success: false,
                message: "We could not record your enquiry right now. Please try again shortly or email askus@dystil.ai."
            }, 503);
        }

        const delivered = await deliverSubmission(env, {
            reference, formType, schema, values, submittedAt,
            attachment: cvResult.attachment
        });

        if (!delivered) {
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

    // Somebody whose JavaScript never loaded lands on this page instead of
    // being redirected, so the payment page has to be reachable from it.
    const payButton = body.paymentUrl
        ? `<p><a href="${escapeHtml(body.paymentUrl)}" style="display:inline-block;background:#147a59;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold;">Pay the programme fee</a></p>`
        : "";

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
            ${payButton}
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

// Reads the visitor figures for the submissions page. The API token must never
// reach a browser, so the Worker holds it and the page asks the Worker.
async function siteVisitors(request, env, corsHeaders) {
    const refusal = await refuseUnlessAdmin(request, env, corsHeaders, "Visitor figures are not configured yet.");

    if (refusal) return refusal;

    const missing = ["CF_ACCOUNT_ID", "CF_ANALYTICS_TOKEN", "CF_SITE_TAG"].filter(function (name) {
        return !env[name];
    });

    if (missing.length) {
        console.error("Visitor figures are missing configuration.", missing.join(", "));

        return jsonResponse({
            success: false,
            message: `Visitor figures are not set up yet. Still to configure: ${missing.join(", ")}.`
        }, 503, corsHeaders);
    }

    let requested = ANALYTICS_DEFAULT_DAYS;

    try {
        const body = await request.json();

        if (body && Number.isFinite(Number(body.days))) requested = Number(body.days);
    } catch {
        /* No body is fine; the default window stands. */
    }

    const days = Math.min(Math.max(Math.round(requested), 1), ANALYTICS_MAX_DAYS);
    const end = new Date();
    const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);

    let siteTag = env.CF_SITE_TAG;
    let attempt = await askForVisitors(env, siteTag, start, end);

    if (attempt.failure) return jsonResponse(attempt.failure.body, attempt.failure.status, corsHeaders);

    // A site tag that matches nothing comes back empty rather than as an error,
    // which is indistinguishable from a quiet week. The beacon carries the site
    // token, and the API filters on the site tag, so when the window is empty
    // the account's sites are listed and the tag beside our token is tried.
    if (isEmpty(attempt.account)) {
        const resolved = await resolveSiteTag(env, siteTag);

        if (resolved.siteTag && resolved.siteTag !== siteTag) {
            const second = await askForVisitors(env, resolved.siteTag, start, end);

            if (!second.failure && !isEmpty(second.account)) {
                console.log("Recovered the visitor figures with site tag", resolved.siteTag);
                siteTag = resolved.siteTag;
                attempt = second;
            }
        }
    }

    const account = attempt.account;

    return jsonResponse({
        success: true,
        siteTag,
        sampled: wasSampled(account.totals),
        range: { days, start: start.toISOString(), end: end.toISOString() },
        totals: totalsFrom(account.totals),
        daily: (account.daily || []).map(function (group) {
            return { date: group.dimensions.date, ...countsFrom(group) };
        }),
        referrers: rankSources(account.referrers),
        pages: (account.pages || []).map(function (group) {
            return { path: group.dimensions.requestPath || "/", ...countsFrom(group) };
        }),
        countries: (account.countries || []).map(function (group) {
            return { country: group.dimensions.countryName || "Unknown", ...countsFrom(group) };
        })
    }, 200, corsHeaders);
}

// Runs the visitor query for one site tag. Failures come back as a ready-made
// response body rather than thrown, so the caller can try a second tag without
// unwinding anything.
async function askForVisitors(env, siteTag, start, end) {
    let payload;

    try {
        const response = await fetch(ANALYTICS_API, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${env.CF_ANALYTICS_TOKEN}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                query: VISITORS_QUERY,
                variables: {
                    accountTag: env.CF_ACCOUNT_ID,
                    siteTag: siteTag,
                    start: start.toISOString(),
                    end: end.toISOString(),
                    top: ANALYTICS_TOP_LIMIT
                }
            })
        });

        payload = await response.json();

        if (!response.ok) throw new Error(`Cloudflare answered ${response.status}.`);
    } catch (error) {
        console.error("Could not reach the analytics API.", error instanceof Error ? error.message : "Unknown error");

        return { failure: { status: 502, body: { success: false, message: "Could not reach the analytics service." } } };
    }

    // GraphQL reports a rejected token or a misnamed field with a 200 and an
    // errors array, so the message is passed through rather than swallowed.
    // Only the password holder sees it, and it is what makes setup fixable.
    if (payload.errors && payload.errors.length) {
        const detail = payload.errors[0].message || "The query was rejected.";
        console.error("The analytics query was rejected.", detail);

        return { failure: { status: 502, body: { success: false, message: `Cloudflare rejected the query: ${detail}` } } };
    }

    const account = payload.data && payload.data.viewer && payload.data.viewer.accounts
        ? payload.data.viewer.accounts[0]
        : null;

    if (!account) {
        return {
            failure: {
                status: 502,
                body: {
                    success: false,
                    message: "Cloudflare returned no account. Check the account ID and that the token can read it."
                }
            }
        };
    }

    return { account };
}

function isEmpty(account) {
    const totals = totalsFrom(account.totals);

    return totals.views === 0 && totals.visits === 0;
}

// Finds the site tag that belongs to the beacon token we already publish. The
// list endpoint may be refused by a token scoped only to analytics, which is
// not worth failing over: the configured tag simply stands.
async function resolveSiteTag(env, currentTag) {
    try {
        const response = await fetch(RUM_SITES_API.replace("%s", env.CF_ACCOUNT_ID), {
            headers: { "Authorization": `Bearer ${env.CF_ANALYTICS_TOKEN}` }
        });

        if (!response.ok) {
            console.error("Could not list the Web Analytics sites.", response.status);

            return {};
        }

        const body = await response.json();
        const sites = Array.isArray(body.result) ? body.result : [];

        // The beacon publishes the site token, so the site carrying it is ours.
        const byToken = sites.find(function (site) { return site.site_token === currentTag; });

        if (byToken && byToken.site_tag) return { siteTag: byToken.site_tag };

        // Falling back to the only site there is beats showing nothing.
        if (sites.length === 1 && sites[0].site_tag) return { siteTag: sites[0].site_tag };

        return {};
    } catch (error) {
        console.error("Could not list the Web Analytics sites.", error instanceof Error ? error.message : "Unknown error");

        return {};
    }
}

// Adaptive sampling means one recorded event can stand for several real ones,
// so every figure is multiplied back out by the interval it was sampled at. A
// quiet site samples everything and the interval is 1.
function countsFrom(group) {
    const interval = Math.max(Number(group.avg && group.avg.sampleInterval) || 1, 1);
    const views = Math.round((Number(group.count) || 0) * interval);
    const visits = Math.round((Number(group.sum && group.sum.visits) || 0) * interval);

    return { views, visits };
}

// A wide window over a quiet site gets sampled hard: Cloudflare returns a
// handful of events and the scaling turns them into round hundreds. The figures
// are still the best estimate available, but the page has to say so rather than
// present three sampled events as three hundred visits.
function wasSampled(groups) {
    return (groups || []).some(function (group) {
        return (Number(group.avg && group.avg.sampleInterval) || 1) > 1;
    });
}

function totalsFrom(groups) {
    return (groups || []).reduce(function (running, group) {
        const counts = countsFrom(group);

        return { views: running.views + counts.views, visits: running.visits + counts.visits };
    }, { views: 0, visits: 0 });
}

// Referring hosts are folded into the same channel names the submissions use,
// so Instagram on this panel means what Instagram means on a row. Several hosts
// share one channel, so equal names are added together.
function rankSources(groups) {
    const totals = new Map();

    (groups || []).forEach(function (group) {
        const host = String(group.dimensions.refererHost || "").replace(/^www\./, "").toLowerCase();
        const external = host && host !== "dystil.ai" && !host.endsWith(".dystil.ai");
        const channel = external ? labelForSource(host) : "Direct";
        const counts = countsFrom(group);
        const running = totals.get(channel) || { channel, views: 0, visits: 0 };

        running.views += counts.views;
        running.visits += counts.visits;
        totals.set(channel, running);
    });

    return [...totals.values()].sort(function (left, right) { return right.views - left.views; });
}

// Every admin endpoint sits behind the same password, the same constant-time
// comparison and the same cap on wrong guesses. Returns a Response when the
// caller should be turned away, or null when they may go on.
async function refuseUnlessAdmin(request, env, corsHeaders, unconfiguredMessage) {
    if (!env.ADMIN_KEY) {
        console.error("ADMIN_KEY is not configured.");
        return jsonResponse({ success: false, message: unconfiguredMessage }, 503, corsHeaders);
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

    return null;
}

// Reads the submissions for the unlisted /students/database page. The password
// travels in a header rather than the URL so it never reaches a browser history,
// a referrer, or an access log.
async function listSubmissions(request, env, corsHeaders) {
    const refusal = await refuseUnlessAdmin(request, env, corsHeaders, "The submissions view is not configured yet.");

    if (refusal) return refusal;

    if (!env.DB) {
        return jsonResponse({ success: false, message: "No database is connected." }, 503, corsHeaders);
    }

    try {
        const { results } = await env.DB.prepare(LIST_SUBMISSIONS_SQL).bind(ADMIN_PAGE_SIZE).all();

        // Who paid, and who reached the payment page and did not. Neither is
        // worth failing the whole page over, so each is simply empty if its
        // table is not there yet.
        let leads = [];
        let paid = [];

        try {
            const started = await env.DB.prepare(LIST_LEADS_SQL).bind(ADMIN_PAGE_SIZE).all();
            leads = started.results || [];
        } catch (error) {
            console.error("Could not read the unpaid registrations.",
                error instanceof Error ? error.message : "Unknown error");
        }

        try {
            const settled = await env.DB.prepare(LIST_PAID_SQL).bind(ADMIN_PAGE_SIZE).all();
            paid = settled.results || [];
        } catch (error) {
            console.error("Could not read the paid registrations.",
                error instanceof Error ? error.message : "Unknown error");
        }

        return jsonResponse({ success: true, submissions: results || [], leads, paid }, 200, corsHeaders);
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

// A paid registration is renumbered the day the money arrives, so the reference
// says when somebody actually joined rather than when they filled the form in:
// DYS-BOT-26-3108001 is the first payment taken on 31 August. The counter starts
// again every day, which is why three digits is enough.
async function allocatePaidReference(db, formType) {
    if (!db) throw new Error("No database binding is configured.");

    const today = new Date();
    const year = today.toLocaleDateString("en-GB", { year: "2-digit", timeZone: "Europe/London" });
    const day = today.toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "2-digit",
        timeZone: "Europe/London"
    }).replace(/\D/g, "");

    // The counter is keyed by day as well as year, so it shares the existing
    // table without ever colliding with the counter that numbers the holds.
    const row = await db.prepare(NEXT_REFERENCE_SQL).bind(`${formType}:paid`, `${year}-${day}`).first();

    if (!row) throw new Error("The paid reference counter returned nothing.");

    return `DYS-${FORM_CODES[formType]}-${year}-${day}${String(row.next_number).padStart(3, "0")}`;
}

// The browser remembers how somebody first reached the site and sends it back
// with the form. First touch is preferred over the current visit, so a person
// who found us on Instagram still counts as Instagram when they return a week
// later and register.
function describeSource(firstTouch, thisVisit) {
    const arrival = parseArrival(firstTouch) || parseArrival(thisVisit);

    if (!arrival) return { channel: "Unknown", detail: "", landing: "" };

    const tag = cleanText(arrival.tag, 60);
    const detail = tag || referrerHost(arrival.referrer);

    return {
        channel: labelForSource(detail),
        detail: detail,
        landing: cleanText(arrival.landing, 200)
    };
}

function parseArrival(raw) {
    if (typeof raw !== "string" || !raw) return null;

    try {
        const parsed = JSON.parse(raw);

        return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
        return null;
    }
}

// Our own pages are not a source, so an internal referrer reads as no referrer.
function referrerHost(referrer) {
    if (typeof referrer !== "string" || !referrer) return "";

    try {
        const host = new URL(referrer).hostname.replace(/^www\./, "").toLowerCase();

        return host === "dystil.ai" || host.endsWith(".dystil.ai") ? "" : host;
    } catch {
        return "";
    }
}

// An unrecognised host is shown as itself rather than lumped into "Other", so a
// referrer we have never seen before is still readable on the submissions page.
function labelForSource(detail) {
    if (!detail) return "Direct";

    const value = detail.toLowerCase();
    const match = SOURCE_LABELS.find(function (entry) { return value.includes(entry[0]); });

    return match ? match[1] : detail;
}

// The CV is kept out of the database and stays an email attachment, so only its
// filename is recorded here.
async function saveSubmission(db, reference, formType, values, attachment, submittedAt, source, fee = 0) {
    await db.prepare(SAVE_SUBMISSION_SQL).bind(
        reference,
        formType,
        values.fullName,
        values.email,
        JSON.stringify(values),
        attachment ? attachment.filename : null,
        submittedAt,
        source.channel,
        source.detail,
        source.landing,
        // Forms nobody pays for leave this empty, so "unpaid" on the
        // submissions page always means somebody still owes money.
        fee ? "unpaid" : null,
        fee || null
    ).run();
}

// What a submission owes, in pence. Nothing is owed unless Stripe is
// configured, so the site behaves exactly as it did before payments existed
// until the secret is in place, and an unrecognised package is treated as no
// price rather than a guess at one.
function feeFor(env, formType, values) {
    if (!env.STRIPE_SECRET_KEY || formType !== PAID_FORM) return 0;

    return BOOTCAMP_PRICES[values.package] || 0;
}

// The first allowed origin is the canonical address of the website, so Stripe
// sends people back to the same place the form was posted from.
function siteUrl(env) {
    return [...getAllowedOrigins(env)][0] || "https://dystil.ai";
}

// Builds and sends the notification and the confirmation, then records whether
// they arrived. Both the unpaid forms and the paid registrations end here, so
// an enquiry reads the same however it reached us.
async function deliverSubmission(env, { reference, formType, schema, values, attachment, submittedAt, payment = null }) {
    const fromEmail = env.FROM_EMAIL || "askus@dystil.ai";
    const adminEmail = env.ADMIN_EMAIL || "askus@dystil.ai";

    // A paid registration says so in the subject line, so the inbox separates
    // the people who have paid from the people who are asking.
    const adminEmailPayload = {
        sender: { name: "Dystil Website", email: fromEmail },
        to: [{ email: adminEmail, name: "Dystil" }],
        replyTo: { email: values.email, name: values.fullName },
        subject: payment
            ? `[${reference}] PAID ${formatMoney(payment.amount)} — ${formType} — ${values.fullName}`
            : `[${reference}] New ${formType} — ${values.fullName}`,
        htmlContent: buildAdminHtml(formType, schema, values, attachment, submittedAt, reference, payment),
        textContent: buildAdminText(formType, schema, values, attachment, submittedAt, reference, payment)
    };

    if (attachment) {
        adminEmailPayload.attachment = [{
            name: attachment.filename,
            content: attachment.content
        }];
    }

    const confirmationEmailPayload = {
        sender: { name: "Dystil", email: fromEmail },
        to: [{ email: values.email, name: values.fullName }],
        replyTo: { email: adminEmail, name: "Dystil" },
        subject: payment
            ? `Payment received | ${reference}`
            : `We’ve received your enquiry | ${reference}`,
        htmlContent: buildConfirmationHtml(values.fullName, formType, reference, payment),
        textContent: buildConfirmationText(values.fullName, formType, reference, payment)
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
    }

    return delivered;
}

// A registration that owes a fee is parked rather than recorded. Nothing is
// emailed and nothing appears in the submissions list until Stripe confirms the
// money arrived; only the name and email are kept, as a lead, so somebody who
// stops at the payment page can still be followed up.
async function startPaidRegistration(env, respond, { formType, values, source, submittedAt, fee, rateLimit }) {
    const token = crypto.randomUUID();
    let reference;

    try {
        reference = await allocateReference(env.DB, formType);

        await env.DB.prepare(SAVE_PENDING_SQL).bind(
            token,
            reference,
            formType,
            JSON.stringify(values),
            source.channel,
            source.detail,
            source.landing,
            submittedAt,
            fee,
            Date.now()
        ).run();

        await env.DB.prepare(SAVE_LEAD_SQL).bind(
            reference, formType, values.fullName, values.email, values.package || null, fee, submittedAt
        ).run();
    } catch (error) {
        console.error("Could not hold the registration.", error instanceof Error ? error.message : "Unknown error");
        await discardPending(env, token);

        return respond({
            success: false,
            message: "We could not start your registration right now. Please try again shortly or email askus@dystil.ai."
        }, 503);
    }

    const paymentUrl = await createCheckoutSession(env, reference, values, fee, token);

    // Without a payment page there is nothing for the held registration to be
    // waiting on, so it is thrown away rather than left to expire quietly.
    if (!paymentUrl) {
        await discardPending(env, token);

        return respond({
            success: false,
            message: "We could not open the payment page just now. Please try again shortly, or email askus@dystil.ai and we will send you a payment link."
        }, 502);
    }

    await recordSubmission(rateLimit);
    await purgeStalePending(env);

    return respond({
        success: true,
        reference,
        paymentUrl,
        // Read on the page that redirects to Stripe, and on the result page a
        // visitor without JavaScript is left looking at with a button under it.
        message: `Your place is held under reference ${reference}. Your registration is completed once the programme fee is paid.`
    }, 200);
}

// Stripe has confirmed the fee, so the held registration becomes a record and
// the emails finally go out.
async function completePaidRegistration(env, session) {
    const token = session.metadata?.token || "";
    const reference = session.client_reference_id || session.metadata?.reference || "";

    if (!token || !env.DB) {
        console.error("A completed payment carried nothing to match.", { reference });
        return true;
    }

    // A completed checkout is not a paid one. Klarna, bank debits and anything
    // else that settles later complete the session first and pay afterwards, so
    // Stripe's own verdict is what decides, never the arrival of the event. The
    // hold is left alone: the later event is what finishes the registration.
    if (session.payment_status !== "paid") {
        console.error("A checkout completed without the money arriving.", {
            reference,
            paymentStatus: session.payment_status
        });

        return true;
    }

    const pending = await env.DB.prepare(READ_PENDING_SQL).bind(token).first();

    // Already dealt with, or expired. Either way there is nothing to do and
    // Stripe should not be asked to try again.
    if (!pending) return true;

    // A retried delivery must not draw a second reference, so the session is
    // checked before anything is allocated.
    if (session.id) {
        const already = await env.DB.prepare(PAID_ALREADY_SQL).bind(session.id).first();

        if (already) {
            await discardPending(env, token);
            return true;
        }
    }

    const values = JSON.parse(pending.details);
    const schema = FORM_SCHEMAS[pending.form_type];
    const paidReference = await allocatePaidReference(env.DB, pending.form_type);

    const saved = await env.DB.prepare(SAVE_PAID_SUBMISSION_SQL).bind(
        paidReference,
        pending.form_type,
        values.fullName,
        values.email,
        pending.details,
        null,
        pending.submitted_at,
        pending.source_channel,
        pending.source_detail,
        pending.source_landing,
        session.amount_total ?? pending.fee,
        session.id || null
    ).run();

    // A repeated delivery inserts nothing. The record and the emails already
    // exist, so this one only clears up after itself.
    if (!saved.meta || saved.meta.changes === 0) {
        await discardPending(env, token);
        return true;
    }

    await env.DB.prepare(MARK_LEAD_PAID_SQL)
        .bind(new Date().toISOString(), paidReference, pending.reference)
        .run();

    await deliverSubmission(env, {
        reference: paidReference,
        formType: pending.form_type,
        schema,
        values,
        attachment: null,
        submittedAt: pending.submitted_at,
        payment: {
            amount: session.amount_total ?? pending.fee,
            reference: session.payment_intent || session.id || "",
            paidAt: new Date().toLocaleString("en-GB", {
                dateStyle: "long",
                timeStyle: "short",
                timeZone: "Europe/London"
            })
        }
    });

    // The record exists whether or not the emails did, so the hold is released
    // either way. A failed email is visible on the submissions page as its
    // delivery status; asking Stripe to retry would only write it twice.
    await discardPending(env, token);

    return true;
}

async function discardPending(env, token) {
    try {
        if (env.DB) await env.DB.prepare(DELETE_PENDING_SQL).bind(token).run();
    } catch (error) {
        console.error("Could not clear a held registration.", {
            token,
            message: error instanceof Error ? error.message : "Unknown error"
        });
    }
}

// Anything still waiting a day later was never paid for. Clearing it here costs
// one query per registration and saves keeping a scheduled job alive.
async function purgeStalePending(env) {
    try {
        const { results } = await env.DB.prepare(STALE_PENDING_SQL)
            .bind(Date.now() - PENDING_LIFETIME_MS)
            .all();

        for (const row of results || []) {
            await discardPending(env, row.token);
        }
    } catch (error) {
        console.error("Could not clear the expired registrations.",
            error instanceof Error ? error.message : "Unknown error");
    }
}

// Opens a Stripe-hosted payment page. Card details are typed on Stripe's own
// page and never reach this Worker or the website. The reference travels as the
// client reference, and the token as metadata, which is what ties the payment
// back to the held registration when the webhook arrives.
async function createCheckoutSession(env, reference, values, fee, token) {
    const home = siteUrl(env);
    const body = new URLSearchParams({
        mode: "payment",
        client_reference_id: reference,
        customer_email: values.email,
        success_url: `${home}/students/payment-complete?ref=${encodeURIComponent(reference)}`,
        cancel_url: `${home}/students/payment-complete?ref=${encodeURIComponent(reference)}&cancelled=1`,
        "line_items[0][quantity]": "1",
        "line_items[0][price_data][currency]": "gbp",
        "line_items[0][price_data][unit_amount]": String(fee),
        "line_items[0][price_data][product_data][name]": `Dystil Launchpad — ${values.package}`,
        "line_items[0][price_data][product_data][description]": `Programme fee, reference ${reference}`,
        "metadata[reference]": reference,
        "metadata[package]": values.package,
        "metadata[token]": token
    });

    try {
        const response = await fetch(STRIPE_SESSIONS_API, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${env.STRIPE_SECRET_KEY}`,
                "Content-Type": "application/x-www-form-urlencoded",
                // The same registration retried must not become a second
                // payment page, and so a second chance to be charged twice.
                "Idempotency-Key": `checkout-${reference}`
            },
            body
        });

        const session = await response.json();

        if (!response.ok || !session.url) {
            console.error("Could not open a payment page.", { reference, status: response.status });
            return "";
        }

        return session.url;
    } catch (error) {
        console.error("Could not reach Stripe.", {
            reference,
            message: error instanceof Error ? error.message : "Unknown error"
        });

        return "";
    }
}

// Stripe tells us a payment succeeded here, and nowhere else. The browser
// coming back from the payment page proves nothing — anybody can open that
// address — so this is the only thing that marks a registration paid.
async function handleStripeWebhook(request, env) {
    if (!env.STRIPE_WEBHOOK_SECRET) {
        console.error("STRIPE_WEBHOOK_SECRET is not configured.");
        return new Response("Not configured.", { status: 503 });
    }

    const payload = await request.text();

    if (!(await stripeSignatureValid(request.headers.get("Stripe-Signature"), payload, env.STRIPE_WEBHOOK_SECRET))) {
        return new Response("Invalid signature.", { status: 400 });
    }

    let event;
    try {
        event = JSON.parse(payload);
    } catch {
        return new Response("Unreadable event.", { status: 400 });
    }

    // A session that expired can never be paid, so the hold it was waiting on
    // goes now rather than sitting there for a day.
    if (event?.type === "checkout.session.expired") {
        const token = event.data?.object?.metadata?.token || "";
        if (token) await discardPending(env, token);

        return new Response("ok", { status: 200 });
    }

    // Anything else Stripe sends is acknowledged and ignored. A non-200 would
    // have it retried for days over an event we were never interested in.
    // async_payment_succeeded is how a delayed method reports that the money
    // finally arrived, and it finishes the registration the same way.
    if (["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event?.type)) {
        const session = event.data?.object || {};

        try {
            // A registration held for payment becomes a record here. A row that
            // predates payment-first still exists as unpaid, so it is marked
            // instead: both kinds of payment end up recorded the same way.
            if (session.metadata?.token) {
                await completePaidRegistration(env, session);
            } else if (session.client_reference_id && env.DB && session.payment_status === "paid") {
                await env.DB.prepare(MARK_PAID_SQL)
                    .bind(session.amount_total ?? null, session.id || null, session.client_reference_id)
                    .run();
            } else {
                console.error("A completed payment carried nothing to match, or nothing was paid.", {
                    session: session.id,
                    paymentStatus: session.payment_status
                });
            }
        } catch (error) {
            // Stripe retries a webhook that did not return 200, so a failure
            // here is worth reporting rather than swallowing: the next attempt
            // is how the registration eventually gets recorded.
            console.error("Could not record the payment.", {
                session: session.id,
                message: error instanceof Error ? error.message : "Unknown error"
            });

            return new Response("Could not record the payment.", { status: 500 });
        }
    }

    return new Response("ok", { status: 200 });
}

// Stripe signs the timestamp and the raw body together. During a secret
// rotation it sends more than one signature, and any one of them matching is
// enough, so every v1 value in the header is checked.
async function stripeSignatureValid(header, payload, secret) {
    if (typeof header !== "string" || !header) return false;

    let timestamp = "";
    const signatures = [];

    for (const part of header.split(",")) {
        const separator = part.indexOf("=");
        if (separator === -1) continue;

        const name = part.slice(0, separator).trim();
        const value = part.slice(separator + 1).trim();

        if (name === "t") timestamp = value;
        if (name === "v1") signatures.push(value);
    }

    if (!timestamp || !signatures.length) return false;

    const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
    if (!Number.isFinite(age) || age > STRIPE_SIGNATURE_TOLERANCE_SECONDS) return false;

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    );

    const signed = await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${payload}`));
    const expected = [...new Uint8Array(signed)].map(function (byte) {
        return byte.toString(16).padStart(2, "0");
    }).join("");

    for (const candidate of signatures) {
        if (await secretsMatch(candidate, expected)) return true;
    }

    return false;
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

function buildAdminHtml(formType, schema, values, attachment, submittedAt, reference, payment = null) {
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

    // Highlighted, because whether the money arrived is the first thing worth
    // knowing when this lands in the inbox.
    const paymentRow = payment ? `
        <tr>
            <td style="padding:10px;border:1px solid #e5e7eb;font-weight:700;vertical-align:top;background:#eaf6f0;">Payment</td>
            <td style="padding:10px;border:1px solid #e5e7eb;vertical-align:top;background:#eaf6f0;"><strong>${escapeHtml(formatMoney(payment.amount))} received</strong> on ${escapeHtml(payment.paidAt)}<br>Stripe: ${escapeHtml(payment.reference)}</td>
        </tr>` : "";

    return `<!doctype html>
        <html><body style="margin:0;background:#f4f7f6;font-family:Arial,sans-serif;color:#16221d;">
            <div style="max-width:680px;margin:0 auto;padding:32px 16px;">
                <div style="background:#123f31;color:#fff;padding:24px;border-radius:12px 12px 0 0;">
                    <h1 style="font-size:24px;margin:0;">${payment ? `Payment received — ${escapeHtml(formType)}` : `New ${escapeHtml(formType)}`}</h1>
                    <p style="margin:8px 0 0;color:#d8ede5;">Submitted ${escapeHtml(submittedAt)}</p>
                </div>
                <div style="background:#fff;padding:24px;border-radius:0 0 12px 12px;">
                    <p style="margin-top:0;">Reply to this email to contact <strong>${escapeHtml(values.fullName)}</strong>.</p>
                    <table style="border-collapse:collapse;width:100%;font-size:14px;">${referenceRow}${paymentRow}${rows}${cvRow}</table>
                </div>
            </div>
        </body></html>`;
}

function buildAdminText(formType, schema, values, attachment, submittedAt, reference, payment = null) {
    const lines = schema.map(([field, label]) => `${label}: ${values[field] || "—"}`);
    if (attachment) lines.push(`CV: ${attachment.filename} (${formatFileSize(attachment.size)}) — attached`);

    return [
        payment ? `Payment received — ${formType}` : `New ${formType}`,
        `Reference ${reference}`,
        `Submitted ${submittedAt}`,
        ...(payment ? [
            `Payment: ${formatMoney(payment.amount)} received on ${payment.paidAt}`,
            `Stripe: ${payment.reference}`
        ] : []),
        "",
        ...lines
    ].join("\n");
}

function buildConfirmationHtml(fullName, formType, reference, payment = null) {
    const isFeedback = formType === FEEDBACK_FORM;
    const opening = payment
        ? `Payment received. Your ${formType.toLowerCase()} is complete and your place is confirmed.`
        : isFeedback
            ? "Your feedback has been sent successfully and received by Dystil."
            : "Your enquiry has been sent successfully and received by Dystil.";
    const recorded = payment
        ? "We will email your joining details before the programme starts."
        : isFeedback
            ? "We read every answer, and what people tell us here decides what the next session looks like."
            : "A member of our team will review your details and contact you shortly.";

    // The receipt Stripe sends is the formal one. This repeats the figure so the
    // amount and the reference sit in the same email as everything else.
    const paidRow = payment
        ? `<p style="background:#f4f7f6;border-left:4px solid #147a59;padding:12px 16px;">Amount paid: <strong>${escapeHtml(formatMoney(payment.amount))}</strong><br>Paid on ${escapeHtml(payment.paidAt)}<br>Stripe emails a receipt separately.</p>`
        : "";

    return `<!doctype html>
        <html><body style="margin:0;background:#f4f7f6;font-family:Arial,sans-serif;color:#16221d;">
            <div style="max-width:620px;margin:0 auto;padding:32px 16px;">
                <div style="background:#123f31;color:#fff;padding:24px;border-radius:12px 12px 0 0;">
                    <h1 style="font-size:24px;margin:0;">Thank you, ${escapeHtml(fullName)}.</h1>
                </div>
                <div style="background:#fff;padding:24px;border-radius:0 0 12px 12px;line-height:1.6;">
                    <p style="margin-top:0;">${escapeHtml(opening)}</p>
                    <p style="background:#f4f7f6;border-left:4px solid #147a59;padding:12px 16px;">Your reference is <strong>${escapeHtml(reference)}</strong>. Please quote it if you contact us about ${payment ? "your place" : "this enquiry"}.</p>
                    ${paidRow}
                    <p>We’ve recorded it as <strong>${escapeHtml(formType)}</strong>. ${escapeHtml(recorded)}</p>
                    <p>If you need to add anything, reply to this email or contact us at <a href="mailto:askus@dystil.ai" style="color:#147a59;">askus@dystil.ai</a>.</p>
                    <p style="margin-bottom:0;">Kind regards,<br><strong>The Dystil Team</strong></p>
                </div>
            </div>
        </body></html>`;
}

function buildConfirmationText(fullName, formType, reference, payment = null) {
    const isFeedback = formType === FEEDBACK_FORM;

    return [
        `Thank you, ${fullName}.`,
        "",
        payment
            ? `Payment received. Your ${formType.toLowerCase()} is complete and your place is confirmed.`
            : isFeedback
                ? "Your feedback has been sent successfully and received by Dystil."
                : "Your enquiry has been sent successfully and received by Dystil.",
        "",
        `Your reference is ${reference}. Please quote it if you contact us about ${payment ? "your place" : "this enquiry"}.`,
        ...(payment ? [
            "",
            `Amount paid: ${formatMoney(payment.amount)}`,
            `Paid on ${payment.paidAt}`,
            "Stripe emails a receipt separately."
        ] : []),
        "",
        `We’ve recorded it as ${formType}. ` + (payment
            ? "We will email your joining details before the programme starts."
            : isFeedback
                ? "We read every answer, and what people tell us here decides what the next session looks like."
                : "A member of our team will review your details and contact you shortly."),
        "",
        "If you need to add anything, reply to this email or contact askus@dystil.ai.",
        "",
        "Kind regards,",
        "The Dystil Team"
    ].join("\n");
}

// Pence to pounds, for an email a person reads rather than a database column.
function formatMoney(pence) {
    if (!Number.isFinite(pence)) return "the programme fee";

    return `£${(pence / 100).toFixed(2)}`;
}

function formatFileSize(bytes) {
    if (!Number.isFinite(bytes)) return "unknown size";
    if (bytes < 1024) return `${bytes} B`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/* ---------------------------------------------------------------------------
   Broadcasts
   ---------------------------------------------------------------------------
   Emailing people who have already registered is a separate job from replying
   to a new enquiry, so it gets its own endpoint behind the same password as the
   submissions view. Two rules keep it safe to run: a recipient must already be
   in the submissions table, so a stolen password cannot turn this into an open
   relay, and every accepted send is written to broadcast_sends, so re-running
   the job skips anyone who has already been mailed.
--------------------------------------------------------------------------- */

const BROADCAST_BATCH_LIMIT = 20;

// The two names a campaign can go out under, and the only people a test may
// reach. Both outlive any one session.
const CAMPAIGN_SENDERS = {
    frank: { email: "frank@dystil.ai", name: "Frank M" },
    askus: { email: "askus@dystil.ai", name: "Dystil" }
};

const TEST_TEAM = [
    { email: "fayazkhadir78@gmail.com", fullName: "Fayyaz Khadir" },
    { email: "aman.kaleeur@gmail.com", fullName: "Aman Kaleeur" },
    { email: "makki.arsalan07@gmail.com", fullName: "Arsalan Makki" },
    { email: "mailboxforbilal@gmail.com", fullName: "Bilal Ahmad" },
    // No dystil.ai mail has ever reached this address, so it shows how Gmail
    // sorts the email with no history to go on. mailboxforbilal has had
    // confirmations land in Primary, and reads as the opposite case.
    { email: "bilal.ahmad096@gmail.com", fullName: "Bilal Ahmad" },
    { email: "bilalphdbath@gmail.com", fullName: "Bilal Ahmad" },
    { email: "billuahmad786@gmail.com", fullName: "Bilal Ahmad" },
    { email: "reliancevodafone9528@gmail.com", fullName: "Bilal Ahmad" },
    { email: "b_ahmad@ee.iitr.ac.in", fullName: "Bilal Ahmad" },
    { email: "talha36292@gmail.com", fullName: "Talha" },
    { email: "mailbox.makki@gmail.com", fullName: "Arsalan Makki" },
    { email: "danishzia2016@gmail.com", fullName: "Danish" },
    { email: "muaaz.daily@gmail.com", fullName: "Muaz" },
    { email: "h.aqibnazir@gmail.com", fullName: "Aqib" },
    { email: "aman@dystil.ai", fullName: "Aman" }
];

const SOCIAL_ICONS = "https://dystil.ai/assets/images/social/";

// The pathway pages the two bootcamp buttons point at. The query is read by
// the register page, which preselects the package, so a reader who picked
// Foundation in the email does not have to pick it again on the form.
// Everything the bootcamp email says about when it runs. Change these three
// lines and the subject, the panel, the HTML and the plain text all follow.
const BOOTCAMP = {
    name: "Career Accelerator",
    starts: "Saturday 26 September 2026",
    closes: "Tuesday 15 September 2026",
    // One link, so no ?package= to preselect with: the form asks for the
    // pathway itself, which is one link fewer in the email.
    register: "https://dystil.ai/students/register",
    pathways: [
        ["\u{1F331}", "Foundation", "Build your foundations and develop practical, future-ready skills.", "https://dystil.ai/students/register?package=foundation"],
        ["\u{26A1}", "Advanced", "Go further with more advanced projects and build a stronger career profile.", "https://dystil.ai/students/register?package=advanced"]
    ]
};

const DYSTIL_PHONE = "+44 7516 317705";
const DYSTIL_PHONE_LINK = "tel:+447516317705";

// Nothing is scheduled. Add a campaign here and it appears in the panel:
// formType picks the register it goes to, buildHtml and buildText build the
// email, sender and replyTo name it, dedupeKey is the ledger that stops a
// second send, and testRecipients is who a test may reach. attachUrl and
// attachName hang a file on it, fetched from the site rather than carried
// here. See the git history for fifteen worked examples.
const BOOTCAMP_REGISTERS = {
    taster1: { label: "first taster", formType: "Free Taster Registration" },
    taster2: { label: "second taster", formType: "Second Taster Registration" }
};

// The same shape as the reminder subjects that reached Primary: what it is,
// a pipe, and when.
const BOOTCAMP_NOTE_SUBJECT = "Carrying on after the taster session?";
// Says what happened, not what to do about it. The reminders that reached
// Primary read the same way.
const PAYMENT_OPEN_SUBJECT = "The payment page is now open | Dystil Career Accelerator";

const BOOTCAMP_SUBJECT = `${BOOTCAMP.starts} | Dystil ${BOOTCAMP.name}`;

/* What reaches Primary, measured rather than guessed.
   ---------------------------------------------------------------------------
   Sent through Brevo, all carrying its pixel:

     Primary     three reminders and the calendar invitation. No images, one
                 link each, a factual subject in the form
                 "Tomorrow | Dystil Free Taster Session, Saturday 11am", and a
                 footer that is one line of Kind regards.
     Promotions  the bootcamp invitation. Three hosted images, seven links, a
                 row of social accounts, and a subject offering a place on a
                 programme.

   So the template is not the problem, and neither is Brevo. Keep a campaign to
   no images, one link, a subject that states a fact, and a plain sign-off, and
   it goes where the reminders went.
--------------------------------------------------------------------------- */

// Anything CAMPAIGNS reads has to be declared above it: the map is built when
// the module loads, so a const further down the file is still in its dead zone
// and the Worker throws on the first request. Builders are fine — functions
// hoist — but the constants they are given here are not.
const CAMPAIGNS = {
    ...buildBootcampCampaigns(),
    ...buildPaymentOpenCampaigns()
};

const BROADCAST_ROSTER_SQL = `
    SELECT lower(trim(email)) AS email, full_name, MAX(reference) AS reference
    FROM submissions
    WHERE form_type = ?
    GROUP BY lower(trim(email))
    ORDER BY reference`;

// Chasing a payment from somebody who has already made one is the worst thing
// this endpoint could do, so the campaign that asks for money asks for this
// roster instead. One paid row under an address is enough to leave it out,
// whichever registration it belongs to.
const BROADCAST_UNPAID_ROSTER_SQL = `
    SELECT lower(trim(email)) AS email, full_name, MAX(reference) AS reference
    FROM submissions
    WHERE form_type = ?
    GROUP BY lower(trim(email))
    HAVING SUM(CASE WHEN payment_status = 'paid' THEN 1 ELSE 0 END) = 0
    ORDER BY reference`;

const BROADCAST_SENT_SQL = "SELECT email FROM broadcast_sends WHERE campaign = ?";

const RECORD_BROADCAST_SQL = `
    INSERT INTO broadcast_sends (campaign, email, sent_at) VALUES (?, ?, ?)
    ON CONFLICT (campaign, email) DO NOTHING`;

async function handleBroadcast(request, env, corsHeaders) {
    const refusal = await refuseUnlessAdmin(request, env, corsHeaders, "Broadcasts are not configured yet.");

    if (refusal) return refusal;

    if (!env.DB) {
        return jsonResponse({ success: false, message: "No database is connected." }, 503, corsHeaders);
    }

    let body = {};
    try {
        body = await request.json();
    } catch {
        return jsonResponse({ success: false, message: "Could not read the request." }, 400, corsHeaders);
    }

    if (body.action === "quota") {
        return readSendingQuota(env, corsHeaders);
    }

    const campaign = CAMPAIGNS[body.campaign];
    if (!campaign) {
        return jsonResponse({ success: false, message: "Unknown campaign." }, 400, corsHeaders);
    }

    // Which ledger records this send. Reminders share one across both senders.
    const ledger = campaign.dedupeKey || body.campaign;
    const roster = await loadBroadcastRoster(env.DB, ledger, campaign.formType, campaign.unpaidOnly);

    if (body.action === "list") {
        return jsonResponse({
            success: true,
            batchLimit: campaign.route === "graph" ? GRAPH_BATCH_LIMIT : BROADCAST_BATCH_LIMIT,
            route: campaign.route || "brevo",
            ...roster,
            testRecipients: (campaign.testRecipients || []).map((person) => ({
                email: person.email,
                fullName: person.fullName
            }))
        }, 200, corsHeaders);
    }

    if (body.action !== "send" && body.action !== "test") {
        return jsonResponse({ success: false, message: "Unknown action." }, 400, corsHeaders);
    }

    let graphToken = null;

    if (campaign.route === "graph") {
        if (!graphIsConfigured(env)) {
            return jsonResponse({
                success: false,
                message: "Microsoft 365 sending is not configured yet. Set MS_TENANT_ID, MS_CLIENT_ID and MS_CLIENT_SECRET."
            }, 503, corsHeaders);
        }

        graphToken = await getGraphToken(env);

        if (!graphToken) {
            return jsonResponse({
                success: false,
                message: "Microsoft 365 refused the sign-in. Check the tenant, client id and secret."
            }, 502, corsHeaders);
        }
    } else if (!env.BREVO_API_KEY) {
        console.error("BREVO_API_KEY is not configured.");
        return jsonResponse({ success: false, message: "The email service is not configured yet." }, 503, corsHeaders);
    }

    if (body.action === "test") {
        return sendBroadcastTest(env, campaign, corsHeaders, cleanText(body.email, 254));
    }

    const requested = Array.isArray(body.emails) ? body.emails : [];
    if (!requested.length) {
        return jsonResponse({ success: false, message: "No recipients were given." }, 400, corsHeaders);
    }

    const batchLimit = campaign.route === "graph" ? GRAPH_BATCH_LIMIT : BROADCAST_BATCH_LIMIT;

    if (requested.length > batchLimit) {
        return jsonResponse({
            success: false,
            message: `Send at most ${batchLimit} recipients per request.`
        }, 400, corsHeaders);
    }

    const known = new Map(roster.recipients.map((person) => [person.email, person]));
    const results = [];

    for (const raw of requested) {
        const email = String(raw || "").trim().toLowerCase();
        const person = known.get(email);

        if (!person) {
            results.push({ email, status: "skipped", reason: "Not a registered applicant." });
            continue;
        }

        if (roster.alreadySent.includes(email)) {
            results.push({ email, status: "skipped", reason: "Already sent." });
            continue;
        }

        const payload = {
            sender: campaign.sender || { email: env.FROM_EMAIL, name: "Dystil" },
            to: [{ email: person.email, name: person.fullName }],
            replyTo: campaign.replyTo || { email: env.ADMIN_EMAIL, name: "Dystil" },
            subject: campaign.subject,
            // A text-only email cannot carry Brevo's tracking pixel, because
            // the pixel is an image and there is no HTML for it to sit in.
            htmlContent: campaign.plainOnly ? undefined : campaign.buildHtml(person.firstName),
            textContent: campaign.buildText(person.firstName)
        };

        // Brevo fetches an attachment given as a URL, so the file lives on the
        // site rather than being carried through the Worker on every send.
        if (campaign.attachUrl) {
            payload.attachment = [{ url: campaign.attachUrl, name: campaign.attachName }];
        }

        if (campaign.plainOnly) delete payload.htmlContent;

        const sent = campaign.route === "graph"
            ? await sendViaGraph(graphToken, campaign.sender.email, buildGraphMessage(campaign, person, person.firstName))
            : await sendEmail(env.BREVO_API_KEY, payload, await buildLimitKey("broadcast", ledger, email));

        if (!sent.ok) {
            results.push({ email, status: "failed", reason: `Email provider returned ${sent.status}.` });
            continue;
        }

        try {
            await env.DB.prepare(RECORD_BROADCAST_SQL).bind(ledger, email, new Date().toISOString()).run();
        } catch (error) {
            console.error("Sent but could not record the broadcast.", email, error instanceof Error ? error.message : "Unknown error");
        }

        results.push({ email, status: "sent" });
    }

    return jsonResponse({ success: true, results }, 200, corsHeaders);
}

// A test goes to the named team list and nowhere else. The caller does not
// choose the addresses, so a stolen password still cannot mail a stranger.
async function sendBroadcastTest(env, campaign, corsHeaders, onlyEmail) {
    const everyone = campaign.testRecipients || [];

    if (!everyone.length) {
        return jsonResponse({ success: false, message: "This campaign has no test list." }, 400, corsHeaders);
    }

    // Naming one address still only picks from the list, so the endpoint cannot
    // be pointed at a stranger. Sending to one on its own also sends it on its
    // own: every test so far went out as a burst of five to nine at once, which
    // is a difference from a single message that has never been separated out.
    const recipients = onlyEmail
        ? everyone.filter((person) => person.email === onlyEmail.trim().toLowerCase())
        : everyone;

    if (!recipients.length) {
        return jsonResponse({
            success: false,
            message: "That address is not on the test list."
        }, 400, corsHeaders);
    }

    let graphToken = null;

    if (campaign.route === "graph") {
        if (!graphIsConfigured(env)) {
            return jsonResponse({
                success: false,
                message: "Microsoft 365 sending is not configured yet. Set MS_TENANT_ID, MS_CLIENT_ID and MS_CLIENT_SECRET."
            }, 503, corsHeaders);
        }

        graphToken = await getGraphToken(env);

        if (!graphToken) {
            return jsonResponse({
                success: false,
                message: "Microsoft 365 refused the sign-in. Check the tenant, client id and secret."
            }, 502, corsHeaders);
        }
    }

    const results = [];

    for (const person of recipients) {
        const payload = {
            sender: campaign.sender || { email: env.FROM_EMAIL, name: "Dystil" },
            to: [{ email: person.email, name: person.fullName }],
            replyTo: campaign.replyTo || { email: env.ADMIN_EMAIL, name: "Dystil" },
            subject: campaign.subject,
            // A text-only email cannot carry Brevo's tracking pixel, because
            // the pixel is an image and there is no HTML for it to sit in.
            htmlContent: campaign.plainOnly ? undefined : campaign.buildHtml(firstNameOf(person.fullName)),
            textContent: campaign.buildText(firstNameOf(person.fullName))
        };

        // Brevo fetches an attachment given as a URL, so the file lives on the
        // site rather than being carried through the Worker on every send.
        if (campaign.attachUrl) {
            payload.attachment = [{ url: campaign.attachUrl, name: campaign.attachName }];
        }

        if (campaign.plainOnly) delete payload.htmlContent;

        const sent = campaign.route === "graph"
            ? await sendViaGraph(graphToken, campaign.sender.email, buildGraphMessage(campaign, person, firstNameOf(person.fullName)))
            : await sendEmail(env.BREVO_API_KEY, payload, crypto.randomUUID());

        results.push(sent.ok
            ? { email: person.email, status: "sent" }
            : { email: person.email, status: "failed", reason: `Email provider returned ${sent.status}.` });
    }

    return jsonResponse({ success: true, results }, 200, corsHeaders);
}

async function loadBroadcastRoster(db, campaignName, formType, unpaidOnly) {
    const rosterSql = unpaidOnly ? BROADCAST_UNPAID_ROSTER_SQL : BROADCAST_ROSTER_SQL;

    const [people, sent] = await Promise.all([
        db.prepare(rosterSql).bind(formType).all(),
        db.prepare(BROADCAST_SENT_SQL).bind(campaignName).all()
    ]);

    return {
        recipients: (people.results || []).map((row) => ({
            email: row.email,
            fullName: row.full_name,
            firstName: firstNameOf(row.full_name),
            reference: row.reference
        })),
        alreadySent: (sent.results || []).map((row) => row.email)
    };
}

// "Bilal Ahmad (website test)" greets as "Bilal". Anything that does not look
// like a name at all is dropped so nobody is greeted "Hey ?!".
function firstNameOf(fullName) {
    const first = String(fullName || "").trim().split(/\s+/)[0] || "";
    const cleaned = first.replace(/[^\p{L}'-]/gu, "");

    return cleaned.length > 1 ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : "";
}

const DYSTIL_SOCIALS = [
    ["\u{1F4D8}", "Facebook", "https://www.facebook.com/profile.php?id=61593583825137"],
    ["\u{1F4F8}", "Instagram", "https://www.instagram.com/dystil.ai"],
    ["\u{1F3B5}", "TikTok", "https://www.tiktok.com/@dystil.ai"]
];

/* ---------------------------------------------------------------------------
   Microsoft Graph
   ---------------------------------------------------------------------------
   Brevo staples a tracking pixel and a rewritten link onto everything it sends
   and offers no way to stop it on transactional mail. That was blamed for the
   Promotions filing, and it was wrong: the three reminders and the calendar
   invitation went through Brevo carrying the same pixel and reached Primary.
   What went to Promotions was the email with three hosted images, seven links
   and a subject that sold something. See the rule above CAMPAIGNS.

   This route stays because a mailbox of our own is still worth having, and
   because it is the one lever left if the content rule ever stops being
   enough. It needs MS_CLIENT_ID and MS_CLIENT_SECRET, which are not set.
--------------------------------------------------------------------------- */

const GRAPH_SEND_URL = "https://graph.microsoft.com/v1.0/users";
const GRAPH_SCOPE = "https://graph.microsoft.com/.default";

// Exchange Online throttles at roughly thirty messages a minute, so the batch
// is smaller here than the Brevo one and the page works through more of them.
const GRAPH_BATCH_LIMIT = 10;

async function getGraphToken(env) {
    const body = new URLSearchParams({
        client_id: env.MS_CLIENT_ID,
        client_secret: env.MS_CLIENT_SECRET,
        scope: GRAPH_SCOPE,
        grant_type: "client_credentials"
    });

    const response = await fetch(`https://login.microsoftonline.com/${env.MS_TENANT_ID}/oauth2/v2.0/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString()
    });

    if (!response.ok) {
        const detail = await response.text();
        console.error("Could not get a Graph token.", response.status, detail.slice(0, 300));
        return null;
    }

    const token = await response.json();
    return token.access_token || null;
}

async function sendViaGraph(token, sender, message) {
    try {
        const response = await fetch(`${GRAPH_SEND_URL}/${encodeURIComponent(sender)}/sendMail`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${token}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(message)
        });

        if (!response.ok) {
            const detail = await response.text();
            console.error("Graph refused the message.", response.status, detail.slice(0, 300));
            return { ok: false, status: response.status };
        }

        return { ok: true, status: response.status };
    } catch (error) {
        console.error("Could not reach Graph.", error instanceof Error ? error.message : "Unknown error");
        return { ok: false, status: 0 };
    }
}

function buildGraphMessage(campaign, person, firstName) {
    return {
        message: {
            subject: campaign.subject,
            body: { contentType: "HTML", content: campaign.buildHtml(firstName) },
            toRecipients: [{
                emailAddress: { address: person.email, name: person.fullName }
            }],
            replyTo: [{
                emailAddress: { address: campaign.replyTo.email, name: campaign.replyTo.name }
            }]
        },
        saveToSentItems: true
    };
}

function graphIsConfigured(env) {
    return Boolean(env.MS_TENANT_ID && env.MS_CLIENT_ID && env.MS_CLIENT_SECRET);
}

// Variant K, built to the shape of the one email that has never missed: the
// registration confirmation, which has reached Primary eighty-nine times out of
// eighty-nine. Same dark header, same panel, same plain register, and the
// meeting is the only link in the message. What it does not carry is what the
// confirmation does not carry — emoji, a pitch, a referral ask, social accounts.
/* ---------------------------------------------------------------------------
   The bootcamp invitation
   ---------------------------------------------------------------------------
   One email, offered against either taster register. The two registers keep
   separate ledgers, so the people who came in August and the people coming in
   September can each be asked once, months apart, from the same campaign.

   Every date it states comes from BOOTCAMP above, so moving the cohort is
   three lines rather than a search through the copy.
--------------------------------------------------------------------------- */

// Built to the reminder that reached Primary, deliberately and exactly: dark
// header, one panel, one accent block of details, one link, no image anywhere,
// and Kind regards on the end. The pathway choice moved onto the registration
// page, which already asks for it, so this can carry a single link.
function buildBootcampHtml(firstName) {
    const heading = firstName
        ? `The ${escapeHtml(BOOTCAMP.name)}, ${escapeHtml(firstName)}.`
        : `The ${escapeHtml(BOOTCAMP.name)}.`;

    const pathways = BOOTCAMP.pathways
        .map(([, name, detail]) => `<p><strong>${escapeHtml(name)}.</strong> ${escapeHtml(detail)}</p>`)
        .join("\n                    ");

    return `<!doctype html>
        <html><body style="margin:0;background:#f4f7f6;font-family:Arial,sans-serif;color:#16221d;">
            <div style="max-width:620px;margin:0 auto;padding:32px 16px;">
                <div style="background:#123f31;color:#fff;padding:24px;border-radius:12px 12px 0 0;">
                    <h1 style="font-size:24px;margin:0;">${heading}</h1>
                </div>
                <div style="background:#fff;padding:24px;border-radius:0 0 12px 12px;line-height:1.6;">
                    <p style="margin-top:0;">You came to the taster session, which was an hour of what the work looks like. The ${escapeHtml(BOOTCAMP.name)} is the longer version: real projects in your own field, finished, and in your portfolio at the end.</p>
                    <p style="background:#f4f7f6;border-left:4px solid #147a59;padding:12px 16px;"><strong>Starts ${escapeHtml(BOOTCAMP.starts)}</strong><br>Registration closes ${escapeHtml(BOOTCAMP.closes)}<br>Online, in two pathways.</p>
                    ${pathways}
                    <p>You choose the pathway on the registration form, and if you are not sure which is yours, reply to this email or call ${escapeHtml(DYSTIL_PHONE)} and we will talk it through.</p>
                    <p><a href="${escapeHtml(BOOTCAMP.register)}" style="color:#147a59;">Register for the ${escapeHtml(BOOTCAMP.name)}</a></p>
                    <p style="margin-bottom:0;">Kind regards,<br><strong>The Dystil Team</strong></p>
                </div>
            </div>
        </body></html>`;
}

function buildBootcampText(firstName) {
    return [
        firstName ? `The ${BOOTCAMP.name}, ${firstName}.` : `The ${BOOTCAMP.name}.`,
        "",
        `You came to the taster session, which was an hour of what the work looks like. The ${BOOTCAMP.name} is the longer version: real projects in your own field, finished, and in your portfolio at the end.`,
        "",
        `Starts ${BOOTCAMP.starts}`,
        `Registration closes ${BOOTCAMP.closes}`,
        "Online, in two pathways.",
        "",
        ...BOOTCAMP.pathways.map(([, name, detail]) => `${name}. ${detail}`),
        "",
        `You choose the pathway on the registration form, and if you are not sure which is yours, reply to this email or call ${DYSTIL_PHONE} and we will talk it through.`,
        "",
        "Register: " + BOOTCAMP.register,
        "",
        "Kind regards,",
        "The Dystil Team"
    ].join("\n");
}

// No HTML, no URL, no image, ninety words. There is nothing here for a filter
// to read as an advertisement: no link to score, no pixel to find, and a
// question at the end that asks for a reply rather than a click. That reply is
// also the thing Gmail weighs most heavily in favour of Primary next time.
function buildBootcampNoteText(firstName) {
    return [
        firstName ? `Hi ${firstName},` : "Hi,",
        "",
        "You came to our taster session in August, so I thought I would let you know what is next.",
        "",
        `The ${BOOTCAMP.name} runs from ${BOOTCAMP.starts}, and registration closes on ${BOOTCAMP.closes}.`,
        "",
        "There are two pathways. Foundation is for building the basics; Advanced is for harder projects and a stronger profile. You would pick one when you register.",
        "",
        "If you would like the details, just reply to this email and I will send them over. Or call me on " + DYSTIL_PHONE + " and we can talk it through.",
        "",
        "Frank M",
        "Dystil"
    ].join("\n");
}

// One campaign per register per name. Both names on a register share a ledger,
// so asking as Frank cannot ask again as Dystil; the two registers do not, so
// the same email reaches each of them once.
/* ---------------------------------------------------------------------------
   The payment page is open
   ---------------------------------------------------------------------------
   For the people who registered before there was anything to pay with. They
   filled the form, were told a place is confirmed on payment, and then had no
   way to make one. This tells them there is one now.

   The form is the payment page, so it asks them to fill it again, which is
   worth saying plainly rather than letting them discover it. Anyone whose
   address carries a paid registration is left out by the roster, not by the
   copy.
--------------------------------------------------------------------------- */

function poundsOf(pence) {
    return "£" + (pence / 100).toFixed(2).replace(/\.00$/, "");
}

function buildPaymentOpenHtml(firstName) {
    const heading = firstName
        ? `Your place is ready to confirm, ${escapeHtml(firstName)}.`
        : "Your place is ready to confirm.";

    return `<!doctype html>
        <html><body style="margin:0;background:#f4f7f6;font-family:Arial,sans-serif;color:#16221d;">
            <div style="max-width:620px;margin:0 auto;padding:32px 16px;">
                <div style="background:#123f31;color:#fff;padding:24px;border-radius:12px 12px 0 0;">
                    <h1 style="font-size:24px;margin:0;">${heading}</h1>
                </div>
                <div style="background:#fff;padding:24px;border-radius:0 0 12px 12px;line-height:1.6;">
                    <p style="margin-top:0;">You registered for the ${escapeHtml(BOOTCAMP.name)} before there was a way to pay for it. There is now, so you can confirm your place.</p>
                    <p style="background:#f4f7f6;border-left:4px solid #147a59;padding:12px 16px;"><strong>Starts ${escapeHtml(BOOTCAMP.starts)}</strong><br>Registration closes ${escapeHtml(BOOTCAMP.closes)}<br>Foundation ${poundsOf(BOOTCAMP_PRICES["Foundation Bootcamp"])}, Advanced ${poundsOf(BOOTCAMP_PRICES["Advanced Bootcamp"])}</p>
                    <p>The form now takes the payment at the end, so it will ask for your details once more. It is short, and it is the last thing standing between you and a seat.</p>
                    <p><a href="${escapeHtml(BOOTCAMP.register)}" style="color:#147a59;">Confirm your place</a></p>
                    <p>Places are held in the order the payments arrive. If anything has changed, or you would rather talk it through first, reply to this email or call ${escapeHtml(DYSTIL_PHONE)}.</p>
                    <p style="margin-bottom:0;">Kind regards,<br><strong>The Dystil Team</strong></p>
                </div>
            </div>
        </body></html>`;
}

function buildPaymentOpenText(firstName) {
    return [
        firstName ? `Your place is ready to confirm, ${firstName}.` : "Your place is ready to confirm.",
        "",
        `You registered for the ${BOOTCAMP.name} before there was a way to pay for it. There is now, so you can confirm your place.`,
        "",
        `Starts ${BOOTCAMP.starts}`,
        `Registration closes ${BOOTCAMP.closes}`,
        `Foundation ${poundsOf(BOOTCAMP_PRICES["Foundation Bootcamp"])}, Advanced ${poundsOf(BOOTCAMP_PRICES["Advanced Bootcamp"])}`,
        "",
        "The form now takes the payment at the end, so it will ask for your details once more. It is short, and it is the last thing standing between you and a seat.",
        "",
        "Confirm your place: " + BOOTCAMP.register,
        "",
        `Places are held in the order the payments arrive. If anything has changed, or you would rather talk it through first, reply to this email or call ${DYSTIL_PHONE}.`,
        "",
        "Kind regards,",
        "The Dystil Team"
    ].join("\n");
}

function buildPaymentOpenCampaigns() {
    const campaigns = {};

    for (const [who, sender] of Object.entries(CAMPAIGN_SENDERS)) {
        campaigns[`bootcamp-payment-open-${who}`] = {
            formType: PAID_FORM,
            subject: PAYMENT_OPEN_SUBJECT,
            buildHtml: buildPaymentOpenHtml,
            buildText: buildPaymentOpenText,
            sender,
            replyTo: sender,
            // Nobody who has paid is asked to pay.
            unpaidOnly: true,
            dedupeKey: "bootcamp-payment-open",
            testRecipients: TEST_TEAM
        };
    }

    return campaigns;
}

function buildBootcampCampaigns() {
    const campaigns = {};

    for (const [register, target] of Object.entries(BOOTCAMP_REGISTERS)) {
        for (const [who, sender] of Object.entries(CAMPAIGN_SENDERS)) {
            // The same offer as a plain note: no HTML part, so no pixel, and
            // no URL to score. Shares the register's ledger with the designed
            // one, so a person gets one or the other and never both.
            campaigns[`bootcamp-2026-09-26-note-${register}-${who}`] = {
                formType: target.formType,
                subject: BOOTCAMP_NOTE_SUBJECT,
                // Never called on a plainOnly campaign, but the payload is
                // built before that is known, so it has to be here.
                buildHtml: buildBootcampNoteText,
                buildText: buildBootcampNoteText,
                plainOnly: true,
                sender,
                replyTo: sender,
                dedupeKey: `bootcamp-2026-09-26-invite-${register}`,
                testRecipients: TEST_TEAM
            };

            campaigns[`bootcamp-2026-09-26-invite-${register}-${who}`] = {
                formType: target.formType,
                subject: BOOTCAMP_SUBJECT,
                buildHtml: buildBootcampHtml,
                buildText: buildBootcampText,
                sender,
                replyTo: sender,
                dedupeKey: `bootcamp-2026-09-26-invite-${register}`,
                testRecipients: TEST_TEAM
            };
        }
    }

    return campaigns;
}

/* ---------------------------------------------------------------------------
   Sending quota
   ---------------------------------------------------------------------------
   Brevo counts every message it accepts, including the test sends this page
   deliberately does not record, so the ledger cannot answer how much of the
   day's allowance is left. Brevo can, and the key it needs is already here.
   Read-only: it asks how many have gone and what the plan allows.
--------------------------------------------------------------------------- */

const BREVO_ACCOUNT_URL = "https://api.brevo.com/v3/account";
const BREVO_STATS_URL = "https://api.brevo.com/v3/smtp/statistics/aggregatedReport";

async function brevoGet(apiKey, url) {
    try {
        const response = await fetch(url, {
            headers: { "accept": "application/json", "api-key": apiKey }
        });

        if (!response.ok) {
            const detail = await response.text();
            return { ok: false, status: response.status, detail: detail.slice(0, 200) };
        }

        return { ok: true, body: await response.json() };
    } catch (error) {
        return { ok: false, status: 0, detail: error instanceof Error ? error.message : "Unknown error" };
    }
}

async function readSendingQuota(env, corsHeaders) {
    if (!env.BREVO_API_KEY) {
        return jsonResponse({ success: false, message: "No email key is configured." }, 503, corsHeaders);
    }

    const today = new Date().toISOString().slice(0, 10);

    const [account, stats] = await Promise.all([
        brevoGet(env.BREVO_API_KEY, BREVO_ACCOUNT_URL),
        brevoGet(env.BREVO_API_KEY, `${BREVO_STATS_URL}?startDate=${today}&endDate=${today}`)
    ]);

    if (!account.ok && !stats.ok) {
        return jsonResponse({
            success: false,
            message: `Brevo did not answer (${account.status}). ${account.detail || ""}`.trim()
        }, 502, corsHeaders);
    }

    const plans = (account.ok && Array.isArray(account.body.plan)) ? account.body.plan : [];
    const sending = plans.find((p) => p.creditsType === "sendLimit")
        || plans.find((p) => typeof p.credits === "number");

    return jsonResponse({
        success: true,
        date: today,
        sentToday: stats.ok ? (stats.body.requests ?? null) : null,
        remaining: sending && typeof sending.credits === "number" ? sending.credits : null,
        planType: sending ? (sending.type || null) : null,
        plan: plans,
        statsError: stats.ok ? null : `${stats.status} ${stats.detail || ""}`.trim(),
        accountError: account.ok ? null : `${account.status} ${account.detail || ""}`.trim()
    }, 200, corsHeaders);
}
