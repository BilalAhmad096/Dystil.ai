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
         source_channel, source_detail, source_landing)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`;

const MARK_DELIVERY_SQL = "UPDATE submissions SET delivery_status = ? WHERE reference = ?";

const LIST_SUBMISSIONS_SQL = `
    SELECT reference, form_type, full_name, email, details, cv_filename, submitted_at, delivery_status,
           source_channel, source_detail, source_landing
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
            await saveSubmission(env.DB, reference, formType, values, cvResult.attachment, submittedAt, source);
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
async function saveSubmission(db, reference, formType, values, attachment, submittedAt, source) {
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
        source.landing
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

const TASTER_REMINDERS = [
    {
        key: "2-days",
        subject: "Saturday 29 August | Dystil Free Taster Session, 11am",
        heading: "Saturday 29 August",
        opening: "Your Dystil free taster session is on Saturday 29 August.",
        when: "Saturday 29 August 2026",
        closing: [
            "Please add it to your calendar now, so the time is held.",
            "If you can no longer attend, reply to this email and let us know, so we can offer your place to someone else."
        ]
    },
    {
        key: "1-day",
        subject: "Tomorrow | Dystil Free Taster Session, Saturday 11am",
        heading: "Tomorrow",
        opening: "Your Dystil free taster session is tomorrow morning.",
        when: "Tomorrow, Saturday 29 August 2026",
        closing: [
            "It is worth saving this email now, so you are not searching for the link on Saturday morning.",
            "If you can no longer attend, reply to this email and let us know, so we can offer your place to someone else."
        ]
    },
    {
        key: "final",
        subject: "We start at 11:00 | Dystil Free Taster Session",
        heading: "We start at 11:00",
        opening: "Your Dystil free taster session starts shortly.",
        when: "Today, Saturday 29 August 2026",
        closing: [
            "The link opens in your browser, so there is nothing to install.",
            "See you shortly."
        ]
    },
    {
        key: "hours",
        subject: "Starting at 11:00 today | Dystil Free Taster Session",
        heading: "This morning",
        opening: "Your Dystil free taster session starts at 11:00 this morning.",
        when: "Today, Saturday 29 August 2026",
        closing: [
            "Please join a few minutes early so we can start on time. The link opens in your browser, so there is nothing to install.",
            "See you shortly."
        ]
    }
];

const TASTER_SENDERS = {
    frank: { email: "frank@dystil.ai", name: "Frank M" },
    askus: { email: "askus@dystil.ai", name: "Dystil" }
};

const TASTER_TEST_TEAM = [
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

const CAMPAIGNS = {
    "taster-2026-08-29-joining-link": {
        formType: "Free Taster Registration",
        subject: "🔥 Dystil: You’re In. This Saturday is Going to Be Different — Here’s What to Expect",
        buildHtml: buildTasterJoiningHtml,
        buildText: buildTasterJoiningText,
        sender: { email: "frank@dystil.ai", name: "Frank M" },
        replyTo: { email: "frank@dystil.ai", name: "Frank M" },
        testRecipients: TASTER_TEST_TEAM
    },
    // Same email, plain packaging and a subject with no emoji or hype, so the
    // two can be sent side by side and the tab they land in compared.
    "taster-2026-08-29-joining-link-original": {
        formType: "Free Taster Registration",
        subject: "Your joining link — Dystil Free Taster Session, Saturday 11am",
        buildHtml: buildTasterJoiningHtml,
        buildText: buildTasterJoiningText,
        sender: { email: "frank@dystil.ai", name: "Frank M" },
        replyTo: { email: "frank@dystil.ai", name: "Frank M" },
        testRecipients: TASTER_TEST_TEAM
    },
    "taster-2026-08-29-calendar-invite-frank": {
        formType: "Free Taster Registration",
        subject: "Calendar invitation | Dystil Free Taster Session, Saturday 29 August",
        buildHtml: buildInviteHtml,
        buildText: buildInviteText,
        sender: { email: "frank@dystil.ai", name: "Frank M" },
        replyTo: { email: "frank@dystil.ai", name: "Frank M" },
        // Built per recipient, because the invitation names its attendee.
        attachInvite: true,
        dedupeKey: "taster-2026-08-29-calendar-invite",
        testRecipients: TASTER_TEST_TEAM
    },
    "taster-2026-08-29-calendar-invite-askus": {
        formType: "Free Taster Registration",
        subject: "Calendar invitation | Dystil Free Taster Session, Saturday 29 August",
        buildHtml: buildInviteHtml,
        buildText: buildInviteText,
        sender: { email: "askus@dystil.ai", name: "Dystil" },
        replyTo: { email: "askus@dystil.ai", name: "Dystil" },
        // Built per recipient, because the invitation names its attendee.
        attachInvite: true,
        dedupeKey: "taster-2026-08-29-calendar-invite",
        testRecipients: TASTER_TEST_TEAM
    },
    "taster-2026-08-29-joining-link-confirmstyle": {
        formType: "Free Taster Registration",
        subject: "Your joining details | Free Taster Session, Saturday 29 August",
        buildHtml: buildTasterConfirmStyleHtml,
        buildText: buildTasterConfirmStyleText,
        sender: { email: "askus@dystil.ai", name: "Dystil" },
        replyTo: { email: "askus@dystil.ai", name: "Dystil" },
        testRecipients: TASTER_TEST_TEAM
    },
    "taster-2026-08-29-joining-link-outlook": {
        formType: "Free Taster Registration",
        subject: "🔥 Dystil: You’re In. This Saturday is Going to Be Different — Here’s What to Expect",
        buildHtml: buildTasterJoiningHtml,
        buildText: buildTasterJoiningText,
        sender: { email: "frank@dystil.ai", name: "Frank M" },
        replyTo: { email: "frank@dystil.ai", name: "Frank M" },
        route: "graph",
        testRecipients: TASTER_TEST_TEAM
    },
    "taster-2026-08-29-joining-link-focused": {
        formType: "Free Taster Registration",
        subject: "Your joining link — Dystil Free Taster Session, Saturday 11am",
        buildHtml: buildTasterFocusedHtml,
        buildText: buildTasterFocusedText,
        sender: { email: "askus@dystil.ai", name: "Dystil" },
        replyTo: { email: "askus@dystil.ai", name: "Dystil" },
        testRecipients: TASTER_TEST_TEAM
    },
    "taster-2026-08-29-joining-link-focused-emoji": {
        formType: "Free Taster Registration",
        subject: "🔥 Dystil: You’re In. This Saturday is Going to Be Different — Here’s What to Expect",
        buildHtml: buildTasterFocusedHtml,
        buildText: buildTasterFocusedText,
        sender: { email: "askus@dystil.ai", name: "Dystil" },
        replyTo: { email: "askus@dystil.ai", name: "Dystil" },
        testRecipients: TASTER_TEST_TEAM
    },
    "taster-2026-08-29-joining-link-askus-branded": {
        formType: "Free Taster Registration",
        subject: "🔥 Dystil: You’re In. This Saturday is Going to Be Different — Here’s What to Expect",
        buildHtml: buildTasterJoiningHtml,
        buildText: buildTasterJoiningText,
        sender: { email: "askus@dystil.ai", name: "Dystil" },
        replyTo: { email: "askus@dystil.ai", name: "Dystil" },
        testRecipients: TASTER_TEST_TEAM
    },
    "taster-2026-08-29-joining-link-screenshot": {
        formType: "Free Taster Registration",
        subject: "Your joining link — Dystil Free Taster Session, Saturday 11am",
        buildHtml: buildTasterJoiningHtml,
        buildText: buildTasterJoiningText,
        sender: { email: "askus@dystil.ai", name: "Dystil" },
        replyTo: { email: "askus@dystil.ai", name: "Dystil" },
        testRecipients: TASTER_TEST_TEAM
    },
    "taster-2026-08-29-joining-link-plain": {
        formType: "Free Taster Registration",
        subject: "Your Saturday session details and joining link",
        buildHtml: buildTasterPlainHtml,
        buildText: buildTasterJoiningText,
        sender: { email: "frank@dystil.ai", name: "Frank M" },
        replyTo: { email: "frank@dystil.ai", name: "Frank M" },
        testRecipients: TASTER_TEST_TEAM
    },
    "taster-2026-08-29-joining-link-askus": {
        formType: "Free Taster Registration",
        subject: "Your Saturday session details and joining link",
        buildHtml: buildTasterPlainHtml,
        buildText: buildTasterJoiningText,
        sender: { email: "askus@dystil.ai", name: "Dystil" },
        replyTo: { email: "askus@dystil.ai", name: "Dystil" },
        testRecipients: TASTER_TEST_TEAM
    },
    "taster-2026-08-29-joining-link-sober": {
        formType: "Free Taster Registration",
        subject: "Your Dystil taster session on Saturday 29 August",
        buildHtml: buildTasterSoberHtml,
        buildText: buildTasterSoberText,
        sender: { email: "askus@dystil.ai", name: "Dystil" },
        replyTo: { email: "askus@dystil.ai", name: "Dystil" },
        testRecipients: TASTER_TEST_TEAM
    },
    "taster-2026-08-29-joining-link-minimal": {
        formType: "Free Taster Registration",
        subject: "Your Saturday session details and joining link",
        buildHtml: buildTasterMinimalHtml,
        buildText: buildTasterJoiningText,
        sender: { email: "askus@dystil.ai", name: "Dystil" },
        replyTo: { email: "askus@dystil.ai", name: "Dystil" },
        testRecipients: TASTER_TEST_TEAM
    },
    ...buildReminderCampaigns()
};

const BROADCAST_ROSTER_SQL = `
    SELECT lower(trim(email)) AS email, full_name, MAX(reference) AS reference
    FROM submissions
    WHERE form_type = ?
    GROUP BY lower(trim(email))
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
    const roster = await loadBroadcastRoster(env.DB, ledger, campaign.formType);

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
            htmlContent: campaign.buildHtml(person.firstName),
            textContent: campaign.buildText(person.firstName)
        };

        if (campaign.attachInvite) {
            payload.attachment = [buildInviteAttachment(person, campaign.sender)];
        }

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
            htmlContent: campaign.buildHtml(firstNameOf(person.fullName)),
            textContent: campaign.buildText(firstNameOf(person.fullName))
        };

        if (campaign.attachInvite) {
            payload.attachment = [buildInviteAttachment(person, campaign.sender)];
        }

        const sent = campaign.route === "graph"
            ? await sendViaGraph(graphToken, campaign.sender.email, buildGraphMessage(campaign, person, firstNameOf(person.fullName)))
            : await sendEmail(env.BREVO_API_KEY, payload, crypto.randomUUID());

        results.push(sent.ok
            ? { email: person.email, status: "sent" }
            : { email: person.email, status: "failed", reason: `Email provider returned ${sent.status}.` });
    }

    return jsonResponse({ success: true, results }, 200, corsHeaders);
}

async function loadBroadcastRoster(db, campaignName, formType) {
    const [people, sent] = await Promise.all([
        db.prepare(BROADCAST_ROSTER_SQL).bind(formType).all(),
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

const TASTER_MEETING_URL = "https://teams.microsoft.com/dl/launcher/launcher.html?url=%2F_%23%2Fmeet%2F229072838157592%3Fp%3DcAIRVOIkArp5srCvN5%26anon%3Dtrue&type=meet&deeplinkId=b1481443-9b4f-424f-b23b-02e70811caf7&directDl=true&msLaunch=true&enableMobilePage=true&suppressPrompt=true";

const TASTER_AGENDA = [
    ["\u{1F680}", "01 · Future of Work", "what's really happening in your industry right now"],
    ["\u{1F916}", "02 · AI Role Impact Demo", "AI applied to real roles, live"],
    ["\u{1F4C1}", "03 · Profile Preview", "the kind of work that makes employers take notice"],
    ["\u{1F3AF}", "04 · Why Dystil? Pathways & Q&A", "where you could go next, and your questions answered"]
];

const TASTER_SOCIALS = [
    ["\u{1F4D8}", "Facebook", "https://www.facebook.com/profile.php?id=61593583825137"],
    ["\u{1F4F8}", "Instagram", "https://www.instagram.com/dystil.ai"],
    ["\u{1F3B5}", "TikTok", "https://www.tiktok.com/@dystil.ai"]
];

function buildTasterJoiningHtml(firstName) {
    const greeting = firstName ? `Hey ${escapeHtml(firstName)}!` : "Hey!";

    const agenda = TASTER_AGENDA.map(([icon, title, detail]) => `
        <tr>
            <td style="padding:8px 0;vertical-align:top;width:34px;font-size:18px;">${icon}</td>
            <td style="padding:8px 0;line-height:1.5;">
                <strong style="color:#123f31;">${escapeHtml(title)}</strong>
                <span style="color:#4c5a54;"> — ${escapeHtml(detail)}</span>
            </td>
        </tr>`).join("");

    const socials = TASTER_SOCIALS.map(([icon, name, href]) =>
        `<p style="margin:4px 0;">${icon} ${escapeHtml(name)}: <a href="${escapeHtml(href)}" style="color:#147a59;">${escapeHtml(href)}</a></p>`
    ).join("");

    return `<!doctype html>
<html><body style="margin:0;background:#f4f7f6;font-family:Arial,Helvetica,sans-serif;color:#16221d;">
    <div style="max-width:620px;margin:0 auto;padding:32px 16px;">
        <div style="background:#123f31;color:#ffffff;padding:28px 24px;border-radius:12px 12px 0 0;">
            <p style="margin:0 0 6px;font-size:12px;letter-spacing:1.6px;color:#8fd3b8;">FREE TASTER SESSION</p>
            <h1 style="font-size:26px;margin:0;">${greeting}</h1>
            <p style="margin:8px 0 0;font-size:16px;color:#d8ede5;">You registered. Smart move.</p>
        </div>

        <div style="background:#ffffff;padding:24px;line-height:1.6;">
            <p style="margin-top:0;">Now mark the calendar, set the alarm, and show up — because this Saturday is going to be worth every minute.</p>

            <p>We're kicking off Dystil's very first Free Taster Session for the Career Accelerator Program, and you're one of the 100s who grabbed a spot.</p>

            <table role="presentation" style="width:100%;border-collapse:collapse;background:#f4f7f6;border-left:4px solid #147a59;margin:20px 0;">
                <tr><td style="padding:14px 16px 4px;">\u{1F4C5} <strong>Saturday, 29th August 2026</strong></td></tr>
                <tr><td style="padding:4px 16px;">⏰ <strong>11:00 AM – 1:00 PM UK Time</strong></td></tr>
                <tr><td style="padding:4px 16px 14px;">\u{1F4BB} <strong>Online – Live Session, <a href="${escapeHtml(TASTER_MEETING_URL)}" style="color:#147a59;">Meeting Link here</a>, calendar invite to follow.</strong></td></tr>
            </table>

            <p style="text-align:center;margin:24px 0;">
                <a href="${escapeHtml(TASTER_MEETING_URL)}" style="display:inline-block;background:#147a59;color:#ffffff;text-decoration:none;font-weight:bold;font-size:16px;padding:14px 32px;border-radius:999px;">Join the session on Teams</a>
            </p>

            <p>You'll get a real look at what the Career Accelerator Program is all about — the skills, the projects, the confidence, and the career edge. Not a sales pitch. An actual session built to give you something useful from minute one.</p>

            <p style="margin-bottom:4px;"><strong>Here's what's coming your way:</strong></p>
            <table role="presentation" style="width:100%;border-collapse:collapse;margin-bottom:20px;">${agenda}
            </table>

            <p>This is our first session ever — and we're building something genuinely exciting. You're part of that from day one.</p>

            <hr style="border:none;border-top:1px solid #e2e9e6;margin:24px 0;">

            <p style="margin-bottom:4px;"><strong>Know someone who'd benefit? Share it.</strong></p>
            <p style="margin-top:0;">If you have a friend, classmate, or colleague who's thinking about their career — send them this link and invite them to register before Friday night:</p>
            <p style="font-size:17px;">\u{1F449} <a href="https://dystil.ai/students/taster" style="color:#147a59;font-weight:bold;">dystil.ai/students/taster</a></p>

            <p style="margin-bottom:4px;"><strong>Follow us for updates before Saturday:</strong></p>
            ${socials}

            <hr style="border:none;border-top:1px solid #e2e9e6;margin:24px 0;">

            <p>We'll see you Saturday at 11:00 AM sharp.</p>
            <p style="margin-bottom:0;">Don't be the one who had a spot and didn't show up. \u{1F609}</p>
        </div>

        <div style="background:#ffffff;padding:20px 24px 24px;border-radius:0 0 12px 12px;line-height:1.6;">
            <p style="margin:0 0 12px;"><strong>The Dystil Team</strong></p>
            <p style="margin:0;font-size:14px;color:#4c5a54;">
                <strong style="color:#16221d;">Frank M</strong><br>
                Executive Partner<br>
                <a href="mailto:askus@dystil.ai" style="color:#147a59;">askus@dystil.ai</a><br>
                <a href="mailto:frank@dystil.ai" style="color:#147a59;">frank@dystil.ai</a><br>
                <a href="https://www.dystil.ai" style="color:#147a59;">www.dystil.ai</a>
            </p>
        </div>

        <p style="text-align:center;font-size:12px;color:#7c8a84;padding:16px 8px 0;">
            You're getting this because you registered for the Dystil Free Taster Session.
        </p>
    </div>
</body></html>`;
}

function buildTasterJoiningText(firstName) {
    const agenda = TASTER_AGENDA.map(([icon, title, detail]) => `${icon} ${title} — ${detail}`);
    const socials = TASTER_SOCIALS.map(([icon, name, href]) => `${icon} ${name}: ${href}`);

    return [
        firstName ? `Hey ${firstName}!` : "Hey!",
        "You registered. Smart move.",
        "",
        "Now mark the calendar, set the alarm, and show up — because this Saturday is going to be worth every minute.",
        "",
        "We're kicking off Dystil's very first Free Taster Session for the Career Accelerator Program, and you're one of the 100s who grabbed a spot.",
        "",
        "\u{1F4C5} Saturday, 29th August 2026",
        "⏰ 11:00 AM – 1:00 PM UK Time",
        "\u{1F4BB} Online – Live Session, Meeting Link here, calendar invite to follow.",
        "",
        "Join the session on Teams:",
        TASTER_MEETING_URL,
        "",
        "You'll get a real look at what the Career Accelerator Program is all about — the skills, the projects, the confidence, and the career edge. Not a sales pitch. An actual session built to give you something useful from minute one.",
        "",
        "Here's what's coming your way:",
        ...agenda,
        "",
        "This is our first session ever — and we're building something genuinely exciting. You're part of that from day one.",
        "",
        "---",
        "",
        "Know someone who'd benefit? Share it.",
        "If you have a friend, classmate, or colleague who's thinking about their career — send them this link and invite them to register before Friday night:",
        "\u{1F449} https://dystil.ai/students/taster",
        "",
        "Follow us for updates before Saturday:",
        ...socials,
        "",
        "---",
        "",
        "We'll see you Saturday at 11:00 AM sharp.",
        "Don't be the one who had a spot and didn't show up. \u{1F609}",
        "",
        "The Dystil Team",
        "",
        "Frank M",
        "Executive Partner",
        "askus@dystil.ai",
        "frank@dystil.ai",
        "www.dystil.ai",
        "",
        "You're getting this because you registered for the Dystil Free Taster Session."
    ].join("\n");
}

// Variant B. Same words, plain packaging: no banner, no pill button, no
// coloured panels, no "why you are getting this" footer. Sent beside the
// designed version so the team can see which tab each one lands in, rather
// than us guessing which signal Gmail is reacting to.
function buildTasterPlainHtml(firstName) {
    const greeting = firstName ? `Hey ${escapeHtml(firstName)}!` : "Hey!";

    const agenda = TASTER_AGENDA.map(([icon, title, detail]) =>
        `<div style="margin:0 0 6px;">${icon} ${escapeHtml(title)} — ${escapeHtml(detail)}</div>`
    ).join("");

    const socials = TASTER_SOCIALS.map(([icon, name, href]) =>
        `<div style="margin:0 0 4px;">${icon} ${escapeHtml(name)}: <a href="${escapeHtml(href)}">${escapeHtml(href)}</a></div>`
    ).join("");

    return `<!doctype html>
<html><body style="margin:0;padding:0;background:#ffffff;">
    <div style="max-width:600px;font-family:-apple-system,'Segoe UI',Arial,sans-serif;font-size:15px;line-height:1.6;color:#222222;padding:16px;">
        <p style="margin:0 0 14px;">${greeting}<br>You registered. Smart move.</p>

        <p style="margin:0 0 14px;">Now mark the calendar, set the alarm, and show up — because this Saturday is going to be worth every minute.</p>

        <p style="margin:0 0 14px;">We're kicking off Dystil's very first Free Taster Session for the Career Accelerator Program, and you're one of the 100s who grabbed a spot.</p>

        <div style="margin:0 0 14px;">
            <div style="margin:0 0 4px;">\u{1F4C5} Saturday, 29th August 2026</div>
            <div style="margin:0 0 4px;">⏰ 11:00 AM – 1:00 PM UK Time</div>
            <div>\u{1F4BB} Online – Live Session, <a href="${escapeHtml(TASTER_MEETING_URL)}">Meeting Link here</a>, calendar invite to follow.</div>
        </div>

        <p style="margin:0 0 14px;">You'll get a real look at what the Career Accelerator Program is all about — the skills, the projects, the confidence, and the career edge. Not a sales pitch. An actual session built to give you something useful from minute one.</p>

        <p style="margin:0 0 8px;">Here's what's coming your way:</p>
        <div style="margin:0 0 14px;">${agenda}</div>

        <p style="margin:0 0 14px;">This is our first session ever — and we're building something genuinely exciting. You're part of that from day one.</p>

        <p style="margin:0 0 4px;">Know someone who'd benefit? Share it.</p>
        <p style="margin:0 0 14px;">If you have a friend, classmate, or colleague who's thinking about their career — send them this link and invite them to register before Friday night:<br>
        \u{1F449} <a href="https://dystil.ai/students/taster">dystil.ai/students/taster</a></p>

        <p style="margin:0 0 8px;">Follow us for updates before Saturday:</p>
        <div style="margin:0 0 14px;">${socials}</div>

        <p style="margin:0 0 14px;">We'll see you Saturday at 11:00 AM sharp.</p>

        <p style="margin:0 0 14px;">Don't be the one who had a spot and didn't show up. \u{1F609}</p>

        <p style="margin:0 0 14px;">The Dystil Team</p>

        <p style="margin:0;">
            Frank M<br>
            Executive Partner<br>
            <a href="mailto:askus@dystil.ai">askus@dystil.ai</a><br>
            <a href="mailto:frank@dystil.ai">frank@dystil.ai</a><br>
            <a href="https://www.dystil.ai">www.dystil.ai</a>
        </p>
    </div>
</body></html>`;
}

// Variant D. The confirmation emails that reach Primary carry no http links at
// all, only a mailto, so Brevo has nothing to rewrite. This keeps every word
// but prints the share and social addresses as text instead of links, leaving
// the meeting the only thing Brevo can wrap.
function buildTasterMinimalHtml(firstName) {
    const greeting = firstName ? `Hey ${escapeHtml(firstName)}!` : "Hey!";

    const agenda = TASTER_AGENDA.map(([icon, title, detail]) =>
        `<div style="margin:0 0 6px;">${icon} ${escapeHtml(title)} — ${escapeHtml(detail)}</div>`
    ).join("");

    const socials = TASTER_SOCIALS.map(([icon, name, href]) =>
        `<div style="margin:0 0 4px;">${icon} ${escapeHtml(name)}: ${escapeHtml(href)}</div>`
    ).join("");

    return `<!doctype html>
<html><body style="margin:0;padding:0;background:#ffffff;">
    <div style="max-width:600px;font-family:-apple-system,'Segoe UI',Arial,sans-serif;font-size:15px;line-height:1.6;color:#222222;padding:16px;">
        <p style="margin:0 0 14px;">${greeting}<br>You registered. Smart move.</p>

        <p style="margin:0 0 14px;">Now mark the calendar, set the alarm, and show up — because this Saturday is going to be worth every minute.</p>

        <p style="margin:0 0 14px;">We're kicking off Dystil's very first Free Taster Session for the Career Accelerator Program, and you're one of the 100s who grabbed a spot.</p>

        <div style="margin:0 0 14px;">
            <div style="margin:0 0 4px;">\u{1F4C5} Saturday, 29th August 2026</div>
            <div style="margin:0 0 4px;">⏰ 11:00 AM – 1:00 PM UK Time</div>
            <div>\u{1F4BB} Online – Live Session, <a href="${escapeHtml(TASTER_MEETING_URL)}">Meeting Link here</a>, calendar invite to follow.</div>
        </div>

        <p style="margin:0 0 14px;">You'll get a real look at what the Career Accelerator Program is all about — the skills, the projects, the confidence, and the career edge. Not a sales pitch. An actual session built to give you something useful from minute one.</p>

        <p style="margin:0 0 8px;">Here's what's coming your way:</p>
        <div style="margin:0 0 14px;">${agenda}</div>

        <p style="margin:0 0 14px;">This is our first session ever — and we're building something genuinely exciting. You're part of that from day one.</p>

        <p style="margin:0 0 4px;">Know someone who'd benefit? Share it.</p>
        <p style="margin:0 0 14px;">If you have a friend, classmate, or colleague who's thinking about their career — send them this link and invite them to register before Friday night:<br>
        \u{1F449} dystil.ai/students/taster</p>

        <p style="margin:0 0 8px;">Follow us for updates before Saturday:</p>
        <div style="margin:0 0 14px;">${socials}</div>

        <p style="margin:0 0 14px;">We'll see you Saturday at 11:00 AM sharp.</p>

        <p style="margin:0 0 14px;">Don't be the one who had a spot and didn't show up. \u{1F609}</p>

        <p style="margin:0 0 14px;">The Dystil Team</p>

        <p style="margin:0;">
            Frank M<br>
            Executive Partner<br>
            <a href="mailto:askus@dystil.ai">askus@dystil.ai</a><br>
            <a href="mailto:frank@dystil.ai">frank@dystil.ai</a><br>
            www.dystil.ai
        </p>
    </div>
</body></html>`;
}

// Variant E. The one variable the other four never moved: the words. This says
// the same practical things — you registered, here is when, here is the link,
// here is what happens — in the register the confirmation emails use, which are
// the ones that reach Primary. No emoji, no pitch, no share or follow section.
// It is a diagnostic, not a redraft: if it lands in Primary, the copy is what
// Gmail is reacting to, and that is a decision about the email, not the code.
function buildTasterSoberHtml(firstName) {
    const greeting = firstName ? `Hi ${escapeHtml(firstName)},` : "Hi,";

    return `<!doctype html>
<html><body style="margin:0;padding:0;background:#ffffff;">
    <div style="max-width:600px;font-family:-apple-system,'Segoe UI',Arial,sans-serif;font-size:15px;line-height:1.6;color:#222222;padding:16px;">
        <p style="margin:0 0 14px;">${greeting}</p>

        <p style="margin:0 0 14px;">You registered for the Dystil free taster session. Here are your joining details.</p>

        <p style="margin:0 0 14px;">
            Date: Saturday 29 August 2026<br>
            Time: 11:00 to 13:00 UK time<br>
            Join: <a href="${escapeHtml(TASTER_MEETING_URL)}">Microsoft Teams</a>
        </p>

        <p style="margin:0 0 14px;">The session runs for two hours and covers the future of work in your industry, a live demonstration of AI applied to real job roles, a look at the kind of projects you would build, and a question and answer session at the end.</p>

        <p style="margin:0 0 14px;">A calendar invitation will follow separately.</p>

        <p style="margin:0 0 14px;">If you can no longer attend, please reply to this email and let us know.</p>

        <p style="margin:0;">
            Frank M<br>
            Executive Partner, Dystil<br>
            <a href="mailto:askus@dystil.ai">askus@dystil.ai</a>
        </p>
    </div>
</body></html>`;
}

function buildTasterSoberText(firstName) {
    return [
        firstName ? `Hi ${firstName},` : "Hi,",
        "",
        "You registered for the Dystil free taster session. Here are your joining details.",
        "",
        "Date: Saturday 29 August 2026",
        "Time: 11:00 to 13:00 UK time",
        "Join: " + TASTER_MEETING_URL,
        "",
        "The session runs for two hours and covers the future of work in your industry, a live demonstration of AI applied to real job roles, a look at the kind of projects you would build, and a question and answer session at the end.",
        "",
        "A calendar invitation will follow separately.",
        "",
        "If you can no longer attend, please reply to this email and let us know.",
        "",
        "Frank M",
        "Executive Partner, Dystil",
        "askus@dystil.ai"
    ].join("\n");
}

// The designed email with the two sections the measurement implicates taken
// out: the referral ask and the follow-us block. The confirmation that reaches
// Primary every time carries the same dark header and the same colour blocks,
// so the template stays; what it does not carry is a request to share and a
// list of social accounts. The pill button goes too, since it was never in the
// copy and it is one more tracked link.
function buildTasterFocusedHtml(firstName) {
    const greeting = firstName ? `Hey ${escapeHtml(firstName)}!` : "Hey!";

    const agenda = TASTER_AGENDA.map(([icon, title, detail]) => `
        <tr>
            <td style="padding:8px 0;vertical-align:top;width:34px;font-size:18px;">${icon}</td>
            <td style="padding:8px 0;line-height:1.5;">
                <strong style="color:#123f31;">${escapeHtml(title)}</strong>
                <span style="color:#4c5a54;"> — ${escapeHtml(detail)}</span>
            </td>
        </tr>`).join("");

    return `<!doctype html>
<html><body style="margin:0;background:#f4f7f6;font-family:Arial,Helvetica,sans-serif;color:#16221d;">
    <div style="max-width:620px;margin:0 auto;padding:32px 16px;">
        <div style="background:#123f31;color:#ffffff;padding:28px 24px;border-radius:12px 12px 0 0;">
            <p style="margin:0 0 6px;font-size:12px;letter-spacing:1.6px;color:#8fd3b8;">FREE TASTER SESSION</p>
            <h1 style="font-size:26px;margin:0;">${greeting}</h1>
            <p style="margin:8px 0 0;font-size:16px;color:#d8ede5;">You registered. Smart move.</p>
        </div>

        <div style="background:#ffffff;padding:24px;line-height:1.6;">
            <p style="margin-top:0;">Now mark the calendar, set the alarm, and show up — because this Saturday is going to be worth every minute.</p>

            <p>We're kicking off Dystil's very first Free Taster Session for the Career Accelerator Program, and you're one of the 100s who grabbed a spot.</p>

            <table role="presentation" style="width:100%;border-collapse:collapse;background:#f4f7f6;border-left:4px solid #147a59;margin:20px 0;">
                <tr><td style="padding:14px 16px 4px;">\u{1F4C5} <strong>Saturday, 29th August 2026</strong></td></tr>
                <tr><td style="padding:4px 16px;">⏰ <strong>11:00 AM – 1:00 PM UK Time</strong></td></tr>
                <tr><td style="padding:4px 16px 14px;">\u{1F4BB} <strong>Online – Live Session, <a href="${escapeHtml(TASTER_MEETING_URL)}" style="color:#147a59;">Meeting Link here</a>, calendar invite to follow.</strong></td></tr>
            </table>

            <p>You'll get a real look at what the Career Accelerator Program is all about — the skills, the projects, the confidence, and the career edge. Not a sales pitch. An actual session built to give you something useful from minute one.</p>

            <p style="margin-bottom:4px;"><strong>Here's what's coming your way:</strong></p>
            <table role="presentation" style="width:100%;border-collapse:collapse;margin-bottom:20px;">${agenda}
            </table>

            <p>This is our first session ever — and we're building something genuinely exciting. You're part of that from day one.</p>

            <p>We'll see you Saturday at 11:00 AM sharp.</p>

            <p style="margin-bottom:0;">Don't be the one who had a spot and didn't show up. \u{1F609}</p>
        </div>

        <div style="background:#ffffff;padding:20px 24px 24px;border-radius:0 0 12px 12px;line-height:1.6;">
            <p style="margin:0 0 12px;"><strong>The Dystil Team</strong></p>
            <p style="margin:0;font-size:14px;color:#4c5a54;">
                <strong style="color:#16221d;">Frank M</strong><br>
                Executive Partner<br>
                <a href="mailto:askus@dystil.ai" style="color:#147a59;">askus@dystil.ai</a><br>
                <a href="mailto:frank@dystil.ai" style="color:#147a59;">frank@dystil.ai</a><br>
                www.dystil.ai
            </p>
        </div>
    </div>
</body></html>`;
}

function buildTasterFocusedText(firstName) {
    return [
        firstName ? `Hey ${firstName}!` : "Hey!",
        "You registered. Smart move.",
        "",
        "Now mark the calendar, set the alarm, and show up — because this Saturday is going to be worth every minute.",
        "",
        "We're kicking off Dystil's very first Free Taster Session for the Career Accelerator Program, and you're one of the 100s who grabbed a spot.",
        "",
        "\u{1F4C5} Saturday, 29th August 2026",
        "⏰ 11:00 AM – 1:00 PM UK Time",
        "\u{1F4BB} Online – Live Session, Meeting Link here, calendar invite to follow.",
        "",
        TASTER_MEETING_URL,
        "",
        "You'll get a real look at what the Career Accelerator Program is all about — the skills, the projects, the confidence, and the career edge. Not a sales pitch. An actual session built to give you something useful from minute one.",
        "",
        "Here's what's coming your way:",
        ...TASTER_AGENDA.map(([icon, title, detail]) => `${icon} ${title} — ${detail}`),
        "",
        "This is our first session ever — and we're building something genuinely exciting. You're part of that from day one.",
        "",
        "We'll see you Saturday at 11:00 AM sharp.",
        "",
        "Don't be the one who had a spot and didn't show up. \u{1F609}",
        "",
        "The Dystil Team",
        "",
        "Frank M",
        "Executive Partner",
        "askus@dystil.ai",
        "frank@dystil.ai",
        "www.dystil.ai"
    ].join("\n");
}

/* ---------------------------------------------------------------------------
   Microsoft Graph
   ---------------------------------------------------------------------------
   Brevo staples a tracking pixel and a rewritten link onto everything it sends
   and offers no way to stop it on transactional mail. Paired with copy that
   markets a programme, that is enough for Gmail to file the email under
   Promotions, which eleven sends across nine mailboxes have now shown. The same
   copy sent by hand from the same tenant reached Primary, because none of those
   bulk markers were on it.

   So the branded email goes out through Microsoft 365 instead: real links, no
   pixel, and the tenant's own reputation. Brevo still carries the enquiry
   confirmations, which reach Primary already and have no reason to move.
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
function buildTasterConfirmStyleHtml(firstName) {
    const greeting = firstName ? `You’re registered, ${escapeHtml(firstName)}.` : "You’re registered.";

    return `<!doctype html>
        <html><body style="margin:0;background:#f4f7f6;font-family:Arial,sans-serif;color:#16221d;">
            <div style="max-width:620px;margin:0 auto;padding:32px 16px;">
                <div style="background:#123f31;color:#fff;padding:24px;border-radius:12px 12px 0 0;">
                    <h1 style="font-size:24px;margin:0;">${greeting}</h1>
                </div>
                <div style="background:#fff;padding:24px;border-radius:0 0 12px 12px;line-height:1.6;">
                    <p style="margin-top:0;">Your place at the Dystil free taster session is confirmed. Here are the joining details.</p>
                    <p style="background:#f4f7f6;border-left:4px solid #147a59;padding:12px 16px;"><strong>Saturday 29 August 2026</strong><br>11:00 to 13:00 UK time<br>Online, on <a href="${escapeHtml(TASTER_MEETING_URL)}" style="color:#147a59;">Microsoft Teams</a>.</p>
                    <p>The session covers the future of work in your industry, a live demonstration of AI applied to real job roles, a look at the kind of projects you would build, and a question and answer session at the end.</p>
                    <p>A calendar invitation will follow separately.</p>
                    <p>If you can no longer attend, reply to this email and let us know.</p>
                    <p style="margin-bottom:0;">Kind regards,<br><strong>The Dystil Team</strong></p>
                </div>
            </div>
        </body></html>`;
}

function buildTasterConfirmStyleText(firstName) {
    return [
        firstName ? `You’re registered, ${firstName}.` : "You’re registered.",
        "",
        "Your place at the Dystil free taster session is confirmed. Here are the joining details.",
        "",
        "Saturday 29 August 2026",
        "11:00 to 13:00 UK time",
        "Online, on Microsoft Teams: " + TASTER_MEETING_URL,
        "",
        "The session covers the future of work in your industry, a live demonstration of AI applied to real job roles, a look at the kind of projects you would build, and a question and answer session at the end.",
        "",
        "A calendar invitation will follow separately.",
        "",
        "If you can no longer attend, reply to this email and let us know.",
        "",
        "Kind regards,",
        "The Dystil Team"
    ].join("\n");
}

/* ---------------------------------------------------------------------------
   Reminders
   ---------------------------------------------------------------------------
   Built to the same shape as the joining email, which is the shape of the
   registration confirmation: dark header, one panel, plain wording, and the
   meeting as the only link. Each reminder can go out under either name, and
   both share one ledger entry, so choosing Frank and then choosing Dystil
   cannot mail the same person the same reminder twice.
--------------------------------------------------------------------------- */

function buildReminderHtml(reminder, firstName) {
    const heading = firstName
        ? `${reminder.heading}, ${escapeHtml(firstName)}.`
        : `${reminder.heading}.`;

    const closing = reminder.closing
        .map((line) => `<p>${escapeHtml(line)}</p>`)
        .join("\n                    ");

    return `<!doctype html>
        <html><body style="margin:0;background:#f4f7f6;font-family:Arial,sans-serif;color:#16221d;">
            <div style="max-width:620px;margin:0 auto;padding:32px 16px;">
                <div style="background:#123f31;color:#fff;padding:24px;border-radius:12px 12px 0 0;">
                    <h1 style="font-size:24px;margin:0;">${heading}</h1>
                </div>
                <div style="background:#fff;padding:24px;border-radius:0 0 12px 12px;line-height:1.6;">
                    <p style="margin-top:0;">${escapeHtml(reminder.opening)}</p>
                    <p style="background:#f4f7f6;border-left:4px solid #147a59;padding:12px 16px;"><strong>${escapeHtml(reminder.when)}</strong><br>11:00 to 13:00 UK time<br>Online, on <a href="${escapeHtml(TASTER_MEETING_URL)}" style="color:#147a59;">Microsoft Teams</a>.</p>
                    ${closing}
                    <p style="margin-bottom:0;">Kind regards,<br><strong>The Dystil Team</strong></p>
                </div>
            </div>
        </body></html>`;
}

function buildReminderText(reminder, firstName) {
    return [
        firstName ? `${reminder.heading}, ${firstName}.` : `${reminder.heading}.`,
        "",
        reminder.opening,
        "",
        reminder.when,
        "11:00 to 13:00 UK time",
        "Online, on Microsoft Teams: " + TASTER_MEETING_URL,
        "",
        ...reminder.closing.flatMap((line) => [line, ""]),
        "Kind regards,",
        "The Dystil Team"
    ].join("\n");
}

// Three reminders under two names is six campaigns, and writing them out by
// hand would be six chances to change one and forget the other.
function buildReminderCampaigns() {
    const campaigns = {};

    for (const reminder of TASTER_REMINDERS) {
        for (const [who, sender] of Object.entries(TASTER_SENDERS)) {
            campaigns[`taster-2026-08-29-reminder-${reminder.key}-${who}`] = {
                formType: "Free Taster Registration",
                subject: reminder.subject,
                buildHtml: (firstName) => buildReminderHtml(reminder, firstName),
                buildText: (firstName) => buildReminderText(reminder, firstName),
                sender,
                replyTo: sender,
                // Both names share one ledger, so a reminder sent as Frank is
                // not sent again as Dystil.
                dedupeKey: `taster-2026-08-29-reminder-${reminder.key}`,
                testRecipients: TASTER_TEST_TEAM
            };
        }
    }

    return campaigns;
}

/* ---------------------------------------------------------------------------
   Calendar invitation
   ---------------------------------------------------------------------------
   The joining email promised one, and an invitation does the job the email
   cannot: it puts the session in the calendar with a reminder attached, so
   nobody has to find the right email on Saturday morning.

   Sent as a real iCalendar REQUEST rather than a link, so the mailbox treats it
   as a meeting. Every recipient gets the same UID, so this is one event that
   can be updated later rather than a new event per person; bumping SEQUENCE is
   what tells a calendar an update has arrived.
--------------------------------------------------------------------------- */

const INVITE_UID = "dystil-taster-2026-08-29@dystil.ai";
const INVITE_SEQUENCE = 0;
// 11:00 to 13:00 UK time on 29 August 2026. Britain is on BST that day, an
// hour ahead of UTC, so the times are written here as 10:00 and 12:00 UTC.
const INVITE_START_UTC = "20260829T100000Z";
const INVITE_END_UTC = "20260829T120000Z";

// A property must not exceed 75 octets on a line; longer ones continue on the
// next line behind a single space. The meeting URL is far past that on its own.
function foldIcsLine(line) {
    if (line.length <= 74) return line;

    const parts = [line.slice(0, 74)];
    let rest = line.slice(74);

    while (rest.length > 73) {
        parts.push(" " + rest.slice(0, 73));
        rest = rest.slice(73);
    }

    if (rest.length) parts.push(" " + rest);

    return parts.join("\r\n");
}

function escapeIcsText(value) {
    return String(value === null || value === undefined ? "" : value)
        .replace(/\\/g, "\\\\")
        .replace(/;/g, "\\;")
        .replace(/,/g, "\\,")
        .replace(/\r?\n/g, "\\n");
}

function buildTasterInvite(person, organiser, stamp) {
    const lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Dystil//Free Taster Session//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:REQUEST",
        "BEGIN:VEVENT",
        `UID:${INVITE_UID}`,
        `SEQUENCE:${INVITE_SEQUENCE}`,
        `DTSTAMP:${stamp}`,
        `DTSTART:${INVITE_START_UTC}`,
        `DTEND:${INVITE_END_UTC}`,
        "SUMMARY:" + escapeIcsText("Dystil Free Taster Session"),
        "DESCRIPTION:" + escapeIcsText(
            "Your Dystil free taster session.\n\n"
            + "Join on Microsoft Teams:\n" + TASTER_MEETING_URL + "\n\n"
            + "The session runs for two hours and covers the future of work in your industry, "
            + "a live demonstration of AI applied to real job roles, a look at the kind of projects "
            + "you would build, and a question and answer session at the end."
        ),
        "LOCATION:" + escapeIcsText("Online, on Microsoft Teams"),
        "URL:" + TASTER_MEETING_URL,
        `ORGANIZER;CN=${escapeIcsText(organiser.name)}:mailto:${organiser.email}`,
        `ATTENDEE;CN=${escapeIcsText(person.fullName)};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${person.email}`,
        "STATUS:CONFIRMED",
        "TRANSP:OPAQUE",
        "BEGIN:VALARM",
        "TRIGGER:-PT30M",
        "ACTION:DISPLAY",
        "DESCRIPTION:" + escapeIcsText("Dystil Free Taster Session starts in 30 minutes"),
        "END:VALARM",
        "END:VEVENT",
        "END:VCALENDAR"
    ];

    return lines.map(foldIcsLine).join("\r\n") + "\r\n";
}

function buildInviteAttachment(person, organiser) {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const ics = buildTasterInvite(person, organiser, stamp);

    return {
        name: "dystil-taster-session.ics",
        content: bytesToBase64(new TextEncoder().encode(ics))
    };
}

function buildInviteHtml(firstName) {
    const heading = firstName
        ? `Your calendar invitation, ${escapeHtml(firstName)}.`
        : "Your calendar invitation.";

    return `<!doctype html>
        <html><body style="margin:0;background:#f4f7f6;font-family:Arial,sans-serif;color:#16221d;">
            <div style="max-width:620px;margin:0 auto;padding:32px 16px;">
                <div style="background:#123f31;color:#fff;padding:24px;border-radius:12px 12px 0 0;">
                    <h1 style="font-size:24px;margin:0;">${heading}</h1>
                </div>
                <div style="background:#fff;padding:24px;border-radius:0 0 12px 12px;line-height:1.6;">
                    <p style="margin-top:0;">Here is the calendar invitation for your Dystil free taster session, as promised. Accepting it puts the session in your calendar with the joining link and a reminder half an hour before.</p>
                    <p style="background:#f4f7f6;border-left:4px solid #147a59;padding:12px 16px;"><strong>Saturday 29 August 2026</strong><br>11:00 to 13:00 UK time<br>Online, on <a href="${escapeHtml(TASTER_MEETING_URL)}" style="color:#147a59;">Microsoft Teams</a>.</p>
                    <p>If your email does not add it for you, open the attached file and your calendar will pick it up.</p>
                    <p>If you can no longer attend, decline the invitation or reply to this email, so we can offer your place to someone else.</p>
                    <p style="margin-bottom:0;">Kind regards,<br><strong>The Dystil Team</strong></p>
                </div>
            </div>
        </body></html>`;
}

function buildInviteText(firstName) {
    return [
        firstName ? `Your calendar invitation, ${firstName}.` : "Your calendar invitation.",
        "",
        "Here is the calendar invitation for your Dystil free taster session, as promised. Accepting it puts the session in your calendar with the joining link and a reminder half an hour before.",
        "",
        "Saturday 29 August 2026",
        "11:00 to 13:00 UK time",
        "Online, on Microsoft Teams: " + TASTER_MEETING_URL,
        "",
        "If your email does not add it for you, open the attached file and your calendar will pick it up.",
        "",
        "If you can no longer attend, decline the invitation or reply to this email, so we can offer your place to someone else.",
        "",
        "Kind regards,",
        "The Dystil Team"
    ].join("\n");
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
