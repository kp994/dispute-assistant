// Gemini provider (free tier friendly). Assess and draft use JSON-schema output.
// Investigate runs a function-calling loop where every tool is a read-only
// PayPal REST call made by this server, then a second call turns the tool
// results into the shared findings schema.

const { GoogleGenAI, ApiError } = require("@google/genai");
const P = require("./prompts");

const NAME = "Gemini";
const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";
const MAX_TOOL_ROUNDS = 5;
const RESULT_CHARS = 8000;

let client = null;
const api = () =>
  (client ||= new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    // Free-tier limits are per minute, so back off and retry on 429s.
    httpOptions: { retryOptions: { attempts: 4, initialDelay: 5, maxDelay: 30, httpStatusCodes: [429, 500, 503] } },
  }));

function configured() {
  return !!process.env.GEMINI_API_KEY;
}

const assess = (caseFile, checklist) => structured(P.assessPrompt(caseFile, checklist), P.ASSESS_SCHEMA);
const draft = (caseFile, action, opts) => structured(P.draftPrompt(caseFile, action, opts), P.DRAFT_SCHEMA);

// Read-only PayPal lookups Gemini may call. Names match PayPal's MCP tools.
const TOOLS = {
  get_dispute: {
    description: "Get a PayPal dispute: reason, status, amounts, messages, disputed transactions, evidence.",
    params: { dispute_id: { type: "string" } },
    required: ["dispute_id"],
    run: (pp, a) => pp.getDispute(a.dispute_id),
  },
  list_transactions: {
    description: "Search the seller's PayPal transactions in a date window of at most 31 days. Returns transaction, payer, shipping and cart info.",
    params: {
      transaction_id: { type: "string", description: "Optional. Narrow to one transaction." },
      start_date: { type: "string", description: "ISO 8601 date-time." },
      end_date: { type: "string", description: "ISO 8601 date-time." },
    },
    required: ["start_date", "end_date"],
    run: (pp, a) => pp.listTransactions(a),
  },
  get_shipment_tracking: {
    description: "Get shipment tracking that the seller added to a PayPal transaction.",
    params: { transaction_id: { type: "string" } },
    required: ["transaction_id"],
    run: (pp, a) => pp.getTrackers(a.transaction_id),
  },
  get_order: {
    description: "Get a PayPal Checkout order by id, including shipping address and items.",
    params: { order_id: { type: "string" } },
    required: ["order_id"],
    run: (pp, a) => pp.getOrder(a.order_id),
  },
};

const DECLARATIONS = Object.entries(TOOLS).map(([name, t]) => ({
  name,
  description: t.description,
  parametersJsonSchema: { type: "object", properties: t.params, required: t.required },
}));

async function investigate(c, paypal) {
  const contents = [{ role: "user", parts: [{ text: P.investigatePrompt(c) }] }];
  const calls = [];
  let model = MODEL;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const res = await api().models.generateContent({
      model: MODEL,
      contents,
      // Picking lookups is simple; low thinking keeps free-tier rounds fast.
      config: { systemInstruction: P.SYSTEM, tools: [{ functionDeclarations: DECLARATIONS }], thinkingConfig: { thinkingLevel: "LOW" } },
    });
    model = res.modelVersion || MODEL;
    const fcs = res.functionCalls || [];
    if (!fcs.length) break;
    // Keep the model turn as returned so its thought signatures survive.
    contents.push(res.candidates[0].content);

    const parts = [];
    for (const fc of fcs) {
      const tool = TOOLS[fc.name];
      const call = { tool: fc.name, input: fc.args || {}, ok: false };
      let response;
      try {
        if (!tool) throw new Error(`Unknown tool ${fc.name}`);
        const out = JSON.stringify(await tool.run(paypal, fc.args || {}));
        call.ok = true;
        call.result = out.slice(0, RESULT_CHARS);
        response = { result: call.result };
      } catch (e) {
        call.result = `Error: ${e.message}`;
        response = { error: e.message };
      }
      call.preview = call.result.slice(0, 600);
      calls.push(call);
      parts.push({ functionResponse: { id: fc.id, name: fc.name, response } });
    }
    contents.push({ role: "user", parts });
  }

  // Second pass: turn what the tools returned into the shared findings schema.
  const transcript = calls.length
    ? calls.map((x, i) => `[${i + 1}] ${x.tool}(${JSON.stringify(x.input)}) ${x.ok ? "returned" : "failed"}:\n${x.result}`).join("\n\n")
    : "No PayPal tools were called.";
  const report = await structured(
    `${P.investigatePrompt(c)}\n\nThese are the PayPal tool calls already made and what they returned:\n\n${transcript}\n\nReport your findings. source_tool must be the name of a tool above whose result shows the fact.`,
    P.INVESTIGATE_SCHEMA
  );
  return { data: report.data, model: report.model || model, calls: calls.map(({ result, ...rest }) => rest), via: "PayPal REST, called by this server" };
}

async function structured(prompt, schema) {
  const res = await api().models.generateContent({
    model: MODEL,
    contents: prompt,
    config: { systemInstruction: P.SYSTEM, responseMimeType: "application/json", responseJsonSchema: schema },
  });
  const finish = res.candidates && res.candidates[0] && res.candidates[0].finishReason;
  const text = res.text;
  if (!text) throw new Error(`Gemini returned no content${finish ? ` (${finish})` : ""}.`);
  if (finish === "MAX_TOKENS") throw new Error("Gemini's response was cut off. Try again.");
  return { data: JSON.parse(text), model: res.modelVersion || MODEL };
}

function errorStatus(err) {
  if (!(err instanceof ApiError)) return null;
  if (err.status === 429) {
    err.message = "Gemini free-tier rate limit reached. Wait a minute and try again.";
    return 429;
  }
  return 502;
}

module.exports = { NAME, MODEL, READ_TOOLS: Object.keys(TOOLS), configured, assess, draft, investigate, errorStatus };
