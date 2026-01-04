// siteSummary.js
const crypto = require("crypto");

console.log("[SITE_SUMMARY_BUILD]", {
  build: "siteSummary-2026-01-03-02",
});

// Simple in-memory cache (resets when Render restarts)
const SITE_CACHE = new Map();

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const MAX_CONTEXT_CHARS = 45_000;

function extractBookingUrlFallback(trimmed, siteKey) {
  if (!trimmed || typeof trimmed !== "string") return null;

  const origin = typeof siteKey === "string" ? siteKey : null;

  // Look for href/url values that include intent keywords.
  // This is deterministic string matching, not AI.
  const intent = /(book|booking|demo|schedule|appointment|get started|consult)/i;

  // Match common patterns like href="...", href:'...', "url":"..."
  const re = /(href|url)\s*[:=]\s*["']([^"']+)["']/gi;

  let m;
  const candidates = [];

  while ((m = re.exec(trimmed)) !== null) {
    const raw = (m[2] || "").trim();
    if (!raw) continue;

    const lower = raw.toLowerCase();
    if (!intent.test(lower)) continue;

    // Make absolute if it's a relative URL and we know origin
    let abs = raw;
    if (origin && raw.startsWith("/")) abs = origin.replace(/\/$/, "") + raw;

    // Only allow http(s) or same-page anchors when combined with origin
    const absLower = abs.toLowerCase();
    const isHttp = absLower.startsWith("http://") || absLower.startsWith("https://");
    const isAnchor = abs.startsWith("#");

    if (isAnchor && origin) abs = origin.replace(/\/$/, "") + "/" + abs; // origin/#...
    if (!isHttp && !abs.startsWith(origin || "")) continue;

    candidates.push(abs);
  }

  // Prefer the strongest-looking ones first
  const preferred = candidates.find((u) => /book|demo|schedule|appointment/i.test(u));
  return preferred || candidates[0] || null;
}

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

function toAbsUrl(href, origin) {
  try {
    return new URL(href, origin).href;
  } catch {
    return null;
  }
}

function extractBookingUrlDeterministic(siteContext, siteKey) {
  const origin = siteContext?.origin || siteKey || null;
  if (!origin) return null;

  const navLinks = Array.isArray(siteContext?.navLinks) ? siteContext.navLinks : [];
  const candidates = navLinks
    .map((l) => ({
      text: String(l?.text || "").toLowerCase(),
      href: String(l?.href || ""),
    }))
    .filter((x) => x.href);

  const priority = [
    /book|booking|schedule|appointment/,
    /demo|get started|start|consult/,
  ];

  for (const re of priority) {
    const hit = candidates.find((c) => re.test(c.text) || re.test(c.href.toLowerCase()));
    if (hit) return toAbsUrl(hit.href, origin);
  }

  // Scan extraPages text for common booking providers
  const extraPages = Array.isArray(siteContext?.extraPages) ? siteContext.extraPages : [];
  const combined = [
    siteContext?.textSample || "",
    ...extraPages.map((p) => p?.textSample || ""),
  ].join("\n");

  const providerMatch = combined.match(
    /\bhttps?:\/\/[^\s<"]*(calendly|janeapp|acuityscheduling|square\.site|setmore|simplybook|appointy)[^\s<"]*/i
  );
  if (providerMatch) return providerMatch[0];

  // Any absolute URL that looks like booking
  const anyMatch = combined.match(
    /\bhttps?:\/\/[^\s<"]*(book|booking|schedule|appointment|demo|get-started)[^\s<"]*/i
  );
  if (anyMatch) return anyMatch[0];

  return null;
}

function extractContactUrlDeterministic(siteContext, siteKey) {
  const origin = siteContext?.origin || siteKey || null;
  if (!origin) return null;

  const navLinks = Array.isArray(siteContext?.navLinks) ? siteContext.navLinks : [];
  const candidates = navLinks
    .map((l) => ({
      text: String(l?.text || "").toLowerCase(),
      href: String(l?.href || ""),
    }))
    .filter((x) => x.href);

  const hit = candidates.find((c) => /contact|call|email|get in touch|support/i.test(c.text) || /contact/i.test(c.href.toLowerCase()));
  if (hit) return toAbsUrl(hit.href, origin);

  const extraPages = Array.isArray(siteContext?.extraPages) ? siteContext.extraPages : [];
  const combined = [
    siteContext?.textSample || "",
    ...extraPages.map((p) => p?.textSample || ""),
  ].join("\n");

  const anyMatch = combined.match(/\bhttps?:\/\/[^\s<"]*(contact|get-in-touch|support)[^\s<"]*/i);
  if (anyMatch) return anyMatch[0];

  return null;
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
- If information is not visible, still return the field with null or empty arrays as appropriate.
- Never omit required fields.
`;

  const SITE_SUMMARY_JSON_SCHEMA = {
    type: "object",
    additionalProperties: false,
    properties: {
      businessName: { type: ["string", "null"] },
      shortDescription: { type: ["string", "null"] },

      services: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string" },
            description: { type: ["string", "null"] },
            duration: { type: ["string", "null"] },
          },
          required: ["name", "description", "duration"],
        },
      },

      pricing: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            item: { type: "string" },
            price: { type: "string" },
            notes: { type: ["string", "null"] },
          },
          required: ["item", "price", "notes"],
        },
      },

      hours: { type: ["string", "null"] },

      booking: {
        type: "object",
        additionalProperties: false,
        properties: {
          method: { type: ["string", "null"] },
          url: { type: ["string", "null"] },
        },
        required: ["method", "url"],
      },

      locations: { type: "array", items: { type: "string" } },
      policies: { type: "array", items: { type: "string" } },

      contact: {
        type: "object",
        additionalProperties: false,
        properties: {
          phone: { type: ["string", "null"] },
          email: { type: ["string", "null"] },
        },
        required: ["phone", "email"],
      },

      importantLinks: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            label: { type: "string" },
            url: { type: "string" },
          },
          required: ["label", "url"],
        },
      },

      confidence: { type: "string", enum: ["high", "medium", "low"] },
      missingFields: { type: "array", items: { type: "string" } },
    },
    required: [
      "businessName",
      "shortDescription",
      "services",
      "pricing",
      "hours",
      "booking",
      "locations",
      "policies",
      "contact",
      "importantLinks",
      "confidence",
      "missingFields",
    ],
  };

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
        temperature: 0.2,
        text: {
          format: {
            type: "json_schema",
            name: "SiteSummary",
            schema: SITE_SUMMARY_JSON_SCHEMA,
            strict: true,
          },
        },
      }),
    });

    if (!r.ok) {
      const errText = await r.text();
      console.log("[siteSummary] OpenAI non-OK", r.status, errText.slice(0, 400));
      throw new Error(
        `[siteSummary] OpenAI non-OK status=${r.status} preview=${errText.slice(0, 200)}`
      );
    }

    const data = await r.json();

    const raw =
      String(data?.output_text || "").trim() ||
      String(data?.output?.[0]?.content?.[0]?.text || "").trim();

    if (!raw) {
      throw new Error("[siteSummary] Schema violation: empty model text output");
    }

    let result;
    try {
      result = JSON.parse(raw);
    
      console.log("[siteSummary] Parsed schema JSON", {
        siteKey,
        businessName: result?.businessName || null,
        servicesCount: Array.isArray(result?.services) ? result.services.length : null,
        pricingCount: Array.isArray(result?.pricing) ? result.pricing.length : null,
        bookingUrl: result?.booking?.url || null,
        missingFields: Array.isArray(result?.missingFields) ? result.missingFields : null,
      });
    
    } catch (e) {
      const preview = raw.length > 500 ? raw.slice(0, 500) + "…" : raw;
      throw new Error(
        `[siteSummary] Schema violation: output_text was not valid JSON. Preview: ${preview}`
      );
    }

    // Deterministic booking URL extraction (NO AI). Prefer structured siteContext over trimmed text.
    const deterministicBookingUrl = extractBookingUrlDeterministic(siteContext, siteKey);
    
    // Always force booking.url if we found one deterministically
    if (deterministicBookingUrl) {
      result.booking = result.booking || { method: null, url: null };
      result.booking.url = deterministicBookingUrl;
      if (!result.booking.method) result.booking.method = "link";
    
      if (Array.isArray(result.missingFields)) {
        result.missingFields = result.missingFields.filter(
          (f) => f !== "booking.url" && f !== "booking.method"
        );
      }
    } else if (!result?.booking?.url) {
      // LAST resort: your older text-only fallback (keep it as a backup)
      const fallback = extractBookingUrlFallback(trimmed, siteKey);
      if (fallback) {
        result.booking = result.booking || { method: null, url: null };
        result.booking.url = fallback;
        if (!result.booking.method) result.booking.method = "link";
    
        if (Array.isArray(result.missingFields)) {
          result.missingFields = result.missingFields.filter(
            (f) => f !== "booking.url" && f !== "booking.method"
          );
        }
      }
    }
    
    // Back-compat alias (server.js currently reads businessSummary.bookingUrl)
    result.bookingUrl = result?.booking?.url || null;

    console.log("[SITE_SUMMARY_URLS]", {
      siteKey,
      bookingUrl: result.bookingUrl || null,
      contactUrl: result.contactUrl || null,
      escalateUrl: result.escalateUrl || null,
    });

    // Deterministic contact URL (separate from booking URL)
    const deterministicContactUrl = extractContactUrlDeterministic(siteContext, siteKey);
    result.contactUrl = deterministicContactUrl || null;
    
    // Escalation URL: for now, default to contactUrl unless you later add a separate escalation link
    result.escalateUrl = result.contactUrl;
    
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
