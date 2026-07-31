(function () {
    function closeMobileMenu() {
        document.body.classList.remove("mobile-menu-open");

        document.querySelectorAll(".mobile-menu-toggle").forEach(function (button) {
            button.classList.remove("active");
        });

        document.querySelectorAll(".mobile-menu-panel").forEach(function (panel) {
            panel.classList.remove("active");
        });

        document.querySelectorAll(".mobile-menu-backdrop").forEach(function (backdrop) {
            backdrop.classList.remove("active");
        });
    }

    function setupMobileMenu() {
        const header = document.querySelector(".site-header");

        if (!header) return;

        const navbar = header.querySelector(".navbar");
        const ctaButton = header.querySelector(".get-started-btn");

        if (!navbar) return;

        if (header.dataset.mobileMenuReady === "true") return;

        header.dataset.mobileMenuReady = "true";

        const toggleButton = document.createElement("button");
        toggleButton.className = "mobile-menu-toggle";
        toggleButton.type = "button";
        toggleButton.setAttribute("aria-label", "Open mobile menu");

        toggleButton.innerHTML = `
            <span></span>
            <span></span>
            <span></span>
        `;

        const backdrop = document.createElement("div");
        backdrop.className = "mobile-menu-backdrop";

        const mobilePanel = document.createElement("div");
        mobilePanel.className = "mobile-menu-panel";

        const clonedNavbar = navbar.cloneNode(true);
        mobilePanel.appendChild(clonedNavbar);

        if (ctaButton) {
            const clonedCta = ctaButton.cloneNode(true);
            mobilePanel.appendChild(clonedCta);
        }

        header.appendChild(toggleButton);
        document.body.appendChild(backdrop);
        document.body.appendChild(mobilePanel);

        toggleButton.addEventListener("click", function (event) {
            event.preventDefault();
            event.stopPropagation();

            toggleButton.classList.toggle("active");
            backdrop.classList.toggle("active");
            mobilePanel.classList.toggle("active");
            document.body.classList.toggle("mobile-menu-open");
        });

        backdrop.addEventListener("click", function () {
            closeMobileMenu();
        });

        mobilePanel.querySelectorAll("a").forEach(function (link) {
            link.addEventListener("click", function () {
                closeMobileMenu();
            });
        });

        document.addEventListener("keydown", function (event) {
            if (event.key === "Escape") {
                closeMobileMenu();
            }
        });
    }

    document.addEventListener("DOMContentLoaded", function () {
        setupMobileMenu();

        const observer = new MutationObserver(function () {
            setupMobileMenu();
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
    });
})();