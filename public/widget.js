(function () {
  if (window.__AUREA_WIDGET_LOADED__) return;
  window.__AUREA_WIDGET_LOADED__ = true;
  window.__AUREA_WIDGET_VERSION__ = "0.1.0";
  console.log(`[Aurea Widget] loaded v${window.__AUREA_WIDGET_VERSION__}`);

  const CONFIG = window.AUREA_CONFIG || {};
  const BUSINESS_NAME = CONFIG.businessName || "Aurea";
  const GREETING =
  CONFIG.greeting || "Hey! I’m Aurea. How can I help?";

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
    <div style="padding:12px 14px; border-bottom:1px solid #eee; font-weight:600;">${BUSINESS_NAME}</div>
    <div id="aurea-messages" style="padding:12px 14px; height:310px; overflow:auto; font-size:14px;"></div>
    <div style="padding:10px; border-top:1px solid #eee; display:flex; gap:8px;">
      <input id="aurea-input" placeholder="Type a message..." style="flex:1; padding:10px; border:1px solid #ddd; border-radius:10px;" />
      <button id="aurea-send" style="padding:10px 12px; border-radius:10px; border:1px solid #111; background:#111; color:#fff;">Send</button>
    </div>
  `;
  document.body.appendChild(panel);

  const messagesEl = panel.querySelector("#aurea-messages");
  const inputEl = panel.querySelector("#aurea-input");
// Force readable input text (some site builders override input styles)
inputEl.style.color = "#111";
inputEl.style.backgroundColor = "#fff";
inputEl.style.webkitTextFillColor = "#111";

  const sendEl = panel.querySelector("#aurea-send");

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
    const wrap = document.createElement("div");
    wrap.style.marginBottom = "10px";
    wrap.style.display = "flex";
    wrap.style.justifyContent = role === "user" ? "flex-end" : "flex-start";

    const bubble = document.createElement("div");
    bubble.textContent = text;
    bubble.style.padding = "10px 12px";
    bubble.style.borderRadius = "12px";
    bubble.style.maxWidth = "85%";
    bubble.style.background = role === "user" ? "#111" : "#f6f6f6";
    bubble.style.color = role === "user" ? "#fff" : "#111";
    bubble.style.border = "1px solid #eee";

    wrap.appendChild(bubble);
    messagesEl.appendChild(wrap);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
  function addTyping() {
    const wrap = document.createElement("div");
    wrap.id = "aurea-typing";
    wrap.style.marginBottom = "10px";
    wrap.style.display = "flex";
    wrap.style.justifyContent = "flex-start";
  
    const bubble = document.createElement("div");
    bubble.textContent = `${(window.AUREA_CONFIG && window.AUREA_CONFIG.businessName) || "Aurea"} is thinking…`;
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
    const typing = document.getElementById("aurea-typing");
    if (typing) typing.remove();
  }
  
  async function send() {
    const text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = "";
    add("user", text);
    addTyping();

    try {
      const r = await fetch("https://chat.aureaautomations.com/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      const d = await r.json();
      removeTyping();
      add("bot", d.reply || "No reply.");
    } catch {
      removeTyping();
      add("bot", "Error. Try again.");
    }
  }
btn.onclick = () => {
  const isClosed = panel.style.display === "none";

  if (isClosed) {
    panel.style.display = "block";
    // animate in on next frame
    requestAnimationFrame(() => {
      panel.style.opacity = "1";
      panel.style.transform = "translateY(0)";
    });
    setTimeout(() => inputEl.focus(), 0);
  } else {
    // animate out then hide
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

  add("bot", GREETING);
})();
