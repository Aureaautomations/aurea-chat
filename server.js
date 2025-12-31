require("dotenv").config();

const { routeMessage, JOBS } = require("./router");

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

// Allow requests from your frontend (including file:// during dev)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");

  if (req.method === "OPTIONS") return res.sendStatus(200);

  next();
});

app.use(express.static("public"));

// helpers (put these above app.post, below middleware is fine)
const HISTORY_LIMIT = 40;

function buildJob4Reply(routeFacts = {}) {
  const noAvail = !!routeFacts.noAvailability;
  const declined = !!routeFacts.bookingDecline;

  if (noAvail) {
    return (
      "No problem — it looks like there aren’t any times that match right now.\n\n" +
      "If you leave your contact info, we’ll follow up with options."
    );
  }

  if (declined) {
    return (
      "No problem.\n\n" +
      "If you want, leave your contact info and we can follow up—otherwise feel free to keep browsing."
    );
  }

  // generic capture-lead fallback
  return (
    "If you’d like, leave your contact info and we’ll follow up."
  );
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

// NEW: chat endpoint (memory-aware)
app.post("/chat", async (req, res) => {
  try {
    const userMessage = req.body?.message;
    const conversationId = req.body?.conversationId; // optional for now
    const history = sanitizeHistory(req.body?.history);

    // ✅ ROUTING (pre-model) — compute + log only, no behavior changes yet
    const route = routeMessage({
      message: userMessage || "",
      history: Array.isArray(history) ? history : [],
      signals: req.body?.signals || {},
      channel: req.body?.channel || "widget",
    });
    
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
    const ctaType = route?.cta?.type || "BOOK_NOW";
    
    // IMPORTANT: CTA URL must match CTA type.
    // - CHOOSE_TIME / BOOK_NOW / CONFIRM_BOOKING should go to the bookingUrl (real booking page)
    // - LEAVE_CONTACT should go to a lead/contact page (if you have one)
    
    // ENV overrides (lets you force a real scheduler link when site extraction is wrong/missing)
    const BOOKING_URL_OVERRIDE = (process.env.AUREA_BOOKING_URL_OVERRIDE || "").trim();
    const CONTACT_URL_OVERRIDE = (process.env.AUREA_CONTACT_URL_OVERRIDE || "").trim();
    
    const bookingUrl =
      (BOOKING_URL_OVERRIDE ? BOOKING_URL_OVERRIDE : (businessSummary?.bookingUrl || "")).trim() || null;
    
    const contactUrl =
      (CONTACT_URL_OVERRIDE
        ? CONTACT_URL_OVERRIDE
        : (businessSummary?.contactUrl || businessSummary?.bookingUrl || "")
      ).trim() || null;
    
    let ctaUrl = null;
    
    if (ctaType === "LEAVE_CONTACT") {
      ctaUrl = contactUrl;
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
        ...systemMessages,
      ];
    
      const response = await openai.responses.create({
        model: "gpt-4.1-mini",
        input: [...jobMessages, ...inputMessages],
        // IMPORTANT: no text.format here
      });
    
      aiReply = response.output_text || "No reply.";
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


