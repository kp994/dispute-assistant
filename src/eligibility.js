// Rule-based case strength. This is the backbone of the win probability;
// Claude can only nudge it within a fixed band (see applyAdjustments).
//
// The checks are a simplified reading of PayPal Seller Protection for
// "item not received" claims. They are not legal or policy advice.

const SIGNATURE_THRESHOLD = 750;
const MAX_AI_SHIFT = 0.15;
const SIZE_WEIGHT = { small: 0.03, medium: 0.06, large: 0.1 };

function checklist(c) {
  const s = c.shipment;
  if (c.reason === "NOT_AS_DESCRIBED") {
    return [
      check("listing", "Listing description on file", !!(c.order && c.order.listing_description),
        "Your listing text is the main evidence for what the buyer was promised."),
      check("photos", "Pre-shipment photos on file", !!(c.order && c.order.photos_on_file),
        "Photos taken before shipping show the item's condition."),
      check("return", "Buyer offered a return", hasReturnOffer(c),
        "PayPal usually asks the buyer to return the item before refunding."),
      check("coverage", "Covered by Seller Protection", false,
        "Not-as-described claims are generally not covered, so outcomes depend on evidence."),
    ];
  }
  return [
    check("tracking", "Tracking number on record", !!(s && s.tracking_number),
      "Without tracking, item-not-received claims are very hard to win."),
    check("delivered", "Carrier shows delivered", !!(s && s.delivered_at),
      "Tracking must show the package was delivered, not just shipped."),
    check("address", "Delivered to the address on the transaction", !!(s && s.delivered_at && s.delivered_to_address_match),
      "Seller Protection requires delivery to the address shown on the PayPal transaction."),
    check("signature", `Signature confirmation (required at $${SIGNATURE_THRESHOLD}+)`,
      c.amount < SIGNATURE_THRESHOLD || !!(s && s.signature_confirmation),
      c.amount < SIGNATURE_THRESHOLD ? "Not required for this amount." : "High-value orders need proof of signature."),
    check("uploaded", "Tracking uploaded to PayPal", !!(s && s.uploaded_to_paypal),
      "Uploading tracking to the transaction makes it visible to PayPal reviewers.", true),
  ];
}

function baseProbability(c, items) {
  const ok = Object.fromEntries(items.map((i) => [i.id, i.passed]));
  if (c.reason === "NOT_AS_DESCRIBED") {
    let p = 0.3;
    if (ok.listing) p += 0.05;
    if (ok.photos) p += 0.1;
    return p;
  }
  if (!ok.tracking) return 0.08;
  if (!ok.delivered) return 0.2;
  if (!ok.address) return 0.25;
  if (!ok.signature) return 0.3;
  return ok.uploaded ? 0.88 : 0.82;
}

function evaluate(c) {
  const items = checklist(c);
  const base = baseProbability(c, items);
  return { items, base_p_win: round(base) };
}

// Turns Claude's qualitative factors into a bounded shift on the base probability.
function applyAdjustments(base, adjustments) {
  let shift = 0;
  for (const a of adjustments || []) {
    const w = SIZE_WEIGHT[a.size] || 0;
    shift += a.direction === "helps" ? w : -w;
  }
  shift = Math.max(-MAX_AI_SHIFT, Math.min(MAX_AI_SHIFT, shift));
  return { shift: round(shift), p_win: round(Math.max(0.02, Math.min(0.97, base + shift))) };
}

function band(p) {
  if (p >= 0.65) return "strong";
  if (p >= 0.35) return "uncertain";
  return "weak";
}

function hasReturnOffer(c) {
  return (c.messages || []).some((m) => m.from === "seller" && /return/i.test(m.text));
}
function check(id, label, passed, note, advisory = false) {
  return { id, label, passed: !!passed, note, advisory };
}
function round(x) {
  return Math.round(x * 100) / 100;
}

module.exports = { evaluate, applyAdjustments, band, MAX_AI_SHIFT };
