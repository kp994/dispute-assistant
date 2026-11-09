(function () {
  "use strict";

  const state = { cases: [], view: null, action: null, editing: false, showTracking: false, grid: null, status: null };
  const $ = (sel, root = document) => root.querySelector(sel);

  // ---------- utils ----------

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  const money = (v, cur = "USD") => `${cur === "USD" ? "$" : cur + " "}${Number(v || 0).toFixed(2)}`;
  const pct = (p) => `${Math.round(Number(p) * 100)}%`;
  const day = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—");
  const stamp = (iso) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const aiName = () => (state.status && state.status.provider) || "AI";
  const REASONS = { ITEM_NOT_RECEIVED: "Item not received", NOT_AS_DESCRIBED: "Not as described" };
  const ACTIONS = { fight: "Fight with evidence", refund: "Refund in full", offer: "Offer partial refund" };

  function due(iso) {
    if (!iso) return { text: "No deadline", cls: "" };
    const ms = new Date(iso) - Date.now();
    if (ms <= 0) return { text: "Overdue", cls: "urgent" };
    const h = Math.floor(ms / 36e5);
    const d = Math.floor(h / 24);
    const text = d > 0 ? `${d}d ${h % 24}h left` : `${h}h ${Math.floor((ms % 36e5) / 6e4)}m left`;
    return { text, cls: h < 24 ? "urgent" : h < 72 ? "soon" : "" };
  }

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove("show"), 3200);
  }

  async function busy(btn, label, fn) {
    const old = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="spin"></span>${esc(label)}`;
    try {
      return await fn();
    } finally {
      btn.disabled = false;
      btn.innerHTML = old;
    }
  }

  // ---------- status & queue ----------

  async function loadStatus() {
    const s = (state.status = await api("GET", "/api/status"));
    $("#status-chips").innerHTML = [
      `<span class="chip ${s.paypal ? "on" : "off"}"><span class="dot"></span>PayPal ${s.paypal ? s.paypal_env : "not connected"}</span>`,
      `<span class="chip ${s.ai ? "on" : "off"}"><span class="dot"></span>${s.ai ? `${esc(s.provider)} · ${esc(s.model)}` : "AI not configured"}</span>`,
    ].join("");
    $("#sync-btn").hidden = !s.paypal;
  }

  async function loadCases(selectId) {
    state.cases = await api("GET", "/api/cases");
    renderGrid();
    const open = state.cases.filter((c) => c.status === "OPEN").sort((a, b) => new Date(a.due_at) - new Date(b.due_at));
    const id = selectId || (state.view && state.view.id) || (open[0] || state.cases[0] || {}).id;
    if (id) await selectCase(id);
  }

  function renderGrid() {
    const host = $("#grid");
    if (!window.agGrid) return renderFallbackTable(host);
    const columnDefs = [
      {
        headerName: "Deadline", field: "due_at", sort: "asc", width: 130,
        comparator: (a, b, na, nb) => statusRank(na.data) - statusRank(nb.data) || new Date(a) - new Date(b),
        cellRenderer: (p) => (p.data.status !== "OPEN" ? `<span class="muted">${esc(p.data.status.toLowerCase())}</span>` : `<span class="cell-due ${due(p.value).cls}">${esc(due(p.value).text)}</span>`),
      },
      { headerName: "Case", field: "id", width: 120, cellClass: "mono" },
      { headerName: "Item", field: "item", flex: 1, minWidth: 180 },
      { headerName: "Reason", field: "reason", width: 160, valueFormatter: (p) => REASONS[p.value] || p.value },
      { headerName: "Amount", field: "amount", width: 110, cellClass: "mono", valueFormatter: (p) => money(p.value, p.data.currency) },
      { headerName: "Win chance", field: "p_win", width: 130, cellRenderer: (p) => `<span class="band ${p.data.band}">${pct(p.value)} ${p.data.band}</span>` },
      { headerName: "Recommended", field: "recommended", width: 140, cellRenderer: (p) => `<span class="cell-rec ${p.value}">${esc(p.value)}</span>` },
      { headerName: "Source", field: "source", width: 100, valueFormatter: (p) => (p.value === "paypal" ? "PayPal" : "Demo") },
    ];
    if (!state.grid) {
      host.className = "grid-host " + (matchMedia("(prefers-color-scheme: dark)").matches ? "ag-theme-quartz-dark" : "ag-theme-quartz");
      state.grid = agGrid.createGrid(host, {
        columnDefs,
        rowData: state.cases,
        domLayout: "autoHeight",
        rowSelection: "single",
        getRowId: (p) => p.data.id,
        defaultColDef: { sortable: true, resizable: true },
        onRowClicked: (e) => selectCase(e.data.id),
      });
    } else {
      state.grid.setGridOption("rowData", state.cases);
    }
    if (state.view) state.grid.forEachNode((n) => n.setSelected(n.data.id === state.view.id));
  }

  function statusRank(c) {
    return c.status === "OPEN" ? 0 : 1;
  }

  function renderFallbackTable(host) {
    host.innerHTML = `<table class="fallback-table"><thead><tr><th>Deadline</th><th>Case</th><th>Item</th><th>Amount</th><th>Recommended</th></tr></thead><tbody>${state.cases
      .map((c) => `<tr data-id="${esc(c.id)}"><td>${esc(due(c.due_at).text)}</td><td class="mono">${esc(c.id)}</td><td>${esc(c.item)}</td><td class="mono">${money(c.amount, c.currency)}</td><td>${esc(c.recommended)}</td></tr>`)
      .join("")}</tbody></table>`;
    host.querySelectorAll("tr[data-id]").forEach((tr) => tr.addEventListener("click", () => selectCase(tr.dataset.id)));
  }

  // ---------- case detail ----------

  async function selectCase(id) {
    const changed = !state.view || state.view.id !== id;
    const v = await api("GET", `/api/cases/${encodeURIComponent(id)}`);
    setView(v, changed);
    if (state.grid) state.grid.forEachNode((n) => n.setSelected(n.data.id === id));
  }

  function setView(v, reset) {
    state.view = v;
    if (reset) {
      state.action = (v.case.draft && v.case.draft.action) || v.ev.result.recommended;
      state.editing = false;
      state.showTracking = false;
    }
    renderDetail();
    const row = state.cases.findIndex((c) => c.id === v.id);
    if (row >= 0) {
      state.cases[row] = { ...state.cases[row], p_win: v.p_win, band: v.band, recommended: v.recommended, status: v.status, assessed: v.assessed };
      if (state.grid) state.grid.setGridOption("rowData", state.cases);
    }
  }

  function renderDetail() {
    const v = state.view;
    const c = v.case;
    const d = due(c.due_at);
    const el = $("#detail");
    el.hidden = false;
    el.innerHTML = `
      <div class="detail-head">
        <div>
          <p class="muted mono">${esc(c.id)}${c.paypal_dispute_id ? ` · PayPal ${esc(c.paypal_dispute_id)}` : ""}</p>
          <h2>${esc(v.item || "Order")}</h2>
          <div class="meta">
            <span class="chip">${esc(REASONS[c.reason] || c.reason)}</span>
            <span class="chip">${c.stage === "INQUIRY" ? "Inquiry stage" : "Claim stage"}</span>
            <span class="chip mono">${money(c.amount, c.currency)}</span>
            <span class="chip">Buyer: ${esc(c.buyer && c.buyer.name)}</span>
            ${c.paypal_status ? `<span class="chip">PayPal status: ${esc(c.paypal_status.replace(/_/g, " ").toLowerCase())}</span>` : ""}
          </div>
        </div>
        <div class="deadline ${c.status === "OPEN" ? d.cls : ""}">
          <div class="label">Response due ${esc(day(c.due_at))}</div>
          <div class="value">${c.status === "OPEN" ? esc(d.text) : esc(c.status.toLowerCase())}</div>
        </div>
      </div>
      <div class="columns">
        <div>${caseFileCard(v)}</div>
        <div>
          ${strengthCard(v)}
          <div class="card" id="ev-card">${evCardInner(v.ev.inputs, v.ev.defaults)}</div>
          ${responseCard(v)}
          ${auditCard(c)}
        </div>
      </div>`;
    wireDetail();
  }

  function caseFileCard(v) {
    const c = v.case;
    const byId = Object.fromEntries(v.facts.map((f) => [f.id, f]));
    const fact = (id) => (byId[id] ? `<div class="fact" id="fact-${esc(id)}"><span class="fid">${esc(id)}</span><span>${esc(byId[id].text)}</span></div>` : "");
    const events = v.facts.filter((f) => f.id.startsWith("event_"));
    const s = c.shipment;

    return `<div class="card">
      <div class="card-head"><div><h3>Case file</h3><p>Every fact ${aiName()} may cite, with its id.</p></div></div>
      <div class="fact-group"><h4>Dispute &amp; order</h4>${["dispute", "order", "ship_to", "listing", "photos"].map(fact).join("")}
        ${!c.order || !c.order.listing_description ? `<button class="btn ghost small" id="listing-btn" type="button">Add listing description</button>` : ""}
      </div>
      ${paypalGroup(v, fact)}
      <div class="fact-group"><h4>Shipment</h4>
        ${["shipment", "tracking_upload", "signature"].map(fact).join("")}
        ${events.length ? `<div class="timeline">${events.map((f) => `<div class="fact ${/deliver/i.test(f.text) && !/out for/i.test(f.text) ? "delivered" : ""}" id="fact-${esc(f.id)}"><span><span class="fid">${esc(f.id)}</span> ${esc(f.text.replace(/^Carrier scan /, ""))}</span></div>`).join("")}</div>` : ""}
        ${fact("delivery")}
        ${s && s.entered_by_seller ? `<p class="note">Tracking details entered by the seller.</p>` : ""}
        <div class="draft-actions">
          <button class="btn ghost small" id="tracking-btn" type="button">${s && s.tracking_number ? "Edit tracking" : "Add tracking"}</button>
          ${s && s.tracking_number && !s.uploaded_to_paypal ? `<span class="note">Tip: upload tracking to PayPal before responding.</span>` : ""}
        </div>
        ${state.showTracking ? trackingForm(c) : ""}
      </div>
      <div class="fact-group"><h4>Messages</h4>
        ${(c.messages || []).length ? c.messages.map((m) => `<div class="msg ${m.from === "seller" ? "seller" : "buyer"}" id="fact-msg_${esc(m.id)}"><div class="who">${m.from === "seller" ? "You" : esc(c.buyer && c.buyer.name)} · ${esc(stamp(m.time))} · <span class="mono">msg_${esc(m.id)}</span></div>${esc(m.text)}</div>`).join("") : `<div class="empty">No messages in the dispute thread.</div>`}
      </div>
    </div>`;
  }

  function paypalGroup(v, fact) {
    const c = v.case;
    const inv = c.investigation;
    const live = c.source === "paypal" && state.status && state.status.paypal;
    const canRun = live && state.status.ai;
    const head = `<div class="card-head inv-head"><div><h4>From PayPal</h4>
        <p>${aiName()} looks up the dispute, transaction and tracking with read-only PayPal tools.</p></div>
        <button class="btn ${inv ? "ghost" : "accent"} small" id="investigate-btn" type="button" ${canRun ? "" : "disabled"}>${inv ? "Investigate again" : "Investigate in PayPal"}</button></div>`;
    if (!live) {
      return `<div class="fact-group">${head}<p class="note">${c.source === "paypal" ? "Connect PayPal sandbox credentials to investigate." : "Available on disputes imported from the PayPal sandbox. Demo cases have no live PayPal data."}</p></div>`;
    }
    if (!inv) return `<div class="fact-group">${head}<div id="investigate-error"></div></div>`;

    const sug = inv.suggested_shipment;
    return `<div class="fact-group">${head}
      ${inv.findings.length ? inv.findings.map((f) => fact(f.id)).join("") : `<div class="empty">No findings.</div>`}
      ${inv.dropped ? `<p class="note">${inv.dropped} finding${inv.dropped > 1 ? "s were" : " was"} dropped because no successful tool call backed ${inv.dropped > 1 ? "them" : "it"}.</p>` : ""}
      ${sug ? `<div class="suggest"><span>PayPal shows tracking <span class="mono">${esc(sug.carrier)} ${esc(sug.tracking_number)}</span>${sug.status ? ` (${esc(sug.status)})` : ""}.</span><button class="btn small" id="use-tracking" type="button">Use this tracking</button></div>` : ""}
      ${inv.gaps.length ? `<p class="note" style="margin-top:8px"><strong>Not found:</strong> ${inv.gaps.map(esc).join("; ")}</p>` : ""}
      <details class="calls"><summary>${inv.calls.length} PayPal call${inv.calls.length === 1 ? "" : "s"} by ${esc(inv.model)}${inv.via ? ` via ${esc(inv.via)}` : ""} · ${esc(stamp(inv.at))}</summary>
        ${inv.calls.map((x) => `<div class="call"><span class="call-status ${x.ok ? "ok" : "err"}">${x.ok ? "ok" : x.ok === false ? "error" : "?"}</span> <span class="mono">${esc(x.tool)}(${esc(JSON.stringify(x.input))})</span>${x.preview ? `<pre>${esc(x.preview)}</pre>` : ""}</div>`).join("")}
      </details>
      <div id="investigate-error"></div>
    </div>`;
  }

  function trackingForm(c) {
    const s = { ...(c.shipment || {}), ...(state.prefill || {}) };
    const local = (iso) => (iso ? new Date(iso).toISOString().slice(0, 16) : "");
    return `<form class="inline-form" id="tracking-form">
      <label>Carrier<input type="text" name="carrier" required value="${esc(s.carrier || "")}" placeholder="USPS" /></label>
      <label>Tracking number<input type="text" name="tracking_number" required value="${esc(s.tracking_number || "")}" /></label>
      <label>Shipped<input type="datetime-local" name="shipped_at" value="${local(s.shipped_at)}" /></label>
      <label>Delivered<input type="datetime-local" name="delivered_at" value="${local(s.delivered_at)}" /></label>
      <label class="check full"><input type="checkbox" name="delivered_to_address_match" ${s.delivered_to_address_match ? "checked" : ""} /> Delivered to the address on the PayPal transaction</label>
      <label class="check full"><input type="checkbox" name="signature_confirmation" ${s.signature_confirmation ? "checked" : ""} /> Signature confirmation</label>
      <label class="check full"><input type="checkbox" name="upload_to_paypal" ${s.uploaded_to_paypal ? "" : "checked"} /> Upload tracking to PayPal${c.source === "paypal" ? "" : " (simulated for demo cases)"}</label>
      <div class="full draft-actions"><button class="btn small" type="submit">Save tracking</button><button class="btn ghost small" type="button" id="tracking-cancel">Cancel</button></div>
    </form>`;
  }

  function strengthCard(v) {
    const e = v.eligibility;
    const a = v.case.assessment;
    const overridden = v.ev.inputs.p_win !== e.model_p_win;
    const shift = e.ai_shift;
    return `<div class="card">
      <div class="card-head">
        <div><h3>Case strength</h3><p>Rules set the base. ${aiName()} can move it by at most 15 points, and shows why.</p></div>
        <button class="btn ${a ? "ghost" : "accent"} small" id="assess-btn" type="button" ${state.status && !state.status.ai ? "disabled" : ""}>${a ? "Re-assess" : `Assess with ${aiName()}`}</button>
      </div>
      <ul class="checklist">${e.items.map((i) => `<li class="${i.passed ? "pass" : "fail"} ${i.advisory ? "advisory" : ""}"><span class="mark">${i.passed ? "✓" : i.advisory ? "!" : "✗"}</span><span>${esc(i.label)}<br /><span class="note">${esc(i.note)}</span></span></li>`).join("")}</ul>
      <div class="prob-row">
        <span class="prob-big">${pct(v.ev.inputs.p_win)}</span>
        <span class="band ${v.band}">${v.band} case</span>
        <span class="prob-math">rules ${pct(e.base_p_win)}${a ? ` ${shift >= 0 ? "+" : "−"} ${aiName()} ${Math.abs(Math.round(shift * 100))}` : ""}${overridden ? " · overridden by you" : ""}</span>
      </div>
      <p class="note">An estimate for comparing options, not a prediction of PayPal's decision.</p>
      ${a ? `<div class="ai-box">
          ${a.stale ? `<p class="stale">Case details changed since this assessment. Re-assess to update it.</p>` : ""}
          <p>${esc(a.summary)}</p>
          <p><strong>Buyer's best argument:</strong> ${esc(a.buyer_position)}</p>
          ${(a.adjustments || []).map((x) => `<div class="adj"><span class="delta ${x.direction}">${x.direction === "helps" ? "+" : "−"}${{ small: 3, medium: 6, large: 10 }[x.size] || 0}</span><div><strong>${esc(x.factor)}</strong> ${citeChips(x.fact_ids)}<div class="why">${esc(x.explanation)}</div></div></div>`).join("")}
          ${(a.missing_evidence || []).length ? `<p style="margin-top:10px"><strong>Evidence that would help</strong></p><ul class="missing">${a.missing_evidence.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>` : ""}
          <p class="note">Assessed by ${esc(a.model)} · ${esc(stamp(a.at))}</p>
        </div>` : `<div class="ai-box"><p class="note">${aiName()} reads the messages and details the checklist can't see, such as admissions, tone, or listing wording.</p></div>`}
      <div id="assess-error"></div>
    </div>`;
  }

  const EV_FIELDS = [
    { k: "dispute_fee", label: "Dispute fee if you lose ($)", step: 1 },
    { k: "account_risk", label: "Cost of a loss on your record ($)", step: 1 },
    { k: "hours_to_fight", label: "Your time to fight (hours)", step: 0.25 },
    { k: "hourly_rate", label: "Your time is worth ($/hour)", step: 1 },
    { k: "return_shipping", label: "Return shipping you pay ($)", step: 1 },
    { k: "recovery_value", label: "Value you recover on refund ($)", step: 1 },
    { k: "offer_amount", label: "Partial refund offer ($)", step: 1 },
    { k: "offer_accept_p", label: "Chance buyer accepts offer (0–1)", step: 0.05 },
  ];

  function evCardInner(inputs, defaults) {
    const r = DisputeEV.compute(inputs);
    const max = Math.max(...r.options.map((o) => o.expected_cost), 1);
    const best = r.options.find((o) => o.action === r.recommended);
    const runnerUp = r.options.filter((o) => o !== best).sort((a, b) => a.expected_cost - b.expected_cost)[0];
    const changed = (k) => Number(inputs[k]) !== Number(defaults[k]);
    return `
      <div class="card-head"><div><h3>Expected cost</h3><p>What each choice is likely to cost you. Lower is better. Change any input.</p></div>
        <button class="btn ghost small" id="ev-reset" type="button">Reset inputs</button></div>
      <div class="bars">${r.options.map((o) => `<div class="bar-row ${o.action === r.recommended ? "best" : ""}"><span class="bar-label">${esc(o.label)}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.max(2, (o.expected_cost / max) * 100)}%"></div></div><span class="cost">${money(o.expected_cost)}</span></div>`).join("")}</div>
      <div class="verdict"><strong>${esc(best.label)}</strong> saves about ${money(runnerUp.expected_cost - best.expected_cost)} versus "${esc(runnerUp.label.toLowerCase())}".
        ${breakevenText(r.breakeven_p_win)}</div>
      <div class="inputs">
        <label class="wide ${changed("p_win") ? "changed" : ""}">Win chance if you fight
          <span class="slider-row"><input type="range" min="0" max="1" step="0.01" data-k="p_win" value="${inputs.p_win}" /><input type="number" min="0" max="1" step="0.01" data-k="p_win" value="${inputs.p_win}" style="width:84px" /></span>
        </label>
        ${EV_FIELDS.map((f) => `<label class="${changed(f.k) ? "changed" : ""}">${esc(f.label)}<input type="number" min="0" step="${f.step}" data-k="${f.k}" value="${inputs[f.k]}" /></label>`).join("")}
      </div>
      <p class="note" style="margin-top:10px">Fight = (1 − win chance) × (amount + fee + record cost) + time. Refund = amount − recovered value + return shipping. Offer = accepted share × offer + rejected share × fight.</p>`;
  }

  function breakevenText(p) {
    if (p === null) return "";
    if (p >= 1) return " With these inputs, refunding costs less than fighting even with a certain win.";
    if (p <= 0) return " With these inputs, fighting costs less than refunding at any win chance.";
    return ` Fighting beats refunding when your win chance is above <strong>${pct(p)}</strong>.`;
  }

  function responseCard(v) {
    const c = v.case;
    if (c.submitted) {
      return `<div class="card"><div class="card-head"><div><h3>Response</h3></div></div>
        <div class="submitted"><strong>${c.submitted.simulated ? "Simulated" : "Sent to PayPal sandbox"}:</strong> ${esc(ACTIONS[c.submitted.action])} via <span class="mono">${esc(c.submitted.via)}</span> · ${esc(stamp(c.submitted.at))}</div>
        <p style="white-space:pre-wrap;font-size:0.92rem">${esc(c.submitted.text)}</p></div>`;
    }
    const d = c.draft;
    const rec = v.ev.result.recommended;
    const stale = d && d.action !== state.action;
    let body;
    if (!d || stale) {
      body = `<div class="empty">${d ? `Your draft is for "${esc(ACTIONS[d.action].toLowerCase())}". Draft again for this choice.` : "No draft yet."}</div>`;
    } else if (state.editing) {
      body = `<textarea id="draft-edit">${esc(d.text)}</textarea><p class="note">Edited text loses its fact citations, so check it carefully.</p>`;
    } else if (d.edited) {
      body = `<div class="draft-text" style="white-space:pre-wrap">${esc(d.text)}</div><p class="note">Edited by you. Citations are no longer tracked.</p>`;
    } else {
      const bad = d.sentences.filter((s) => s.unsupported).length;
      body = `<div class="draft-text">${d.sentences.map((s) => `<span class="sent ${s.unsupported ? "unsupported" : ""}">${esc(s.text)}</span>${s.kind === "fact" ? citeChips(s.fact_ids, s.unsupported) : ""} `).join("")}</div>
        <p class="note">${bad ? `${bad} sentence${bad > 1 ? "s state" : " states"} facts without a source. Fix or remove ${bad > 1 ? "them" : "it"} before sending.` : "Every factual sentence links to the case file. Click a tag to see the source."} Drafted by ${esc(d.model)}.</p>`;
    }
    return `<div class="card">
      <div class="card-head"><div><h3>Response</h3><p>Pick what to do. Nothing reaches PayPal until you approve it.</p></div></div>
      <div class="action-pick" role="group" aria-label="Response type">${Object.entries(ACTIONS).map(([k, label]) => `<button type="button" data-action="${k}" aria-pressed="${state.action === k}">${esc(label)}${k === rec ? `<span class="rec">best</span>` : ""}</button>`).join("")}</div>
      ${body}
      <div class="draft-actions">
        <button class="btn ${d && !stale ? "ghost" : "accent"} small" id="draft-btn" type="button" ${state.status && !state.status.ai ? "disabled" : ""}>${d && !stale ? "Redraft" : `Draft with ${aiName()}`}</button>
        ${d && !stale ? (state.editing ? `<button class="btn ghost small" id="save-edit" type="button">Save edit</button><button class="btn ghost small" id="cancel-edit" type="button">Cancel</button>` : `<button class="btn ghost small" id="edit-btn" type="button">Edit</button><button class="btn small" id="review-btn" type="button">Review &amp; approve</button>`) : ""}
      </div>
      <div id="draft-error"></div>
    </div>`;
  }

  function auditCard(c) {
    if (!(c.audit || []).length) return "";
    return `<div class="card"><div class="card-head"><div><h3>Activity</h3></div></div>
      <ul class="audit">${c.audit.slice().reverse().map((a) => `<li><time>${esc(stamp(a.at))}</time><span>${esc(a.message)}</span></li>`).join("")}</ul></div>`;
  }

  function citeChips(ids, unsupported) {
    if (unsupported) return `<span class="cite bad" title="No supporting fact">no source</span>`;
    return (ids || []).map((id) => `<button type="button" class="cite" data-fact="${esc(id)}" title="${esc(factText(id))}">${esc(id)}</button>`).join("");
  }
  function factText(id) {
    const f = state.view.facts.find((x) => x.id === id);
    return f ? f.text : "";
  }

  // ---------- wiring ----------

  function wireDetail() {
    const v = state.view;
    const id = encodeURIComponent(v.id);
    const root = $("#detail");

    root.querySelectorAll(".cite[data-fact]").forEach((b) =>
      b.addEventListener("click", () => {
        const target = document.getElementById(`fact-${b.dataset.fact}`);
        if (!target) return;
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        target.classList.add("flash");
        setTimeout(() => target.classList.remove("flash"), 1600);
      })
    );

    const assess = $("#assess-btn");
    if (assess) assess.addEventListener("click", () => busy(assess, "Reading case…", async () => {
      try {
        setView(await api("POST", `/api/cases/${id}/assess`), false);
        toast("Assessment updated");
      } catch (e) {
        $("#assess-error").innerHTML = `<div class="error-box">${esc(e.message)}</div>`;
      }
    }));

    root.querySelectorAll("[data-action]").forEach((b) => b.addEventListener("click", () => {
      state.action = b.dataset.action;
      state.editing = false;
      renderDetail();
    }));

    const draftBtn = $("#draft-btn");
    if (draftBtn) draftBtn.addEventListener("click", () => busy(draftBtn, "Drafting…", async () => {
      try {
        await flushEv();
        state.editing = false;
        setView(await api("POST", `/api/cases/${id}/draft`, { action: state.action }), false);
      } catch (e) {
        $("#draft-error").innerHTML = `<div class="error-box">${esc(e.message)}</div>`;
      }
    }));

    const edit = $("#edit-btn");
    if (edit) edit.addEventListener("click", () => { state.editing = true; renderDetail(); $("#draft-edit").focus(); });
    const cancel = $("#cancel-edit");
    if (cancel) cancel.addEventListener("click", () => { state.editing = false; renderDetail(); });
    const save = $("#save-edit");
    if (save) save.addEventListener("click", async () => {
      try {
        const next = await api("PUT", `/api/cases/${id}/draft`, { text: $("#draft-edit").value });
        state.editing = false;
        setView(next, false);
      } catch (e) {
        $("#draft-error").innerHTML = `<div class="error-box">${esc(e.message)}</div>`;
      }
    });

    const review = $("#review-btn");
    if (review) review.addEventListener("click", () => busy(review, "Preparing…", openApproval));

    const inv = $("#investigate-btn");
    if (inv) inv.addEventListener("click", () => busy(inv, "Calling PayPal…", async () => {
      try {
        setView(await api("POST", `/api/cases/${id}/investigate`), false);
        toast("Investigation complete");
      } catch (e) {
        const box = $("#investigate-error");
        if (box) box.innerHTML = `<div class="error-box">${esc(e.message)}</div>`;
        else toast(e.message);
      }
    }));

    const use = $("#use-tracking");
    if (use) use.addEventListener("click", () => {
      const sug = v.case.investigation.suggested_shipment;
      state.prefill = { carrier: sug.carrier, tracking_number: sug.tracking_number };
      state.showTracking = true;
      renderDetail();
      $("#tracking-form").scrollIntoView({ behavior: "smooth", block: "center" });
    });

    const tb = $("#tracking-btn");
    if (tb) tb.addEventListener("click", () => { state.showTracking = !state.showTracking; state.prefill = null; renderDetail(); });
    const tc = $("#tracking-cancel");
    if (tc) tc.addEventListener("click", () => { state.showTracking = false; state.prefill = null; renderDetail(); });
    const tf = $("#tracking-form");
    if (tf) tf.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const f = new FormData(tf);
      const iso = (k) => (f.get(k) ? new Date(f.get(k)).toISOString() : null);
      try {
        const res = await api("PUT", `/api/cases/${id}/shipment`, {
          carrier: f.get("carrier"),
          tracking_number: f.get("tracking_number"),
          shipped_at: iso("shipped_at"),
          delivered_at: iso("delivered_at"),
          delivered_to_address_match: f.get("delivered_to_address_match") === "on",
          signature_confirmation: f.get("signature_confirmation") === "on",
          upload_to_paypal: f.get("upload_to_paypal") === "on",
        });
        state.showTracking = false;
        state.prefill = null;
        setView(res, false);
        toast(res.note);
      } catch (e) {
        toast(e.message);
      }
    });

    const lb = $("#listing-btn");
    if (lb) lb.addEventListener("click", async () => {
      const text = prompt("Paste the listing description the buyer saw:");
      if (!text) return;
      setView(await api("PUT", `/api/cases/${id}/listing`, { listing_description: text }), false);
    });

    wireEv();
  }

  let evTimer = null;
  let evPending = null;

  function wireEv() {
    const card = $("#ev-card");
    card.querySelectorAll("input[data-k]").forEach((input) => input.addEventListener("input", () => {
      const v = state.view;
      const n = Number(input.value);
      if (!Number.isFinite(n) || input.value === "") return;
      v.ev.inputs[input.dataset.k] = n;
      // Keep the slider and number box for p_win in step without re-rendering the focused one.
      card.querySelectorAll(`input[data-k="${input.dataset.k}"]`).forEach((o) => { if (o !== input) o.value = n; });
      refreshEvOutputs();
      scheduleEvSave();
    }));
    $("#ev-reset").addEventListener("click", async () => {
      clearTimeout(evTimer);
      evPending = null;
      setView(await api("PUT", `/api/cases/${encodeURIComponent(state.view.id)}/ev`, { reset: true }), false);
    });
  }

  // Updates bars, verdict and the strength number without rebuilding inputs (keeps focus).
  function refreshEvOutputs() {
    const v = state.view;
    const tmp = document.createElement("div");
    tmp.innerHTML = evCardInner(v.ev.inputs, v.ev.defaults);
    const card = $("#ev-card");
    card.querySelector(".bars").replaceWith(tmp.querySelector(".bars"));
    card.querySelector(".verdict").replaceWith(tmp.querySelector(".verdict"));
    card.querySelectorAll(".inputs label").forEach((label, i) => label.className = tmp.querySelectorAll(".inputs label")[i].className);
    const prob = $("#detail .prob-big");
    if (prob) prob.textContent = pct(v.ev.inputs.p_win);
    const r = DisputeEV.compute(v.ev.inputs);
    $("#detail").querySelectorAll(".action-pick .rec").forEach((x) => x.remove());
    const recBtn = $(`#detail .action-pick [data-action="${r.recommended}"]`);
    if (recBtn) recBtn.insertAdjacentHTML("beforeend", `<span class="rec">best</span>`);
  }

  function scheduleEvSave() {
    clearTimeout(evTimer);
    evPending = { id: state.view.id, inputs: { ...state.view.ev.inputs } };
    evTimer = setTimeout(flushEv, 600);
  }

  async function flushEv() {
    clearTimeout(evTimer);
    if (!evPending) return;
    const { id, inputs } = evPending;
    evPending = null;
    try {
      const next = await api("PUT", `/api/cases/${encodeURIComponent(id)}/ev`, inputs);
      if (state.view && state.view.id === id) {
        state.view = next;
        const strength = $("#detail .prob-row");
        if (strength) {
          // Only the "overridden" label and band can change here; re-render the strength card cheaply.
          strength.querySelector(".band").className = `band ${next.band}`;
          strength.querySelector(".band").textContent = `${next.band} case`;
        }
        const row = state.cases.findIndex((c) => c.id === id);
        if (row >= 0) {
          state.cases[row] = { ...state.cases[row], p_win: next.p_win, band: next.band, recommended: next.recommended };
          if (state.grid) state.grid.setGridOption("rowData", state.cases);
        }
      }
    } catch (e) {
      toast(e.message);
    }
  }

  // ---------- approval ----------

  async function openApproval() {
    const v = state.view;
    const id = encodeURIComponent(v.id);
    let prep;
    try {
      prep = await api("POST", `/api/cases/${id}/approve/prepare`);
    } catch (e) {
      return toast(e.message);
    }
    const dlg = $("#approve-dialog");
    dlg.innerHTML = `<form method="dialog" class="inner">
      <h3>Review before sending</h3>
      <dl>
        <dt>Destination</dt><dd><span class="live-tag ${prep.plan.live ? "live" : "sim"}">${prep.plan.live ? "PayPal sandbox" : "Simulated"}</span> ${esc(prep.plan.target)}</dd>
        <dt>Action</dt><dd>${esc(prep.plan.describe)} <span class="mono note">(${esc(prep.plan.call)})</span></dd>
      </dl>
      <blockquote>${esc(prep.text)}</blockquote>
      ${prep.unsupported.length ? `<div class="error-box">${prep.unsupported.length} sentence${prep.unsupported.length > 1 ? "s in this draft state" : " in this draft states"} facts without a source in the case file. Edit the draft or confirm you have checked them.</div>` : ""}
      <label class="confirm"><input type="checkbox" id="confirm-box" /> <span>I have read this response and it is accurate. I want to ${esc(prep.plan.describe.charAt(0).toLowerCase() + prep.plan.describe.slice(1))}.</span></label>
      <div class="row">
        <button class="btn ghost" value="cancel" type="submit">Cancel</button>
        <button class="btn" id="confirm-btn" type="button" disabled>Approve &amp; send</button>
      </div>
    </form>`;
    dlg.showModal();
    const box = $("#confirm-box");
    const btn = $("#confirm-btn");
    box.addEventListener("change", () => (btn.disabled = !box.checked));
    btn.addEventListener("click", () => busy(btn, "Sending…", async () => {
      try {
        const res = await api("POST", `/api/cases/${id}/approve`, { token: prep.token, confirm: true });
        dlg.close();
        toast(res.simulated ? "Recorded (simulated for demo case)" : "Sent to PayPal sandbox");
        await loadCases(v.id);
      } catch (e) {
        dlg.close();
        toast(e.message);
      }
    }));
  }

  // ---------- top bar ----------

  $("#sync-btn").addEventListener("click", (e) => busy(e.currentTarget, "Syncing…", async () => {
    try {
      const r = await api("POST", "/api/sync");
      toast(`Imported ${r.imported} dispute${r.imported === 1 ? "" : "s"}${r.skipped ? `, skipped ${r.skipped} unsupported` : ""}`);
      await loadCases();
    } catch (err) {
      toast(err.message);
    }
  }));

  $("#reset-btn").addEventListener("click", (e) => busy(e.currentTarget, "Resetting…", async () => {
    await api("POST", "/api/reset-demo");
    state.view = null;
    await loadCases();
    toast("Demo cases reset");
  }));

  // Countdown refresh.
  setInterval(() => {
    if (state.grid) state.grid.refreshCells({ columns: ["due_at"], force: true });
    const v = state.view;
    const el = $("#detail .deadline .value");
    if (v && el && v.case.status === "OPEN") el.textContent = due(v.case.due_at).text;
  }, 30_000);

  loadStatus().then(() => loadCases()).catch((e) => toast(e.message));
})();
