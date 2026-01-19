// responseSafetyFilter.js
// V1 deterministic guardrail: run AFTER aiReply is produced, BEFORE res.json()

function normalizeText(s) {
  return String(s || "").replace(/\r\n/g, "\n").trim();
}

function containsContactCollection(text) {
  const t = String(text || "").toLowerCase();

  // Asking for or collecting contact info "in chat"
  return (
    /\b(leave|drop|share|send)\s+(your\s+)?(phone|number|email)\b/.test(t) ||
    /\bwhat('?s| is)\s+your\s+(phone|number|email)\b/.test(t) ||
    /\b(can you|please)\s+(give|share|send)\s+(me\s+)?(your\s+)?(phone|number|email)\b/.test(t) ||
    /\b(text|sms|email)\s+me\s+at\b/.test(t) ||
    /\b(contact\s*info|your\s*contact\s*info|leave\s*(your\s*)?contact\s*info)\b/.test(t)
  );
}

function containsCapabilityDrift(text) {
  const t = String(text || "").toLowerCase();

  // Claims we must not make (V1)
  return (
    /\b(i('| a)?ll|we('| a)?ll)\s+(text|sms|email|call)\b/.test(t) ||
    /\b(i|we)\s+can\s+(text|sms|email|call)\b/.test(t) ||
    /\b(i|we)\s+will\s+remind\b/.test(t) ||
    /\b(set up|schedule)\s+(a\s+)?reminder\b/.test(t) ||
    /\b(i|we)\s+(booked|scheduled)\s+(you|it)\b/.test(t) ||
    /\b(i|we)\s+confirmed\s+(your\s+)?appointment\b/.test(t)
  );
}

function containsCantFindLinkLanguage(text) {
  const t = String(text || "").toLowerCase();
  return (
    /\b(can'?t|cannot|couldn'?t|unable to)\s+(find|see|locate)\b/.test(t) ||
    /\b(i don'?t see)\s+(a\s+)?(booking|contact)\b/.test(t) ||
    /\b(no\s+booking\s+link|no\s+contact\s+link)\b/.test(t)
  );
}

function containsPricingClaim(text) {
  const t = String(text || "").toLowerCase();

  // Hard indicators: dollar amounts, "from $", "only $", "$120", etc.
  if (/\$\s*\d/.test(t)) return true;
  if (/\b\d+\s*(dollars|cad|usd)\b/.test(t)) return true;
  if (/\b(from|starting at|only)\s*\$?\s*\d/.test(t)) return true;

  return false;
}

function containsHoursClaim(text) {
  const t = String(text || "").toLowerCase();

  if (/\b(hours?|open|opens|opening|close|closes|closing)\b/.test(t)) return true;
  if (/\b\d{1,2}(:\d{2})?\s*(am|pm)\b/.test(t)) return true;
  if (/\b(mon|tue|wed|thu|fri|sat|sun)(day)?\b/.test(t) && /\b(open|close|am|pm)\b/.test(t)) return true;

  return false;
}

function safeCtaInstruction(ctaType, ctaUrl) {
  const hasCta = typeof ctaUrl === "string" && ctaUrl.trim().length > 0;

  // If there is NO CTA, do not tell them to tap a button.
  if (!hasCta) {
    return "I can help with services, pricing, or how booking works — what do you want to know?";
  }

  if (ctaType === "LEAVE_CONTACT") return 'Tap “Leave contact info” and the team will follow up.';
  if (ctaType === "ESCALATE") return "Please use the button below to contact the team.";
  return 'Tap “Book now” to choose an available time.';
}

/**
 * V1 filter: does NOT change ctaType/ctaUrl.
 * It only rewrites reply text to enforce rules.
 */
function applyResponseSafetyFilter({ reply, ctaType, ctaUrl, businessSummary }) {
  let text = normalizeText(reply);
  const original = text;
  const reasons = [];

function setText(newText, reason) {
  const next = normalizeText(newText);
  if (next && next !== text) {
    text = next;
    if (reason) reasons.push(reason);
  } else if (reason) {
    // Even if text ends up same, still track why we evaluated it
    // (optional; remove if you only want reasons when changed)
    reasons.push(reason);
  }
}

// 1) In-chat contact capture language
if (containsContactCollection(text)) {
  setText(safeCtaInstruction(ctaType, ctaUrl), "ASKS_FOR_CONTACT_IN_CHAT");
}

// 2) “can’t find booking/contact”
if (containsCantFindLinkLanguage(text)) {
  setText(safeCtaInstruction(ctaType, ctaUrl), "CANT_FIND_BOOKING_OR_CONTACT");
}

// 3) Capability drift (text/email/call/remind/booked/confirmed)
if (containsCapabilityDrift(text)) {
  setText(safeCtaInstruction(ctaType, ctaUrl), "CAPABILITY_DRIFT");
}

// 4) Hours guard: only allowed if BUSINESS_SUMMARY.hours exists
const hasHours = !!(businessSummary && businessSummary.hours);
if (!hasHours && containsHoursClaim(text)) {
  setText(
    'I don’t see hours listed on this page. ' + safeCtaInstruction(ctaType, ctaUrl),
    "HOURS_WITHOUT_SOURCE"
  );
}

// 5) Pricing guard: block numeric pricing only when pricing is missing
const p = businessSummary ? businessSummary.pricing : null;
const hasPricing =
  (Array.isArray(p) && p.length > 0) ||
  (typeof p === "string" && p.trim().length > 0) ||
  (p && typeof p === "object" && Object.keys(p).length > 0);

if (!hasPricing && containsPricingClaim(text)) {
  setText(
    'I don’t see pricing listed on this page. What are you looking for—services, how it works, or booking?',
    "PRICING_WITHOUT_SOURCE"
  );
}

return {
  text: normalizeText(text),
  changed: normalizeText(text) !== normalizeText(original),
  reasons: reasons.filter(Boolean),
};
}

module.exports = { applyResponseSafetyFilter };

