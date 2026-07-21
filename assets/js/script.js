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