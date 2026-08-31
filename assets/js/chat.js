/* The Dystil AI Advisor.
 *
 * A launcher in the corner of every page, and a panel that answers questions
 * about Dystil. The OpenAI key lives in the Cloudflare Worker, never here, so
 * this file asks the Worker and the Worker asks OpenAI.
 *
 * The site is a set of separate pages rather than an app, so the conversation
 * is kept in sessionStorage: somebody who asks about the bootcamps on one page
 * and follows a link still has their chat when the next page loads. It is the
 * browser's own tab storage, cleared when the tab closes, and nothing anybody
 * types is recorded by Dystil unless they choose to send an enquiry.
 */

(function startAdvisor() {
    "use strict";

    const ICON_CHAT = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.5 9.5 0 0 1-3.4-.6L3 21l1.8-5a8.2 8.2 0 0 1-.8-3.5 8.4 8.4 0 0 1 8.5-8.4 8.4 8.4 0 0 1 8.5 8.4Z"/></svg>';

    const ICON_SPARK = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M12 2.5l1.9 5.3 5.3 1.9-5.3 1.9L12 17l-1.9-5.4-5.3-1.9 5.3-1.9L12 2.5Z"/><path d="M18.5 15l.9 2.4 2.4.9-2.4.9-.9 2.4-.9-2.4-2.4-.9 2.4-.9.9-2.4Z"/></svg>';

    const ICON_CLOSE = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

    const ICON_SEND = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12h14M12 5l7 7-7 7"/></svg>';

    const WORKER = "https://dystil-contact.dystil-ai.workers.dev";
    const CHAT_ENDPOINT = window.DYSTIL_CHAT_ENDPOINT || WORKER + "/api/chat";
    const ENQUIRY_ENDPOINT = window.DYSTIL_FORM_ENDPOINT || WORKER + "/api/enquiry";

    const STORAGE_KEY = "dystil-advisor";
    const STORED_TURNS = 24;
    const MESSAGE_LIMIT = 1500;

    /* The submissions view is a private admin page; an assistant offering to
       sell somebody a bootcamp has no business on it. */
    const CLOSED_PAGES = ["/students/database"];

    const path = normalisePath(window.location.pathname);

    if (CLOSED_PAGES.includes(path)) return;

    const audience = path.indexOf("/corporate") === 0
        ? "corporate"
        : path.indexOf("/students") === 0 ? "student" : "general";

    /* What the advisor opens with, and the choices offered underneath, follow
       the half of the site the visitor is already reading. */
    const OPENINGS = {
        corporate: "Hi — I'm the Dystil AI Advisor. I can help you work out what AI training would actually move things for your team, and what it would look like. What brings you here?",
        student: "Hi — I'm the Dystil AI Advisor. I can help you find the Dystil programme that fits where you are right now. What are you looking for?",
        general: "Hi — I'm the Dystil AI Advisor. I can point you to the right part of Dystil, whether that's for you, your team or a student programme. What brings you here?"
    };

    const STARTERS = {
        corporate: [
            "🏢 Upskill my team",
            "📊 AI for our finance team",
            "🤖 How does DystilX work?",
            "📅 Speak to the Dystil team"
        ],
        student: [
            "🎓 Which bootcamp suits me?",
            "📘 What's in the Foundation Bootcamp?",
            "✨ Is there a free taster session?",
            "💷 What does it cost?"
        ],
        general: [
            "🏢 Upskill my team",
            "🎓 Explore student programmes",
            "🤖 What does Dystil do?",
            "📅 Speak to the Dystil team"
        ]
    };

    /* The advisor closes a reply with [[LEAD:corporate]] or [[LEAD:student]]
       when it wants an enquiry form to open. The marker is never shown, and the
       second pattern catches one that is still half-written mid-stream. */
    const MARKER = /\[\[LEAD:(corporate|student)\]\]/i;
    const MARKER_ANY = /\[\[LEAD:[a-z]*\]\]/gi;
    const MARKER_PARTIAL = /\[\[?(L(E(A(D(:[a-z]*)?)?)?)?)?$/i;

    const LEAD_FORMS = {
        corporate: {
            formType: "Corporate Enquiry",
            title: "Send this to the Dystil team",
            note: "Your chat so far is included, so the team already has the context when they reply.",
            fields: [
                { name: "fullName", label: "Full name", required: true },
                { name: "email", label: "Work email", type: "email", required: true },
                { name: "company", label: "Company", required: true },
                { name: "focusArea", label: "Team or focus area", required: true, placeholder: "Finance, marketing, whole organisation…" }
            ],
            transcriptField: "challenge"
        },
        student: {
            formType: "Student Enquiry",
            title: "Send this to the Dystil team",
            note: "Your chat so far is included, so the team already has the context when they reply.",
            fields: [
                { name: "fullName", label: "Full name", required: true },
                { name: "email", label: "Email", type: "email", required: true },
                { name: "phone", label: "Phone", required: true },
                { name: "interest", label: "What you're interested in", required: true, placeholder: "Foundation Bootcamp, taster session…" }
            ],
            transcriptField: "message"
        }
    };

    const state = {
        open: false,
        busy: false,
        messages: [],
        leadSent: false
    };

    let panel;
    let launcher;
    let log;
    let starterRow;
    let input;
    let sendButton;

    restore();
    build();

    /* ------------------------------------------------------------------
       Building the widget
    ------------------------------------------------------------------ */

    function build() {
        launcher = element("button", "advisor-launcher");
        launcher.type = "button";
        launcher.setAttribute("aria-label", "Open the Dystil AI Advisor");
        launcher.innerHTML = ICON_CHAT + '<span class="advisor-launcher-text">Ask Dystil</span>';
        launcher.addEventListener("click", toggle);

        panel = element("div", "advisor-panel");
        panel.setAttribute("role", "dialog");
        panel.setAttribute("aria-label", "Dystil AI Advisor");
        panel.hidden = true;
        panel.innerHTML = [
            '<div class="advisor-head">',
            '<span class="advisor-avatar" aria-hidden="true">' + ICON_SPARK + "</span>",
            '<span class="advisor-titles"><strong>Dystil AI Advisor</strong><span>Practical AI training, for teams and students</span></span>',
            '<button type="button" class="advisor-close" aria-label="Close the advisor">' + ICON_CLOSE + "</button>",
            "</div>",
            '<div class="advisor-log" role="log" aria-live="polite" aria-relevant="additions text"></div>',
            '<div class="advisor-starters"></div>',
            '<form class="advisor-composer" novalidate>',
            '<textarea rows="1" maxlength="' + MESSAGE_LIMIT + '" placeholder="Ask about Dystil…" aria-label="Your message"></textarea>',
            '<button type="submit" class="advisor-send" aria-label="Send message">' + ICON_SEND + "</button>",
            "</form>",
            '<p class="advisor-foot">An AI assistant, so check anything important. <a href="/privacy">Privacy</a></p>'
        ].join("");

        log = panel.querySelector(".advisor-log");
        starterRow = panel.querySelector(".advisor-starters");
        input = panel.querySelector("textarea");
        sendButton = panel.querySelector(".advisor-send");

        panel.querySelector(".advisor-close").addEventListener("click", close);
        panel.querySelector(".advisor-composer").addEventListener("submit", onSubmit);

        input.addEventListener("input", growInput);
        input.addEventListener("keydown", function(event) {
            if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                onSubmit(event);
            }
        });

        document.addEventListener("keydown", function(event) {
            if (event.key === "Escape" && state.open) close();
        });

        document.body.appendChild(launcher);
        document.body.appendChild(panel);

        if (!state.messages.length) {
            state.messages.push({ role: "assistant", content: OPENINGS[audience] });
        }

        state.messages.forEach(function(message) {
            addBubble(message.role, message.content);
        });

        drawStarters();

        if (state.open) open();
    }

    function drawStarters() {
        starterRow.innerHTML = "";

        // Once somebody has said something of their own, the suggestions have
        // done their job and only take up room.
        const asked = state.messages.some(function(message) {
            return message.role === "user";
        });

        if (asked) {
            starterRow.hidden = true;
            return;
        }

        starterRow.hidden = false;

        STARTERS[audience].forEach(function(label) {
            const chip = element("button", "advisor-chip");
            chip.type = "button";
            chip.textContent = label;
            chip.addEventListener("click", function() {
                send(label.replace(/^[^\w]+/, "").trim());
            });
            starterRow.appendChild(chip);
        });
    }

    /* ------------------------------------------------------------------
       Opening and closing
    ------------------------------------------------------------------ */

    function toggle() {
        if (state.open) close();
        else open();
    }

    function open() {
        state.open = true;
        panel.hidden = false;
        launcher.classList.add("advisor-launcher-open");
        launcher.setAttribute("aria-label", "Close the Dystil AI Advisor");

        // The panel has to be visible before it can be scrolled or focused.
        window.requestAnimationFrame(function() {
            panel.classList.add("advisor-panel-open");
            scrollLog();
            if (window.innerWidth > 700) input.focus();
        });

        remember();
    }

    function close() {
        state.open = false;
        panel.classList.remove("advisor-panel-open");
        launcher.classList.remove("advisor-launcher-open");
        launcher.setAttribute("aria-label", "Open the Dystil AI Advisor");

        window.setTimeout(function() {
            if (!state.open) panel.hidden = true;
        }, 200);

        remember();
    }

    /* ------------------------------------------------------------------
       Sending and answering
    ------------------------------------------------------------------ */

    function onSubmit(event) {
        event.preventDefault();
        send(input.value);
    }

    async function send(text) {
        const message = String(text || "").trim().slice(0, MESSAGE_LIMIT);

        if (!message || state.busy) return;

        input.value = "";
        growInput();

        state.messages.push({ role: "user", content: message });
        addBubble("user", message);
        drawStarters();
        setBusy(true);

        const thinking = addThinking();
        let bubble = null;
        let answer = "";

        try {
            let response;

            // A dropped connection throws a browser message nobody can act on,
            // so it is turned into one that says what to do instead.
            try {
                response = await fetch(CHAT_ENDPOINT, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        messages: state.messages.slice(-STORED_TURNS),
                        page: { path: path, title: document.title }
                    })
                });
            } catch {
                throw new Error("I could not be reached just then. Please check your connection and try again, or email askus@dystil.ai.");
            }

            if (!response.ok || !response.body) {
                const refusal = new Error(await refusalMessage(response));

                // The advisor not being switched on yet is news, not a fault,
                // so it is spoken rather than shown in red.
                refusal.spoken = response.status === 503;

                throw refusal;
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();

            for (;;) {
                const chunk = await reader.read();

                if (chunk.done) break;

                answer += decoder.decode(chunk.value, { stream: true });

                if (!bubble) {
                    thinking.remove();
                    bubble = addBubble("assistant", "");
                }

                bubble.innerHTML = renderMarkdown(visibleText(answer));
                scrollLog();
            }

            if (!answer.trim()) throw new Error("The advisor had nothing to say. Please try again.");
        } catch (error) {
            thinking.remove();
            if (bubble) bubble.remove();
            addBubble(
                error.spoken ? "assistant" : "error",
                error.message || "Something went wrong. Please email askus@dystil.ai."
            );
            setBusy(false);
            return;
        }

        const spoken = visibleText(answer);

        if (bubble) bubble.innerHTML = renderMarkdown(spoken);
        state.messages.push({ role: "assistant", content: spoken });

        const wanted = answer.match(MARKER);

        if (wanted && !state.leadSent) addLeadForm(wanted[1].toLowerCase());

        setBusy(false);
        remember();
        scrollLog();
    }

    async function refusalMessage(response) {
        try {
            const body = await response.json();
            if (body && body.message) return body.message;
        } catch {
            /* An error page rather than JSON. */
        }

        return "The advisor is unavailable right now. Please try again shortly, or email askus@dystil.ai.";
    }

    function setBusy(busy) {
        state.busy = busy;
        sendButton.disabled = busy;
        input.disabled = busy;

        if (!busy && state.open && window.innerWidth > 700) input.focus();
    }

    /* ------------------------------------------------------------------
       The enquiry form the advisor can open
    ------------------------------------------------------------------ */

    function addLeadForm(kind) {
        const shape = LEAD_FORMS[kind];

        if (!shape) return;

        state.leadSent = true;

        const card = element("div", "advisor-lead");
        const form = element("form", "advisor-lead-form");

        form.noValidate = true;
        form.innerHTML = "<h4>" + shape.title + "</h4>";

        shape.fields.forEach(function(field) {
            const id = "advisor-" + field.name;
            const label = element("label", "");

            label.setAttribute("for", id);
            label.textContent = field.label;

            const box = element("input", "");
            box.id = id;
            box.name = field.name;
            box.type = field.type || "text";
            box.required = Boolean(field.required);
            box.autocomplete = autoCompleteFor(field.name);
            if (field.placeholder) box.placeholder = field.placeholder;

            form.appendChild(label);
            form.appendChild(box);
        });

        const status = element("p", "advisor-lead-status");
        const submit = element("button", "advisor-lead-send");

        submit.type = "submit";
        submit.textContent = "Send to the team";

        const note = element("p", "advisor-lead-note");
        note.textContent = shape.note;

        form.appendChild(submit);
        form.appendChild(note);
        form.appendChild(status);
        card.appendChild(form);
        log.appendChild(card);
        scrollLog();

        form.addEventListener("submit", function(event) {
            event.preventDefault();
            sendLead(shape, form, submit, status);
        });
    }

    async function sendLead(shape, form, submit, status) {
        const missing = shape.fields.find(function(field) {
            return field.required && !form.elements[field.name].value.trim();
        });

        if (missing) {
            status.className = "advisor-lead-status advisor-lead-error";
            status.textContent = "Please fill in " + missing.label.toLowerCase() + ".";
            return;
        }

        submit.disabled = true;
        submit.textContent = "Sending…";
        status.className = "advisor-lead-status";
        status.textContent = "";

        const body = new FormData();

        body.set("formType", shape.formType);
        shape.fields.forEach(function(field) {
            body.set(field.name, form.elements[field.name].value.trim());
        });
        body.set(shape.transcriptField, transcript());
        body.set("sourceFirst", storedSource("localStorage", "dystil-first-source"));
        body.set("sourceVisit", storedSource("sessionStorage", "dystil-visit-source"));

        try {
            const response = await fetch(ENQUIRY_ENDPOINT, { method: "POST", body: body });
            const result = await response.json();

            if (!response.ok || !result.success) {
                throw new Error(result.message || "We could not send your details. Please try again.");
            }

            form.replaceWith(sentCard(result.reference));
        } catch (error) {
            submit.disabled = false;
            submit.textContent = "Send to the team";
            status.className = "advisor-lead-status advisor-lead-error";
            status.textContent = error.message;
            state.leadSent = false;
        }

        scrollLog();
    }

    function sentCard(reference) {
        const done = element("div", "advisor-lead-done");

        done.innerHTML = "<strong>Sent.</strong> The Dystil team will come back to you by email"
            + (reference ? ", quoting " + escapeHtml(reference) : "")
            + ". Anything else I can help with in the meantime?";

        return done;
    }

    // Enough of the conversation for whoever replies to know what was already
    // discussed, so nobody has to ask the same questions again.
    function transcript() {
        const lines = state.messages.map(function(message) {
            return (message.role === "user" ? "Visitor: " : "Advisor: ") + message.content;
        });

        return "Sent from the Dystil AI Advisor chat.\n\n" + lines.join("\n\n");
    }

    function autoCompleteFor(name) {
        if (name === "fullName") return "name";
        if (name === "email") return "email";
        if (name === "phone") return "tel";
        if (name === "company") return "organization";

        return "off";
    }

    /* ------------------------------------------------------------------
       Drawing messages
    ------------------------------------------------------------------ */

    function addBubble(role, text) {
        const row = element("div", "advisor-row advisor-row-" + role);
        const bubble = element("div", "advisor-bubble advisor-bubble-" + role);

        bubble.innerHTML = role === "assistant" ? renderMarkdown(text) : "<p>" + escapeHtml(text) + "</p>";

        row.appendChild(bubble);
        log.appendChild(row);
        scrollLog();

        return bubble;
    }

    function addThinking() {
        const row = element("div", "advisor-row advisor-row-assistant");

        row.innerHTML = '<div class="advisor-bubble advisor-bubble-assistant advisor-thinking">'
            + "<span></span><span></span><span></span></div>";

        log.appendChild(row);
        scrollLog();

        return row;
    }

    function scrollLog() {
        log.scrollTop = log.scrollHeight;
    }

    function growInput() {
        input.style.height = "auto";
        input.style.height = Math.min(input.scrollHeight, 120) + "px";
    }

    /* ------------------------------------------------------------------
       Text handling
    ------------------------------------------------------------------ */

    // The lead marker is an instruction to this widget, not something to read,
    // so it never reaches the page — including the half of one that has arrived
    // while the rest of the reply is still streaming.
    function visibleText(raw) {
        return raw.replace(MARKER_ANY, "").replace(MARKER_PARTIAL, "").trimEnd();
    }

    function renderMarkdown(text) {
        const lines = escapeHtml(text).split("\n");

        let html = "";
        let paragraph = [];
        let inList = false;

        function flushParagraph() {
            if (!paragraph.length) return;

            html += "<p>" + inlineMarkdown(paragraph.join("<br>")) + "</p>";
            paragraph = [];
        }

        function closeList() {
            if (!inList) return;

            html += "</ul>";
            inList = false;
        }

        lines.forEach(function(line) {
            const bullet = line.match(/^\s*[-*•]\s+(.*)$/) || line.match(/^\s*\d+[.)]\s+(.*)$/);

            if (bullet) {
                flushParagraph();

                if (!inList) {
                    html += "<ul>";
                    inList = true;
                }

                html += "<li>" + inlineMarkdown(bullet[1]) + "</li>";
                return;
            }

            closeList();

            if (!line.trim()) {
                flushParagraph();
                return;
            }

            paragraph.push(line.trim());
        });

        closeList();
        flushParagraph();

        return html;
    }

    function inlineMarkdown(text) {
        return text
            .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
            .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function(whole, label, href) {
                const target = safeHref(href);

                return target ? '<a href="' + target + '">' + label + "</a>" : label;
            });
    }

    // Only Dystil's own pages and mailbox. A model that invents a link, or is
    // talked into writing one, cannot turn the advisor into a way of sending
    // visitors somewhere else.
    function safeHref(href) {
        if (/^\/(?!\/)[\w\-/#?=&.]*$/.test(href)) return href;
        if (/^https:\/\/(www\.)?dystil\.ai(\/[\w\-/#?=&.]*)?$/.test(href)) return href;
        if (/^mailto:[\w.\-]+@dystil\.ai$/.test(href)) return href;

        return "";
    }

    function escapeHtml(value) {
        return String(value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    /* ------------------------------------------------------------------
       Remembering the conversation across pages
    ------------------------------------------------------------------ */

    function remember() {
        try {
            window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
                open: state.open,
                leadSent: state.leadSent,
                messages: state.messages.slice(-STORED_TURNS)
            }));
        } catch {
            /* Private browsing refuses storage, and a forgotten chat is not
               worth failing a page over. */
        }
    }

    function restore() {
        let saved;

        try {
            saved = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) || "null");
        } catch {
            return;
        }

        if (!saved || !Array.isArray(saved.messages)) return;

        state.open = Boolean(saved.open);
        state.leadSent = Boolean(saved.leadSent);
        state.messages = saved.messages.filter(function(message) {
            return message
                && (message.role === "user" || message.role === "assistant")
                && typeof message.content === "string";
        });
    }

    function normalisePath(pathname) {
        const clean = pathname.replace(/\/index\.html$/, "/").replace(/\.html$/, "");

        return clean === "" ? "/" : clean;
    }

    function storedSource(store, key) {
        try {
            return window[store].getItem(key) || "";
        } catch {
            return "";
        }
    }

    function element(tag, className) {
        const node = document.createElement(tag);

        if (className) node.className = className;

        return node;
    }

})();
