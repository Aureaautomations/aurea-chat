(function () {
  if (window.__AUREA_WIDGET_LOADED__) return;
  window.__AUREA_WIDGET_LOADED__ = true;

  // bump version
  window.__AUREA_WIDGET_VERSION__ = "0.2.1";
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
    btn.style.padding = "12px 14px";
    btn.style.borderRadius = "999px";
    btn.style.border = "1px solid #ddd";
    btn.style.background = "#111";
    btn.style.color = "#fff";
    btn.style.cursor = "pointer";
    btn.style.fontFamily = "system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif";
    btn.style.pointerEvents = "auto";
    AUREA_HOST.appendChild(btn);
  }
  
  const panel = document.createElement("div");

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
  panel.style.fontFamily = "system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif";

  panel.innerHTML = `
  <div style="height:100%; display:flex; flex-direction:column;">
    <div style="padding:12px 14px; border-bottom:1px solid #eee; font-weight:600; display:flex; justify-content:space-between; align-items:center;">
      <span>${BUSINESS_NAME}</span>
      <button id="aurea-newchat" style="font-size:12px; padding:6px 8px; border-radius:10px; border:1px solid #ddd; background:#fff; cursor:pointer;">
        New
      </button>
    </div>

    <div id="aurea-messages" style="padding:12px 14px; flex:1; overflow:auto; font-size:14px;"></div>

    <div style="padding:10px; border-top:1px solid #eee; display:flex; gap:8px;">
      <input id="aurea-input" placeholder="Type a message..." style="flex:1; padding:10px; border:1px solid #ddd; border-radius:10px;" />
      <button id="aurea-send" style="padding:10px 12px; border-radius:10px; border:1px solid #111; background:#111; color:#fff;">Send</button>
    </div>
  </div>
`;
  
  panel.style.pointerEvents = "auto";
  AUREA_HOST.appendChild(panel);

  const messagesEl = panel.querySelector("#aurea-messages");
  const inputEl = panel.querySelector("#aurea-input");
  const sendEl = panel.querySelector("#aurea-send");
  
  const newChatBtn = panel.querySelector("#aurea-newchat");
  newChatBtn.onclick = (e) => {
    e.stopPropagation();          // prevent accidental panel close
    clearHistoryAndUI();          // handles storage + UI reset
    setTimeout(() => inputEl.focus(), 0);
  };

  // Force readable input text (some site builders override input styles)
  inputEl.style.color = "#111";
  inputEl.style.backgroundColor = "#fff";
  inputEl.style.webkitTextFillColor = "#111";

  // Some site builders hijack keyboard events.
  // This captures typing early and manually updates the input.
  if (MODE === "floating") {
    window.addEventListener(
      "keydown",
      (e) => {
        if (document.activeElement !== inputEl) return;
  
        // allow shortcuts
        if (e.metaKey || e.ctrlKey || e.altKey) return;
  
        if (e.key === "Enter") {
          e.preventDefault();
          send();
          return;
        }
  
        if (e.key === "Backspace") {
          e.preventDefault();
          inputEl.value = inputEl.value.slice(0, -1);
          return;
        }
  
        if (e.key.length === 1) {
          e.preventDefault();
          inputEl.value += e.key;
        }
      },
      true // capture phase
    );
  }
  
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
        case "CHOOSE_TIME": return "Choose a time";
        case "LEAVE_CONTACT": return "Leave contact info";
        case "ESCALATE": return "Contact the clinic";
        default: return "Book now";
      }
    }
    
    function renderDeterministicCTA(ctaType, bookingUrl) {
      // remove any existing CTA (we only want one visible at a time)
      const existing = document.getElementById("aurea-cta-wrap");
      if (existing) existing.remove();
    
      if (!bookingUrl || typeof bookingUrl !== "string") return;
    
      const wrap = document.createElement("div");
      wrap.id = "aurea-cta-wrap";
      wrap.style.marginBottom = "10px";
      wrap.style.display = "flex";
      wrap.style.justifyContent = "flex-start";
    
      const btn = document.createElement("a");
      btn.id = "aurea-cta";
      btn.href = bookingUrl;
      btn.target = "_blank";
      btn.rel = "noopener noreferrer";
      btn.textContent = ctaLabel(ctaType);

      btn.addEventListener("click", () => {
        const isBookingCta = ["BOOK_NOW", "CHOOSE_TIME", "CONFIRM_BOOKING"].includes(ctaType);
      
        setSignal({
          lastCtaClicked: ctaType,
          bookingPageOpened: isBookingCta ? true : false,
          contactPageOpened: ctaType === "LEAVE_CONTACT" ? true : false,
        });
      });
    
      // inline styles only
      btn.style.display = "inline-flex";
      btn.style.alignItems = "center";
      btn.style.justifyContent = "center";
      btn.style.whiteSpace = "nowrap";
      btn.style.marginTop = "2px";
      btn.style.padding = "10px 14px";
      btn.style.background = "#111";
      btn.style.color = "#fff";
      btn.style.borderRadius = "10px";
      btn.style.textDecoration = "none";
      btn.style.fontWeight = "600";
      btn.style.border = "1px solid #111";
    
      btn.addEventListener("mouseenter", () => (btn.style.opacity = "0.85"));
      btn.addEventListener("mouseleave", () => (btn.style.opacity = "1"));
    
      wrap.appendChild(btn);
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
    bubble.style.padding = "10px 12px";
    bubble.style.borderRadius = "12px";
    bubble.style.maxWidth = "85%";
    bubble.style.background = isUser ? "#111" : "#f6f6f6";
    bubble.style.color = isUser ? "#fff" : "#111";
    bubble.style.border = "1px solid #eee";

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
      
      const ctaType = d.ctaType || "BOOK_NOW";
      const ctaUrl = (typeof d.ctaUrl === "string" && d.ctaUrl.trim()) ? d.ctaUrl.trim() : null;

      // Job #4 one-shot gating: only mark leadOfferMade when Job #4 actually ran
      const job = d?.route?.job || "";
      if (job === "JOB_4_CAPTURE_LEAD") {
        setSignal({ leadOfferMade: true });
      }
      
      renderDeterministicCTA(ctaType, ctaUrl);
      
    } catch {
      removeTyping();
      add("assistant", "Error. Try again.");
      pushToHistory("assistant", "Error. Try again.");
    }
  }

  if (btn) {
    btn.onclick = () => {
      const isClosed = panel.style.display === "none";
  
      if (isClosed) {
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
  
        setTimeout(() => inputEl.focus(), 0);
      } else {
        panel.style.opacity = "0";
        panel.style.transform = "translateY(8px)";
        setTimeout(() => {
          panel.style.display = "none";
        }, 170);
      }
    };
  }

  sendEl.onclick = send;
  // Note: we no longer auto-add greeting on load.
  // It now happens on first open, and only once.
})();
