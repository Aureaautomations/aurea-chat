// siteSummary.js
import crypto from "crypto";

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

export function getSiteKey(meta) {
  const url = meta?.pageUrl;
  if (!url) return null;

  try {
    const u = new URL(url);
    return u.origin; // e.g. https://amplifymassage.com
  } catch {
    return null;
  }
}

export function hashSiteContext(siteContext) {
  const trimmed = safeTrimContext(siteContext);
  return sha256(trimmed);
}

export function getCachedSummary(siteKey, contextHash) {
  if (!siteKey) return null;

  const hit = SITE_CACHE.get(siteKey);
  if (!hit) return null;

  const isExpired = Date.now() - hit.updatedAt > CACHE_TTL_MS;
  const hashChanged = hit.contextHash !== contextHash;

  if (isExpired || hashChanged) return null;
  return hit.summary;
}

export function setCachedSummary(siteKey, contextHash, summary) {
  if (!siteKey || !summary) return;
  SITE_CACHE.set(siteKey, {
    summary,
    contextHash,
    updatedAt: Date.now(),
  });
}

// Placeholder: we’ll wire OpenAI in the next step
export async function summarizeSiteContext({ siteKey, siteContext }) {
  const trimmed = safeTrimContext(siteContext);

  // For now return a dummy summary so we can test wiring + caching
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
    confidence: trimmed.length > 200 ? "medium" : "low",
    missingFields: ["businessName", "services", "pricing", "hours", "booking"],
    _debug: { siteKey, contextChars: trimmed.length },
  };
}
