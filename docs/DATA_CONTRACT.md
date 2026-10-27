# Synthetic import contract

## Envelope

A JSON object with `schema_version` (1 or 2), `synthetic: true`, `currency: "USD"`, `periods`, `billing_lines`, `usage`, and `outcomes`. Unknown fields are retained in source evidence but never used as instructions or promoted into tool context. There are no external URLs to fetch or commands to execute in the contract.

- Import body: at most 2 MB, including the API wrapper/name.
- Collections: at most 5,000 usage, billing and outcome records each.
- Periods: 2–24, ordered from oldest to newest. IDs are unique.
- IDs: 1–80 ASCII letters, digits, `.`, `_`, or `-`.
- Numeric source fields: nonnegative safe integers up to 1,000,000,000. Monetary units are microdollars, so this is $1,000 per individual source amount and invoice summary in this bounded demo.
- Costs finer than one microdollar are rejected; adapters must explicitly handle their source precision rather than truncate it. The number of rows and per-field limits bound aggregate monetary integers below JavaScript's safe integer limit; allocation products use `BigInt`.

## Periods and billing

Each period requires `id` and `invoice_micros`. Schema v2 additionally requires ISO `start` and `end` dates. End is exclusive; dates must be real, ordered and non-overlapping. Gaps between periods are allowed. Differences in duration are disclosed, not automatically normalized. Period IDs are labels; source coverage inside a window is not independently proven.

Each billing line requires `id`, `period`, string `account_id` (12 fictional digits), `region`, `service` and `cost_micros`. Billing lines must sum to the invoice summary for each period. Negative source amounts are unsupported. Positive and negative **reconciliation differences** are both supported.

## Usage/invocation records

| Field                                     | Contract                                                          |
| ----------------------------------------- | ----------------------------------------------------------------- |
| `id`, `period`                            | Unique usage ID and existing period                               |
| `billing_line_id`                         | Existing billing line with matching period/account/region/service |
| `account_id`, `region`, `service`         | Explicit billing dimensions                                       |
| `model`                                   | Fictional model/cost-group ID; no pricing lookup                  |
| `cost_micros`                             | Exact integer microdollars                                        |
| `input_tokens`, `output_tokens`, `tokens` | Nonnegative integers; input + output = total                      |
| `workflow`                                | Workflow ID or null                                               |
| `outcome_id`                              | Existing outcome ID or null; must match period/workflow           |
| `shared`                                  | Boolean; shared rows cannot carry workflow/outcome links          |
| `attempt`                                 | Integer ≥1; descriptive, not a verified retry sequence            |
| `invocation_status`                       | `success`, `failure` or `overhead`                                |
| `tags`                                    | Object with ID `team` and `workflow` matching the workflow field  |

Shared overhead may have zero tokens, no outcome and an `overhead` status. An untagged non-shared cost remains unallocated. A failed invocation may link to an ultimately successful workflow (e.g. a later retry succeeds). An invocation success linked to a failed workflow is a review finding, not an automatic correction. Reusing the same usage ID is rejected; two different IDs with otherwise identical records are not automatically deduplicated.

## Outcomes

All versions require `id`, `period`, `workflow` and `status` (`success` or `failure`). V2 additionally requires `account_id`, `region`, and `team`. A linked v2 invocation must agree with all outcome dimensions. Successful outcomes with no cost links remain in the denominator and are flagged; their cost is unknown, not assumed to be truly zero.

V1 imports remain readable, but lack window and outcome dimensional evidence. Account/region/team-filtered outcome ratios are therefore unavailable. Model-filtered ratios are unavailable for both schemas: attributing a workflow success denominator to one model would imply an unsupported relationship.

## Allocation and filters

For each shared record, consider only tagged non-shared usage in the same period/account/region. Sum token weights by `(workflow, team)`. Compute integer microdollar shares using largest remainder, breaking equal remainders by stable key order. A zero-weight pool leaves the source unallocated. Expanded allocation entries are capped at 50,000 per analysis.

The full ledger is built before applying account, region, model, workflow and team filters. Each allocated entry carries its original source ID/model plus its target workflow/team. The scoped spend therefore contains direct costs and the matching shares of overhead. Selecting a model filters source cost by that model; it does not infer which model caused a workflow success.

Billing views apply account/region filters only. The data-quality page explicitly shows full-period findings across all accounts. Investigation/model tools instead keep evidence within the selected scope: billing-gap findings are omitted with an explanation under model/workflow/team filters because billing has no such attribution. Model-filtered outcome-coverage findings are also unavailable. Evidence explorer searches the full selected dataset, independent of dashboard filters.

## Counterfactual variance decomposition

For a model with positive baseline tokens:

- Observed change = current cost − baseline cost.
- Token-volume effect = baseline cost × (current tokens − baseline tokens) / baseline tokens, rounded once to the nearest microdollar, ties away from zero.
- Rate/mix residual = observed change − rounded token-volume effect.

The exact rational numerator (decimal string) and denominator are retained in finding calculation inputs. If the counterfactual or residual cannot be represented safely as an integer, decomposition is unavailable while source totals remain valid. Zero-token overhead has no token-rate decomposition. These numbers are a transparent arithmetic split, **not verified price, mix, routing or causal effects**.

## Synthetic fixture

`workbench.json` covers May–October 2026, fictional accounts `000000000001` and `000000000002`, regions `us-east-1` and `eu-west-1`, and support, knowledge search and document review workflows. October introduces premium-model mix, repeated support attempts, missing cost links, untagged usage and billing differences. Model names and fixed costs are illustrative, not actual Bedrock prices. `npm run fixture` reproduces the input without randomness or network access.
