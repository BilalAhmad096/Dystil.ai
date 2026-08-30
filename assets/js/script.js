/* Show clean URLs when a page is opened through an older .html link */
(function stripHtmlExtension() {
    if (!window.location.protocol.startsWith("http")) return;
    if (!window.location.pathname.endsWith(".html")) return;

    const cleanPath = window.location.pathname
        .replace(/\/index\.html$/, "/")
        .replace(/\.html$/, "");

    window.history.replaceState(null, "", cleanPath + window.location.search + window.location.hash);
})();

/* Cloudflare Web Analytics — cookieless page counts, live domain only */
(function loadWebAnalytics() {
    const host = window.location.hostname;

    if (host !== "dystil.ai" && host !== "www.dystil.ai") return;

    const beacon = document.createElement("script");

    beacon.type = "module";
    beacon.src = "https://static.cloudflareinsights.com/beacon.min.js";
    beacon.setAttribute("data-cf-beacon", '{"token": "9cea9d84df65490881d2fc85d295ee0e"}');

    document.head.appendChild(beacon);
})();

/* Remember how somebody reached the site, so a submission can say whether it
   came from Instagram, a search or a direct visit */
const VISIT_SOURCE_KEY = "dystil-visit-source";
const FIRST_SOURCE_KEY = "dystil-first-source";

(function recordArrival() {
    if (!window.location.protocol.startsWith("http")) return;

    const params = new URLSearchParams(window.location.search);
    const arrival = JSON.stringify({
        referrer: document.referrer || "",
        landing: window.location.pathname,
        tag: params.get("ref") || params.get("utm_source") || "",
        at: new Date().toISOString()
    });

    /* Written once per visit and once ever, so moving between our own pages
       never overwrites the source somebody actually arrived from. */
    rememberOnce(window.sessionStorage, VISIT_SOURCE_KEY, arrival);
    rememberOnce(window.localStorage, FIRST_SOURCE_KEY, arrival);
})();

/* Private browsing refuses storage outright, and an unrecorded source is never
   worth failing a page or a submission over. */
function rememberOnce(store, storageKey, value) {
    try {
        if (!store.getItem(storageKey)) store.setItem(storageKey, value);
    } catch {
        /* Nothing to remember. */
    }
}

function readStoredSource(store, storageKey) {
    try {
        return store.getItem(storageKey) || "";
    } catch {
        return "";
    }
}

function loadComponent(id, file) {
    const element = document.getElementById(id);

    if (!element) return;

    fetch(file)
        .then(function(response) {
            if (!response.ok) {
                throw new Error("File not found: " + file);
            }

            return response.text();
        })
        .then(function(data) {
            element.innerHTML = data;

            setupLinksAndImages();
            setActiveLink();
        })
        .catch(function(error) {
            console.log("Component loading error:", error.message);
        });
}

function setupLinksAndImages() {
    document.querySelectorAll("[data-link]").forEach(function(link) {
        const target = link.getAttribute("data-link");

        if (!target) return;

        link.href = target;
    });

    document.querySelectorAll("[data-src]").forEach(function(image) {
        const target = image.getAttribute("data-src");

        if (!target) return;

        image.src = target;
        image.style.cursor = "pointer";

        image.addEventListener("click", function() {
            window.location.href = "/";
        });
    });
}

/* Compare whole paths, since /corporate/home and /students/home share a last segment */
function normalisePath(pathname) {
    const path = pathname.replace(/\/index\.html$/, "/").replace(/\.html$/, "");

    return path === "" ? "/" : path;
}

function setActiveLink() {
    const currentPath = normalisePath(window.location.pathname);

    document.querySelectorAll(".navbar a").forEach(function(link) {
        link.classList.remove("active");

        const href = link.getAttribute("href");

        if (!href) return;

        const linkPath = normalisePath(new URL(href, window.location.origin).pathname);

        if (currentPath === linkPath) {
            link.classList.add("active");
        }
    });
}

function loadMainLayout() {
    loadComponent("header", "/components/main-header.html");
    loadComponent("footer", "/components/main-footer.html");
}

function loadStudentLayout() {
    loadComponent("header", "/components/student-header.html");
    loadComponent("footer", "/components/student-footer.html");
}

function loadCorporateLayout() {
    loadComponent("header", "/components/corporate-header.html");
    loadComponent("footer", "/components/corporate-footer.html");
}

/* Student bootcamp detail toggle */
document.addEventListener("click", function(e) {
    const button = e.target.closest(".choice-link");

    if (!button) return;

    const card = button.closest(".bootcamp-choice");

    if (!card) return;

    const selected = card.getAttribute("data-bootcamp");
    const targetDetail = document.getElementById(selected + "-detail");

    if (!targetDetail) return;

    document.querySelectorAll(".bootcamp-choice").forEach(function(item) {
        item.classList.remove("active");
    });

    document.querySelectorAll(".bootcamp-detail").forEach(function(detail) {
        detail.classList.remove("active");
    });

    card.classList.add("active");
    targetDetail.classList.add("active");

    targetDetail.scrollIntoView({
        behavior: "smooth",
        block: "start"
    });
});

/* Corporate FAQ accordion */
document.addEventListener("click", function(e) {
    const question = e.target.closest(".faq-question");

    if (!question) return;

    const clickedItem = question.closest(".faq-item");
    const isAlreadyOpen = clickedItem.classList.contains("active");

    document.querySelectorAll(".faq-item").forEach(function(item) {
        item.classList.remove("active");
    });

    if (!isAlreadyOpen) {
        clickedItem.classList.add("active");
    }
});

/* Website enquiry forms */
function setupEnquiryForms() {
    document.querySelectorAll("[data-enquiry-form]").forEach(function(form) {
        if (form.dataset.enquiryReady === "true") return;

        form.dataset.enquiryReady = "true";
        form.addEventListener("submit", submitEnquiryForm);
    });
}

async function submitEnquiryForm(event) {
    event.preventDefault();

    const form = event.currentTarget;
    const status = form.querySelector(".form-status");
    const submitButton = form.querySelector('button[type="submit"]');
    const endpoint = window.DYSTIL_FORM_ENDPOINT || "";
    const cv = form.querySelector('input[name="cv"]')?.files[0];

    if (!endpoint || endpoint.includes("YOUR-WORKERS-SUBDOMAIN")) {
        showFormStatus(status, "error", "This form is not connected yet. Please email askus@dystil.ai.");
        return;
    }

    if (cv && cv.size > 4 * 1024 * 1024) {
        showFormStatus(status, "error", "Please upload a CV that is 4 MB or smaller.");
        return;
    }

    const originalButtonText = submitButton.textContent;
    const controller = new AbortController();
    const timeout = window.setTimeout(function() {
        controller.abort();
    }, 30000);

    submitButton.disabled = true;
    submitButton.textContent = "Sending…";
    showFormStatus(status, "", "Sending your details securely…");

    try {
        const formData = new FormData(form);
        formData.set("formType", form.dataset.formType || "Website Enquiry");
        formData.set("sourceFirst", readStoredSource(window.localStorage, FIRST_SOURCE_KEY));
        formData.set("sourceVisit", readStoredSource(window.sessionStorage, VISIT_SOURCE_KEY));

        const response = await fetch(endpoint, {
            method: "POST",
            body: formData,
            signal: controller.signal
        });

        let result = {};
        try {
            result = await response.json();
        } catch {
            result = {};
        }

        if (!response.ok || !result.success) {
            throw new Error(result.message || "We could not send your details. Please try again.");
        }

        form.reset();
        showFormStatus(status, "success", result.message || "Thanks — your details have been sent.");

        // A registration that owes a fee comes back with a Stripe payment page
        // to go to. The details are already saved and emailed by this point, so
        // leaving the page loses nothing if somebody changes their mind.
        if (result.paymentUrl) {
            showFormStatus(status, "success", (result.message || "") + " Taking you to the payment page…");
            window.location.assign(result.paymentUrl);
            return;
        }
    } catch (error) {
        const message = error.name === "AbortError"
            ? "The request took too long. Please try again or email askus@dystil.ai."
            : error.message;

        showFormStatus(status, "error", message || "We could not send your details. Please email askus@dystil.ai.");
    } finally {
        window.clearTimeout(timeout);
        submitButton.disabled = false;
        submitButton.textContent = originalButtonText;
    }
}

function showFormStatus(element, type, message) {
    if (!element) return;

    element.classList.remove("form-status-success", "form-status-error");
    if (type === "success") element.classList.add("form-status-success");
    if (type === "error") element.classList.add("form-status-error");
    element.textContent = message;
}

setupEnquiryForms();
