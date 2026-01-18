(function () {
  if (window.__AUREA_WIDGET_LOADED__) return;
  window.__AUREA_WIDGET_LOADED__ = true;

  // bump version
  window.__AUREA_WIDGET_VERSION__ = "0.2.3";
  console.log(`[Aurea Widget] loaded v${window.__AUREA_WIDGET_VERSION__}`);

  const CONFIG = window.AUREA_CONFIG || {};
  const CLIENT_ID = (CONFIG.clientId || "").trim();

  const MODE = "floating"; // locked
  
  if (!CLIENT_ID) {
    console.error("[Aurea Widget] Missing window.AUREA_CONFIG.clientId — widget will not start.");
    return;
  }
  
  const BUSINESS_NAME = CONFIG.businessName || "Support";
  const GREETING = CONFIG.greeting || "Hi — how can I help?";

  let __aurea_sitewide_cache = null;
  let __aurea_sitewide_cache_at = 0;

  // -----------------------------
  // Site context (Phase 1 v1)
  // -----------------------------
  function getSiteContextV1() {
    try {
      const origin = window.location.origin;

      const title = document.title || "";
      const metaDesc =
        document.querySelector('meta[name="description"]')?.getAttribute("content") || "";

      const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
        .slice(0, 30)
        .map((el) => (el.textContent || "").trim())
        .filter(Boolean);

      const navRoot =
        document.querySelector("nav") ||
        document.querySelector("header") ||
        document.body;

      const navLinks = Array.from(navRoot.querySelectorAll("a"))
        .slice(0, 30)
        .map((a) => ({
          text: (a.textContent || "").trim().slice(0, 80),
          href: (a.getAttribute("href") || "").trim().slice(0, 300),
        }))
        .filter((l) => l.text && l.href);

      const jsonLd = Array.from(
        document.querySelectorAll('script[type="application/ld+json"]')
      )
        .slice(0, 5)
        .map((s) => (s.textContent || "").trim())
        .filter(Boolean);

      const main =
        document.querySelector("main") ||
        document.querySelector("[role='main']") ||
        document.body;

      const rawText = (main.innerText || "").replace(/\s+/g, " ").trim();
      const textSample = rawText.slice(0, 2500);

      return {
        origin,
        url: window.location.href,
        title,
        metaDesc,
        headings,
        navLinks,
        jsonLd,
        textSample,
        collectedAt: new Date().toISOString(),
        v: 1,
      };
    } catch {
      return {
        origin: window.location.origin,
        url: window.location.href,
        collectedAt: new Date().toISOString(),
        v: 1,
        error: "context_collection_failed",
      };
    }
  }

  // --- Site-wide context (v2) ---
// Keep v1 exactly as-is. v2 uses v1 + fetches a few key internal pages.

function normalizeUrl(href) {
  try {
    return new URL(href, window.location.href);
  } catch {
    return null;
  }
}

function isFetchableInternalUrl(urlObj) {
  if (!urlObj) return false;

  // Must be same website (same origin)
  if (urlObj.origin !== window.location.origin) return false;

  // Skip hashes, mailto, tel, javascript, files we don't want
  const href = urlObj.href;
  if (href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("javascript:")) return false;
  if (urlObj.pathname.match(/\.(pdf|jpg|jpeg|png|gif|webp|svg|zip|mp4|mp3)$/i)) return false;

  return true;
}

function scoreLink(urlObj, text) {
  const t = (text || "").toLowerCase();
  const p = (urlObj?.pathname || "").toLowerCase();

  const hay = `${t} ${p}`;

  // These are the pages that usually contain the "business facts"
  const keywords = [
    "pricing", "price", "rates", "packages",
    "services", "service",
    "book", "booking", "appointments", "schedule",
    "contact", "about",
    "faq", "policies", "policy",
    "hours", "location"
  ];

  let score = 0;
  for (const k of keywords) {
    if (hay.includes(k)) score += 10;
  }

  // Prefer shorter paths (usually more important)
  score += Math.max(0, 10 - p.split("/").filter(Boolean).length);

  return score;
}

function extractPageTextFromDocument(doc) {
  const title = doc.title || "";
  const metaDesc =
    doc.querySelector('meta[name="description"]')?.getAttribute("content") || "";

  const headings = Array.from(doc.querySelectorAll("h1, h2, h3"))
    .slice(0, 30)
    .map((el) => (el.textContent || "").trim())
    .filter(Boolean);

  const main =
    doc.querySelector("main") ||
    doc.querySelector("[role='main']") ||
    doc.body;

  const rawText = (main?.innerText || "").replace(/\s+/g, " ").trim();
  const textSample = rawText.slice(0, 2000); // keep each fetched page small

  return { title, metaDesc, headings, textSample };
}

async function fetchInternalPageContext(url, timeoutMs = 2500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "GET",
      credentials: "include",
      signal: controller.signal,
      headers: {
        // Helps some servers return normal HTML
        "Accept": "text/html,application/xhtml+xml"
      }
    });

    if (!res.ok) return null;

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) return null;

    const html = await res.text();

    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");

    const extracted = extractPageTextFromDocument(doc);

    return {
      url,
      ...extracted
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
  
async function getSiteContextV2() {
  // Start with the current page snapshot (your existing working logic)
  const base = getSiteContextV1();

  try {
    const MAX_PAGES = 8;

    // Collect candidates from navLinks + also any obvious footer links if available
    const candidates = [];

    // From v1 navLinks
    for (const l of base.navLinks || []) {
      const urlObj = normalizeUrl(l.href);
      if (!isFetchableInternalUrl(urlObj)) continue;
      candidates.push({ urlObj, text: l.text || "" });
    }

    // Sort by importance (pricing/services/book/contact/etc)
    candidates.sort((a, b) => scoreLink(b.urlObj, b.text) - scoreLink(a.urlObj, a.text));

    // Deduplicate by pathname
    const seen = new Set();
    const picked = [];
    for (const c of candidates) {
      const key = c.urlObj.pathname.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      // Skip the current page (we already have it)
      if (c.urlObj.href === window.location.href) continue;

      picked.push(c.urlObj.href);
      if (picked.length >= MAX_PAGES) break;
    }

    // Fetch in parallel, then filter failures
    const fetched = await Promise.all(picked.map((u) => fetchInternalPageContext(u)));
    const extraPages = fetched.filter(Boolean);

    return {
      ...base,
      extraPages,
      v: 2
    };
  } catch {
    return {
      ...base,
      v: 2,
      extraPages: [],
      error: "sitewide_context_failed"
    };
  }
}

  // -----------------------------
  // Memory v1 (localStorage)
  // -----------------------------
  const LS_KEYS = {
    conversationId: "aurea_conversation_id",
    history: "aurea_chat_history_v1",
    signals: "aurea_signals_v1",
  };

  const HISTORY_LIMIT = 40; // total messages (user+assistant)

  function loadSignals() {
    const raw = localStorage.getItem(LS_KEYS.signals);
    const s = safeJsonParse(raw, {});
    return s && typeof s === "object" ? s : {};
  }
  
  function saveSignals(signals) {
    localStorage.setItem(LS_KEYS.signals, JSON.stringify(signals || {}));
    return signals || {};
  }
  
  function setSignal(patch) {
    const s = loadSignals();
    const next = { ...s, ...(patch || {}), _ts: Date.now() };
    return saveSignals(next);
  }

  function sendAureaEvent(eventPayload) {
  try {
    const url = `https://chat.aureaautomations.com/event?clientId=${encodeURIComponent(CLIENT_ID)}`;
    const body = JSON.stringify(eventPayload);

    // Prefer sendBeacon to survive navigation
    if (navigator.sendBeacon) {
      return navigator.sendBeacon(url, body); // sends as text/plain
    }

    // Fallback: keepalive fetch (also text/plain to avoid preflight)
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    // never block UX
  }
}

  function safeJsonParse(value, fallback) {
    try {
      const parsed = JSON.parse(value);
      return parsed ?? fallback;
    } catch {
      return fallback;
    }
  }

  function generateConversationId() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return "c_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
  }

  function getConversationId() {
    let id = localStorage.getItem(LS_KEYS.conversationId);
    if (!id) {
      id = generateConversationId();
      localStorage.setItem(LS_KEYS.conversationId, id);
    }
    return id;
  }

  function loadHistory() {
    const raw = localStorage.getItem(LS_KEYS.history);
    const history = safeJsonParse(raw, []);
    return Array.isArray(history) ? history : [];
  }

  function saveHistory(history) {
    const trimmed = history.slice(-HISTORY_LIMIT);
    localStorage.setItem(LS_KEYS.history, JSON.stringify(trimmed));
    return trimmed;
  }

  function pushToHistory(role, content) {
    const history = loadHistory();
    history.push({
      role, // "user" | "assistant"
      content: String(content ?? ""),
      ts: Date.now(),
    });
    return saveHistory(history);
  }
  function newConversationId() {
    const id = generateConversationId();
    localStorage.setItem(LS_KEYS.conversationId, id);
    return id;
  }
  
  function clearHistoryAndUI() {
    localStorage.removeItem(LS_KEYS.history);
    localStorage.removeItem(LS_KEYS.signals);
    newConversationId();

    __aurea_sitewide_cache = null;
    __aurea_sitewide_cache_at = 0;
  
    messagesEl.innerHTML = "";
    const existing = document.getElementById("aurea-cta-wrap");
    if (existing) existing.remove();
    historyRendered = false;
  
    add("assistant", GREETING);
    pushToHistory("assistant", GREETING);
    historyRendered = true;
  }
  
  // Ensure ID exists early
  getConversationId();

  // -----------------------------
  // UI
  // -----------------------------

  function detectSiteTypography() {
    // Prefer real readable text
    const el =
      document.querySelector("main p") ||
      document.querySelector("p") ||
      document.querySelector("main") ||
      document.body;

    const cs = getComputedStyle(el);
    return {
      fontFamily: (cs.fontFamily || "").trim() || "Arial, Helvetica, sans-serif",
      fontSize: (cs.fontSize || "").trim() || "16px",
      fontWeight: (cs.fontWeight || "").trim() || "400",
      letterSpacing: (cs.letterSpacing || "").trim() || "normal",
      lineHeight: (cs.lineHeight || "").trim() || "normal",
    };
  }

  const SITE_TYPO = detectSiteTypography();
  
  // Use the site's font (or allow an explicit override per client)
  function detectPageFontFamily() {
    // Client override wins
    if (typeof CONFIG.fontFamily === "string" && CONFIG.fontFamily.trim()) {
      return CONFIG.fontFamily.trim();
    }

    // Wix often sets font on a wrapper inside <body>, not on body/html.
    // So sample common "real text" nodes and pick the first usable font-family.
    const candidates = [
      document.querySelector("h1"),
      document.querySelector("h2"),
      document.querySelector("p"),
      document.querySelector("a"),
      document.querySelector("button"),
      document.querySelector("span"),
      document.querySelector("div"),
      document.body,
      document.documentElement,
    ].filter(Boolean);

    for (const el of candidates) {
      const ff = (getComputedStyle(el).fontFamily || "").trim();
      if (ff) return ff;
    }

    // Final fallback
    return "system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif";
  }

  const PAGE_FONT = detectPageFontFamily();

  const AUREA_HOST = document.createElement("div");
  AUREA_HOST.id = "__aurea_host__";
  AUREA_HOST.style.pointerEvents = "none";
  AUREA_HOST.style.background = "transparent";

  AUREA_HOST.style.position = "fixed";
  AUREA_HOST.style.inset = "0";
  AUREA_HOST.style.zIndex = "2147483647";
  document.documentElement.appendChild(AUREA_HOST);

  let btn = null;
  
  if (MODE === "floating") {
    btn = document.createElement("button");
    btn.textContent = "Chat";
    btn.style.position = "fixed";
    btn.style.right = "20px";
    btn.style.bottom = "20px";
    btn.style.zIndex = "999999";
    btn.style.padding = "12px 16px";
    btn.style.borderRadius = "999px";
    btn.style.border = "1px solid rgba(0,0,0,0.12)";
    btn.style.background = "#111";
    btn.style.color = "#fff";
    btn.style.cursor = "pointer";
    btn.style.fontSize = "14px";
    btn.style.fontFamily = "inherit";
    btn.style.fontWeight = "600";
    btn.style.lineHeight = "1";
    btn.style.boxShadow = "0 10px 24px rgba(0,0,0,0.18)";
    btn.style.transition = "transform 120ms ease, opacity 120ms ease, box-shadow 120ms ease";
    btn.style.userSelect = "none";
    btn.style.webkitTapHighlightColor = "transparent";
    btn.style.pointerEvents = "auto";
    AUREA_HOST.appendChild(btn);

    btn.addEventListener("mouseenter", () => {
      btn.style.opacity = "0.92";
      btn.style.transform = "translateY(-1px)";
      btn.style.boxShadow = "0 12px 28px rgba(0,0,0,0.22)";
    });
    
    btn.addEventListener("mouseleave", () => {
      btn.style.opacity = "1";
      btn.style.transform = "translateY(0)";
      btn.style.boxShadow = "0 10px 24px rgba(0,0,0,0.18)";
    });
    
    btn.addEventListener("mousedown", () => {
      btn.style.transform = "translateY(0) scale(0.98)";
    });
    
    btn.addEventListener("mouseup", () => {
      btn.style.transform = "translateY(-1px)";
    });
  }
  
  const panel = document.createElement("div");

  // Apply font inheritance AFTER btn/panel exist (prevents ReferenceError)
  if (btn) btn.style.fontFamily = "inherit";
  panel.style.fontFamily = "inherit";

  // Optional: refresh font-family after webfonts load (safe now)
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
      const refreshed = detectPageFontFamily();
      AUREA_HOST.style.fontFamily = refreshed;
      if (btn) btn.style.fontFamily = "inherit";
      panel.style.fontFamily = "inherit";
    }).catch(() => {});
  }

  panel.style.position = "fixed";
  panel.style.right = "20px";
  panel.style.bottom = "70px";
  panel.style.width = "min(340px, calc(100vw - 40px))";
  panel.style.height = "min(420px, calc(100vh - 120px))";
  panel.style.zIndex = "999999";
  panel.style.border = "1px solid #e5e5e5";
  panel.style.borderRadius = "14px";
  panel.style.background = "#fff";
  panel.style.boxShadow = "0 10px 30px rgba(0,0,0,0.12)";
  panel.style.display = "none";
  panel.style.opacity = "0";
  panel.style.transform = "translateY(8px)";
  panel.style.transition = "opacity 160ms ease, transform 160ms ease";
  panel.style.overflow = "hidden";
  panel.style.color = "#111";
  panel.style.textRendering = "optimizeLegibility";
  panel.style.webkitFontSmoothing = "antialiased";
  panel.style.fontFamily = "inherit";
  panel.style.fontSize = "inherit";
  panel.style.lineHeight = "inherit";

  panel.innerHTML = `
  <div style="height:100%; display:flex; flex-direction:column;">
    <div style="
      padding:14px 16px;
      border-bottom:1px solid #eee;
      font-weight:600;
      font-size:14px;
      display:flex;
      justify-content:space-between;
      align-items:center;
    ">
      <span>${BUSINESS_NAME}</span>
      <button
        id="aurea-newchat"
        style="
          font-size:12px;
          padding:7px 10px;
          border-radius:999px;
          border:1px solid #e6e6e6;
          background:#fff;
          color:#111;
          font-weight:600;
          cursor:pointer;
          transition:opacity 120ms ease, transform 120ms ease, background 120ms ease;
          user-select:none;
        "
      >
        New
      </button>
    </div>

    <div id="aurea-messages" style="
      padding:14px 16px;
      flex:1;
      overflow:auto;
      font-size:14px;
      line-height:1.45;
    "></div>

    <div id="aurea-footer" style="padding:10px; border-top:1px solid #eee; display:flex; gap:8px;">
    <textarea
      id="aurea-input"
      placeholder="Type a message…"
      rows="1"
      style="
        flex:1;
        padding:10px 12px;
        border:1px solid #ddd;
        border-radius:12px;
        resize:none;
        overflow:hidden;
        line-height:1.45;
        font-family:inherit;
        font-size:14px;
        outline:none;
      "
    ></textarea>
      <button
        id="aurea-send"
        style="
          padding:10px 14px;
          border-radius:12px;
          border:1px solid #111;
          background:#111;
          color:#fff;
          font-size:14px;
          font-weight:600;
          cursor:pointer;
          transition:opacity 120ms ease, transform 120ms ease;
          user-select:none;
        "
      >
        Send
      </button>
  </div>
`;
  
  AUREA_HOST.appendChild(panel);
  panel.style.pointerEvents = "auto";

  // ✅ Query elements (must exist before we use them)
  const messagesEl = panel.querySelector("#aurea-messages");
  const inputEl = panel.querySelector("#aurea-input");
  const sendEl = panel.querySelector("#aurea-send");

  let __aurea_pointer_started_inside = false;
  
  // Prevent clicks inside the widget from closing it
  panel.addEventListener("click", (e) => {
    e.stopPropagation();
  });
  
  // Track where the user's interaction started
  document.addEventListener("pointerdown", (e) => {
    __aurea_pointer_started_inside =
      panel.contains(e.target) || (btn && btn.contains(e.target));
  });

  // Auto-grow textarea up to a max height so user can see what they're typing
  const INPUT_MAX_HEIGHT = 120; // px (about ~6-7 lines)
  
  function autosizeInput() {
    // reset to measure natural height
    inputEl.style.height = "auto";
  
    const next = Math.min(inputEl.scrollHeight, INPUT_MAX_HEIGHT);
    inputEl.style.height = next + "px";
  
    // once we hit max height, allow internal scrolling
    inputEl.style.overflowY = inputEl.scrollHeight > INPUT_MAX_HEIGHT ? "auto" : "hidden";
  }
  
  // run on every input change
  inputEl.addEventListener("input", autosizeInput);

  // Normalize pasted text (prevent unwanted line breaks)
  inputEl.addEventListener("paste", (e) => {
    e.preventDefault();
  
    const text = (e.clipboardData || window.clipboardData)
      .getData("text")
      .replace(/\r?\n+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const start = inputEl.selectionStart;
    const end = inputEl.selectionEnd;
  
    inputEl.value =
      inputEl.value.slice(0, start) +
      text +
      inputEl.value.slice(end);
  
    // Move cursor to end of pasted text
    const cursor = start + text.length;
    inputEl.selectionStart = inputEl.selectionEnd = cursor;
  
    autosizeInput();
  });

  // ensure correct height on open / focus
  setTimeout(autosizeInput, 0);

   inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  const newChatBtn = panel.querySelector("#aurea-newchat");
  newChatBtn.onclick = (e) => {
    e.stopPropagation();          // prevent accidental panel close
    clearHistoryAndUI();          // handles storage + UI reset
    setTimeout(() => inputEl.focus(), 0);
  };

  newChatBtn.addEventListener("mouseenter", () => {
    newChatBtn.style.background = "#f6f6f6";
  });
  
  newChatBtn.addEventListener("mouseleave", () => {
    newChatBtn.style.background = "#fff";
    newChatBtn.style.transform = "scale(1)";
    newChatBtn.style.opacity = "1";
  });
  
  newChatBtn.addEventListener("mousedown", () => {
    newChatBtn.style.transform = "scale(0.98)";
    newChatBtn.style.opacity = "0.9";
  });
  
  newChatBtn.addEventListener("mouseup", () => {
    newChatBtn.style.transform = "scale(1)";
    newChatBtn.style.opacity = "1";
  });

  // Force readable input text (some site builders override input styles)
  inputEl.style.color = "#111";
  inputEl.style.backgroundColor = "#fff";
  inputEl.style.webkitTextFillColor = "#111";
  
  function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

  // Matches http(s) links and bare domains like example.com/path
  const URL_REGEX =
    /(\bhttps?:\/\/[^\s<]+|\bwww\.[^\s<]+|\b[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s<]*)?)/gi;
  
  function linkifyToHtml(text) {
    const safe = escapeHtml(text);
  
    return safe.replace(URL_REGEX, (raw) => {
      const href = raw.startsWith("http")
        ? raw
        : raw.startsWith("www.")
          ? `https://${raw}`
          : `https://${raw}`;
  
      return `<a href="${href}" target="_blank" rel="noopener noreferrer">${raw}</a>`;
    });
  }
  
  function setMessageContent(el, role, text) {
    if (role !== "assistant") {
      el.textContent = text;
      return;
    }
  
    // Assistant: clickable links + preserve line breaks
    el.innerHTML = linkifyToHtml(text).replace(/\n/g, "<br/>");
  }

  function styleBookingLinks(container) {
    const links = container.querySelectorAll("a");
    if (!links.length) return;
  
    let madeOneButton = false;
  
    links.forEach((link) => {
      if (madeOneButton) return; // only one primary CTA per message
  
      const href = (link.getAttribute("href") || "").toLowerCase();
      const text = (link.textContent || "").toLowerCase();
  
      const isBooking = /book|booking|schedule|appointment|demo/.test(href) ||
                        /book|booking|schedule|appointment|demo/.test(text);
  
      if (!isBooking) return;
      
      link.insertAdjacentHTML("beforebegin", "<br/>");
  
      // button styling (inline so it survives site-builder CSS)
      link.style.display = "inline-flex";
      link.style.alignItems = "center";
      link.style.justifyContent = "center";
      link.style.marginTop = "10px";
      link.style.marginLeft = "0";
      link.style.whiteSpace = "nowrap";
      link.style.padding = "10px 14px";
      link.style.background = "#111";
      link.style.color = "#fff";
      link.style.borderRadius = "10px";
      link.style.textDecoration = "none";
      link.style.fontWeight = "600";
      link.style.border = "1px solid #111";
  
      // nicer label if the raw URL is showing
      if (link.textContent && link.textContent.trim().startsWith("http")) {
        link.textContent = "Book now";
      }
  
      // hover feel
      link.addEventListener("mouseenter", () => (link.style.opacity = "0.85"));
      link.addEventListener("mouseleave", () => (link.style.opacity = "1"));
  
      madeOneButton = true;
    });
  }
    function ctaLabel(ctaType) {
      switch (ctaType) {
        case "BOOK_NOW": return "Book now";
        case "LEAVE_CONTACT": return "Leave contact info";
        case "ESCALATE": return "Contact the clinic";
        default: return "Book now";
      }
    }
  
    function resolveStrictCtaUrl(d, ctaType) {
      if (!d || typeof d !== "object") return null;
    
      const norm = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
    
      if (ctaType === "BOOK_NOW") return norm(d.bookingUrl);
      if (ctaType === "LEAVE_CONTACT") return norm(d.contactUrl);
      if (ctaType === "ESCALATE") return norm(d.escalateUrl);
    
      return null;
    }

    function sendEventBeacon(payload) {
      try {
        const url = `https://chat.aureaautomations.com/event?clientId=${encodeURIComponent(CLIENT_ID)}`;
        const body = JSON.stringify(payload || {});
    
        // Prefer sendBeacon (no CORS preflight, survives page nav)
        if (navigator.sendBeacon) {
          const blob = new Blob([body], { type: "text/plain" });
          navigator.sendBeacon(url, blob);
          return;
        }
    
        // Fallback
        fetch(url, {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body,
          keepalive: true,
        }).catch(() => {});
      } catch {
        // never throw
      }
    }
  
    function renderDeterministicCTA(primaryCtaType, primaryUrl, secondaryCtaType, secondaryUrl) {
      // remove any existing CTA wrap
      const existing = document.getElementById("aurea-cta-wrap");
      if (existing) existing.remove();
    
      // If nothing to show, bail
      const hasPrimary = primaryUrl && typeof primaryUrl === "string";
      const hasSecondary = secondaryUrl && typeof secondaryUrl === "string";
      if (!hasPrimary && !hasSecondary) return;
    
      const wrap = document.createElement("div");
      wrap.id = "aurea-cta-wrap";
      wrap.style.marginBottom = "10px";
      wrap.style.display = "flex";
      wrap.style.gap = "10px";
      wrap.style.flexWrap = "wrap";
      wrap.style.justifyContent = "flex-start";
    
      function makeBtn(ctaType, url, variant) {
        const a = document.createElement("a");
        a.href = url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = ctaLabel(ctaType);
    
        a.addEventListener("click", () => {
          const isBooking = ctaType === "BOOK_NOW";
    
          setSignal({
            lastCtaClicked: ctaType,
            bookingPageOpened: isBooking ? true : false,
            contactPageOpened: ctaType === "LEAVE_CONTACT" ? true : false,
          });
    
          // Analytics: track deterministic events you already support
          if (ctaType === "BOOK_NOW") {
            let host = null;
            try { host = new URL(url, window.location.href).host; } catch {}
    
            sendEventBeacon({
              eventName: "cta_clicked",
              ctaType: "BOOK_NOW",
              clientId: CLIENT_ID,
              conversationId: getConversationId(),
              sessionId: null,
              pageUrl: window.location.href,
              ctaUrlHost: host,
              ts: new Date().toISOString(),
            });
    
            sendEventBeacon({
              eventName: "booking_page_opened",
              ctaType: "BOOK_NOW",
              clientId: CLIENT_ID,
              conversationId: getConversationId(),
              sessionId: null,
              pageUrl: window.location.href,
              bookingUrlHost: host,
              ts: new Date().toISOString(),
            });
          }
    
          if (ctaType === "LEAVE_CONTACT") {
            let host = null;
            try { host = new URL(url, window.location.href).host; } catch {}
    
            sendEventBeacon({
              eventName: "contact_page_opened",
              ctaType: "LEAVE_CONTACT",
              clientId: CLIENT_ID,
              conversationId: getConversationId(),
              sessionId: null,
              pageUrl: window.location.href,
              contactUrlHost: host,
              ts: new Date().toISOString(),
            });
          }
        });
    
        // Shared styling
        a.style.display = "inline-flex";
        a.style.alignItems = "center";
        a.style.justifyContent = "center";
        a.style.whiteSpace = "nowrap";
        a.style.padding = "10px 14px";
        a.style.borderRadius = "10px";
        a.style.textDecoration = "none";
        a.style.fontWeight = "600";
        a.style.cursor = "pointer";
        a.style.userSelect = "none";
    
        // Same style for both CTAs (V1)
        a.style.background = "#111";
        a.style.color = "#fff";
        a.style.border = "1px solid #111";

        a.addEventListener("mouseenter", () => (a.style.opacity = "0.85"));
        a.addEventListener("mouseleave", () => (a.style.opacity = "1"));
    
        return a;
      }
    
      if (hasPrimary) wrap.appendChild(makeBtn(primaryCtaType, primaryUrl, "primary"));
      if (hasSecondary) wrap.appendChild(makeBtn(secondaryCtaType, secondaryUrl, "secondary"));
    
      messagesEl.appendChild(wrap);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

  function add(role, text) {
    // Normalize role names for UI
    const isUser = role === "user";
    const wrap = document.createElement("div");
    wrap.style.marginBottom = "10px";
    wrap.style.display = "flex";
    wrap.style.justifyContent = isUser ? "flex-end" : "flex-start";

    const bubble = document.createElement("div");
    setMessageContent(bubble, role, text);
    if (role === "assistant") {
      styleBookingLinks(bubble);
    }
    bubble.style.padding = "10px 14px";
    bubble.style.borderRadius = "14px";
    bubble.style.maxWidth = "82%";
    bubble.style.lineHeight = "1.45";
    bubble.style.wordBreak = "break-word";
    
    if (isUser) {
      bubble.style.background = "#111";
      bubble.style.color = "#fff";
      bubble.style.border = "1px solid #111";
    } else {
      bubble.style.background = "#f7f7f8";
      bubble.style.color = "#111";
      bubble.style.border = "1px solid #e6e6e6";
    }

    wrap.appendChild(bubble);
    messagesEl.appendChild(wrap);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function addTyping() {
    // prevent duplicates
    if (messagesEl.querySelector("#aurea-typing")) return;

    const wrap = document.createElement("div");
    wrap.id = "aurea-typing";
    wrap.style.marginBottom = "10px";
    wrap.style.display = "flex";
    wrap.style.justifyContent = "flex-start";

    const bubble = document.createElement("div");
    bubble.textContent = `${BUSINESS_NAME} is thinking…`;
    bubble.style.padding = "10px 12px";
    bubble.style.borderRadius = "12px";
    bubble.style.maxWidth = "85%";
    bubble.style.background = "#f6f6f6";
    bubble.style.color = "#777";
    bubble.style.border = "1px solid #eee";
    bubble.style.fontStyle = "italic";

    wrap.appendChild(bubble);
    messagesEl.appendChild(wrap);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function removeTyping() {
    const typing = messagesEl.querySelector("#aurea-typing");
    if (typing) typing.remove();
  }

  let historyRendered = false;

  function renderHistoryIntoUI() {
    if (historyRendered) return;
    const history = loadHistory();
    if (!history.length) return;

    historyRendered = true;

    history.forEach((m) => {
      if (!m || typeof m.content !== "string") return;
      if (m.role === "user") add("user", m.content);
      if (m.role === "assistant") add("assistant", m.content);
    });
  }

  async function send() {
    const text = inputEl.value.trim();
    if (!text) return;

    inputEl.value = "";
    autosizeInput();

    // Show in UI + persist
    add("user", text);
    pushToHistory("user", text);

    addTyping();

    try {
      const conversationId = getConversationId();
      const history = loadHistory(); // includes the user message we just pushed
      const signals = loadSignals();

      let siteContext = null;
      const CACHE_MS = 5 * 60 * 1000;
      
      if (__aurea_sitewide_cache && (Date.now() - __aurea_sitewide_cache_at) < CACHE_MS) {
        siteContext = __aurea_sitewide_cache;
      } else {
        siteContext = await getSiteContextV2();
        __aurea_sitewide_cache = siteContext;
        __aurea_sitewide_cache_at = Date.now();
      }
  
    const r = await fetch(`https://chat.aureaautomations.com/chat?clientId=${encodeURIComponent(CLIENT_ID)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Aurea-Client-Id": CLIENT_ID,
      },
      body: JSON.stringify({
        clientId: CLIENT_ID,
        conversationId,
        message: text,
        history,
        signals,
        siteContext,
        meta: {
          businessName: BUSINESS_NAME,
          pageUrl: window.location.href,
          pageTitle: document.title,
          siteKeyOverride: (CONFIG.siteKeyOverride || "").trim() || null,
        },
      }),
    });

      if (!r.ok) {
        removeTyping();
        add("assistant", "Sorry, something went wrong on the server. Please try again.");
        pushToHistory("assistant", "Sorry, something went wrong on the server. Please try again.");
        return;
      }

      const d = await r.json();

      if (d && d.route) {
        const patch = {};
        if (d.route.facts) patch.routerFacts = d.route.facts;
        if (d.route.job) patch.lastJob = d.route.job; // NEW
        setSignal(patch);
      }

      removeTyping();

      const reply = d.reply || "No reply.";
      add("assistant", reply);
      pushToHistory("assistant", reply);
      
      const primaryCtaType = d.ctaType || "BOOK_NOW";
      const primaryUrl = resolveStrictCtaUrl(d, primaryCtaType);
      
      // Always offer the other main action as secondary (V1)
      const secondaryCtaType = primaryCtaType === "LEAVE_CONTACT" ? "BOOK_NOW" : "LEAVE_CONTACT";
      const secondaryUrl = resolveStrictCtaUrl(d, secondaryCtaType);
      
      renderDeterministicCTA(primaryCtaType, primaryUrl, secondaryCtaType, secondaryUrl);

    } catch {
      removeTyping();
      add("assistant", "Error. Try again.");
      pushToHistory("assistant", "Error. Try again.");
    }
  }

  function isPanelOpen() {
    return panel.style.display !== "none";
  }
  
  function openPanel() {
    if (isPanelOpen()) return;

    AUREA_HOST.style.pointerEvents = "auto";
  
    panel.style.display = "block";
    requestAnimationFrame(() => {
      panel.style.opacity = "1";
      panel.style.transform = "translateY(0)";
    });
  
    const history = loadHistory();
    if (history.length) {
      renderHistoryIntoUI();
    } else {
      add("assistant", GREETING);
      pushToHistory("assistant", GREETING);
      historyRendered = true;
    }

    const existing = document.getElementById("aurea-cta-wrap");
    if (existing) existing.remove();

    setTimeout(() => {
      inputEl.focus();
      // if you implemented textarea autosizeInput(), keep this:
      if (typeof autosizeInput === "function") autosizeInput();
    }, 0);
  }
  
  function closePanel() {
    if (!isPanelOpen()) return;
  
    panel.style.opacity = "0";
    panel.style.transform = "translateY(8px)";
    setTimeout(() => {
      panel.style.display = "none";
      AUREA_HOST.style.pointerEvents = "none";
    }, 170);
  }
  
  if (btn) {
    btn.onclick = (e) => {
      console.log("[Aurea] chat button clicked");
      e.stopPropagation();
  
      console.log("[Aurea] before toggle display =", panel.style.display);
  
      try {
        if (isPanelOpen()) closePanel();
        else openPanel();
      } catch (err) {
        console.error("[Aurea] toggle error:", err);
      }
  
      console.log("[Aurea] after toggle display =", panel.style.display);
    };
  }

  document.addEventListener("pointerdown", (e) => {
    if (!isPanelOpen()) return;
  
    // click started on the chat button -> let toggle handler deal with it
    if (btn && btn.contains(e.target)) return;
  
    // click started inside panel -> do nothing (don't close)
    if (panel.contains(e.target)) return;
  
    // otherwise, outside click closes
    closePanel();
  }, true); // ✅ capture phase

  sendEl.onclick = send;
  // Note: we no longer auto-add greeting on load.
  // It now happens on first open, and only once.
  sendEl.addEventListener("mouseenter", () => {
    sendEl.style.opacity = "0.9";
  });
  
  sendEl.addEventListener("mouseleave", () => {
    sendEl.style.opacity = "1";
  });
  
  sendEl.addEventListener("mousedown", () => {
    sendEl.style.transform = "scale(0.97)";
  });
  
  sendEl.addEventListener("mouseup", () => {
    sendEl.style.transform = "scale(1)";
  });
})();
