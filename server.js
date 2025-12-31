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
          "- If a booking link is present, include it when the user asks how to book.\n",
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
    const ctaUrl =
      ctaType === "LEAVE_CONTACT"
        ? (businessSummary?.bookingUrl || null) // for now, reuse bookingUrl (your Aurea contact page)
        : (businessSummary?.bookingUrl || null);

    
    let aiReply = "How can I help you book today?";
    
    // Job #1
    if (route.job === JOBS.JOB_1) {
      const jobMessages = [
        { role: "system", content: JOB1_SYSTEM_PROMPT },
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
      let parsed;
      try { parsed = JSON.parse(raw); } catch { parsed = null; }
      
      aiReply = parsed?.text || "No reply.";

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
            "Response requirements:\n" +
            "- First sentence: confirm what we captured (e.g., 'Got it — tomorrow afternoon.').\n" +
            "- Then either ask the one allowed question OR instruct them to click the CTA.\n",
        },
        ...systemMessages,
      ];
    
      const response = await openai.responses.create({
        model: "gpt-4.1-mini",
        input: [...job2Messages, ...inputMessages],
        text: {
          format: {
            type: "json_schema",
            strict: true,
            schema: JOB2_RESPONSE_SCHEMA,
          },
        },
      });
      
      const raw = response.output_text || "";
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch {}
      aiReply = parsed?.text || "No reply.";

    }
    
    // Everything else (keep your deterministic fallback for now)
    else {
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


