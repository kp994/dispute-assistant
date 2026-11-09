// PayPal REST client for the sandbox: Disputes API, plus Add Tracking.
// Docs: https://developer.paypal.com/docs/api/customer-disputes/v1/

const BASE = "https://api-m.sandbox.paypal.com";

let token = null;

function configured() {
  return !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
}

async function accessToken() {
  if (token && token.expires_at > Date.now() + 60_000) return token.value;
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString("base64");
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const body = await res.json();
  if (!res.ok) throw new PayPalError("Could not get a PayPal access token", res.status, body);
  token = { value: body.access_token, expires_at: Date.now() + body.expires_in * 1000 };
  return token.value;
}

async function call(method, path, { json, form } = {}) {
  const headers = { Authorization: `Bearer ${await accessToken()}` };
  let body;
  if (json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  } else if (form) {
    body = form; // fetch sets the multipart boundary
  }
  const res = await fetch(`${BASE}${path}`, { method, headers, body });
  const text = await res.text();
  const data = text ? safeJson(text) : {};
  if (!res.ok) throw new PayPalError(`PayPal ${method} ${path} failed`, res.status, data);
  return data;
}

const listDisputes = (pageSize = 20) => call("GET", `/v1/customer/disputes?page_size=${pageSize}`);
const getDispute = (id) => call("GET", `/v1/customer/disputes/${encodeURIComponent(id)}`);

// Read-only lookups, used as AI tools during investigation.
function listTransactions({ transaction_id, start_date, end_date }) {
  let end = new Date(end_date);
  let start = new Date(start_date);
  if (isNaN(end)) end = new Date();
  if (isNaN(start)) start = new Date(end.getTime() - 30 * 864e5);
  if (end - start > 31 * 864e5) start = new Date(end.getTime() - 31 * 864e5); // API limit
  const q = new URLSearchParams({
    start_date: start.toISOString(),
    end_date: end.toISOString(),
    fields: "transaction_info,payer_info,shipping_info,cart_info",
    page_size: "20",
  });
  if (transaction_id) q.set("transaction_id", transaction_id);
  return call("GET", `/v1/reporting/transactions?${q}`);
}

const getTrackers = (transactionId) =>
  call("GET", `/v1/shipping/trackers?${new URLSearchParams({ transaction_id: transactionId })}`);

const getOrder = (id) => call("GET", `/v2/checkout/orders/${encodeURIComponent(id)}`);

function provideEvidence(id, { notes, tracking }) {
  const evidence = { evidence_type: tracking ? "PROOF_OF_FULFILLMENT" : "OTHER", notes };
  if (tracking) evidence.evidence_info = { tracking_info: [{ carrier_name: tracking.carrier, tracking_number: tracking.tracking_number }] };
  const form = new FormData();
  form.append("input", new Blob([JSON.stringify({ evidences: [evidence] })], { type: "application/json" }));
  return call("POST", `/v1/customer/disputes/${encodeURIComponent(id)}/provide-evidence`, { form });
}

const sendMessage = (id, message) =>
  call("POST", `/v1/customer/disputes/${encodeURIComponent(id)}/send-message`, { json: { message } });

const acceptClaim = (id, note) =>
  call("POST", `/v1/customer/disputes/${encodeURIComponent(id)}/accept-claim`, { json: { note, accept_claim_type: "REFUND" } });

const makeOffer = (id, note, amount, currency) =>
  call("POST", `/v1/customer/disputes/${encodeURIComponent(id)}/make-offer`, {
    json: { note, offer_type: "REFUND", offer_amount: { currency_code: currency, value: Number(amount).toFixed(2) } },
  });

const addTracking = (transactionId, { carrier, tracking_number }) =>
  call("POST", "/v1/shipping/trackers-batch", {
    json: { trackers: [{ transaction_id: transactionId, tracking_number, status: "SHIPPED", carrier: carrier.toUpperCase() }] },
  });

const REASONS = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: "ITEM_NOT_RECEIVED",
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: "NOT_AS_DESCRIBED",
};

// Maps a PayPal dispute into our case shape. Returns null for reasons we don't handle.
function toCase(d, existing) {
  const reason = REASONS[d.reason];
  if (!reason) return null;
  const tx = (d.disputed_transactions || [])[0] || {};
  const amount = Number((d.dispute_amount || {}).value || 0);
  return {
    ...(existing || { audit: [], shipment: null }),
    id: existing ? existing.id : `pp-${d.dispute_id}`,
    source: "paypal",
    paypal_dispute_id: d.dispute_id,
    paypal_status: d.status,
    paypal_actions: (d.links || []).filter((link) => link.method === "POST").map((link) => link.rel.replaceAll("_", "-")),
    paypal_refund_types: d.allowed_response_options?.accept_claim?.accept_claim_types ?? null,
    paypal_offer_types: d.allowed_response_options?.make_offer?.offer_types ?? null,
    paypal_transaction_id: tx.seller_transaction_id || null,
    reason,
    stage: d.dispute_life_cycle_stage === "INQUIRY" ? "INQUIRY" : "CLAIM",
    status: d.status === "RESOLVED" ? "RESOLVED" : "OPEN",
    amount,
    currency: (d.dispute_amount || {}).currency_code || "USD",
    opened_at: d.create_time,
    due_at: d.seller_response_due_date || null,
    buyer: { name: (tx.buyer && tx.buyer.name) || "PayPal buyer" },
    order: {
      id: tx.seller_transaction_id || d.dispute_id,
      placed_at: tx.create_time || d.create_time,
      items: (tx.items || []).map((i) => ({ name: i.item_name || "Item", qty: Number(i.item_quantity || 1), price: Number((i.item_amount || {}).value || amount) })),
      ship_to: (existing && existing.order && existing.order.ship_to) || null,
      listing_description: (existing && existing.order && existing.order.listing_description) || null,
    },
    messages: (d.messages || []).map((m, i) => ({
      id: `pp${i + 1}`,
      from: m.posted_by === "SELLER" ? "seller" : "buyer",
      time: m.time_posted,
      text: m.content,
    })),
  };
}

class PayPalError extends Error {
  constructor(message, status, body) {
    const detail = body && (body.message || body.error_description || body.name);
    super(detail ? `${message}: ${detail}` : message);
    this.status = status;
    this.debug_id = body && body.debug_id;
    this.details = body && body.details;
  }
}

function safeJson(t) {
  try {
    return JSON.parse(t);
  } catch {
    return { raw: t };
  }
}

// PayPal's hosted MCP server (the same one the PayPal AI Toolkit plugin uses).
const MCP_URL = "https://mcp.sandbox.paypal.com/sse";

module.exports = {
  configured, accessToken, MCP_URL, listDisputes, getDispute, listTransactions, getTrackers, getOrder, provideEvidence, sendMessage,
  acceptClaim, makeOffer, addTracking, toCase, PayPalError, BASE,
};
