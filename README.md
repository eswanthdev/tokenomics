# tokenomics

A local, runnable evidence-backed AI FinOps prototype for Eswanth. Import synthetic AWS-style costs and invocation records, reconcile billing, allocate shared spend, investigate a period change, and connect spend to successful support outcomes.

**Synthetic demo, deterministic investigation, no live LLM agent.** No AWS credentials, SDK, cloud access, model calls, database, or deployment. Not production-ready. The server binds to `127.0.0.1` and stores no imports. Refreshing clears the view.

## Run

Requires Node.js 22+; no packages to install.

```sh
npm start
# Open http://127.0.0.1:3000
npm test
npm run check
npm run test:browser  # optional: local Chromium at /usr/bin/chromium
# CHROMIUM=/path/to/chromium npm run test:browser
```

Click **Load synthetic AWS example**, or download the sample, modify it and use **Import JSON**. A rejected import clears the previous report to avoid showing stale results. `PORT=3001 npm start` selects another local port. Stop with Ctrl-C.

The optional browser test uses headless Chromium with `--no-sandbox` for this container and a temporary profile. Use only trusted local content. It writes a mobile screenshot to `/tmp/tokenomics-mobile.png`, removes its profile, and stops the test server/browser.

## What works

- Browser import, strict core-field validation, actionable errors, empty state and clear/reset; 2 MB payload and 5,000 records per collection limits.
- Invoice-to-billing-line validation; billing-line-to-usage reconciliation with source links. Missing usage stays a gap.
- Workflow attribution by tags, token-weighted allocation of shared costs, and an explicit unallocated bucket.
- Period-over-period contributions by model/cost group, with references to every contributing source. Contributions sum exactly to observed spend change.
- Successful and failed workflow counts, linked-cost coverage, direct cost per successful outcome and fully allocated cost per successful outcome.
- Source billing, usage and outcome tables, including retries and failures, and visible assumptions/unknowns.

## Synthetic AWS-inspired schema

See `fixtures/support.json` for a complete import. This is a **simplified custom schema inspired by AWS billing exports/CUR and Bedrock invocation records**, not a CUR parser, supported AWS export format, or live connector. Account `000000000001` is fictional. Model names are fictional; costs are illustrative fixed values, **not current AWS rates**. No pricing lookup or rate claims are made.

Top-level fields:

| Field | Meaning |
| --- | --- |
| `schema_version` | Must be `1` |
| `synthetic` | Must be `true`; this flag is an assertion, not automatic data classification |
| `currency` | USD only |
| `periods` | Exactly two IDs in baseline/current order, each with integer `invoice_micros` |
| `billing_lines` | Unique ID, period, fictional 12-digit `account_id`, region, service and `cost_micros`; period sums must equal invoices |
| `usage` | Unique ID, period, billing reference, account/region/service, fictional model, token counts, cost, allocation tags and invocation metadata |
| `outcomes` | Unique ID, period, workflow and `success`/`failure` |

Every usage record requires `billing_line_id`, `account_id`, `region`, `service`, `model`, nonnegative integer `cost_micros`, `tokens`, `input_tokens`, `output_tokens`, boolean `shared`, `workflow` (ID or null), `outcome_id` (ID or null), integer `attempt` >= 1, `invocation_status` (`success`, `failure`, or `overhead`) and `tags` with `team` and `workflow`. Input + output tokens must equal total tokens. The workflow tag must equal the workflow field. References must match period/workflow or period/account/region/service as appropriate. IDs use 1–80 ASCII letters, digits, dots, underscores or hyphens. Monetary and token source fields are capped at 1 billion each. Unknown fields are ignored, not rendered.

A usage ID is the deduplication key; different IDs are treated as distinct events. Attempt numbers are descriptive, not an enforced retry sequence. `outcome_id` joins multiple attempts to one workflow outcome. Invocation failure can therefore belong to an ultimately successful workflow. Cost-only shared overhead uses zero tokens and null workflow/outcome; an untagged non-shared record stays unallocated.

## Calculations and expected example

Amounts must be exactly representable as integer microdollars; fractional microdollars are rejected. Import adapters must explicitly handle finer source precision, never silently truncate it. All source money, totals and allocations use integer microdollars (1 USD = 1,000,000 micros). Allocation multiplication uses `BigInt` to avoid intermediate precision loss. Shared source amounts are split across workflows by tagged non-shared token counts within the period. Floor each share, then distribute remaining microdollars by descending remainder, with workflow ID as a deterministic tie-break. Zero eligible tokens leaves the entire shared source unallocated. This policy is illustrative, not a measurement of overhead consumed.

| Measure | September | October |
| --- | ---: | ---: |
| Billing | $105.00 | $171.00 |
| Imported usage | $100.00 | $168.00 |
| Billing − usage gap | $5.00 | $3.00 |
| Allocated support spend | $100.00 | $165.00 |
| Unallocated | $0.00 | $3.00 |
| Successful / failed outcomes | 3 / 1 | 4 / 1 |
| Direct spend linked to successful outcomes | $45.00 | $110.00 |
| Direct cost per success | $15.00 | $27.50 |
| All allocated support cost per success | $33.33 | $41.25 |

October's $68.00 increase (68%) is premium +$60, standard +$18, and shared overhead −$10. A $10 failed invocation plus a $20 retry both link to October ticket 3; all $30 count toward that successful outcome. Failed workflow costs remain in total allocated spend but not the successful-outcome direct numerator.

Direct cost per success = costs linked to successful outcomes / count of successful outcomes. Allocated cost per success = all workflow-tagged plus allocated shared costs / successful outcomes. Monetary amounts display up to six decimals so sub-cent gaps stay visible. Exact numerators and denominators remain in the API; ratios and percentages are rounded only for display. Zero denominators return null, rendered as N/A. These are costs, **not ROI**, profit or verified business value. Missing links can understate direct costs, even when an outcome has at least one linked record.

## Architecture and future integration

- `src/engine.js`: pure validation, reconciliation, allocation, outcome metrics and `investigate(data, periods)`.
- `src/server.js`: small HTTP adapter, fixed static routes, sample GET and stateless `POST /api/analyze`.
- `public/`: responsive interface without third-party assets/scripts.
- `test/`: independent expected-value finance tests and HTTP integration checks.
- `scripts/browser-smoke.js`: real Chromium import/report/error/mobile checks through DevTools.

`investigate` is the future model/tool integration boundary. Its evidence bundle includes deterministic metrics, source IDs, contributions and unknowns; a future model could narrate that bundle behind a separate adapter. The arithmetic, references and policy must stay authoritative and independently tested. This version makes no model call and is explicitly labeled `deterministic-evidence-v1`.

## Limits and next steps

Only two manually selected periods, USD and nonnegative microdollar amounts are supported. Period duration, completeness, success labels, tag truth and duplicate events with different IDs are not independently verified. Amounts finer than one microdollar, credits/refunds, taxes, commitments, discounts, currencies, invoice timing, and AWS CUR columns need an explicit ingestion design. Token weighting ignores differences in input/output rates and model prices. Model-group changes show contributions, not causal volume/rate/mix decomposition.

There is no persistence, authentication, authorization, audit-log service or multi-user isolation. Imports are intended to contain synthetic records only; the flag cannot verify that. This local prototype has bounded payloads and escaped output but has not undergone production security or accessibility review.

Next: validate the workflow with users; define authoritative billing/invocation identifiers and source precision requirements; add explicit period windows and coverage checks; design offline AWS export adapters and allocation policies; then evaluate a read-only narrative agent against verified evidence. Live integrations, credentials and publication require a separate decision.
