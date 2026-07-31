function setupMobileMenu() {
    const header = document.querySelector(".site-header");

    if (!header) return;

    if (header.querySelector(".mobile-menu-toggle")) return;

    const toggleButton = document.createElement("button");
    toggleButton.className = "mobile-menu-toggle";
    toggleButton.setAttribute("aria-label", "Open mobile menu");
    toggleButton.innerHTML = `
        <span></span>
        <span></span>
        <span></span>
    `;

    const overlay = document.createElement("div");
    overlay.className = "mobile-menu-overlay";

    header.appendChild(toggleButton);
    document.body.appendChild(overlay);

    toggleButton.addEventListener("click", function() {
        document.body.classList.toggle("mobile-menu-open");
        header.classList.toggle("mobile-menu-active");
    });

    overlay.addEventListener("click", function() {
        document.body.classList.remove("mobile-menu-open");
        header.classList.remove("mobile-menu-active");
    });

    document.querySelectorAll(".navbar a, .get-started-btn").forEach(function(link) {
        link.addEventListener("click", function() {
            document.body.classList.remove("mobile-menu-open");
            header.classList.remove("mobile-menu-active");
        });
    });
}

document.addEventListener("DOMContentLoaded", function() {
    setupMobileMenu();

    const observer = new MutationObserver(function() {
        setupMobileMenu();
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true
    });
});