require("dotenv").config();

const { routeMessage, JOBS } = require("./router");
const { getClientConfig, isOriginAllowed } = require("./clients");

const OpenAI = require("openai");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ✅ Site context summarization + cache (backend)
const {
  getSiteKey,
  hashSiteContext,
  getCachedSummary,
  setCachedSummary,
  summarizeSiteContext,
} = require("./siteSummary.js");

const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

const AUREA_SYSTEM_PROMPT = `
You are Aurea, an AI sales assistant for a service business.
Your job is to help convert website visitors into booked appointments or qualified leads.

How you should respond:
- Be friendly, confident, and concise.
- Ask 1 short clarifying question if needed.
- Focus on next steps: booking, availability, pricing, services, and FAQs.
- If the user is just browsing, offer a simple suggestion to book or leave contact info.
- Never mention you are “just a language model”. You are Aurea, the assistant.
- If you don’t know a detail (like exact pricing), say so and offer the best next step.
`;

const JOB1_SYSTEM_PROMPT =
  "You are Aurea Revenue Agent running JOB #1: Convert Website Visitors Into Bookings.\n" +
  "Goal: move the visitor toward booking with minimal friction.\n" +
  "Rules:\n" +
  "- Ask at most ONE question at a time.\n" +
  "- Keep replies short (2–5 sentences).\n" +
  "- Do NOT include any URLs.\n" +
  "- Do NOT invent services/pricing/hours.\n" +
  "- If you need info, ask a clarifying question.\n" +
  "- Do NOT mention jobs, routing, or internal systems.\n";

const JOB2_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    text: { type: "string" },
    askedField: {
      anyOf: [
        { type: "string", enum: ["desiredDay", "desiredTimeWindow"] },
        { type: "null" }
      ]
    }
  },
  required: ["text", "askedField"]
};

app.use(express.json());

// CORS + Origin allowlist (per-client). IMPORTANT: clientId must be in header for OPTIONS preflight.
app.use((req, res, next) => {
  const origin = req.headers.origin || null;

  // Only enforce allowlist on /chat (marketing site/static assets can remain public)
  if (req.path !== "/chat") {
    // minimal CORS for non-/chat endpoints (optional)
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    return next();
  }

  const clientId =
    (
      req.headers["x-aurea-client-id"] ||
      req.query?.clientId ||
      req.body?.clientId ||
      ""
    ).toString().trim();

  // Always advertise the headers/methods we accept
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Aurea-Client-Id");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");

  // Preflight requests do NOT include JSON body — header is required
  if (!clientId) {
    // Fail closed
    if (req.method === "OPTIONS") return res.sendStatus(403);
    return res.status(400).json({ error: "Missing clientId" });
  }

  const client = getClientConfig(clientId);
  if (!client) {
    if (req.method === "OPTIONS") return res.sendStatus(403);
    return res.status(403).json({ error: "Invalid clientId" });
  }

  // Origin is required for browser calls; allow server-to-server calls with no Origin header
  if (origin) {
    const ok = isOriginAllowed(origin, client);
    if (!ok) {
      if (req.method === "OPTIONS") return res.sendStatus(403);
      return res.status(403).json({ error: "Origin not allowed" });
    }

    // Set CORS for allowed origin
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  // If preflight passed, return success now
  if (req.method === "OPTIONS") return res.sendStatus(204);

  // attach clientConfig for /chat handler
  req.aureaClient = client;

  next();
});

app.use(express.static("public"));

// helpers (put these above app.post, below middleware is fine)
const HISTORY_LIMIT = 40;

function buildJob4Reply(routeFacts = {}) {
  const noAvail = !!routeFacts.noAvailability;
  const declined = !!routeFacts.bookingDecline;
  const cannotBookNow = !!routeFacts.cannotBookNow;
  const wantsReminderLater = !!routeFacts.wantsReminderLater;

  // A0) Wants to book later (delay, not schedule confusion)
  // Router only sets wantsReminderLater when bookingContext exists.
  if (wantsReminderLater) {
    return (
      "No problem — you don’t have to book right now.\n\n" +
      "If you leave your email or phone, I’ll send a quick reminder with the booking link so you can grab a time when you’re ready."
    );
  }
  
  // A) Schedule not set yet (cannot book right now)
  // Router only sends Job #4 for cannotBookNow when bookingContext exists, so this copy can assume intent.
  if (cannotBookNow) {
    return (
      "Totally fair — if you don’t know your schedule yet, you don’t have to book right now.\n\n" +
      "If you leave your email or phone, I’ll send a quick reminder and the booking link so you can choose a time when you’re ready."
    );
  }

  // B) No availability
  if (noAvail) {
    return (
      "Got it — there aren’t any times that fit right now.\n\n" +
      "If you leave your email or phone, I’ll follow up when a good opening comes up and include the best options."
    );
  }

  // C) Explicit booking decline
  if (declined) {
    return (
      "No problem.\n\n" +
      "If you leave your email or phone, I can send you the key details to review later so you don’t have to keep checking back."
    );
  }

  // D) Fallback (should be rare)
  return (
    "If you leave your email or phone, I can follow up with the details you were looking for."
  );
}

function buildJob7Reply(routeFacts = {}) {
  const r = String(routeFacts.escalationReason || "").toUpperCase();

  if (r === "SAFETY") {
    return "I can’t handle safety issues in chat. Please use the button below to contact the clinic right away.";
  }

  if (r === "LEGAL_DISPUTE") {
    return "I can’t help with disputes or chargebacks in chat. Please use the button below so the team can handle this directly.";
  }

  if (r === "MEDICAL") {
    return "I can’t provide medical advice. Please contact a clinician for medical questions. To reach the team about booking or clinic policies, use the button below.";
  }

  if (r === "STAFF_COMPLAINT") {
    return "I’m sorry that happened. I can’t resolve staff complaints in chat. Please use the button below and include what happened, the date, and your name.";
  }

  if (r === "PRIVACY_REQUEST") {
    return "I can’t process privacy or data requests in chat. Please use the button below so the team can handle it.";
  }

  // fallback
  return "That needs a human decision. Please use the button below and the team will follow up.";
}

function buildBookingAck(facts = {}, lastUserText = "", bookingIntentThisTurn = false) {
  const day = facts.desiredDay || null;
  const tw = facts.desiredTimeWindow || null;

  const t = String(lastUserText || "").toLowerCase();
  
  // If the user is delaying/hedging, don't repeat old day/time details
  const isDelayLanguage =
    t.includes("later") ||
    t.includes("not now") ||
    t.includes("not yet") ||
    t.includes("another time") ||
    t.includes("maybe");
  
  const isChangeLanguage =
    t.includes("actually") ||
    t.includes("instead");
  
  // Only treat "actually/instead" as delay if they are NOT booking in the same message
  const isDelay = (isDelayLanguage || isChangeLanguage) && !bookingIntentThisTurn;
  
  if (isDelay) return "No problem.";

  if (day && tw) return `Got it — ${day} ${tw}.`;
  if (day) return `Got it — ${day}.`;
  if (tw) return `Got it — ${tw}.`;
  return `Got it.`;
}

function isAllowedJob2Tail(text, allowedSentence) {
  if (!text) return false;
  const t = String(text).trim();

  // Option B: exact instruction (verbatim)
  if (t === String(allowedSentence || "").trim()) return true;
  
  // Option A: exactly ONE question (single sentence ending with "?")
  if (!t.endsWith("?")) return false;
  if (t.includes("\n")) return false;

  // Only one question mark total
  if (t.split("?").length !== 2) return false;

  // Optional: keep it tight so the model can't ramble
  if (t.length > 160) return false;

  return true;
}

function fallbackJob2Tail(facts = {}, allowedSentence = "") {
  const day = facts.desiredDay || null;
  const tw = facts.desiredTimeWindow || null;

  // Ask ONLY what’s missing; always ONE question
  if (!day && !tw) return "What day and general time window would you prefer?";
  if (!day) return "What day would you prefer?";
  if (!tw) return "What time window works best (morning, afternoon, or evening)?";

  // If nothing missing, deterministic instruction
  return String(allowedSentence || "").trim() || "Please click the button to choose a time.";
}

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim().length > 0
    )
    .slice(-HISTORY_LIMIT)
    .map((m) => ({
      role: m.role,
      content: m.content.trim(),
    }));
}

function isHoursQuestion(text) {
  const t = String(text || "").toLowerCase();
  return /\b(hours?|when are you open|open (today|tomorrow)?|closing time|opening time)\b/.test(t);
}

function containsHoursClaim(text) {
  const t = String(text || "").toLowerCase();

  // “hours/open/close” language
  if (/\b(hours?|open|opens|opening|close|closes|closing)\b/.test(t)) return true;

  // explicit time ranges like "9 AM", "5pm", "10:30 am"
  if (/\b\d{1,2}(:\d{2})?\s*(am|pm)\b/.test(t)) return true;

  // days + hours combos like "mon-fri"
  if (/\b(mon|tue|wed|thu|fri|sat|sun)(day)?\b/.test(t) && /\b(open|close|am|pm)\b/.test(t)) return true;

  return false;
}

function stripUrls(text) {
  if (!text) return text;
  return String(text)
    // remove http(s) URLs
    .replace(/\bhttps?:\/\/[^\s<]+/gi, "")
    // remove www. URLs
    .replace(/\bwww\.[^\s<]+/gi, "")
    // remove bare domains like example.com/path
    .replace(/\b[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s<]*)?/gi, "")
    // clean extra whitespace
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildDeterministicPricingReply(businessSummary) {
  const p = businessSummary?.pricing;

  // If pricing isn't present, be explicit and ask one short clarifier (Job #1 rules).
  if (!p) {
    return 'I don’t see pricing listed on this page. What do you want—services, how it works, or booking?';
  }

  // Normalize pricing into clean, fixed lines (no bullets).
  const lines = [];

  // Case 1: pricing is a simple string
  if (typeof p === "string") {
    lines.push(p.trim());
  }

  // Case 2: pricing is an array
  else if (Array.isArray(p)) {
    for (const item of p) {
      if (!item) continue;
      if (typeof item === "string") {
        lines.push(item.trim());
        continue;
      }
      if (typeof item === "object") {
        const name = item.name || item.title || item.plan || item.service || "";
        const price = item.price || item.amount || item.cost || "";
        const duration = item.duration || item.length || "";
        const parts = [name, price, duration].filter(Boolean).map(String);
        if (parts.length) lines.push(parts.join(" — "));
      }
    }
  }

  // Case 3: pricing is an object (common shapes: {plans:[...]}, {items:[...]}, {packages:[...]}, etc.)
  else if (typeof p === "object") {
    const candidateArrays = [
      p.plans,
      p.items,
      p.packages,
      p.services,
      p.options,
      p.prices,
    ];

    const arr = candidateArrays.find(x => Array.isArray(x));

    if (arr) {
      for (const item of arr) {
        if (!item) continue;
        if (typeof item === "string") {
          lines.push(item.trim());
          continue;
        }
        if (typeof item === "object") {
          const name = item.name || item.title || item.plan || item.service || "";
          const price = item.price || item.amount || item.cost || "";
          const duration = item.duration || item.length || "";
          const parts = [name, price, duration].filter(Boolean).map(String);
          if (parts.length) lines.push(parts.join(" — "));
        }
      }
    } else {
      // fallback: flatten top-level key/values
      for (const [k, v] of Object.entries(p)) {
        if (v == null) continue;
        if (typeof v === "string" || typeof v === "number") {
          lines.push(`${k}: ${String(v)}`.trim());
        }
      }
    }
  }

  // Final fallback if we couldn't extract anything usable
  if (!lines.length) {
    return 'I don’t see clear pricing details in the page data. What service are you looking for?';
  }

  // Fixed format, deterministic, short. No greeting. One short question at end.
  const clean = lines
    .map(s => String(s || "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .map(s => (s.length > 90 ? s.slice(0, 87) + "..." : s))
    .slice(0, 8);
  
  const body = clean.join("\n");
  
  // total hard cap (prevents runaway blobs)
  const finalBody = body.length > 600 ? body.slice(0, 597) + "..." : body;
  
  return `Pricing:\n${finalBody}\n\nWhat service are you considering?`;
  }

function logEscalationEvent({ conversationId, route, meta, siteKey, channel, message }) {
  const payload = {
    event: "AUREA_ESCALATION",
    ts: new Date().toISOString(),
    conversationId: conversationId || null,
    escalationReason: route?.facts?.escalationReason || null,
    routerBuild: route?._routerBuild || null,
    pageUrl: meta?.pageUrl || null,
    businessName: meta?.businessName || null,
    siteKey: siteKey || null,
    channel: channel || "unknown",
    messageHash: hashMessage(message),
  };

  console.log(JSON.stringify(payload));
}

const crypto = require("crypto");

function hashMessage(text) {
  if (!text || typeof text !== "string") return null;
  return crypto
    .createHash("sha256")
    .update(text)
    .digest("hex")
    .slice(0, 16); // short, non-reversible fingerprint
}

function detectReminderIntent(text = "") {
  const t = String(text || "").toLowerCase();

  // Strong phrases
  const strong =
    /\b(remind|reminder|notify|notification|follow\s*up|check\s*back|touch\s*base|touch\s*back|circle\s*back|reach\s*out|ping\s*me|text\s*me|message\s*me|sms\s*me)\b/i;

  // Weaker phrases that often imply “later”
  const soft =
    /\b(in\s+a\s+few\s+days|in\s+a\s+couple\s+days|next\s+week|later\s+this\s+week|later\s+on|another\s+time)\b/i;

  return strong.test(t) || soft.test(t);
}

function getBookingHandoffSentence(client) {
  const label = (client && typeof client.bookingPlatformLabel === "string" && client.bookingPlatformLabel.trim())
    ? client.bookingPlatformLabel.trim()
    : null;

  if (label) {
    return `I can’t book it directly here. I’ll send you to ${label} to choose the exact time.`;
  }

  return "I can’t book it directly here. I’ll send you to the booking page to choose the exact time.";
}

function containsHoursClaim(text) {
  const t = String(text || "").toLowerCase();
  return /\b(hours|open|close|closing|opening)\b/.test(t) || /\b\d{1,2}\s*(am|pm)\b/.test(t);
}

// NEW: chat endpoint (memory-aware)
app.post("/chat", async (req, res) => {
  try {
    const userMessage = req.body?.message;
    const conversationId = req.body?.conversationId; // optional for now
    const history = sanitizeHistory(req.body?.history);
    const clientId =
      (req.headers["x-aurea-client-id"] || req.body?.clientId || "").toString().trim();

    // middleware already validated this for /chat, but keep a hard check
    const client = req.aureaClient || getClientConfig(clientId);
    if (!client) {
      return res.status(403).json({ error: "Invalid client" });
    }

    const BOOKING_HANDOFF_SENTENCE = getBookingHandoffSentence(client);

    console.log("[CLIENT_RESOLVED]", {
      clientId: client.clientId,
      bookingPlatformLabel: client.bookingPlatformLabel || null,
      bookingUrlOverride: client.bookingUrlOverride || null,
      contactUrlOverride: client.contactUrlOverride || null,
      escalateUrlOverride: client.escalateUrlOverride || null,
    });

    // ✅ ROUTING (pre-model) — compute + log only, no behavior changes yet
    console.log("[SIGNALS_IN]", req.body?.signals || null);
    
    const route = routeMessage({
      message: userMessage || "",
      history: Array.isArray(history) ? history : [],
      signals: req.body?.signals || {},
      channel: req.body?.channel || "widget",
    });

    // ✅ Reminder / follow-up intent guard (deterministic)
    // If the user asks for a reminder / follow-up, do NOT enter Job #2.
    // Treat as wantsReminderLater and route to Job #4 with LEAVE_CONTACT.
    const reminderIntent = detectReminderIntent(userMessage || "");
    
    // If booking already started, reminder language means "not now / later" → exit Job #2.
    if (reminderIntent) {
      route.facts = route.facts || {};
      route.facts.wantsReminderLater = true;
      route.facts.reminderIntent = true; // for logging/visibility (optional but useful)
    
      // Force to Job #4 (widget-allowed) and deterministic lead CTA
      route.job = JOBS.JOB_4;
      route.cta = { type: "LEAVE_CONTACT" };
    }

    // Optional per-client job disables (fail-safe to JOB_1)
    if (client?.jobDisables && client.jobDisables[route.job] === true) {
      route.job = JOBS.JOB_1;
      route.cta = { type: "BOOK_NOW" };
    }

    console.log("[ROUTE]", route);
    console.log("[ROUTER_FACTS]", {
      desiredDay: route?.facts?.desiredDay || null,
      desiredTimeWindow: route?.facts?.desiredTimeWindow || null,
      serviceInterest: route?.facts?.serviceInterest || null,
      lastCtaClicked: req.body?.signals?.lastCtaClicked || null,
      bookingPageOpened: !!req.body?.signals?.bookingPageOpened,
    });

    // ✅ pull site context from widget payload
    const siteContext = req.body?.siteContext;
    const meta = req.body?.meta;
    
    // ✅ compute site key + context hash
    const siteKey = getSiteKey(siteContext?.origin || meta?.pageUrl);
    
    // ✅ get or create cached business summary
    let businessSummary = getCachedSummary(siteKey);
    const summaryWasCached = !!businessSummary;
    
    if (!businessSummary) {
      businessSummary = await summarizeSiteContext({ siteKey, siteContext });
    
    // Only cache successful summaries (avoid poisoning cache with failures)
    if (businessSummary && businessSummary._debug?.usedOpenAI && !businessSummary._debug?.error) {
        setCachedSummary(siteKey, businessSummary);
      } else {
        console.log("[siteSummary] not caching due to error", {
          siteKey,
          error: businessSummary?._debug?.error || "unknown",
        });
      }
    }
    
    if (!userMessage || typeof userMessage !== "string" || !userMessage.trim()) {
      return res.status(400).json({ error: "Missing 'message' in request body" });
    }

    // Build a message list from history.
    // If the widget already included the latest user message in history, this is enough.
    // If not (or history empty), we add it.
    const inputMessages = [...history];

    const last = inputMessages[inputMessages.length - 1];
    const latestTrimmed = userMessage.trim();

    const historyAlreadyHasLatest =
      last && last.role === "user" && last.content === latestTrimmed;

    if (!historyAlreadyHasLatest) {
      inputMessages.push({ role: "user", content: latestTrimmed });
    }

    // Put the business summary in a SYSTEM message so it stays top-priority
    const systemMessages = [
      {
        role: "system",
        content:
          AUREA_SYSTEM_PROMPT +
          "\n\nRules for using Business Summary:\n" +
          "- Use BUSINESS_SUMMARY as the source of truth for services, pricing, hours, booking links.\n" +
          "- Do NOT guess. If pricing is not present, say: \"I don’t see pricing listed on this page.\" \n" +
          "- If pricing IS present, list plans/prices clearly in bullet points.\n" +
          "- Do NOT include links. If the user asks how to book, tell them to use the CTA button.\n",
      },
      {
        role: "system",
        content:
          "BUSINESS_SUMMARY (authoritative JSON):\n" +
          JSON.stringify(businessSummary),
      },
    ];

    function firstNonEmpty(...vals) {
      for (const v of vals) {
        const s = (typeof v === "string" ? v : "").trim();
        if (s) return s;
      }
      return null;
    }
    
    function resolveCtaUrlStrict(ctaType, { bookingUrl, contactUrl, escalateUrl }) {
      if (ctaType === "LEAVE_CONTACT") return contactUrl || null;
      if (ctaType === "ESCALATE") return escalateUrl || null;
    
      if (ctaType === "BOOK_NOW" || ctaType === "CHOOSE_TIME" || ctaType === "CONFIRM_BOOKING") {
        return bookingUrl || null;
      }
    
      // Unknown CTA => no CTA shown
      return null;
    }
    
    // Deterministic CTA type (model never chooses)
    const pricingIntent = !!route?.facts?.pricingIntent;
    const ctaType = pricingIntent ? "LEAVE_CONTACT" : (route?.cta?.type || "BOOK_NOW");
    
    // ENV overrides are allowed ONLY for aurea (debug/dev), never for other clients
    const BOOKING_URL_OVERRIDE = (process.env.AUREA_BOOKING_URL_OVERRIDE || "").trim();
    const CONTACT_URL_OVERRIDE = (process.env.AUREA_CONTACT_URL_OVERRIDE || "").trim();
    const ESCALATE_URL_OVERRIDE = (process.env.AUREA_ESCALATE_URL_OVERRIDE || "").trim();
    const allowEnvFallback = client?.clientId === "aurea";
    
    // Per-client override wins, then site summary, then (aurea-only) env fallback.
    // NO cross-fallbacks.
    const bookingUrl = firstNonEmpty(
      client?.bookingUrlOverride,
      businessSummary?.bookingUrl,
      allowEnvFallback ? BOOKING_URL_OVERRIDE : ""
    );
    
    const contactUrl = firstNonEmpty(
      client?.contactUrlOverride,
      businessSummary?.contactUrl,
      allowEnvFallback ? CONTACT_URL_OVERRIDE : ""
    );
    
    const escalateUrl = firstNonEmpty(
      client?.escalateUrlOverride,
      businessSummary?.escalateUrl,
      allowEnvFallback ? ESCALATE_URL_OVERRIDE : ""
    );
    
    let ctaUrl = resolveCtaUrlStrict(ctaType, { bookingUrl, contactUrl, escalateUrl });
    
    console.log("[CTA_RESOLVED]", {
      clientId: client.clientId,
      ctaType,
      ctaUrl,
      bookingUrl,
      contactUrl,
      escalateUrl,
      siteKey,
      pageUrl: meta?.pageUrl || null,
    
      // DEBUG: prove where contactUrl came from
      contactUrlSource: {
        clientOverride: client?.contactUrlOverride || null,
        summary: businessSummary?.contactUrl || null,
        env:
          allowEnvFallback
            ? (process.env.AUREA_CONTACT_URL_OVERRIDE || "").trim() || null
            : null,
      },
    });

    // Strict hide: if required URL is missing, return NO CTA (ctaUrl = null)
    const needsUrl = ["BOOK_NOW", "CHOOSE_TIME", "CONFIRM_BOOKING", "LEAVE_CONTACT", "ESCALATE"].includes(ctaType);
    
    if (needsUrl && (!ctaUrl || typeof ctaUrl !== "string" || !ctaUrl.trim())) {
      console.error("[CTA_MISSING_URL]", {
        clientId: client?.clientId || clientId,
        ctaType,
        bookingUrl,
        contactUrl,
        escalateUrl,
        siteKey,
        pageUrl: meta?.pageUrl || null,
      });
    
      // Return a safe reply with NO CTA (widget will hide it)
      ctaUrl = null;
    }

    let aiReply = "How can I help you book today?";
    
    // Job #1 (plain text — NO structured output)
    if (route.job === JOBS.JOB_1) {
      const jobMessages = [
        { role: "system", content: JOB1_SYSTEM_PROMPT },
    
        // deterministic “browse mode” immediately after Job #4
        ...(route?.facts?.afterLeadCapture || route?.facts?.browseIntent
          ? [{
              role: "system",
              content:
                "BROWSE MODE.\n" +
                "RULES FOR THIS TURN:\n" +
                "- Do NOT greet.\n" +
                "- Do NOT ask about booking.\n" +
                "- Do NOT tell them to book.\n" +
                "- Answer the question using BUSINESS_SUMMARY.\n" +
                "- End with ONE short question to understand what info they want (services, pricing, how it works).\n" +
                "- Keep it to 1–3 sentences.\n"
            }]
          : []),
    
        ...systemMessages,
      ];
    
      // 1) Deterministic pricing path
      if (pricingIntent) {
        aiReply = stripUrls(buildDeterministicPricingReply(businessSummary));
      }
    
      // 2) Deterministic hours path (prevents weird phrasing/hallucination)
      else if (isHoursQuestion(latestTrimmed)) {
        if (businessSummary?.hours) {
          aiReply = `Hours: ${String(businessSummary.hours).trim()}\n\nDo you want to book, or ask about services?`;
        } else {
          aiReply =
            "I don’t see the clinic hours listed on this page. If you tap Book Now, the booking page will show the available times.";
        }
      }
    
      // 3) Normal Job 1 LLM response
      else {
        const job1Response = await openai.responses.create({
          model: "gpt-4.1-mini",
          input: [...jobMessages, ...inputMessages],
        });
    
        aiReply = stripUrls(job1Response.output_text || "No reply.");
    
        // Guard: never state hours unless BUSINESS_SUMMARY.hours is present
        if (!businessSummary?.hours && containsHoursClaim(aiReply)) {
          aiReply =
            "I don’t see the clinic hours listed on this page. If you tap Book Now, the booking page will show the available times.";
        }
      }
    }
      
    // Job #2
    else if (route.job === JOBS.JOB_2) {
      const f = route?.facts || {};
    
      const desiredDay = f.desiredDay || null;
      const desiredTimeWindow = f.desiredTimeWindow || null;
    
      // Determine the ONE thing we're missing
      let allowedQuestion = null;
      if (!desiredDay) allowedQuestion = "desiredDay";
      else if (!desiredTimeWindow) allowedQuestion = "desiredTimeWindow";
      else allowedQuestion = null;
    
      const job2Messages = [
        {
          role: "system",
          content:
            "You are JOB_2_EXECUTE_BOOKING.\n" +
            "Goal: help the user complete a booking step.\n\n" +
            "Hard rules:\n" +
            "- You MUST use the provided ROUTE_FACTS.\n" +
            "- You may ask at most ONE question.\n" +
            "- You may ONLY ask about ALLOWED_QUESTION.\n" +
            "- If ALLOWED_QUESTION is null: ask no questions; output the exact disclosure sentence.\n" +
            "- Do NOT mention any specific industry unless it is explicitly present in BUSINESS_SUMMARY.\n" +
            "- Do NOT include links.\n\n" +
            "ROUTE_FACTS:\n" +
            JSON.stringify({ desiredDay, desiredTimeWindow }) +
            "\n\n" +
            "ALLOWED_QUESTION:\n" +
            JSON.stringify(allowedQuestion) +
            "\n\n" +
            "OUTPUT RULES (STRICT):\n" +
            "You must output ONLY ONE of the following:\n" +
            "A) Exactly one question (a single sentence ending with \"?\") ONLY if required to proceed.\n" +
            "B) Exactly this sentence (verbatim, no changes): " + JSON.stringify(BOOKING_HANDOFF_SENTENCE) + "\n" +
            "\n" +
            "Do not confirm details.\n" +
            "Do not say \"Got it\".\n" +
            "Do not add extra sentences.\n" +
            "Do not add bullet points.\n" +
            "Do not include links.\n" +
            "Do not mention CTAs, routing, jobs, or internal systems.\n",
        },
        ...systemMessages,
      ];
    
      const response = await openai.responses.create({
        model: "gpt-4.1-mini",
        input: [...job2Messages, ...inputMessages],
        text: {
          format: {
            type: "json_schema",
            name: "job2_execute_booking",
            strict: true,
            schema: JOB2_RESPONSE_SCHEMA,
          },
        },
      });

      const raw = response.output_text || "";
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch {}

      // ✅ Deterministic first sentence from backend facts
      const lastUserText = (inputMessages || [])
        .filter(m => m && m.role === "user" && typeof m.content === "string")
        .map(m => m.content)
        .pop() || "";
      
      const ack = buildBookingAck(route?.facts || {}, lastUserText, !!route?.facts?.bookingIntent);

      // ✅ Model is ONLY allowed to produce the second sentence ("tail")
      const modelTail = (parsed && typeof parsed.text === "string") ? parsed.text : "";

      // ✅ Hard gate: if the model violates format, replace with deterministic fallback
      const tail = isAllowedJob2Tail(modelTail, BOOKING_HANDOFF_SENTENCE)
        ? modelTail.trim()
        : fallbackJob2Tail({ desiredDay, desiredTimeWindow }, BOOKING_HANDOFF_SENTENCE);

      aiReply = `${ack}\n\n${tail}`;
    }

    // Job #7 (deterministic — no OpenAI)
    else if (route.job === JOBS.JOB_7) {
      logEscalationEvent({
        conversationId,
        route,
        meta,
        siteKey,
        channel: req.body?.channel || "widget",
        message: userMessage,
      });
      aiReply = buildJob7Reply(route?.facts || {});
    }

    // Job #4 (deterministic — no OpenAI)
    else if (route.job === JOBS.JOB_4) {
      aiReply = buildJob4Reply(route?.facts || {});
    }
      
    // Everything else (keep your deterministic fallback for now)
    else {
      // Only booking-related fallbacks belong here
    if (ctaType !== "CHOOSE_TIME" && ctaType !== "BOOK_NOW" && ctaType !== "CONFIRM_BOOKING") {
      aiReply = "If you’d like, leave your contact info and we’ll follow up.";
    
      return res.json({
        reply: aiReply,
        conversationId: conversationId || null,
        route,
        ctaType,
        ctaUrl,
        siteDebug: {
          buildTag: "debug-v1",
          siteKey,
          summaryWasCached,
          summaryConfidence: businessSummary?.confidence ?? null,
          contextChars: businessSummary?._debug?.contextChars ?? null,
        },
        pricing: businessSummary?.pricing ?? null,
      
        bookingUrl: bookingUrl || null,
        contactUrl: contactUrl || null,
        escalateUrl: escalateUrl || null,
      
        services: businessSummary?.services ?? null,
      });
    }
      const f = route?.facts || {};
      const day = f.desiredDay ? String(f.desiredDay) : null;
      const win = f.desiredTimeWindow ? String(f.desiredTimeWindow) : null;
    
      if (day && win) aiReply = `Got it — ${day} ${win}. Click “Choose a time” to pick an available slot.`;
      else if (day && !win) aiReply = `Got it — ${day}. What time window works best: morning, afternoon, or evening?`;
      else if (!day && win) aiReply = `Got it — ${win}. What day are you aiming for (today, tomorrow, or later this week)?`;
      else aiReply = `What day are you aiming for (today/tomorrow/this week), and do you prefer morning, afternoon, or evening?`;
    }

    return res.json({
      reply: aiReply,
      conversationId: conversationId || null,
      route,
      ctaType,
      ctaUrl,
      siteDebug: {
        buildTag: "debug-v1",
        siteKey,
        summaryWasCached,
        summaryConfidence: businessSummary?.confidence ?? null,
        contextChars: businessSummary?._debug?.contextChars ?? null,
      },
    
      pricing: businessSummary?.pricing ?? null,
    
      bookingUrl: bookingUrl || null,
      contactUrl: contactUrl || null,
      escalateUrl: escalateUrl || null,
    
      services: businessSummary?.services ?? null,
    });
    
  } catch (error) {
    console.error("OpenAI error:", error);
    return res.status(500).json({
      reply: "Something went wrong.",
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});


