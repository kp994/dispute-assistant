# PayPal AI Hackathon submission

Submit by **November 12, 2026 at noon PST (November 13 at 1:30 a.m. IST)**. Keep judging access available at no charge through **December 15 at 8 a.m. PST (9:30 p.m. IST)**. [Official rules](https://paypalaihackathon.devpost.com/rules) · [Event overview](https://paypalaihackathon.devpost.com/)

## Submission checklist

| Requirement | Dispute Agent |
| --- | --- |
| Meaningful PayPal sandbox and AI integration | Sandbox disputes drive the case workflow. Gemini uses read-only PayPal tools during investigation and produces structured assessments and drafts. Rehearse the full flow on a dedicated test dispute before recording. |
| Working build and free judging access | The [README](README.md) includes local setup, a sample-case walkthrough, and instructions for enabling Gemini and connecting PayPal sandbox. Hosting is optional. Supply access instructions for any private test deployment. |
| Public open-source repository | Publish the source, assets, setup instructions, and [MIT license](LICENSE) on GitHub, GitLab, or Bitbucket. Check that the host detects the license. Add the repository URL to Devpost. |
| English project description and tool disclosure | Adapt the text below. If this extends a pre-existing project, identify the substantial changes made since October 1. |
| Public YouTube demo under three minutes | Record the browser workflow with working software and use material you have rights to include. Upload publicly and paste the link into Devpost. |
| Entry and eligibility | Register and complete the required Devpost fields. Check age, residency, conflicts, ownership, third-party rights, and sponsor-support restrictions against the official rules. For a team or organization, designate an authorized representative. |

AG Grid Community powers the deadline queue and is the existing sponsor integration to show in the video. Render is configured as a hosting option. List it as a tool used if you actually deploy there. The sponsor categories are optional. [Prize rules, section 8](https://paypalaihackathon.devpost.com/rules)

## Devpost description

**Dispute Agent helps small online sellers decide which PayPal disputes are worth fighting and prepare a response they can verify.** Sellers start with a deadline-sorted queue, then review the disputed transaction, shipment, and buyer messages in one case file.

When a case is imported from PayPal sandbox, Gemini can choose read-only PayPal lookups to investigate it. The app shows which calls succeeded and turns findings from those calls into facts a draft can cite. A checklist sets the starting win estimate, and evidence-based AI adjustments are capped. Sellers can change the assumptions to compare the expected cost of fighting, refunding, and making a partial offer. They review the draft, inspect its citations, and confirm the action before it goes to PayPal sandbox.

**Tools used.** PayPal Sandbox Disputes API for imports and seller-approved actions, with PayPal reporting, tracking, and Orders lookups for investigation. Gemini provides function calling and structured assessment and drafting. Claude is an optional provider with read-only PayPal MCP investigation. AG Grid Community powers the dispute queue.

## Demo recording plan

Rehearse on a dedicated sandbox dispute with a seller action available and usable shipment or transaction evidence. Use sample data in the video and keep keys and account credentials off screen.

| Time | Screen and narration |
| --- | --- |
| 0:00–0:20 | State the small-seller problem. Show the deadline queue, sort by deadline, and open a newly synced PayPal sandbox case. |
| 0:20–0:55 | Run **Investigate in PayPal**. Expand the tool log, then show a fact added to the case from a successful call. |
| 0:55–1:30 | Run the assessment. Show one cited factor and the buyer's strongest argument. Change a cost input and point to how the comparison changes. |
| 1:30–2:10 | Generate a response, follow a citation to its evidence, and show the confirmation dialog with the action and sandbox destination. |
| 2:10–2:45 | Confirm on the dedicated test dispute. Show the app's audit trail and verify the action in PayPal sandbox. Close with how this helps the seller prioritize their time and check the evidence before acting. |

The same sequence covers the five equally weighted judging criteria. The PayPal calls and AI output demonstrate implementation. The queue-to-approval flow demonstrates design. The small-seller example shows impact. Editable economics and source-linked drafts demonstrate the idea. The completed sandbox action anchors the presentation. [Judging criteria](https://paypalaihackathon.devpost.com/#judging-criteria)
