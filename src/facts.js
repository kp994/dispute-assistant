// Flattens a case into numbered, citable facts. Claude may only cite these ids,
// and every factual sentence in a draft must point back to at least one.

function buildFacts(c) {
  const facts = [];
  const add = (id, text) => facts.push({ id, text });
  const money = (v) => `${c.currency || "USD"} ${Number(v).toFixed(2)}`;

  add("dispute", `Dispute opened ${day(c.opened_at)}: reason ${c.reason.replace(/_/g, " ").toLowerCase()}, stage ${c.stage.toLowerCase()}, amount ${money(c.amount)}. Seller response due ${day(c.due_at)}.`);

  const o = c.order;
  if (o) {
    const items = (o.items || []).map((i) => `${i.qty} x ${i.name} (${money(i.price)})`).join(", ");
    add("order", `Order ${o.id} placed ${day(o.placed_at)}: ${items}.`);
    if (o.ship_to) add("ship_to", `Ship-to address on the PayPal transaction: ${formatAddress(o.ship_to)}.`);
    if (o.listing_description) add("listing", `Listing description at time of sale: "${o.listing_description}"`);
    if (o.photos_on_file) add("photos", `Seller has pre-shipment photos of the item on file.`);
  }

  const s = c.shipment;
  if (!s || !s.tracking_number) {
    add("shipment", s && s.shipped_at
      ? `Shipped ${day(s.shipped_at)} via ${s.carrier || "unknown carrier"} with no tracking number.`
      : "No shipment or tracking information on record.");
  } else {
    add("shipment", `Shipped ${day(s.shipped_at)} via ${s.carrier}, tracking number ${s.tracking_number}.`);
    add("tracking_upload", s.uploaded_to_paypal ? "Tracking was uploaded to the PayPal transaction." : "Tracking has not been uploaded to the PayPal transaction.");
    add("signature", s.signature_confirmation ? "Shipment used signature confirmation." : "Shipment did not use signature confirmation.");
    (s.events || []).forEach((e, i) => add(`event_${i + 1}`, `Carrier scan ${day(e.time)}: ${e.status}${e.location ? `, ${e.location}` : ""}.`));
    if (s.delivered_at) {
      add("delivery", `Carrier reports delivered ${day(s.delivered_at)}${s.delivered_to_address_match ? " to an address matching the transaction" : " to an address that does NOT match the transaction"}.`);
    }
  }

  ((c.investigation && c.investigation.findings) || []).forEach((f) => add(f.id, `From PayPal (${f.source_tool}): ${f.text}`));

  (c.messages || []).forEach((m) => add(`msg_${m.id}`, `${m.from === "buyer" ? "Buyer" : "Seller"} message ${day(m.time)}: "${m.text}"`));
  return facts;
}

function factsAsText(facts) {
  return facts.map((f) => `[${f.id}] ${f.text}`).join("\n");
}

function formatAddress(a) {
  return [a.line1, a.city, a.state, a.postal_code, a.country].filter(Boolean).join(", ");
}
function day(iso) {
  return iso ? new Date(iso).toISOString().slice(0, 10) : "unknown date";
}

module.exports = { buildFacts, factsAsText };
