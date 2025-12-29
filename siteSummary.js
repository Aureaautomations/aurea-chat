// siteSummary.js
const crypto = require("crypto");

// Simple in-memory cache (resets when Render restarts)
const SITE_CACHE = new Map();

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const MAX_CONTEXT_CHARS = 45_000;

function safeTrimContext(raw) {
  if (!raw) return "";
  const s = typeof raw === "string" ? raw : JSON.stringify(raw);
  return s.length > MAX_CONTEXT_CHARS ? s.slice(0, MAX_CONTEXT_CHARS) : s;
}

function sha256(input) {
  return crypto.createHash("sha256").update(input || "", "utf8").digest("hex");
}

function getSiteKey(input) {
  // Accept either:
  // - a URL string (preferred)
  // - an object with .origin
  // - an object with .pageUrl (legacy)
  const url =
    (typeof input === "string" ? input : null) ||
    input?.origin ||
    input?.pageUrl;

  if (!url) return null;

  try {
    const u = new URL(url);
    return u.origin; // e.g. https://aureaautomations.com
  } catch {
    return null;
  }
}

function hashSiteContext(siteContext) {
  const trimmed = safeTrimContext(siteContext);
  return sha256(trimmed);
}

function getCachedSummary(siteKey) {
  if (!siteKey) return null;

  console.log("[siteSummary] cache lookup", {
  siteKey,
  hasKey: SITE_CACHE.has(siteKey),
  cacheSize: SITE_CACHE.size,
});
  
  const hit = SITE_CACHE.get(siteKey);
  if (!hit) return null;

  const isExpired = Date.now() - hit.updatedAt > CACHE_TTL_MS;
  if (isExpired) return null;

  return hit.summary;
}

function setCachedSummary(siteKey, summary) {
  if (!siteKey) return;

  SITE_CACHE.set(siteKey, {
    summary,
    updatedAt: Date.now(),
  });

  console.log("[siteSummary] cache set", {
  siteKey,
  cacheSize: SITE_CACHE.size,
});
}

// Real summarizer: uses OpenAI to extract business info from the DOM snapshot
async function summarizeSiteContext({ siteKey, siteContext }) {
  const trimmed = safeTrimContext(siteContext);

  console.log("[siteSummary] summarizeSiteContext() START", {
    siteKey,
    contextChars: trimmed.length,
  });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.log("[siteSummary] Missing OPENAI_API_KEY");
    return {
      businessName: null,
      shortDescription: null,
      services: [],
      pricing: [],
      hours: null,
      booking: { method: null, url: null },
      locations: [],
      policies: [],
      contact: { phone: null, email: null },
      importantLinks: [],
      confidence: "low",
      missingFields: ["OPENAI_API_KEY"],
      _debug: { siteKey, contextChars: trimmed.length, error: "missing_api_key" },
    };
  }

  // Ask the model to return STRICT JSON matching our schema
  const schemaHint = `
Return ONLY valid JSON with this exact shape:
{
  "businessName": string|null,
  "shortDescription": string|null,
  "services": [{"name": string, "description": string|null, "duration": string|null}],
  "pricing": [{"item": string, "price": string, "notes": string|null}],
  "hours": string|null,
  "booking": {"method": string|null, "url": string|null},
  "locations": [string],
  "policies": [string],
  "contact": {"phone": string|null, "email": string|null},
  "importantLinks": [{"label": string, "url": string}],
  "confidence": "high"|"medium"|"low",
  "missingFields": [string]
}
Rules:
- Use exact text you can see. Do not guess.
- If pricing isn't visible, set pricing=[] and include "pricing" in missingFields.
- If booking URL isn't visible, set booking.url=null and include "booking" in missingFields.
`;

  const input = [
    {
      role: "system",
      content:
        "You extract business details from a website DOM snapshot for a customer support chat widget.\n" +
        schemaHint,
    },
    {
      role: "user",
      content:
        `SITE KEY: ${siteKey}\n\n` +
        `DOM SNAPSHOT (trimmed):\n` +
        trimmed,
    },
  ];

  try {
    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        input,
        // Keep it deterministic-ish for extraction
        temperature: 0.2,
      }),
    });

    if (!r.ok) {
      const errText = await r.text();
      console.log("[siteSummary] OpenAI non-OK", r.status, errText.slice(0, 400));
      return {
        businessName: null,
        shortDescription: null,
        services: [],
        pricing: [],
        hours: null,
        booking: { method: null, url: null },
        locations: [],
        policies: [],
        contact: { phone: null, email: null },
        importantLinks: [],
        confidence: "low",
        missingFields: ["openai_error"],
        _debug: {
          siteKey,
          contextChars: trimmed.length,
          status: r.status,
          errorPreview: errText.slice(0, 200),
        },
      };
    }

    const data = await r.json();

    // Responses API returns text in output_text on many SDKs,
    // but in raw HTTP you can safely rebuild from output items.
    const text =
      (data.output_text && String(data.output_text)) ||
      JSON.stringify(data);

    // Try to locate JSON in the text and parse it
    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    const jsonSlice =
      firstBrace !== -1 && lastBrace !== -1 ? text.slice(firstBrace, lastBrace + 1) : text;

    let parsed = null;
    try {
      parsed = JSON.parse(jsonSlice);
    } catch (e) {
      console.log("[siteSummary] JSON parse failed. Preview:", text.slice(0, 250));
    }

    const result =
      parsed && typeof parsed === "object"
        ? parsed
        : {
            businessName: null,
            shortDescription: null,
            services: [],
            pricing: [],
            hours: null,
            booking: { method: null, url: null },
            locations: [],
            policies: [],
            contact: { phone: null, email: null },
            importantLinks: [],
            confidence: trimmed.length > 200 ? "medium" : "low",
            missingFields: ["json_parse_failed"],
          };

    // Attach debug (safe)
    result._debug = {
      siteKey,
      contextChars: trimmed.length,
      usedOpenAI: true,
    };

    console.log("[siteSummary] summarizeSiteContext() DONE", {
      siteKey,
      confidence: result.confidence,
      services: Array.isArray(result.services) ? result.services.length : null,
      pricing: Array.isArray(result.pricing) ? result.pricing.length : null,
      bookingUrl: result.booking?.url || null,
    });

    return result;
  } catch (err) {
    console.log("[siteSummary] OpenAI error:", err && err.message ? err.message : err);
    return {
      businessName: null,
      shortDescription: null,
      services: [],
      pricing: [],
      hours: null,
      booking: { method: null, url: null },
      locations: [],
      policies: [],
      contact: { phone: null, email: null },
      importantLinks: [],
      confidence: "low",
      missingFields: ["openai_exception"],
      _debug: { siteKey, contextChars: trimmed.length, error: String(err?.message || err) },
    };
  }
}

module.exports = {
  getSiteKey,
  hashSiteContext,
  getCachedSummary,
  setCachedSummary,
  summarizeSiteContext,
};
