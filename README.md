# Dispute Agent

Small online sellers lose money on PayPal disputes in three ways: they miss the response deadline, they submit the wrong evidence, or they fight cases that cost more to fight than the sale was worth.

Dispute Agent puts each dispute's order, tracking and buyer messages into one case file. It compares the expected cost of fighting, refunding, or making an offer, and drafts a response with links to the case file. Dispute responses require seller review and confirmation before submission to PayPal sandbox.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/).

See the [Devpost submission checklist, description, and demo script](HACKATHON.md).

## What it does

- **Deadline-first queue.** Open disputes sorted by time left, with a recommended action for each (AG Grid).
- **Case strength from rules, not vibes.** A checklist based on PayPal Seller Protection for item-not-received claims (tracking, delivered, delivered to the transaction address, signature at $750+, tracking uploaded) sets a base win chance.
- **AI reads what the rules can't.** The AI reviews the messages and listing and names factors that help or hurt, each tied to the facts it relied on. Each factor moves the estimate by a fixed small, medium or large step, capped at ±15 points. The AI never picks the number directly. It also states the buyer's strongest argument.
- **Expected-cost panel.** This compares fighting, a full refund, and a partial-refund offer. Every input is editable: win chance, dispute fee, your time, return shipping, resale value, offer amount and acceptance odds. The panel also shows the break-even win chance where fighting beats refunding.
- **Drafts that cite their sources.** Every factual sentence in a draft is tagged with the case-file facts behind it. A sentence with no valid source is highlighted, and the approval screen warns about it.
- **AI investigates in PayPal.** For imported sandbox disputes, the AI decides which PayPal lookups to make: the dispute, the transaction, the shipment tracking and the order. It then adds what it found to the case file as citable facts. Only read tools are available. Every call and its result is shown, and the server drops any finding that isn't backed by a successful call.
- **Two-step approval.** The server issues a short-lived confirmation token tied to the reviewed draft, action, and submission details. Changes require a new review.
- **Tracking upload.** Add tracking to a case and upload it to the PayPal transaction.

## PayPal integration (sandbox)

| Feature | API |
| --- | --- |
| Import disputes | `GET /v1/customer/disputes`, `GET /v1/customer/disputes/{id}` |
| Fight with evidence | `POST /v1/customer/disputes/{id}/provide-evidence` (multipart, with tracking as `PROOF_OF_FULFILLMENT`) |
| Reply in the thread | `POST /v1/customer/disputes/{id}/send-message` |
| Refund in full | `POST /v1/customer/disputes/{id}/accept-claim` |
| Partial refund offer | `POST /v1/customer/disputes/{id}/make-offer` |
| Upload tracking | `POST /v1/shipping/trackers-batch` |
| AI investigation (Gemini) | Function calls answered by this server: `GET /v1/customer/disputes/{id}`, `GET /v1/reporting/transactions`, `GET /v1/shipping/trackers`, `GET /v2/checkout/orders/{id}` |
| AI investigation (Claude) | PayPal's hosted MCP server `https://mcp.sandbox.paypal.com/sse`, read-only tools `get_dispute`, `list_transactions`, `get_shipment_tracking`, `get_order` |

REST calls go to `https://api-m.sandbox.paypal.com`. The AI only ever gets read-only lookups, on purpose. Tools that move money (`accept_dispute_claim`, `create_refund`) are never given to it, so every write goes through the app's own REST calls and the seller's approval. The four built-in demo cases are simulated and never call PayPal. The approval dialog labels every action as **Simulated** or **PayPal sandbox**.

## AI tools used

The AI layer has one interface ([`src/ai.js`](src/ai.js)) with two providers. Both use the same prompts and output schemas ([`src/prompts.js`](src/prompts.js)).

- **Google Gemini (default, free tier)** through `@google/genai`:
  - **Assess:** JSON-schema output with a summary, the buyer's position, the factors that help or hurt (with fact ids), and missing evidence.
  - **Draft:** JSON-schema output of sentences, each labeled as fact or courtesy, with fact ids for every fact sentence.
  - **Investigate:** function calling. Gemini picks which of four read-only PayPal lookups to call, this server runs them against the PayPal REST API, and a second call turns the results into findings, tracking, the ship-to address and gaps.
- **Claude (optional)** through `@anthropic-ai/sdk`. Set `AI_PROVIDER=claude` and `ANTHROPIC_API_KEY`. Investigation then uses Anthropic's MCP connector to reach PayPal's hosted MCP server, with a toolset allowlist that enables only the read tools.
- **PayPal AI Toolkit** ([paypal/AI-Toolkit](https://github.com/paypal/AI-Toolkit)) during development, for PayPal API best practices, error explanations and sandbox access while building the integration.
- **Guardrails:**
  - Buyer messages and tool results are treated as data, not instructions.
  - The server drops any fact ids the AI cites that don't exist.
  - The server also drops any investigation finding that isn't backed by a successful PayPal call.
- **The decision is arithmetic, not the AI.** The win chance comes from rules plus a capped, explained AI adjustment. The final choice is plain math in [`public/ev.js`](public/ev.js), shared by the server and the browser.

### For judges

Start with the four sample cases to try the deadline queue, evidence checklist, and expected-cost calculator without signing up for anything. For AI assessment, citation-linked drafting, and simulated approval on sample cases, configure Gemini using the steps below. For investigation and a real sandbox submission, also connect a dedicated PayPal sandbox business account and import a test dispute.

## Run it locally

Requires Node 20+.

```bash
npm ci
npm start
```

Open [localhost:3000](http://localhost:3000). Choose a case in the queue, inspect its evidence, and move the win-chance slider to see the expected costs update. **Reset demo** restores the four sample cases and their relative deadlines.

To enable AI, stop the server, copy `.env.example` to `.env` (`Copy-Item .env.example .env` in PowerShell or `cp .env.example .env` on macOS/Linux), set `GEMINI_API_KEY` from [Google AI Studio](https://aistudio.google.com/), and restart. Use a free-tier key where available. Open a sample case, select **Assess**, generate a draft, click a citation to inspect its source, and review and confirm the simulated submission. Claude is optional and requires its own key.

### Try it with real sandbox disputes

1. Create a sandbox REST app at https://developer.paypal.com/dashboard/applications/sandbox, then put its client id and secret in `.env`.
2. Use a sandbox **personal** account to pay the sandbox **business** account. Any sandbox checkout works.
3. Sign in to https://www.sandbox.paypal.com as the buyer and open a dispute on that payment ("item not received" or "not as described").
4. Restart the app after adding the keys. Click **Sync PayPal sandbox**, open the imported case, and run **Investigate in PayPal**. Review the call log and evidence, accept applicable tracking, then assess and draft.
5. Use a dedicated test dispute for submission. Review the destination and action before confirming, then check the app's audit trail and the dispute in the PayPal sandbox account. Available actions depend on the dispute's stage and status.

## Deploy on Render

`render.yaml` defines a free web service. For a public sample-case demo, leave PayPal credentials unset and optionally set `GEMINI_API_KEY` in the Render dashboard. The app uses a shared case store. Use a private or local instance with dedicated sandbox accounts for connected testing. The AI routes are rate limited (`AI_REQUESTS_PER_HOUR`).

Render's free disk is wiped on restart. When the data file is missing, the app re-creates the demo cases at startup, so a fresh instance always has something to show. Imported sandbox disputes come back with **Sync**.

## Project layout

```
server.js            Express routes, approval flow, rate limit for AI calls
src/eligibility.js   Seller Protection checklist, base win chance, capped AI shift
src/facts.js         Case file -> numbered facts the AI can cite
src/ai.js            Picks the AI provider (Gemini or Claude)
src/prompts.js       Shared prompts and JSON schemas
src/gemini.js        Gemini: assess, draft, function-calling investigation
src/claude.js        Claude: assess, draft, MCP-connector investigation
src/paypal.js        PayPal sandbox client and dispute -> case mapping
src/store.js         JSON-file store with relative-date seeding
seed/cases.json      Four demo disputes
public/              Vanilla JS UI, AG Grid queue, shared EV math
```

## Limits

- The checklist is a simplified reading of PayPal Seller Protection, not policy or legal advice.
- Win chance is an estimate for comparing options, not a prediction of PayPal's decision.
- Real sellers keep orders and tracking in their store platform (Shopify, eBay, ShipStation and so on). Here the seller enters tracking by hand, and connecting a store platform is future work.
