# Case-first FinOps experience

## Working journey

Start with `npm ci --ignore-scripts` and `npm start` on Node 22.13+; open the server in that machine's browser or the documented private Codespaces preview. This branch has not been published or copied to a laptop. The new experience is `/` and `/finops`; existing cost analysis is `/costs`, raw rule diagnostics `/rules`.

The seeded brief contains two quantified review candidates, four evidence gaps and three policy-blocked cases. Coverage is seven complete service/Region scopes out of nine. These counts derive from the synthetic fixture and verified engine results. The S3 case has a $47.104000 one-month gross scenario; the CloudTrail case has a $64.00 scenario for the provided avoidable-copy volume. Different bases are not summed. Verified savings remain unavailable.

Open a case, read its prerequisites and calculation, inspect source records, then create a review plan. Plans preserve baseline evidence, local owner, status, notes and versioned decision history. Dismissal removes the case from daily recommendations while retaining the inbox record. Review approval never authorizes execution. Later billing and operational evidence would be needed to verify savings; this release does not implement that ingestion or verification.

Guided questions support EC2, S3 and CloudTrail, including compound requests. The supervisor runs the existing bounded assessment; the question selects which service findings to present. It is keyword routing and deterministic specialist execution, not arbitrary language understanding or live AI. Unsupported causes, services, free-text scope changes and mutations return capability gaps. The timeline shows stored worker events, not simulated conversation. Saved questions and plans reopen after restart.

## Implementation and boundaries

- `src/agent-experience.js`: SQLite question receipts, immutable finding-derived cases, active resource snapshot, plan concurrency/history and coverage projection.
- `src/finops-agent.js` and `src/finops-rules.js`: existing bounded supervisor, rule contracts, evidence validation and exact assessment math; unchanged by this redesign.
- `src/opportunity-money.js`: display rounding directly from exact rational amounts, avoiding intermediate microdollar double rounding. Nonzero sub-cent opportunities display `<$0.01`.
- `fixtures/agent-resources.json`: fictional teams/accounts/resources and illustrative rates, including denied and partial scope coverage.
- `public/agent.*`: responsive brief, inbox, case/evidence dialogs, investigations, plans, coverage and readiness.
- `src/server.js`: `/api/agent/state`, `/api/agent/ask`, `/api/agent/plans` and plan PATCH routes. Existing strict host/origin and workspace-token checks remain.

Question receipts bind dataset and text to request ID. Plan creation is unique per finding, writes retain optimistic version checks and transactional audit, and incomplete runs retain existing restart/cancel semantics. UI drafts survive refresh/navigation; late responses cannot redirect a newer navigation. Imported metadata is rendered as text and cannot provide tool permissions or execution instructions.

SQLite remains a local, single-process, single-user store. There is no authentication or shared-user isolation. Bounded runs are not a distributed job system. Customer-owned ECS, PostgreSQL, Cognito and private Bedrock are readiness targets only. AWS is unconnected; the optional model adapter remains off and not live-verified. No telemetry or resource-changing tool is added. Existing browser/Codespaces trust boundaries in the README apply.

## Review and validation

Independent code and Chromium review found and verified fixes for active-snapshot selection after duplicate imports, unsaved review drafts lost on refresh, delayed responses hijacking navigation, exact-amount display double rounding, and newer drafts retaining stale versions after an earlier save. Suggested-question receipt reuse was also corrected. Regression tests cover these cases; dismissal remains auditable.

Run `npm test`, `npm run lint`, `npm run check`, `npm run format:check`, and `npm run test:browser`. Browser tests require locally installed Chromium and exercise both the retained workbench and new experience, including seeded/empty entry, search/filter, evidence dialogs, keyboard Escape/Tab, review persistence/drafts, compound/unsupported questions, stale navigation, network retry and desktop/mobile overflow. Screenshots are generated under `docs/screenshots/agent-*.png`.

This experience was checked on Node 24.19.0. Node 22.13+ is declared; the new code has not been rerun on Node 22 in this environment. No actual AWS, hosted-model, authenticated Codespaces-proxy or production deployment test occurred. Passing local tests does not certify production readiness or commercial quality.

A separate visual review inspected desktop/mobile brief and case screenshots. Follow-up fixes retain setup and AI cost navigation on mobile, show snapshot age/coverage/offline context, increase small-label contrast and size, clear transient notices on navigation, and preserve the case route when using the skip link. Mobile cases lead with the observation before the financial scenario. The final desktop screenshots were regenerated and inspected after correcting duplicate mobile-only links. This was a bounded visual review, not a full accessibility certification. Final verification: 118 automated tests passed; lint, syntax, formatting and both browser suites passed on Node 24.19.0.
