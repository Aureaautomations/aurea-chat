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
  
  // Job #7 triggers (tight + auditable)
  escalationSafety: /\b(threat(en)?|kill|hurt|attack|violence|weapon|stalk(ing)?|harass(ment)?|unsafe|danger)\b/i,
  
  escalationLegal: /\b(chargeback|dispute|lawsuit|sue|attorney|lawyer|legal action|fraud|scam|report you)\b/i,
  
  escalationMedical: /\b(diagnose|diagnosis|medical advice|treat(ment)? advice|is it safe|contraindication|pregnan(t|cy)|symptom(s)?)\b/i,
  
  escalationStaffComplaint: /\b(complain(t)?|complaint|rude|unprofessional|assault|inappropriate|touched me|injured me|refund)\b/i,
  
  escalationPrivacy: /\b(delete my data|remove my data|privacy request|PIPEDA|PHIPA|HIPAA|GDPR)\b/i,

  cannotBookNow: /\b(i\s*(do\s*not|don'?t)\s*(know|have)\s*(my\s*)?(availability|schedule)|i\s*(do\s*not|don'?t)\s*(know|have)\s*when\s*i'?m\s*free|(not|n'?t)\s*sure(\s*yet)?(\s*when\s*i'?m\s*free)?|need\s*to\s*check(\s*my)?\s*(availability|schedule)|have\s*to\s*check(\s*my)?\s*(availability|schedule)|let\s*me\s*check(\s*my)?\s*(availability|schedule)|i\s*need\s*to\s*look\s*at\s*my\s*schedule|i\s*have\s*to\s*look\s*at\s*my\s*schedule|i\s*(do\s*not|don'?t)\s*know\s*yet|not\s*sure\s*yet)\b/i,

  bookingIntent: /\b(book|booking|schedule|appointment|times?|today|tomorrow|this week|next week)\b/i,
  availabilityIntent: /\b(availability|available)\b/i,

  // Booking DELAY = explicit deferral (NOT rescheduling or time preference)
  bookingDelay: /\b(not yet|maybe later|not now|another time|some other time|i[' ]?ll (book|schedule) (later|another time)|i[' ]?ll do it later|in a bit)\b/i,

  reminderIntent: /\b(remind|reminder|notify|notification|follow\s*up|check\s*back|touch\s*back|touch\s*base|circle\s*back|reach\s*out|ping\s*me)\b/i,
  
  // Booking DECLINE (exit Job #2)
  bookingDecline: /\b(no thanks|no thank you|nah|nope|don'?t want to book|not booking|stop|leave me alone)\b/i,

  // No availability (Job #4)
  noAvailability: /\b(no times|nothing available|fully booked|no availability|sold out)\b/i,

  // Simple “ready” confirmations (Job #2 when Job #1 was active)
  readyConfirm: /^\s*(yes|yeah|yep|ok(ay)?|let'?s do it|book it)\s*$/i,

  // Service/duration selection (used for facts; Job #3 is hard-blocked for now anyway)
  duration: /\b(30|45|60|75|90)\s*(min|mins|minutes)\b/i,
  serviceHint: /\b(service|treatment|session|package|plan|membership|add-?on|upgrade)\b/i,

  pricingIntent: /\b(prices?|pricing|costs?|rates?|fee|fees|how much|plans?)\b/i,

  dayHint: /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|this week|next week)\b/i,
  timeWindow: /\b(morning|afternoon|evening|tonight)\b/i,
  serviceInterest: /\b(sms|text|email|re-?engagement|welcome|lead capture|reminders?|reviews?)\b/i,
  timeSelectionIntent: /\b(choose a time|pick a time|select a time|what (day|time)|when (are you|is)|available times?|openings?|slots?)\b/i,

  browseIntent: /\b(just browsing|just looking|browsing|looking around|curious|info|information|tell me about|what do you offer|services|how does it work|website( link)?|site( link)?|url|link)\b/i,
};

// --- helpers ---
function safeString(x) {
  return typeof x === "string" ? x : "";
}

function historyShowsBookingIntent(history = []) {
  const recent = history.slice(-20);

  return recent.some(m => {
    const role = (m.role || "").toLowerCase();
    if (role !== "user") return false;

    const text = String(m.content || m.text || "").toLowerCase();
    return /\b(book|booking|consultation|schedule|appointment|call)\b/.test(text);
  });
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
  const priorFacts = (s.routerFacts && typeof s.routerFacts === "object") ? s.routerFacts : {};
  const lastCtaClicked = safeString(s.lastCtaClicked); // e.g., "BOOK_NOW"
  const bookingPageOpened = Boolean(s.bookingPageOpened);
  const lastJob = safeString(s.lastJob); // e.g., "JOB_4_CAPTURE_LEAD"
  const bookingContext =
    bookingPageOpened ||
    ["BOOK_NOW", "CHOOSE_TIME", "CONFIRM_BOOKING"].includes(lastCtaClicked) ||
    Boolean(priorFacts.bookingIntent) ||
    historyShowsBookingIntent(history);

  // derived facts (deterministic booleans)
  const facts = {
    bookingIntent:
      RE.bookingIntent.test(text) ||
      RE.bookingIntent.test(lastUser) ||
      ["BOOK_NOW", "CHOOSE_TIME", "CONFIRM_BOOKING"].includes(lastCtaClicked) ||
      bookingPageOpened,
    
    reminderIntent: RE.reminderIntent.test(text),

    wantsReminderLater:
      bookingContext &&
      (
        RE.bookingDelay.test(text) ||
        RE.reminderIntent.test(text)
      ) &&
      !RE.cannotBookNow.test(text) &&
      !RE.bookingDecline.test(text) &&
      !RE.noAvailability.test(text),
  
    // Decline means “do not continue booking flow”.
    // Treat "no availability" as NOT a decline — it's a capture-lead scenario.
    bookingDecline:
      bookingContext &&
      RE.bookingDecline.test(text) &&
      !RE.browseIntent.test(text) &&
      !RE.noAvailability.test(text),

    cannotBookNow: RE.cannotBookNow.test(text),

    noAvailability: RE.noAvailability.test(text),
    afterLeadCapture: Boolean(s.leadOfferMade),

    browseIntent: RE.browseIntent.test(text),
    pricingIntent: RE.pricingIntent.test(text) && !RE.browseIntent.test(text),

    hasServiceSelected:
      RE.duration.test(text) ||
      RE.serviceHint.test(text) ||
      RE.serviceInterest.test(text),

    desiredDay: ((text.match(RE.dayHint) || lastUser.match(RE.dayHint)) || [])[0] || null,
    desiredTimeWindow: ((text.match(RE.timeWindow) || lastUser.match(RE.timeWindow)) || [])[0] || null,
    serviceInterest: (text.match(RE.serviceInterest) || [])[0] || null,

    timeSelectionIntent:
      RE.dayHint.test(text) ||
      RE.timeWindow.test(text) ||
      RE.timeSelectionIntent.test(text),


    firstTimeLikely: /\b(first time|new (client|customer)|never been)\b/i.test(text),

    // leave false for now; you are NOT implementing Job #3 yet
    upgradeEligible: false,

    bookingBlocked: Boolean(priorFacts.bookingBlocked),
  };

  const mergedFacts = {
    ...priorFacts,
    ...facts,
    // keep prior values if this turn didn’t find a new one
    desiredDay: facts.desiredDay || priorFacts.desiredDay || null,
    desiredTimeWindow: facts.desiredTimeWindow || priorFacts.desiredTimeWindow || null,
    serviceInterest: facts.serviceInterest || null,
    pricingIntent: facts.pricingIntent || false,
    // NEW: once noAvailability happens, block Job #2 from re-entering
    // Clear ONLY when a fresh booking intent happens (book words or booking CTA click)
    bookingBlocked:
      (Boolean(priorFacts.bookingBlocked) && !facts.bookingIntent) || facts.noAvailability,
  };

  // Clear escalation flags unless this turn is actively escalating
  const escalationTriggeredThisTurn =
    RE.escalationSafety.test(text) ||
    RE.escalationLegal.test(text) ||
    RE.escalationMedical.test(text) ||
    RE.escalationPrivacy.test(text) ||
    RE.escalationStaffComplaint.test(text);
  
  if (!escalationTriggeredThisTurn) {
    delete mergedFacts.escalationReason;
  }

  // ---- PRIORITY ORDER (LOCKED) ---- :contentReference[oaicite:1]{index=1}
  // 1) Job #7 Escalation Gate
  let escalationReason = null;

  if (RE.escalationSafety.test(text)) escalationReason = "SAFETY";
  else if (RE.escalationLegal.test(text)) escalationReason = "LEGAL_DISPUTE";
  else if (RE.escalationMedical.test(text)) escalationReason = "MEDICAL";
  else if (RE.escalationPrivacy.test(text)) escalationReason = "PRIVACY_REQUEST";
  else if (RE.escalationStaffComplaint.test(text)) escalationReason = "STAFF_COMPLAINT";
  
  if (escalationReason) {
    return {
      job: JOBS.JOB_7,
      facts: { ...mergedFacts, escalationReason },
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
    !facts.noAvailability &&
    !facts.bookingDecline &&
    !facts.cannotBookNow &&
    !facts.wantsReminderLater &&
    !mergedFacts.bookingBlocked &&
    (
      // If they clicked a booking CTA or opened booking page, Job #2 can run
      ["BOOK_NOW", "CHOOSE_TIME", "CONFIRM_BOOKING"].includes(lastCtaClicked) ||
      bookingPageOpened ||
    
      // Otherwise, only enter Job #2 when they are clearly selecting a time
      (facts.bookingIntent && facts.timeSelectionIntent) ||
    
      // Ready-confirm is only meaningful if they are in time-selection mode
      (RE.readyConfirm.test(text) && facts.timeSelectionIntent)
    )

  ) {
    return {
      job: JOBS.JOB_2,
      facts: mergedFacts,
      cta: { type: "CHOOSE_TIME" },
      _routerBuild: ROUTER_BUILD,
    };
  }
  
  // 3.5) Sticky Job #2: if booking started anywhere in recent history, stay in Job #2
  const bookingInProgress =
    mergedFacts.bookingIntent === true || historyShowsBookingIntent(history);
  
  if (
    bookingInProgress &&
    !facts.bookingDecline &&
    !facts.noAvailability &&
    !facts.cannotBookNow &&
    !facts.wantsReminderLater &&
    !mergedFacts.bookingBlocked
    && (
      ["BOOK_NOW", "CHOOSE_TIME", "CONFIRM_BOOKING"].includes(lastCtaClicked) ||
      bookingPageOpened ||
      facts.timeSelectionIntent
    )
  ) {
    return {
      job: JOBS.JOB_2,
      facts: {
        ...mergedFacts,
        bookingIntent: true,
      },
      cta: { type: "CHOOSE_TIME" },
      _routerBuild: ROUTER_BUILD,
    };
  }

  // 5) Job #4 Capture Lead (one-shot per chat)
  // Only offer lead capture if we haven't already offered it this conversation.
  const leadOfferMade = Boolean(s.leadOfferMade);
  
  if (
    (facts.noAvailability ||
      facts.bookingDecline ||
      facts.wantsReminderLater ||
      (facts.cannotBookNow && bookingContext)) &&
    !leadOfferMade
  ) {
    
    return {
      job: JOBS.JOB_4,
      facts: mergedFacts,
      cta: { type: "LEAVE_CONTACT" },
      _routerBuild: ROUTER_BUILD,
    };
  }

  // 6) Job #1 Convert Visitor (default)
  const job1CtaType =
  facts.afterLeadCapture || facts.browseIntent || RE.pricingIntent.test(text)
    ? "LEAVE_CONTACT"
    : "BOOK_NOW";

  return {
    job: JOBS.JOB_1,
    facts: mergedFacts,
    cta: { type: job1CtaType },
    _routerBuild: ROUTER_BUILD,
  };
}

module.exports = {
  JOBS,
  routeMessage,
};
