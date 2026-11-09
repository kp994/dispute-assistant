require("dotenv").config({ quiet: true });

const crypto = require("crypto");
const path = require("path");
const express = require("express");

const store = require("./src/store");
const paypal = require("./src/paypal");
const ai = require("./src/ai");
const { evaluate, applyAdjustments, band } = require("./src/eligibility");
const { buildFacts, factsAsText } = require("./src/facts");
const EV = require("./public/ev");

const app = express();
app.use(express.json({ limit: "200kb" }));
app.use(express.static(path.join(__dirname, "public")));

// ---------- view model ----------

function view(c, { full = false } = {}) {
  const elig = evaluate(c);
  const adj = c.assessment ? applyAdjustments(elig.base_p_win, c.assessment.adjustments) : { shift: 0, p_win: elig.base_p_win };
  const defaults = EV.defaultInputs(c, adj.p_win);
  const inputs = { ...defaults, ...(c.ev_inputs || {}) };
  const ev = EV.compute(inputs);
  const summary = {
    id: c.id,
    source: c.source,
    reason: c.reason,
    stage: c.stage,
    status: c.status,
    amount: c.amount,
    currency: c.currency,
    due_at: c.due_at,
    buyer: c.buyer,
    item: ((c.order && c.order.items) || []).map((i) => i.name).join(", "),
    p_win: inputs.p_win,
    band: band(inputs.p_win),
    recommended: ev.recommended,
    assessed: !!c.assessment,
  };
  if (!full) return summary;
  return {
    ...summary,
    case: c,
    facts: buildFacts(c),
    eligibility: { ...elig, ai_shift: adj.shift, model_p_win: adj.p_win },
    ev: { defaults, inputs, result: ev },
  };
}

// ---------- reads ----------

app.get("/api/status", (req, res) => {
  res.json({
    paypal: paypal.configured(),
    paypal_env: "sandbox",
    ai: ai.configured(),
    provider: ai.NAME,
    model: ai.MODEL,
    read_tools: ai.READ_TOOLS,
  });
});

app.get("/api/cases", (req, res) => {
  res.json(store.all().map((c) => view(c)));
});

app.get("/api/cases/:id", (req, res) => {
  const c = mustGet(req.params.id);
  res.json(view(c, { full: true }));
});

// ---------- seller edits ----------

const EV_FIELDS = ["p_win", "dispute_fee", "account_risk", "hours_to_fight", "hourly_rate", "return_shipping", "recovery_value", "offer_amount", "offer_accept_p"];

app.put("/api/cases/:id/ev", (req, res) => {
  const c = mustGet(req.params.id);
  const next = {};
  for (const k of EV_FIELDS) {
    if (req.body[k] === undefined || req.body[k] === null || req.body[k] === "") continue;
    const n = Number(req.body[k]);
    if (!Number.isFinite(n) || n < 0) throw httpError(400, `${k} must be a non-negative number`);
    if ((k === "p_win" || k === "offer_accept_p") && n > 1) throw httpError(400, `${k} must be between 0 and 1`);
    next[k] = n;
  }
  store.update(c.id, (x) => { x.ev_inputs = req.body.reset ? {} : next; });
  res.json(view(store.get(c.id), { full: true }));
});

app.put("/api/cases/:id/shipment", async (req, res) => {
  const c = mustGet(req.params.id);
  const b = req.body || {};
  if (!b.carrier || !b.tracking_number) throw httpError(400, "carrier and tracking_number are required");
  const shipment = {
    ...(c.shipment || { events: [] }),
    carrier: String(b.carrier).slice(0, 40),
    tracking_number: String(b.tracking_number).slice(0, 60),
    shipped_at: b.shipped_at || (c.shipment && c.shipment.shipped_at) || null,
    delivered_at: b.delivered_at || null,
    delivered_to_address_match: !!b.delivered_to_address_match,
    signature_confirmation: !!b.signature_confirmation,
    entered_by_seller: true,
  };

  let note = "Tracking saved.";
  if (b.upload_to_paypal) {
    if (c.source === "paypal") {
      if (!c.paypal_transaction_id || !paypal.configured()) throw httpError(400, "A PayPal sandbox connection and transaction ID are required to upload tracking");
      await paypal.addTracking(c.paypal_transaction_id, shipment);
      shipment.uploaded_to_paypal = true;
      note = "Tracking saved and uploaded to the PayPal sandbox transaction.";
    } else {
      shipment.uploaded_to_paypal = true;
      note = "Tracking saved. Demo case: upload to PayPal simulated.";
    }
  }
  store.update(c.id, (x) => {
    x.shipment = shipment;
    if (x.assessment) x.assessment.stale = true;
    x.audit.push(audit("tracking", note));
  });
  res.json({ note, ...view(store.get(c.id), { full: true }) });
});

app.put("/api/cases/:id/listing", (req, res) => {
  const c = mustGet(req.params.id);
  const text = String((req.body && req.body.listing_description) || "").slice(0, 2000);
  store.update(c.id, (x) => {
    x.order = { ...(x.order || {}), listing_description: text || null };
    if (x.assessment) x.assessment.stale = true;
  });
  res.json(view(store.get(c.id), { full: true }));
});

// ---------- AI ----------

app.post("/api/cases/:id/assess", aiLimit, async (req, res) => {
  const c = mustGet(req.params.id);
  const facts = buildFacts(c);
  const { items } = evaluate(c);
  const { data, model } = await ai.assess(factsAsText(facts), items);
  const ids = new Set(facts.map((f) => f.id));
  data.adjustments = (data.adjustments || []).map((a) => ({ ...a, fact_ids: (a.fact_ids || []).filter((id) => ids.has(id)) }));
  store.update(c.id, (x) => {
    x.assessment = { ...data, model, at: new Date().toISOString() };
    // A fresh assessment replaces the old model estimate, so drop a stale manual p_win.
    if (x.ev_inputs) delete x.ev_inputs.p_win;
    x.audit.push(audit("assess", `Assessed by ${model}`));
  });
  res.json(view(store.get(c.id), { full: true }));
});

app.post("/api/cases/:id/investigate", aiLimit, async (req, res) => {
  const c = mustGet(req.params.id);
  if (c.source !== "paypal") throw httpError(400, "Investigation reads live PayPal data, so it works on cases imported from the PayPal sandbox.");
  if (!paypal.configured()) throw httpError(400, "PayPal sandbox credentials are not configured");

  const { data, model, calls, via } = await ai.investigate(c, paypal);

  // Keep only findings backed by a tool call that actually succeeded in this run.
  const succeeded = new Set(calls.filter((x) => x.ok).map((x) => x.tool));
  const findings = (data.findings || [])
    .filter((f) => f.text && succeeded.has(f.source_tool))
    .map((f, i) => ({ id: `pp_${i + 1}`, text: f.text, source_tool: f.source_tool }));
  const dropped = (data.findings || []).length - findings.length;

  store.update(c.id, (x) => {
    x.investigation = {
      findings,
      dropped,
      gaps: data.gaps || [],
      calls: calls.map(({ tool, input, ok, preview }) => ({ tool, input, ok, preview })),
      suggested_shipment: data.shipment && data.shipment.found && data.shipment.tracking_number ? data.shipment : null,
      model,
      via,
      at: new Date().toISOString(),
    };
    if (data.ship_to && data.ship_to.found && !(x.order && x.order.ship_to)) {
      const { found, ...addr } = data.ship_to;
      x.order = { ...(x.order || {}), ship_to: { ...addr, source: "paypal" } };
    }
    if (x.assessment) x.assessment.stale = true;
    x.audit.push(audit("investigate", `${ai.NAME} made ${calls.length} read-only PayPal call${calls.length === 1 ? "" : "s"} and recorded ${findings.length} finding${findings.length === 1 ? "" : "s"}`));
  });
  res.json(view(store.get(c.id), { full: true }));
});

app.post("/api/cases/:id/draft", aiLimit, async (req, res) => {
  const c = mustGet(req.params.id);
  const action = req.body && req.body.action;
  if (!["fight", "refund", "offer"].includes(action)) throw httpError(400, "action must be fight, refund or offer");
  const v = view(c, { full: true });
  const facts = v.facts;
  const { data, model } = await ai.draft(factsAsText(facts), action, { offer: v.ev.inputs.offer_amount, currency: c.currency });

  const ids = new Set(facts.map((f) => f.id));
  const sentences = (data.sentences || []).map((s) => {
    const cited = (s.fact_ids || []).filter((id) => ids.has(id));
    return { text: String(s.text || "").trim(), kind: s.kind, fact_ids: cited, unsupported: s.kind === "fact" && cited.length === 0 };
  });
  const draft = {
    action,
    sentences,
    text: sentences.map((s) => s.text).join(" "),
    offer_amount: action === "offer" ? v.ev.inputs.offer_amount : null,
    edited: false,
    model,
    at: new Date().toISOString(),
  };
  store.update(c.id, (x) => {
    x.draft = draft;
    x.audit.push(audit("draft", `Drafted ${action} response with ${model}`));
  });
  res.json(view(store.get(c.id), { full: true }));
});

app.put("/api/cases/:id/draft", (req, res) => {
  const c = mustGet(req.params.id);
  if (!c.draft) throw httpError(400, "No draft to edit");
  const text = String((req.body && req.body.text) || "").trim().slice(0, 4000);
  if (!text) throw httpError(400, "Draft text cannot be empty");
  store.update(c.id, (x) => {
    if (text !== x.draft.text) {
      x.draft.text = text;
      x.draft.edited = true;
    }
  });
  res.json(view(store.get(c.id), { full: true }));
});

// ---------- approval (two-step) ----------

const pending = new Map(); // token -> { caseId, reviewHash, expires }
const submitting = new Set();

app.post("/api/cases/:id/approve/prepare", (req, res) => {
  const c = mustGet(req.params.id);
  if (!c.draft) throw httpError(400, "Draft a response before approving");
  if (c.status !== "OPEN") throw httpError(409, "This case is no longer open");
  const plan = actionPlan(c);
  const token = crypto.randomBytes(16).toString("hex");
  const now = Date.now();
  for (const [key, entry] of pending) if (entry.expires <= now) pending.delete(key);
  pending.set(token, { caseId: c.id, reviewHash: reviewHash(c, plan), expires: now + 10 * 60_000 });
  res.json({ token, plan, text: c.draft.text, unsupported: c.draft.edited ? [] : c.draft.sentences.filter((s) => s.unsupported).map((s) => s.text) });
});

app.post("/api/cases/:id/approve", async (req, res) => {
  const c = mustGet(req.params.id);
  const p = pending.get(req.body && req.body.token);
  if (!p || p.caseId !== c.id || p.expires <= Date.now()) throw httpError(400, "Confirmation expired. Review the draft again.");
  if (c.status !== "OPEN" || submitting.has(c.id)) throw httpError(409, "This case is no longer open for submission");
  if (!c.draft) throw httpError(409, "The draft changed after review. Review it again.");
  const plan = actionPlan(c);
  if (p.reviewHash !== reviewHash(c, plan)) throw httpError(409, "The draft or submission details changed after review. Review them again.");
  if (req.body.confirm !== true) throw httpError(400, "Approval must be confirmed");
  pending.delete(req.body.token);

  submitting.add(c.id);
  try {
    res.json(await submit(c, plan));
  } finally {
    submitting.delete(c.id);
  }
});

async function submit(c, plan) {
  const { action, text, offer_amount } = c.draft;
  let result = { simulated: !plan.live };
  if (plan.live) {
    const id = c.paypal_dispute_id;
    if (plan.call === "provide-evidence") result.paypal = await paypal.provideEvidence(id, { notes: text, tracking: c.shipment && c.shipment.tracking_number ? c.shipment : null });
    else if (plan.call === "send-message") result.paypal = await paypal.sendMessage(id, text);
    else if (plan.call === "accept-claim") result.paypal = await paypal.acceptClaim(id, text);
    else if (plan.call === "make-offer") result.paypal = await paypal.makeOffer(id, text, offer_amount, c.currency);
  }

  store.update(c.id, (x) => {
    x.status = action === "refund" ? "RESOLVED" : "RESPONDED";
    x.submitted = { action, text, at: new Date().toISOString(), via: plan.call, simulated: !plan.live };
    x.audit.push(audit("approve", `${plan.live ? "Sent to PayPal sandbox" : "Simulated"}: ${plan.call}`));
  });

  if (plan.live) {
    try {
      const fresh = await paypal.getDispute(c.paypal_dispute_id);
      store.update(c.id, (x) => { x.paypal_status = fresh.status; });
    } catch { /* status refresh is best-effort */ }
  }
  return { ...result, ...view(store.get(c.id), { full: true }) };
}

function actionPlan(c) {
  const live = c.source === "paypal";
  if (live && !paypal.configured()) throw httpError(400, "PayPal sandbox credentials are required to submit this dispute");
  const a = c.draft.action;
  const fightCall = c.paypal_actions?.includes("send-message") && !c.paypal_actions.includes("provide-evidence")
    ? "send-message" : "provide-evidence";
  const call = a === "refund" ? "accept-claim" : a === "offer" ? "make-offer" : fightCall;
  if (live && !c.paypal_actions) throw httpError(409, "Sync PayPal sandbox to refresh the available actions, then review again");
  if (live && !c.paypal_actions.includes(call)) throw httpError(409, `PayPal sandbox does not currently allow ${call} for this dispute`);
  const refundTypes = a === "refund" ? c.paypal_refund_types : a === "offer" ? c.paypal_offer_types : null;
  if (live && refundTypes && !refundTypes.includes("REFUND")) throw httpError(409, "PayPal sandbox does not allow a refund without return for this dispute");
  const describe = {
    "provide-evidence": "Submit this note as evidence" + (c.shipment && c.shipment.tracking_number ? ` with tracking ${c.shipment.carrier} ${c.shipment.tracking_number}` : ""),
    "send-message": "Send this message in the dispute thread",
    "accept-claim": `Accept the claim and refund ${c.currency} ${Number(c.amount).toFixed(2)}`,
    "make-offer": `Offer a partial refund of ${c.currency} ${Number(c.draft.offer_amount || 0).toFixed(2)}`,
  }[call];
  return {
    live,
    call,
    describe,
    target: live ? `PayPal sandbox dispute ${c.paypal_dispute_id}` : "Demo case (simulated, nothing is sent to PayPal)",
  };
}

// ---------- PayPal sync & demo reset ----------

app.post("/api/sync", async (req, res) => {
  if (!paypal.configured()) throw httpError(400, "PayPal sandbox credentials are not configured");
  const list = await paypal.listDisputes();
  let imported = 0;
  let skipped = 0;
  for (const item of list.items || []) {
    const d = await paypal.getDispute(item.dispute_id);
    const existing = store.all().find((c) => c.paypal_dispute_id === d.dispute_id);
    const mapped = paypal.toCase(d, existing);
    if (!mapped) { skipped++; continue; }
    if (!existing) mapped.audit.push(audit("import", `Imported from PayPal sandbox (${d.status})`));
    store.upsert(mapped);
    imported++;
  }
  res.json({ imported, skipped });
});

app.post("/api/reset-demo", (req, res) => {
  store.resetDemo();
  res.json({ ok: true });
});

// ---------- helpers ----------

// Keeps a public demo from burning through the AI key.
const hits = new Map();
function aiLimit(req, res, next) {
  if (!ai.configured()) return next(httpError(503, "AI is not configured. Set GEMINI_API_KEY (free) or ANTHROPIC_API_KEY."));
  const key = req.ip;
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((t) => now - t < 3600_000);
  if (recent.length >= Number(process.env.AI_REQUESTS_PER_HOUR || 40)) return next(httpError(429, "Too many AI requests from this address. Try again later."));
  recent.push(now);
  hits.set(key, recent);
  next();
}

function mustGet(id) {
  const c = store.get(id);
  if (!c) throw httpError(404, "Case not found");
  return c;
}
function audit(type, message) {
  return { type, message, at: new Date().toISOString() };
}
function reviewHash(c, plan) {
  const { action, text, offer_amount } = c.draft;
  const details = [plan, action, text, offer_amount, c.currency, c.shipment?.carrier, c.shipment?.tracking_number];
  return crypto.createHash("sha256").update(JSON.stringify(details)).digest("hex");
}
function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

app.use((err, req, res, next) => {
  let status = err.status || 500;
  status = ai.errorStatus(err) || status;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message, debug_id: err.debug_id });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Dispute Agent running on http://localhost:${port}`));
