(function () {
  if (window.__AUREA_WIDGET_LOADED__) return;
  window.__AUREA_WIDGET_LOADED__ = true;

  // bump version
  window.__AUREA_WIDGET_VERSION__ = "0.2.0";
  console.log(`[Aurea Widget] loaded v${window.__AUREA_WIDGET_VERSION__}`);

  const CONFIG = window.AUREA_CONFIG || {};
  const BUSINESS_NAME = CONFIG.businessName || "Aurea";
  const GREETING = CONFIG.greeting || "Hey! I’m Aurea. How can I help?";

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


  

  // -----------------------------
  // Memory v1 (localStorage)
  // -----------------------------
  const LS_KEYS = {
    conversationId: "aurea_conversation_id",
    history: "aurea_chat_history_v1",
  };

  const HISTORY_LIMIT = 40; // total messages (user+assistant)

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
    // Clear storage
    localStorage.removeItem(LS_KEYS.history);
    newConversationId();
  
    // Clear UI
    messagesEl.innerHTML = "";
    historyRendered = false;
  
    // Show fresh greeting
    add("assistant", GREETING);
    pushToHistory("assistant", GREETING);
    historyRendered = true;
  }
  
  // Ensure ID exists early
  getConversationId();

  // -----------------------------
  // UI
  // -----------------------------
  const btn = document.createElement("button");
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
  document.body.appendChild(btn);

  const panel = document.createElement("div");
  panel.style.position = "fixed";
  panel.style.right = "20px";
  panel.style.bottom = "70px";
  panel.style.width = "340px";
  panel.style.height = "420px";
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
    <div style="padding:12px 14px; border-bottom:1px solid #eee; font-weight:600; display:flex; justify-content:space-between; align-items:center;">
      <span>${BUSINESS_NAME}</span>
      <button id="aurea-newchat" style="font-size:12px; padding:6px 8px; border-radius:10px; border:1px solid #ddd; background:#fff; cursor:pointer;">
        New
      </button>
    </div>
    <div id="aurea-messages" style="padding:12px 14px; height:310px; overflow:auto; font-size:14px;"></div>
    <div style="padding:10px; border-top:1px solid #eee; display:flex; gap:8px;">
      <input id="aurea-input" placeholder="Type a message..." style="flex:1; padding:10px; border:1px solid #ddd; border-radius:10px;" />
      <button id="aurea-send" style="padding:10px 12px; border-radius:10px; border:1px solid #111; background:#111; color:#fff;">Send</button>
    </div>
  `;

  document.body.appendChild(panel);

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

  function add(role, text) {
    // Normalize role names for UI
    const isUser = role === "user";
    const wrap = document.createElement("div");
    wrap.style.marginBottom = "10px";
    wrap.style.display = "flex";
    wrap.style.justifyContent = isUser ? "flex-end" : "flex-start";

    const bubble = document.createElement("div");
    bubble.textContent = text;
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

      const siteContext = getSiteContextV1();
      
      const r = await fetch("https://chat.aureaautomations.com/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId,
          message: text,
          history,
          siteContext, // ✅ ADD THIS LINE (right above meta is perfect)
          meta: {
            businessName: BUSINESS_NAME,
            pageUrl: window.location.href,
            pageTitle: document.title,
          },
        }),
      });

      const d = await r.json();
      removeTyping();

      const reply = d.reply || "No reply.";
      add("assistant", reply);
      pushToHistory("assistant", reply);
    } catch {
      removeTyping();
      add("assistant", "Error. Try again.");
      pushToHistory("assistant", "Error. Try again.");
    }
  }

  btn.onclick = () => {
    const isClosed = panel.style.display === "none";

    if (isClosed) {
      panel.style.display = "block";
      requestAnimationFrame(() => {
        panel.style.opacity = "1";
        panel.style.transform = "translateY(0)";
      });

      // Render history (or greeting) when opened
      const history = loadHistory();
      if (history.length) {
        renderHistoryIntoUI();
      } else {
        // Only greet once and persist it
        add("assistant", GREETING);
        pushToHistory("assistant", GREETING);
        historyRendered = true; // prevents later renderHistory from duplicating
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

  document.addEventListener("mousedown", (e) => {
    if (panel.style.display === "none") return;
    const clickedInsidePanel = panel.contains(e.target);
    const clickedButton = btn.contains(e.target);
    if (!clickedInsidePanel && !clickedButton) {
      panel.style.opacity = "0";
      panel.style.transform = "translateY(8px)";
      setTimeout(() => {
        panel.style.display = "none";
      }, 170);
    }
  });

  sendEl.onclick = send;
  inputEl.onkeydown = (e) => e.key === "Enter" && send();

  // Note: we no longer auto-add greeting on load.
  // It now happens on first open, and only once.
})();
