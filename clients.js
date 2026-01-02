// clients.js — JSON-based per-client config (no DB). Cached in memory.

const fs = require("fs");
const path = require("path");

const CLIENTS_PATH = path.join(__dirname, "clients.json");

let _cache = null;
let _cacheAt = 0;
const CACHE_MS = 10_000; // tiny cache; safe for Render; avoids disk read every request

function loadClients() {
  const now = Date.now();
  if (_cache && (now - _cacheAt) < CACHE_MS) return _cache;

  const raw = fs.readFileSync(CLIENTS_PATH, "utf8");
  const parsed = JSON.parse(raw);

  _cache = parsed && typeof parsed === "object" ? parsed : {};
  _cacheAt = now;
  return _cache;
}

function getClientConfig(clientIdRaw) {
  const clientId = String(clientIdRaw || "").trim();
  if (!clientId) return null;

  const clients = loadClients();
  const c = clients[clientId];

  if (!c || typeof c !== "object") return null;

  // normalize allowedOrigins to exact strings
  const allowedOrigins = Array.isArray(c.allowedOrigins)
    ? c.allowedOrigins.map(String).map(s => s.trim()).filter(Boolean)
    : [];
  
  if (!allowedOrigins.length) return null;

  return {
    clientId,
    allowedOrigins,
    bookingUrlOverride: String(c.bookingUrlOverride || "").trim(),
    contactUrlOverride: String(c.contactUrlOverride || "").trim(),
    escalateUrlOverride: String(c.escalateUrlOverride || "").trim(),
    jobDisables: (c.jobDisables && typeof c.jobDisables === "object") ? c.jobDisables : {},
  };
}

function isOriginAllowed(origin, clientConfig) {
  if (!origin) return false;
  if (!clientConfig) return false;

  // exact match only (no wildcards)
  return clientConfig.allowedOrigins.includes(origin);
}

module.exports = {
  getClientConfig,
  isOriginAllowed,
};
