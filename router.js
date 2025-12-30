// router.js — deterministic, pre-model router
// Picks exactly one job for each user message.
// IMPORTANT: No OpenAI calls in here.

const JOBS = {
  JOB_1: "JOB_1_CONVERT_VISITOR",
  JOB_2: "JOB_2_EXECUTE_BOOKING",
  JOB_3: "JOB_3_INCREASE_ABV",
  JOB_4: "JOB_4_CAPTURE_LEAD",
  JOB_5: "JOB_5_REFILL_CANCELLATIONS",
  JOB_6: "JOB_6_RETAIN_REBOOK",
  JOB_7: "JOB_7_ESCALATION_GATE",
};

const ROUTER_BUILD = "router-build-2025-12-30-01";

// --- keyword/regex detectors (keep these tight + auditable) ---
const RE = {
  // Job #7 triggers (examples from your spec: legal/medical, threats, chargebacks, harassment, therapist complaint)
  escalation: /\b(diagnose|treat|medical advice|should i take|lawsuit|sue|legal advice|chargeback|refund dispute|fraud|harass|threat|unsafe|injury|complain(t)?|therapist issue)\b/i,

  // Booking execution intent (Job #2)
  bookingIntent: /\b(book|booking|schedule|appointment|availability|available|times?|today|tomorrow|this week|next week)\b/i,

  // Booking decline / hesitation (Job #4)
  bookingDeclined: /\b(not yet|maybe later|just looking|i[' ]?ll think|not ready|no thanks|don'?t want to book)\b/i,

  // No availability (Job #4)
  noAvailability: /\b(no times|nothing available|fully booked|no availability|sold out)\b/i,

  // Simple “ready” confirmations (Job #2 when Job #1 was active)
  readyConfirm: /^\s*(yes|yeah|yep|ok(ay)?|let'?s do it|book it)\s*$/i,

  // Service/duration selection (used for facts; Job #3 is hard-blocked for now anyway)
  duration: /\b(30|45|60|75|90)\s*(min|mins|minutes)\b/i,
  serviceHint: /\b(deep tissue|relaxation|swedish|sports massage|prenatal|hot stone)\b/i,

  pricingIntent: /\b(prices?|pricing|costs?|rates?|fee|fees|how much|plans?)\b/i,
};

// --- helpers ---
function safeString(x) {
  return typeof x === "string" ? x : "";
}

function lastUserMessage(history) {
  if (!Array.isArray(history)) return "";
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m && m.role === "user" && typeof m.content === "string") return m.content;
  }
  return "";
}

// --- main router ---
function routeMessage({ message, history, signals, channel = "widget" }) {
  const text = safeString(message).trim();
  const lastUser = lastUserMessage(history);

  // normalize signals (v1 may be absent)
  const s = signals || {};
  const lastCtaClicked = safeString(s.lastCtaClicked); // e.g., "BOOK_NOW"
  const bookingPageOpened = Boolean(s.bookingPageOpened);

  // derived facts (deterministic booleans)
  const facts = {
    bookingIntent:
      RE.bookingIntent.test(text) ||
      RE.bookingIntent.test(lastUser) ||
      ["BOOK_NOW", "CHOOSE_TIME", "CONFIRM_BOOKING"].includes(lastCtaClicked) ||
      bookingPageOpened,

    bookingDeclined: RE.bookingDeclined.test(text) || RE.noAvailability.test(text),

    hasServiceSelected: RE.duration.test(text) || RE.serviceHint.test(text),

    firstTimeLikely: /\b(first time|new (client|customer)|never been)\b/i.test(text),

    // leave false for now; you are NOT implementing Job #3 yet
    upgradeEligible: false,
  };

  // ---- PRIORITY ORDER (LOCKED) ---- :contentReference[oaicite:1]{index=1}
  // 1) Job #7 Escalation Gate
  if (RE.escalation.test(text)) {
    return {
      job: JOBS.JOB_7,
      facts,
      cta: { type: "ESCALATE" },
      _routerBuild: ROUTER_BUILD,
    };
  }

  // 2) Job #5 / #6 are hard-blocked from widget
  if (channel === "widget") {
    // never route to 5/6
  }

  // 3) Job #2 Execute Booking Process
  if (
    ["BOOK_NOW", "CHOOSE_TIME", "CONFIRM_BOOKING"].includes(lastCtaClicked) ||
    RE.bookingIntent.test(text) ||
    (RE.readyConfirm.test(text) && facts.bookingIntent)
  ) {
    return {
      job: JOBS.JOB_2,
      facts,
      cta: { type: "CHOOSE_TIME" },
      _routerBuild: ROUTER_BUILD,
    };
  }

  // 4) Job #3 Increase ABV (disabled until you explicitly enable it)
  // if (...) return { job: JOBS.JOB_3, ... }

  // 5) Job #4 Capture Lead
  if (facts.bookingDeclined) {
    return {
      job: JOBS.JOB_4,
      facts,
      cta: { type: "LEAVE_CONTACT" },
      _routerBuild: ROUTER_BUILD,
    };
  }

  // 6) Job #1 Convert Visitor (default)
  const job1CtaType = RE.pricingIntent.test(text)
    ? "LEAVE_CONTACT"
    : "BOOK_NOW";
  
  return {
    job: JOBS.JOB_1,
    facts,
    cta: { type: job1CtaType },
    _routerBuild: ROUTER_BUILD,
  };
}

module.exports = {
  JOBS,
  routeMessage,
};
