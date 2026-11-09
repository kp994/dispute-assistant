// Claude provider. Assess and draft use structured JSON outputs; investigate
// connects Claude to PayPal's hosted MCP server with only read tools enabled.

const Anthropic = require("@anthropic-ai/sdk").default;
const P = require("./prompts");

const NAME = "Claude";
const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
let client = null;
const api = () => (client ||= new Anthropic());

// Anything that moves money (accept_dispute_claim, create_refund) stays behind
// the app's own approval flow and is never enabled here.
const READ_TOOLS = (process.env.PAYPAL_MCP_READ_TOOLS || "get_dispute,list_transactions,get_shipment_tracking,get_order")
  .split(",").map((s) => s.trim()).filter(Boolean);

function configured() {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

const assess = (caseFile, checklist) => structured(P.assessPrompt(caseFile, checklist), P.ASSESS_SCHEMA, "high");
const draft = (caseFile, action, opts) => structured(P.draftPrompt(caseFile, action, opts), P.DRAFT_SCHEMA, "medium");

async function investigate(c, paypal) {
  const token = await paypal.accessToken();
  const messages = [{ role: "user", content: P.investigatePrompt(c) }];
  const calls = [];
  let res;
  // The server runs the tool loop; pause_turn means it wants another round.
  for (let round = 0; round < 4; round++) {
    res = await api().beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ["mcp-client-2025-11-20", "server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: P.SYSTEM,
      output_config: { effort: "medium", format: { type: "json_schema", schema: P.INVESTIGATE_SCHEMA } },
      mcp_servers: [{ type: "url", url: paypal.MCP_URL, name: "paypal", authorization_token: token }],
      tools: [{
        type: "mcp_toolset",
        mcp_server_name: "paypal",
        default_config: { enabled: false },
        configs: Object.fromEntries(READ_TOOLS.map((t) => [t, { enabled: true }])),
      }],
      messages,
    });
    collectCalls(res.content, calls);
    if (res.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: res.content });
  }
  return { data: parseFinal(res), model: res.model, calls, via: "PayPal MCP server" };
}

function collectCalls(content, calls) {
  for (const b of content) {
    if (b.type === "mcp_tool_use") calls.push({ id: b.id, tool: b.name, input: b.input, ok: null });
    if (b.type === "mcp_tool_result") {
      const call = calls.find((x) => x.id === b.tool_use_id);
      if (call) {
        call.ok = !b.is_error;
        const text = (Array.isArray(b.content) ? b.content : []).filter((x) => x.type === "text").map((x) => x.text).join("\n");
        call.preview = text.slice(0, 600);
      }
    }
  }
}

async function structured(prompt, schema, effort) {
  const res = await api().beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: P.SYSTEM,
    output_config: { effort, format: { type: "json_schema", schema } },
    messages: [{ role: "user", content: prompt }],
  });
  return { data: parseFinal(res), model: res.model };
}

function parseFinal(res) {
  if (res.stop_reason === "refusal") throw new Error("Claude declined to process this case.");
  if (res.stop_reason === "max_tokens") throw new Error("Claude's response was cut off. Try again.");
  if (res.stop_reason === "pause_turn") throw new Error("Claude needed more rounds than allowed. Try again.");
  const text = res.content.filter((b) => b.type === "text").pop();
  if (!text) throw new Error("Claude returned no content.");
  return JSON.parse(text.text);
}

// Maps SDK errors to an HTTP status for the API response.
function errorStatus(err) {
  return err instanceof Anthropic.APIError ? 502 : null;
}

module.exports = { NAME, MODEL, READ_TOOLS, configured, assess, draft, investigate, errorStatus };
