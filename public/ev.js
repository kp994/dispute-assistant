// Expected-value math for fight / refund / partial-offer decisions.
// Shared by the server (require) and the browser (window.DisputeEV) so the
// panel the seller edits runs exactly the same numbers the server recommends.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DisputeEV = factory();
})(typeof self !== "undefined" ? self : this, function () {
  // Defaults are assumptions the seller is expected to change.
  function defaultInputs(c, pWin) {
    const amount = Number(c.amount) || 0;
    const notAsDescribed = c.reason === "NOT_AS_DESCRIBED";
    return {
      amount,
      p_win: round(pWin, 2),
      dispute_fee: 15, // charged when a claim is escalated and lost; check your PayPal fee schedule
      account_risk: 10, // what a lost claim on your record is worth to you
      hours_to_fight: notAsDescribed ? 1 : 0.5,
      hourly_rate: 25,
      return_shipping: notAsDescribed ? 8 : 0,
      recovery_value: notAsDescribed ? round(amount * 0.6, 2) : 0, // resale value of a returned item
      offer_amount: round(amount * 0.3, 2),
      offer_accept_p: notAsDescribed ? 0.5 : 0.3,
    };
  }

  function compute(inp) {
    const n = (k) => Number(inp[k]) || 0;
    const amount = n("amount");
    const p = clamp(n("p_win"), 0, 1);
    const timeCost = n("hours_to_fight") * n("hourly_rate");
    const lossIfLost = amount + n("dispute_fee") + n("account_risk");

    const fight = (1 - p) * lossIfLost + timeCost;
    const refund = amount - n("recovery_value") + n("return_shipping") + 0.1 * n("hourly_rate");
    const accept = clamp(n("offer_accept_p"), 0, 1);
    // If the buyer rejects the offer you are back to fighting.
    const offer = accept * (n("offer_amount") + 0.2 * n("hourly_rate")) + (1 - accept) * fight;

    const options = [
      { action: "fight", label: "Fight with evidence", expected_cost: round(fight, 2) },
      { action: "refund", label: "Refund in full", expected_cost: round(refund, 2) },
      { action: "offer", label: "Offer partial refund", expected_cost: round(offer, 2) },
    ];
    const best = options.reduce((a, b) => (b.expected_cost < a.expected_cost ? b : a));

    // Win probability at which fighting and refunding cost the same.
    const breakeven = lossIfLost > 0 ? clamp(1 - (refund - timeCost) / lossIfLost, 0, 1) : null;

    return {
      options,
      recommended: best.action,
      breakeven_p_win: breakeven === null ? null : round(breakeven, 3),
      margin: round(
        Math.min(...options.filter((o) => o !== best).map((o) => o.expected_cost)) - best.expected_cost,
        2
      ),
    };
  }

  function clamp(x, lo, hi) {
    return Math.min(hi, Math.max(lo, x));
  }
  function round(x, d) {
    const f = Math.pow(10, d);
    return Math.round(x * f) / f;
  }

  return { defaultInputs, compute };
});
