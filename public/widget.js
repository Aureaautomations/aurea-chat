(function () {
  if (window.__AUREA_WIDGET_LOADED__) return;
  window.__AUREA_WIDGET_LOADED__ = true;

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
  panel.style.overflow = "hidden";
  panel.style.fontFamily = "system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif";

  panel.innerHTML = `
    <div style="padding:12px 14px; border-bottom:1px solid #eee; font-weight:600;">Aurea</div>
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

  async function send() {
    const text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = "";
    add("user", text);

    try {
      const r = await fetch("https://chat.aureaautomations.com/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      const d = await r.json();
      add("bot", d.reply || "No reply.");
    } catch {
      add("bot", "Error. Try again.");
    }
  }

  btn.onclick = () => {
    panel.style.display = panel.style.display === "none" ? "block" : "none";
  };
  sendEl.onclick = send;
  inputEl.onkeydown = (e) => e.key === "Enter" && send();

  add("bot", "Hey! I’m Aurea. How can I help?");
})();
