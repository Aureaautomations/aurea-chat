// aurea-backend/db.js (CommonJS)
const { Pool } = require("pg");

function hasDb() {
  return !!process.env.DATABASE_URL;
}

const pool = hasDb()
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
  : null;

/**
 * Fire-and-forget event insert.
 * IMPORTANT: Must never throw, must never block UX.
 */
function insertEventSafe(event) {
  try {
    if (!pool) return;

    const {
      eventType,
      clientId,
      conversationId = null,
      sessionId = null,
      pageUrl = null,
      ctaType = null,
      job = null,
      metadata = null,
    } = event || {};

    if (!eventType || !clientId) return;

    // NOTE: conversationId must be UUID or null.
    pool
      .query(
        `
        INSERT INTO events
          (event_type, client_id, conversation_id, session_id, page_url, cta_type, job, metadata)
        VALUES
          ($1,         $2,        $3,             $4,         $5,       $6,      $7,  $8)
        `,
        [
          String(eventType),
          String(clientId),
          conversationId || null,
          sessionId || null,
          pageUrl || null,
          ctaType || null,
          job || null,
          metadata ? JSON.stringify(metadata) : null,
        ]
      )
      .catch((err) => {
        console.error("[DB_EVENT_ERROR]", err?.message || err);
      });
  } catch (e) {
    console.error("[DB_EVENT_FATAL]", e?.message || e);
  }
}

module.exports = { insertEventSafe };
