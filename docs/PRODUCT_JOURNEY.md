# FinOps investigation experience — design brief

## Problem with the previous interface

The first viewport presented implementation setup, not a decision: import JSON, choose a hash, run three rules. On mobile even the first result was several screens away. Source IDs, raw catalog JSON and repeated generic warnings dominated the information hierarchy. A successful check did not lead to a persisted decision or verification plan. It was a useful developer harness, but not an operator's daily workflow.

## Product promise and scope

Help one operator decide **what deserves attention, why, and what evidence is needed before acting**. The primary object is a saved investigation case. This is a local FinOps agent, not a SaaS billing/tenant platform. The demo is synthetic and offline; deterministic specialists do not imply live AI. Existing exact rule engines remain authoritative. No AWS changes, provider calls or connection setup are executed.

## First-session journey

1. Open a seeded daily brief immediately. Show an as-of date, small evidence-derived counts, one recommended review, and explicit unresolved coverage. No fabricated savings sum.
2. Open a case from the prioritized opportunity inbox. Search/filter by service, account, Region and readiness. Priority reflects evidence readiness and risk, not inflated dollars.
3. Inspect a responsive evidence workspace: observation, gross scenario if supported, eligibility, blockers, source records and a real dispatch timeline. Explicitly distinguish observation from hypothesis and no evidence from zero.
4. Ask a guided compound question spanning EC2, S3 and CloudTrail. Deterministic routing dispatches bounded tasks; saved questions reopen with exact evidence. Unsupported causes, services or changes receive a capability-gap explanation.
5. Create a review plan, set a local owner, record a decision and request follow-up evidence. Preserve history. No status can declare verified savings; verification needs later billing and operational evidence.
6. Inspect coverage and setup readiness. Fixture accounts/Regions are demo scopes, not connected AWS accounts. Customer-owned ECS/PostgreSQL/Cognito/private Bedrock remain future architecture.

## Interface direction

A compact dark-ink navigation rail and restrained warm-white workspace, clear serif-free typography, emerald reserved for affirmative controls, amber for prerequisites and neutral red for coverage gaps. Dense enough for real work, with generous grouping rather than a wall of cards. The daily brief is editorial: a short verdict, an evidence-backed recommended case and a compact inbox. Case details use a master/detail work area on desktop and a dedicated navigable sheet on mobile. All controls have an outcome; no ornamental activity indicators, fabricated conversation or placeholder connection buttons.

Navigation: Brief / Opportunities / Investigations / Review plans / Coverage / Setup. Persistent synthetic/offline label; detailed boundaries live in context. Loading, retry, unsupported, cancelled and empty filtered states are first-class. Keyboard users can navigate cards, forms, tabs and evidence dialogs with visible focus and sensible return paths.

## Design evidence

Parent research identified case ownership/status and work-item patterns in CloudZero (https://docs.cloudzero.com/docs/anomaly-detection), evidence and competing-hypothesis workspaces in Resolve (https://website-prod.resolve.ai/product/incidents), and explicit setup/capability boundaries in AWS FinOps Agent (https://docs.aws.amazon.com/finops-agent/latest/userguide/setting-up.html). These are vendor-described patterns, not proof of effectiveness or a feature-parity claim. We adapt only patterns supported by our deterministic evidence.

## Release tests

Seeded brief -> filtered inbox -> source evidence -> compound investigation -> persisted review plan -> restart/reopen. Also unsupported requests, coverage loss, concurrent/stale action edits, repeated/lost-response requests, cancellation, empty imports, network failures/retry, mobile overflow and keyboard operation. No live-model, real-Codespaces or customer-AWS validation is claimed.
