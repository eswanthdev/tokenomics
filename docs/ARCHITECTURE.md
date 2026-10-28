# Architecture and boundaries

## Agent scope and optional interface

The core is a local AI cost agent: bounded cost investigation, evidence-backed recommendations, and analysis of recorded outcomes. SQLite is agent memory and audit history. The web UI is an optional interaction surface, not a multi-tenant SaaS platform; subscriptions and administration features are outside scope. The current investigation mode is deterministic and offline. The optional Bedrock adapter is contract-tested but not live-verified, and no live execution or credentials are approved.

The browser is a plain ES-module application with responsive CSS and accessible native controls/dialogs. The Node HTTP server exposes fixed static files and a narrow JSON API. Financial logic is pure; persistence is isolated from computation and provider orchestration.

| Module             | Responsibility                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `src/engine.js`    | Shared schema validation, exact allocation and v1-compatible analysis endpoint                                     |
| `src/workbench.js` | Fixed-scope ledger, trends, reconciliation, quality checks, counterfactual decomposition and guided investigations |
| `src/store.js`     | SQLite immutable datasets, saved cases, versioned actions and audit transactions                                   |
| `src/server.js`    | Loopback HTTP, request limits, origin/token checks and validated routes                                            |
| `src/bedrock.js`   | Optional bounded Converse adapter with strict read-only tool/results contract                                      |
| `public/`          | Overview, investigation notebook, quality, evidence, task and history views                                        |

SQLite uses Node's built-in `DatabaseSync` API, prepared statements, transactions, WAL and full synchronous writes. The code uses the API available from Node 22.13 onward; no external database daemon is required. See the [official Node SQLite API](https://nodejs.org/api/sqlite.html). Synchronous queries and bounded payloads are suitable for this local prototype; no concurrent multi-user throughput claim is made.

The schema is version 2; startup additively creates investigation-request receipts for an existing version-1 database. Datasets are SHA-256-addressed snapshots of the received JSON serialization. This is content identity, not semantic normalization: key-order or ignored-field changes can create another version. Investigations reference an immutable dataset and retain computed findings. Actions link to recommendations, carry an optimistic version, and append a before/after audit event in the same transaction. Duplicated tracking of the same recommendation is checked inside the write transaction. The investigation API requires an 8–100 character `request_id` (letters, digits, underscores or hyphens). Investigation request IDs and fingerprints are committed atomically with saved results; replay survives restart, conflicting input is rejected, and concurrent duplicate provider requests are blocked in the single server process. Audit records are append-only through app APIs, not cryptographically tamper-proof.

## Read-only agent boundary

The offline path routes supported questions to deterministic tools. It displays the actual tool names and server-computed outputs. It does not simulate model token generation, claim to understand arbitrary requests or make provider calls.

The optional adapter follows [Bedrock Converse](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html): it submits `messages`, `system`, `toolConfig` and bounded inference parameters; processes `tool_use`; and sends back user-role `toolResult` messages. Its input/output envelope follows AWS's [ToolUseBlock](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ToolUseBlock.html) and [ToolResultBlock](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ToolResultBlock.html) contracts. The SDK factory uses the official JavaScript [BedrockRuntimeClient and ConverseCommand](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/javascript_bedrock-runtime_code_examples.html). These are implementation references, not evidence of live compatibility testing.

The transport can be injected for mock tests or constructed through `createBedrockSdkAdapter`. The factory requires `enabled: true`, explicit region/model ID, and an explicit credential provider; it does not discover ambient credentials. The shipped launcher does not call it. An authorized future embedding application can inject the returned adapter into `createServer({modelAdapter})` and use the validated API `mode: "bedrock"`. The shipped UI remains offline-only.

Tool allowlist:

- `inspect_variance`
- `inspect_retries`
- `inspect_quality`
- `inspect_outcomes`

Every tool accepts exactly `{}`. Scope belongs to the application and cannot be changed in a tool argument. There are no shell, filesystem, network-fetch, messaging, cloud-mutation, database-query or action-update tools. Four provider rounds and six total tool calls bound execution. Requests cap output at 600 tokens; responses are size-checked; a request timeout aborts its transport; SDK retries are disabled. The limits bound requests, not a verified dollar budget.

Tool results are curated deterministic findings rather than raw imported notes. References in the model context are capped, while the server retains the full evidence set. The final model response must be a JSON object containing only 1–8 unique `finding_ids` from those returned results. The server renders the original findings, not model-authored calculations or prose. Unknown IDs, extra fields, forbidden calls, duplicate tool-call IDs, malformed responses, timeouts and budget exhaustion fail closed without saving an investigation. The model may choose which verified findings to emphasize; this is narrower than a general autonomous agent.

## Input and trust threats

Imported data, identifiers, questions and notes are untrusted. Validation restricts numeric and identifier fields; unknown extra text remains only in the saved source records. Evidence is shown as escaped text. Imported data cannot expand tool access or choose executable operations. Prompt text also tells the model to treat supplied content as data, but the primary controls are the external allowlist, fixed scope and strict verified-ID output contract. This is defense in depth, not a proof of prompt-injection immunity.

The browser can update only local workflow state using validated API routes. Hosts outside localhost and the optional exact configured Codespaces preview host are rejected, as are mismatched Origin headers and cross-site Fetch Metadata. Preview writes require the matching HTTPS Origin as well as the workspace token. Forwarded request headers do not establish trust. See the README for validated preview configuration and proxy assumptions; the private Codespaces gateway supplies access control, not the app. Every non-GET request requires a random per-process workspace token, and JSON writes reject other media types. No CORS access is granted. CSP disallows third-party scripts, framing and external default resources. Data IDs never become filesystem paths or SQL fragments.

These controls do not provide production user authentication. Same-machine processes or anyone with filesystem access are within the local trust boundary. The workspace is not appropriate for untrusted multi-user hosting. No AWS permissions, credentials, access policies, live requests or hosted deployment were configured in this release.

## Test evidence and known gaps

Tests cover monetary conservation and sub-cent aggregation, fixed allocations under filters, exact decomposition with overflow handling, schema/date/reference failures, coverage and contradictory outcomes, unsupported intent, tool allowlists, hostile model output, timeout/budget enforcement, evidence fidelity, restart persistence, stale action conflicts, failed-import retention and API origin/token/host checks. Chromium journeys cover seeded and empty workspaces, filters, dialogs, saved/repeated investigations, actions/reload, evidence pagination, malformed imports and simulated network recovery.

Model contracts are mocked. Even the SDK-construction test never resolves credentials or sends a request. Live Bedrock model compatibility, tool-response behavior, costs, latency and answer-selection quality are unverified. Windows commands are supplied, but the release was exercised on Linux. Tests, syntax, lint, format and Chromium journeys also ran on the exact minimum Node 22.13.0 binary downloaded from nodejs.org and verified against its official SHA-256 manifest, as well as Node 24.19.0. CI has not run remotely. Formal accessibility, penetration, load and disaster-recovery testing remain out of scope.

Dataset mutations invalidate the prior analysis view until refreshed. Confirmed saves are distinguished from subsequent read failures; unknown transport outcomes never claim that nothing was saved. A browser mutation lock survives read recomputation and navigation. Same-question retries after a lost response reuse the pending request ID for that browser session.
