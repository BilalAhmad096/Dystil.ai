const isPageFolder = window.location.pathname.includes("/pages/");
const basePath = isPageFolder ? "../" : "";

function loadComponent(id, file) {
    const element = document.getElementById(id);

    if (!element) return;

    fetch(basePath + file)
        .then(function(response) {
            if (!response.ok) {
                throw new Error("File not found: " + basePath + file);
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

        link.href = basePath + target;
    });

    document.querySelectorAll("[data-src]").forEach(function(image) {
        const target = image.getAttribute("data-src");

        if (!target) return;

        image.src = basePath + target;
        image.style.cursor = "pointer";

        image.addEventListener("click", function() {
            window.location.href = basePath + "index.html";
        });
    });
}

function setActiveLink() {
    const currentPage = window.location.pathname.split("/").pop();

    document.querySelectorAll(".navbar a").forEach(function(link) {
        link.classList.remove("active");

        const href = link.getAttribute("href");

        if (!href) return;

        const cleanHref = href.split("#")[0];
        const linkPage = cleanHref.split("/").pop();

        if (currentPage === linkPage) {
            link.classList.add("active");
        }
    });
}

function loadMainLayout() {
    loadComponent("header", "components/main-header.html");
    loadComponent("footer", "components/main-footer.html");
}

function loadStudentLayout() {
    loadComponent("header", "components/student-header.html");
    loadComponent("footer", "components/student-footer.html");
}

function loadCorporateLayout() {
    loadComponent("header", "components/corporate-header.html");
    loadComponent("footer", "components/corporate-footer.html");
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
