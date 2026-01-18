const { applyResponseSafetyFilter } = require("./responseSafetyFilter");

function run(name, input, expectIncludes, expectNotIncludes) {
  const out = applyResponseSafetyFilter(input);

  const incOk = (expectIncludes || []).every(s => out.includes(s));
  const notOk = (expectNotIncludes || []).every(s => !out.includes(s));

  const ok = incOk && notOk;

  console.log(ok ? "✅" : "❌", name);
  if (!ok) {
    console.log("INPUT:", input);
    console.log("OUTPUT:", out);
    console.log("EXPECT includes:", expectIncludes);
    console.log("EXPECT not includes:", expectNotIncludes);
    process.exitCode = 1;
  }
}

const bsNone = { hours: null, pricing: [] };
const bsWithHours = { hours: "Mon–Fri 9am–5pm", pricing: [] };
const bsWithPricing = { hours: null, pricing: [{ item: "Massage", price: "$120", notes: null }] };

run(
  "Blocks in-chat contact collection (contact info)",
  {
    reply: "If you’d like, leave your contact info and we’ll follow up.",
    ctaType: "LEAVE_CONTACT",
    ctaUrl: "https://x.com/contact",
    businessSummary: bsNone,
  },
  ['Tap “Leave contact info”'],
  ["leave your contact info"]
);

run(
  "Blocks can't-find language",
  {
    reply: "I can’t reschedule directly in chat, and I don’t see a booking or contact link on this page.",
    ctaType: "BOOK_NOW",
    ctaUrl: "https://x.com/book",
    businessSummary: bsNone,
  },
  ['Tap “Book now”'],
  ["don’t see a booking or contact link", "can't find"]
);

run(
  "Hours claim blocked when hours missing",
  {
    reply: "We’re open 9am to 5pm Mon–Fri.",
    ctaType: "BOOK_NOW",
    ctaUrl: "https://x.com/book",
    businessSummary: bsNone,
  },
  ["I don’t see hours listed on this page."],
  ["9am", "Mon–Fri"]
);

run(
  "Hours claim allowed when hours present",
  {
    reply: "We’re open 9am to 5pm Mon–Fri.",
    ctaType: "BOOK_NOW",
    ctaUrl: "https://x.com/book",
    businessSummary: bsWithHours,
  },
  ["We’re open 9am to 5pm Mon–Fri."],
  []
);

run(
  "Numeric pricing blocked when pricing missing",
  {
    reply: "It’s $120 for 60 minutes.",
    ctaType: "LEAVE_CONTACT",
    ctaUrl: "https://x.com/contact",
    businessSummary: bsNone,
  },
  ["I don’t see pricing listed on this page."],
  ["$120"]
);

run(
  "Numeric pricing allowed when pricing exists",
  {
    reply: "It’s $120 for 60 minutes.",
    ctaType: "BOOK_NOW",
    ctaUrl: "https://x.com/book",
    businessSummary: bsWithPricing,
  },
  ["It’s $120 for 60 minutes."],
  []
);

run(
  "No CTA present: does not tell them to tap a button",
  {
    reply: "Tap “Book now” to choose an available time.",
    ctaType: "BOOK_NOW",
    ctaUrl: null,
    businessSummary: bsNone,
  },
  ["I can help with services, pricing, or how booking works"],
  ['Tap “Book now”']
);

console.log("Done.");
