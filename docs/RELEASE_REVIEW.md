# Local release review — investigation workbench

## Delivery state

- Local branch: `feature/investigation-workbench`, based on verified prototype commit `2313e5b4f72822fc38b17980e0e531893828b475`.
- No push, PR, merge, deployment, AWS access, model call, credential configuration or permission change.
- Original v1 synthetic fixture retained; unrelated existing work was not present or overwritten.

## Implemented

A connected six-view local workbench: spend/outcome dashboard and dimension filters; persisted investigation notebook; billing/data-quality register; searchable/paginated evidence explorer; recommendation/action tracker; and dataset/audit history.

Six months of reproducible AWS-inspired synthetic billing/invocation/outcome data cover multiple accounts, regions, models, workflows and teams. Exact microdollar computations, fixed allocation before filtering, positive/negative billing gaps, rule-based anomaly signals, token-volume/rate-mix decomposition, missing outcome links and retry/failure overlap are explicit. Source references are checked against immutable dataset versions.

SQLite provides transactional persistence, restart recovery, version conflict detection and audit history for local single-user use. The optional Bedrock Converse adapter uses bounded read-only tools and accepts only verified finding IDs from model output. The default app remains entirely offline.

## Executed checks

All passed on Linux with both the exact minimum Node 22.13.0 and Node 24.19.0:

| Check                         | Result                                                                |
| ----------------------------- | --------------------------------------------------------------------- |
| Clean dependency installation | `npm ci --ignore-scripts` passed using a writable temporary npm cache |
| Automated tests               | `npm test`: 63 passed, 0 failed, 0 skipped                            |
| Syntax                        | `npm run check`: all source, UI, test and script files                |
| Lint                          | `npm run lint`: no errors                                             |
| Formatting                    | `npm run format:check`: all files conform                             |
| Browser                       | `npm run test:browser`: passed in real headless Chromium              |
| Diff integrity                | `git diff --check`: passed                                            |

Automated cases include sub-cent aggregation, allocation conservation and filter invariance, counterfactual overflow handling, zero baselines, contradictory/missing source data, allocation expansion limits, invalid imports, unsupported questions, immutable evidence references, database close/reopen, optimistic conflicts and audit atomicity, host/origin/token checks, injected tool misuse, fabricated model findings, timeout and call-budget enforcement. SDK-construction coverage did not resolve credentials or send requests.

Browser journeys include seeded/empty workspaces; filtering; exact source dialogs; saved, unsupported and repeated investigations; action editing/reload; quality views; evidence pagination/search; simulated transport failure/recovery; invalid/valid/repeated imports; escaped hostile source text; mobile navigation and overflow checks. No uncaught browser exceptions were observed. Desktop and mobile screenshots were visually inspected; mobile filters were collapsed after review to improve use of space.

## Screenshots

- [Desktop overview](screenshots/desktop-overview.png)
- [Desktop investigation](screenshots/desktop-investigation.png)
- [Detailed findings](screenshots/desktop-investigation-findings.png)
- [Data quality](screenshots/desktop-quality.png)
- [Mobile overview](screenshots/mobile-overview.png)
- [Mobile investigation](screenshots/mobile-investigation.png)
- [Mobile findings](screenshots/mobile-investigation-findings.png)

## Not run / not claimed

Live Bedrock/AWS, Windows execution, hosted CI, production multi-user security, formal accessibility, load and disaster-recovery audits were not run. Bedrock integration is implemented but **not live-verified**. The CI workflow is configured locally with pinned action commits and read-only permissions; it has not been published or triggered. The previously denied GitHub Actions API operation was not retried.

No remaining implementation blocker for this bounded local release. Further work should start with operator validation and offline AWS export normalization, followed by explicitly authorized live model evaluation and a separate production security/identity design.

## Independent adversarial review

A separate reviewer reproduced financial, storage and browser race bugs, then independently verified their closure after fixes. No demonstrated P0/P1 defect was found; every demonstrated P2/P3 finding below is fixed and regression-covered.

| Severity | Finding                                                                                    | Fix                                                                                              |
| -------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| P2       | Retry/failure totals differed for unallocated records; shared refs polluted retry evidence | All non-shared invocation rows use the same definition and evidence set                          |
| P2       | A workflow named `unallocated` merged with missing workflow tags                           | Structured null keys and distinct display labels                                                 |
| P2       | Large safe integers lost a microdollar during currency formatting                          | Integer quotient/remainder formatting and exact rational rounding                                |
| P2       | Model quality tool broadened account scope                                                 | Scoped quality evidence; unsupported billing attribution is disclosed without broader references |
| P2       | Two Store writers could create duplicate recommendation actions                            | Recheck under the SQLite write transaction                                                       |
| P2       | Unsupported response after navigation touched missing DOM                                  | Navigation-aware rendering and guarded response targets                                          |
| P2       | Save success plus refresh failure falsely claimed nothing saved                            | Confirmed saved results and unconfirmed transport outcomes are handled separately                |
| P2       | Filter refresh released a pending mutation lock                                            | Separate mutation lock and disabled scope controls                                               |
| P2       | Import/activate/clear refresh failure left stale analysis visible                          | Central synchronization state hides stale reports until successful reload                        |
| P3       | Inherited static-map keys returned 500                                                     | Own-property route checks return 404                                                             |

Additional hardening persists investigation request IDs atomically with results, replays responses after restart, rejects conflicting input, and blocks duplicate in-flight provider requests. Browser regression tests simulate response loss after commit, read-refresh failure, navigation while pending and dataset synchronization failures. Database tests inject audit-write failure to verify rollback and check additive version-1 migration/fail-closed future versions.

Node 22.13.0 was obtained from the official nodejs.org distribution and verified against its SHA-256 manifest. Its SQLite experimental warning is expected; tests and browser journeys pass.

Remaining severity-ranked boundaries: no open demonstrated release defect; **P2 if used beyond this boundary**: no production authentication/tenancy or live Bedrock verification; **P3 validation gaps**: Windows execution, hosted CI, independent accessibility/security/load/disaster-recovery audits remain unperformed. These do not authorize broader deployment.
