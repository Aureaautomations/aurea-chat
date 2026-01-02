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

  // A) No availability
  if (noAvail) {
    return (
      "Got it — there aren’t any times that fit right now.\n\n" +
      "If you leave your email or phone, I’ll follow up when a good opening comes up and include the best options."
    );
  }

  // B) Explicit booking decline
  if (declined) {
    return (
      "No problem.\n\n" +
      "If you leave your email or phone, I can send you the key details to review later so you don’t have to keep checking back."
    );
  }

  // C) Fallback (should be rare)
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

function isAllowedJob2Tail(text) {
  if (!text) return false;
  const t = String(text).trim();

  // Option B: exact instruction (verbatim)
  if (t === "Please click the button to choose a time.") return true;

  // Option A: exactly ONE question (single sentence ending with "?")
  if (!t.endsWith("?")) return false;
  if (t.includes("\n")) return false;

  // Only one question mark total
  if (t.split("?").length !== 2) return false;

  // Optional: keep it tight so the model can't ramble
  if (t.length > 160) return false;

  return true;
}

function fallbackJob2Tail(facts = {}) {
  const day = facts.desiredDay || null;
  const tw = facts.desiredTimeWindow || null;

  // Ask ONLY what’s missing; always ONE question
  if (!day && !tw) return "What day and general time window would you prefer?";
  if (!day) return "What day would you prefer?";
  if (!tw) return "What time window works best (morning, afternoon, or evening)?";

  // If nothing missing, deterministic instruction
  return "Please click the button to choose a time.";
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

    // ✅ ROUTING (pre-model) — compute + log only, no behavior changes yet
    console.log("[SIGNALS_IN]", req.body?.signals || null);
    
    const route = routeMessage({
      message: userMessage || "",
      history: Array.isArray(history) ? history : [],
      signals: req.body?.signals || {},
      channel: req.body?.channel || "widget",
    });

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
    const contextHash = hashSiteContext(siteContext);
    
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
    // Deterministic CTA type (model never chooses)
    const pricingIntent = !!route?.facts?.pricingIntent;
    const ctaType = pricingIntent ? "LEAVE_CONTACT" : (route?.cta?.type || "BOOK_NOW");
    
    // IMPORTANT: CTA URL must match CTA type.
    // - CHOOSE_TIME / BOOK_NOW / CONFIRM_BOOKING should go to the bookingUrl (real booking page)
    // - LEAVE_CONTACT should go to a lead/contact page (if you have one)
    
    // ENV overrides should NEVER apply across clients.
    // Only allow env overrides for the "aurea" client as a last-resort fallback.
    const BOOKING_URL_OVERRIDE = (process.env.AUREA_BOOKING_URL_OVERRIDE || "").trim();
    const CONTACT_URL_OVERRIDE = (process.env.AUREA_CONTACT_URL_OVERRIDE || "").trim();
    const ESCALATE_URL_OVERRIDE = (process.env.AUREA_ESCALATE_URL_OVERRIDE || "").trim();
    
    const allowEnvFallback = client?.clientId === "aurea";
    
    // Per-client override wins, then site summary, then (aurea-only) env fallback.
    const bookingUrl =
      (client?.bookingUrlOverride || businessSummary?.bookingUrl || (allowEnvFallback ? BOOKING_URL_OVERRIDE : "") || "").trim() || null;
    
    const contactUrl =
      (client?.contactUrlOverride || businessSummary?.contactUrl || (allowEnvFallback ? CONTACT_URL_OVERRIDE : "") || "").trim() || null;
    
    const escalateUrl =
      (client?.escalateUrlOverride || businessSummary?.contactUrl || contactUrl || (allowEnvFallback ? ESCALATE_URL_OVERRIDE : "") || "").trim() || null;

    let ctaUrl = null;
    
    if (ctaType === "LEAVE_CONTACT") {
      ctaUrl = contactUrl;
    } else if (ctaType === "ESCALATE") {
      ctaUrl = escalateUrl;
    } else if (["BOOK_NOW", "CHOOSE_TIME", "CONFIRM_BOOKING"].includes(ctaType)) {
      ctaUrl = bookingUrl;
    } else {
      ctaUrl = bookingUrl;
    }

    let aiReply = "How can I help you book today?";
    
    // Job #1 (plain text — NO structured output)
    if (route.job === JOBS.JOB_1) {
      const jobMessages = [
        { role: "system", content: JOB1_SYSTEM_PROMPT },
      
    // NEW: deterministic “browse mode” immediately after Job #4
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

      if (pricingIntent) {
        aiReply = stripUrls(buildDeterministicPricingReply(businessSummary));  
      } else {
      const job1Response = await openai.responses.create({
        model: "gpt-4.1-mini",
        input: [...jobMessages, ...inputMessages],
        // IMPORTANT: no text.format here
      });
    
      aiReply = stripUrls(job1Response.output_text || "No reply.");
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
            "- If ALLOWED_QUESTION is null: ask no questions; tell them to click the CTA to choose a time.\n" +
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
            "B) Exactly this sentence (verbatim, no changes): \"Please click the button to choose a time.\"\n" +
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
      const tail = isAllowedJob2Tail(modelTail)
        ? modelTail.trim()
        : fallbackJob2Tail({ desiredDay, desiredTimeWindow });

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
        bookingUrl: businessSummary?.bookingUrl ?? null,
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
    
      // TEMP: prove what the model is seeing
      pricing: businessSummary?.pricing ?? null,
      bookingUrl: businessSummary?.bookingUrl ?? null,
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


