# FinOps rule-agent slice

This slice assesses synthetic resource evidence with a deterministic supervisor and three service-pattern workers. These are ordinary bounded code paths, **not live LLM agents**. It complements the existing AI spend-to-outcome tools. No AWS access, credentials, paid inference, telemetry or resource-changing tools are present.

## Inspect locally

Use Node 22.13+ (this slice was exercised on Node 24.19.0), run `npm ci --ignore-scripts` and `npm start`, then open **http://127.0.0.1:3000/finops**. The existing interface also links to **FinOps agent**. Load the synthetic example and run an assessment. Inspect individual findings, evidence buttons, the supervisor dispatch trace and the rule catalog. The existing exact Codespaces preview configuration applies; keep its port private. This slice was not tested in an actual authenticated Codespace.

A first visit is intentionally empty. The example import is explicit and repeatable; identical serialized snapshots deduplicate. Reopening the app preserves imported evidence and saved assessments. A sample run contains six tasks across two fictional account/Region pairs and ends **partial** because one CloudTrail coverage entry is denied. Partial is a coverage result, not permission to assume missing spend is zero.

## Rule catalog and financial boundaries

`src/finops-rules.js:catalog` is deeply frozen and content-versioned. Each rule includes its ID/version, source document/page, category, requirements, policy parameters, deterministic condition, exclusions, dependencies, risk, savings basis and test categories. The source is the parent's user-approved specification for **AWS_cost_Optimization - Google Sheets.pdf**, pages 1, 5 and 6. The PDF itself was not independently parsed in this slice.

Parameters are explicit versioned policy defaults, not AWS recommendations or universally safe thresholds. To tune policy in this first slice, review a catalog change, update the rule version and expectations, and rerun tests. There is deliberately no unvalidated per-request policy override. Saved runs retain catalog hash and each finding retains rule version; historical interpretations are not silently recomputed under new policy. Each run also stores the full catalog snapshot for historical policy lookup.

- **EC2-UTIL-001 v0.1:** at least 14 representative days and an observation window at least 14 days long, known peaks represented, at least 95% of expected five-minute running samples, nearest-rank p95 below 5% and maximum below 20%. Missing CPU/peaks/coverage prevents the observation. Missing memory/I/O/license/ASG suitability is a decision blocker, not a false claim that CPU evidence is absent. DR/batch/burstable/GPU dependencies exclude ordinary rightsizing; unknown exclusions remain blockers. There is no compatible-target/rate model, so all EC2 savings remain unquantified.
- **S3-LIFECYCLE-001 v0.1:** upload older than seven days; two complete paginated snapshots at least 24 hours apart; unchanged part digest and byte count; fresh latest snapshot. Known active/long-running uploads are excluded. Unknown activity/lifecycle is insufficient evidence. Effective lifecycle cleanup is pending cleanup, not another opportunity. Missing bytes prevent confirmation of unchanged storage. Missing applicable rate leaves a review candidate unquantified. Zero stored bytes produce no opportunity. No observed activity does not establish abandonment.
- **CLOUDTRAIL-DUP-001 v0.1:** normalize source ARN to its declared home Region, verify canonical identity and member ownership, deduplicate canonical shadow representations within each account/Region, and compare active management Read/Write atoms. Organization trails are represented explicitly in each covered member account/Region. Conflicting shadows or incomplete permissions block comparison. Different names alone, disjoint selectors or inactive trails do not establish overlap. Required destinations are excluded from removable opportunities. Quantification additionally needs an asserted verified avoidable additional-copy volume/rate and a matching active retained trail covering every affected selector. No delete/disable API exists.

CloudTrail's Read/Write selector atoms are a **simplified normalized contract**, not an implementation of every CloudTrail selector variant or an AWS collector. Unsupported advanced selectors/coverage must be represented as unsupported or partial; declaring them complete without normalization would misrepresent the source. Cross-partition ARNs are unsupported.

Gross opportunity uses exact BigInt rational arithmetic. S3: `part_bytes × micros_per_GiB_month / 1073741824`, assuming one month of persistence. CloudTrail: `verified_avoidable_additional_events × micros_per_100000_events / 100000` for the supplied volume, not an inferred monthly run rate. Numerator and denominator are decimal strings; rounded microdollars are also strings, with round-half-up for these nonnegative amounts. A sub-microdollar estimate may display zero rounded microdollars while its nonzero exact fraction remains visible. This does not round individual historical invocation costs; the existing spend engine is unchanged.

The fixture uses illustrative rates, not current AWS prices: 10 GiB at 23,000 microdollars/GiB-month yields **$0.230000** gross; 100,000 asserted avoidable management copies at 2,000,000 microdollars/100k yields **$2.000000** gross. Neither is realizable bill savings. Discounts, commitments, retained destinations, actual producer behavior and future persistence can change the bill effect. There is **no sum of opportunities**; CloudTrail candidate alternatives may overlap.

## Immutable evidence contract

`fixtures/resources.json` is the executable example. `validateEvidence` rejects invalid synthetic envelopes, duplicate IDs, out-of-scope rows, invalid timestamps, unknown service types and unsafe/noninteger numeric fields. API imports are limited to 2 MB; envelopes to 20 enabled account/Region pairs, 60 coverage rows and 100 resource representations. This is a bounded local assessment, not account-wide production inventory support.

Envelope fields:

- `schema_version: 1`, `synthetic: true`, and `as_of` (UTC ISO timestamp).
- `scopes`: explicit unique account IDs and enabled Regions. All supplied scopes are dispatched; the application does not discover or enable Regions. Completeness of the supplied Region list is not independently verified.
- `coverage`: stable ID, account, Region, service, observed timestamp, and `complete | partial | denied | unsupported | missing`. An absent entry is missing. Complete empty inventory is explicitly distinct from denied/missing inventory.
- `resources`: stable ID, account, Region, service, observed timestamp and service-specific `facts`.

Freshness is assessed against **the snapshot's historical as-of timestamp**, not today's clock. The policy is 48 hours. Future observation times are rejected; stale coverage/resources block confidence. CPU additionally requires a fresh metric window end. S3 snapshots carry independent times/completeness flags. Missing/unknown fields are represented by null where the contract permits them, never silently coerced to zero.

EC2 facts use a histogram of `{cpu_bps,count}` five-minute samples, expected running samples, window start/end, representative day count, peak representation and tri-state dependencies. Histogram p95 is calculated, not accepted as an imported percentile. Dependency `true` means an exclusion is present for DR/batch/burstable/GPU; for memory/I/O/license/ASG it means suitability/dependency review was completed. These are synthetic source assertions, not proof supplied by a collector. Raw time-series verification, per-day coverage and target compatibility are deferred.

Multipart facts include initiation time, activity/long-running/lifecycle tri-states, two snapshots with bytes/part digest and complete-pagination flags, and nullable applicable staging rate with Region/unit/class. Digests/completeness/rate applicability are evidence assertions, not independently re-fetched AWS state.

CloudTrail facts include source/canonical ARN, home Region, organization/member kind, active state, normalized management atoms, required-destination tri-state and nullable billing basis. The source snapshot is the provenance for asserted volume and rates; external invoice linkage, billing-period normalization and actual permission verification are deferred. Unknown billing volume/rate uses a null billing basis.

SHA-256 identifies the serialized evidence content, not semantic equivalence across JSON key ordering. The API exposes snapshot retrieval by hash; there is no update/delete route. References resolve within that exact snapshot. Imported extra text is retained only as source data and escaped in the UI; it cannot become a tool call or instruction. The synthetic flag is not a privacy classifier. Keep real customer data out of this slice.

## Typed dispatch and result verification

Task contract: `{rule_id, dataset_id, scope:{account_id,region}}`. Additional task fields, unknown rule IDs, foreign snapshots and unauthorized scopes are rejected. The runtime supplies the evidence object; no tool can fetch arbitrary paths/URLs or mutate resources. Each result contains rule ID/version, snapshot ID, scope, resource ID, status, evidence refs, metrics when available, unknown/unquantified or exact rational savings basis, and a stable content-derived finding ID.

Supervisor state: `pending → running → completed | partial | cancelled | failed`; previously pending/running rows become `interrupted` on restart. Serial dispatch intentionally yields between tasks: deterministic CPU calculations gain nothing from concurrent promises. Limits are one active assessment, at most 60 tasks, 100 source resources and a 10-second cooperative deadline. There is no queue and no recursive delegation. Cancellation is cooperative between bounded tasks, not a preemptive worker-thread kill.

Each worker result is recomputed by `verifyWorkerResult` and compared to the trusted deterministic result before publication. This catches amount/status/reference/scope tampering. Calculation logic is shared, so this is a trust-boundary check, not independent mathematical proof; explicit financial expected-value tests are also required. Successful task trace entries persist, but findings are published only after the entire dispatch completes or produces a qualified coverage-partial result. Cancellation/failure publishes no partial findings.

The application validates the entire evidence envelope before dispatch. Canonical trail conflicts are handled conservatively at the scoped rule level. Insufficient coverage never triggers broader account/Region substitution.

## Local storage port and recovery

`FinopsRepository` adapts the existing SQLite store with additive `resource_evidence` and `finops_runs` tables. Methods define the local storage port: import/get/list evidence, create/get/list/update runs and recover interrupted runs. Workers receive no SQL handles. The runtime depends on the repository interface rather than filesystem paths or SQL.

Request IDs are unique and fingerprint snapshot/catalog identity. Completed replays return the original run. Snapshot imports and run/event transitions use existing immediate transactions; a run's serialized findings are published atomically with its terminal transition/audit. No append-per-retry finding duplication occurs. Explicit new requests may intentionally reassess the same snapshot and reuse stable finding identities.

On restart, incomplete runs are marked interrupted and **not automatically resumed**. A new request may rerun deterministic checks. Durable leases, multiple supervisor processes, a distributed queue, per-task resume, monetary budgets and provider attempt recovery are deferred. Run only one server process per local database; recovery is not safe as a multi-process leader-election mechanism. A persistence failure is contained, surfaced in the API/UI, and blocks further dispatch until storage is repaired and the process restarted. Local caps are 30 evidence snapshots and 200 runs. Existing SQLite backup guidance applies.

A future PostgreSQL adapter should preserve unique request IDs, immutable evidence identities and atomic run/event publication. Introduce an asynchronous repository port, migrations, row-version/lease checks and transactional task claiming before using multiple application instances; current synchronous method signatures are not a drop-in PostgreSQL driver. No RDS/PostgreSQL service, Cognito identity, ECS deployment, private endpoint or customer provisioning is implemented.

The accepted future boundary is customer-chosen hosting account/home Region, assessment across enabled Regions without enabling any, customer-owned PostgreSQL/evidence/logs/backups, future Cognito sign-in and ECS/Fargate hosting, and separately approved Bedrock through a private endpoint. Self-hosted inference is optional future work. No vendor telemetry or resource mutation is part of this slice.

## API

All existing Host/Origin/JSON/token controls apply. Write requests require the process's `X-Workspace-Token` from the state response; private Codespaces writes also require the exact preview Origin.

| Endpoint                                  | Purpose                                                         |
| ----------------------------------------- | --------------------------------------------------------------- |
| `GET /api/finops/state`                   | Catalog, snapshot summaries, persisted runs and workspace token |
| `GET /api/finops/sample`                  | Synthetic resource example                                      |
| `POST /api/finops/import`                 | `{data}` → immutable `dataset_id`                               |
| `GET /api/finops/evidence?dataset_id=...` | Exact source snapshot                                           |
| `POST /api/finops/run`                    | `{dataset_id,request_id}` → run, HTTP 202; poll state           |
| `POST /api/finops/cancel`                 | `{run_id}` → cancellation request; poll terminal state          |

No query endpoint executes arbitrary SQL, AWS actions, shell commands or model prompts.

## Verification

Run `npm test`, `npm run check`, `npm run lint`, `npm run format:check`, and `npm run test:browser`. Tests cover positive/negative rule cases, missing/stale/denied/partial/unsupported coverage, dependency exclusions, sub-micro exact rational estimates, shadow normalization, reference/scope tampering, token validation, bounded dispatch, cancellation, idempotency and SQLite close/reopen recovery. Browser journeys cover empty/start/import/run/evidence/saved-run reload/network error recovery/malformed import and mobile layout alongside the existing AI cost journeys.

Review screenshots: [desktop](screenshots/finops-desktop.png), [mobile](screenshots/finops-mobile.png). These are local synthetic browser captures, not customer-hosted AWS deployment evidence.

## Focused review of this slice

Independent review and regression fixes cover semantic CloudTrail shadow equivalence (selector/property ordering is not a contradiction), strict scalar scope types (no regex coercion into false empty inventory), CPU window/count consistency, accepted-run refresh failure with idempotent retry, obsolete refresh errors, and snapshot scope-fetch failure. The interface clears stale scope details and blocks Run until the selected scope resolves. A failed refresh after an accepted dispatch retains the request ID for a safe retry. No actual Node 22 runtime was available during this slice's review; Node 24.19.0 was used.

After a separately approved commit/push, an existing Windows checkout can fetch and switch to the published `feature/finops-rule-agent` branch, run `npm.cmd ci --ignore-scripts` and `npm.cmd start`, then use `http://127.0.0.1:3000/finops` **on that Windows machine**. The executor's localhost is not reachable from the user's laptop. Publication and laptop setup are separate actions; verify the published branch and commit before fetching.
