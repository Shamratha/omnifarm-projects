# CivicFlow handoff

**Status: READY FOR PACKAGING — local synthetic demo. Session complete.** Final router verification completed on 2026-10-14 at 21:01 UTC. Not deployed or approved for production use.

## Goal

Maintain a local, synthetic public-service case router with inspectable classification, routing, prioritization, redaction, workload, audit, escalation rules, and deadline calculations. The latest scope was to finish mobile deadline-label readability and urgent missing-document/workload accessibility, run the complete suite, build and browser smoke checks, then mark the local prototype ready.

Closeout: the user accepted the passed checks and requested session completion with the router marked ready for packaging. Only readiness documentation changed during closeout; the verified runtime source and `dist/` assets are unchanged.

## State

Complete for the requested local prototype:

- Six synthetic forms include attachments, language preferences, accessibility requests, service policies, deadlines, and escalation rules.
- The overview queue supports search and filters for urgent work, missing documents, and language/accessibility needs.
- Selecting a case now shows two structured decision cards beside the route:
  - **Deadline calculation:** submitted-vs-policy-SLA source, exact timestamps, millisecond subtraction, hours remaining, inclusive thresholds, and six examples: overdue by 1ms, due now, exactly 24h, 24h+1ms, exactly 72h, and 72h+1ms.
  - **Escalation rule:** matched policy text, shared safety/urgent rule, standard vs review-required state, active triggers, and next handling action.
- Invalid deadlines remain invalid and require review; they are not silently replaced by an SLA.
- High-priority cases at a service review boundary can show a prompt reviewer trigger without being incorrectly treated as urgent.
- Browser audit history is still append-only in memory for the current session; refresh resets the demo. Workload reruns do not double-count assignments.
- Every evaluated result now includes an explicit `caseState`: accepted intake, routed/review-required/unassigned workflow, document completeness, deadline state, escalation state, assignment, human-review requirement, and `canProgress`.
- Mobile queue deadline labels use readable text (at least 14px), explicit UTC date labels (at least 12px), and unclipped content at 320px and 390px. Table regions are named and keyboard-scrollable, with scroll hints and visible focus.
- `CF-0143` is an urgent benefits renewal with an 18-hour deadline and missing income evidence. Intake remains accepted, assigned and counted; duty-lead attention and document follow-up happen in parallel. The missing-document filter also includes `CF-0146`.
- Both workload views expose named meters and visible urgent/awaiting-document counts. Above-capacity work stays assigned and urgent, with supervisor-review text. Meter percentages cap at 100 while accessible value descriptions retain the actual active/capacity/overflow counts.
- Urgent document warnings and flag icons have accessible names/text, and case selection has a polite live announcement. Critical deadline/document/workload text passes targeted 4.5:1 contrast checks. These checks are not a full assistive-technology certification.
- Keyboard navigation is browser-verified: the first Tab reveals the skip link, activation skips sidebar controls, Tab reaches queue/workload/audit navigation, Enter/Space activates views with exactly one `aria-current="page"`, and closing the mobile decision dialog restores focus to its trigger.
- The prototype stays local and dependency-free at runtime. No real citizen data, external APIs, remote fonts, analytics, auth, or database are used.

No unfinished work or blockers remain within the requested local prototype scope. Production gaps are listed below.

## Files

- `index.html` — dashboard shell, dialogs, local icons, named keyboard-scrollable queue region, scroll hint, and live announcements.
- `styles.css` — responsive dashboard, decision cards, mobile deadline typography, wrapping, and accessible critical-text colors.
- `src/data.js` — fixed demo clock, synthetic cases, policies, teams; permit review boundary is 72 hours and `CF-0143` has missing income evidence.
- `src/engine.js` — deterministic routing and decision/state metadata; workload totals now include per-case `awaitingDocuments` and `overCapacity` counts.
- `src/app.js` — deadline/UTC labels, urgent document follow-up text, named flag icons, live case announcements, and accessible meters in both workload views; retains existing inspection/export/audit flows.
- `server.js` — loopback static server with asset allowlist and security headers; supports `--port` and `--host`.
- `scripts/build.mjs` — dependency-free static asset build into `dist/`.
- `test/router.test.js` — added deadline-calculation, SLA fallback/invalid date, and escalation-rule tests.
- `test/review.test.js` — manual review and unsupported configuration regressions.
- `test/privacy.test.js` — redaction regressions.
- `test/accessibility-scenarios.test.js` — urgent incomplete intake, above-capacity workload, immutable deterministic reruns, and missing-document deadline-boundary regressions.
- `scripts/browser-smoke.mjs` — Chromium flow checks plus mobile deadline readability/contrast, skip-link and Tab/Enter/Space navigation, dialog focus return, keyboard scrolling, accessible meter values, exact workload rerun counts, and urgent incomplete capacity overflow; test server uses an automatically assigned free port.
- `dist/` — rebuilt static assets matching the current source byte-for-byte.
- `README.md` — usage, rules, scenario/accessibility semantics, limits, and checks.

## Decisions

- Deadline boundaries use exact milliseconds. `remaining <= 24h` is urgent, `24h < remaining <= 72h` is high, and `remaining > 72h` is normal unless a safety risk overrides to urgent.
- Boundary examples are generated from the injected fixed evaluation clock, so the UI and tests cannot drift with the system clock.
- Policy escalation text is displayed as supplied synthetic policy data. A separate shared rule makes the cross-service 24-hour safety/urgent behavior explicit without overwriting service-specific rules.
- `reviewDeadlineHours` is optional policy data. Only permits currently sets it to 72 hours, matching its policy text; other service review behavior comes from urgency, safety, documents, classification, capabilities, and capacity flags.
- The displayed English queue subjects are authored fixture labels; source multilingual content remains available in the form dialog and is not machine-translated.
- Missing documents never reject intake, defer urgency, or remove workload assignments. Awaiting-document workload counts cases once, not individual missing files. Overflow is retained in text rather than concealed by the bounded meter.
- The browser capacity stress scenario changes only synthetic data in that browser session; reload restores the shipped fixtures. No app dependency or external integration was added.
- There is no Git repository in the workspace (`git status` reports not a repository), so this handoff describes the current filesystem state rather than a branch/commit.

## Checks

Working directory for all commands: `/home/ubuntu/Desktop/civic-case-router`.

The following results are from the final 2026-10-14 run completed at 21:01 UTC against the current source, expanded navigation smoke checks and rebuilt assets, superseding earlier verification results.

- **Syntax/check — passed:** `npm run check`
  - `node --check server.js`
  - `node --check src/app.js`
  - `node --check src/data.js`
  - `node --check src/engine.js`
- **Browser-script syntax — passed:** `node --check scripts/browser-smoke.mjs`
- **Unit tests — passed:** `npm test`
  - 56 tests, 56 passed, 0 failed, 0 skipped, 0 cancelled.
  - Includes Spanish/French/Arabic fields, exact deadline boundaries, overdue work, SLA fallback, invalid deadlines, missing documents, accessibility/language capabilities, workloads, manual review, immutability, audit, and redaction.
  - Three new tests verify accepted/assigned urgent incomplete intake, capacity overflow with supervisor review and exact workload counts, and urgency at overdue/due-now/exact-24h boundaries despite missing documents.
- **Build — passed:** `npm run build`
  - Created `dist/index.html`, `dist/styles.css`, and `dist/src/{app,data,engine}.js` as a clean local asset bundle.
  - Artifact verification passed: `cmp -s index.html dist/index.html && cmp -s styles.css dist/styles.css && cmp -s src/app.js dist/src/app.js && cmp -s src/data.js dist/src/data.js && cmp -s src/engine.js dist/src/engine.js` exited successfully; all five generated files match the source byte-for-byte.
- **Browser check — passed:** `PLAYWRIGHT_MODULE=/tmp/omnirush/node_modules/playwright/index.mjs npm run test:browser`
  - Exercises queue filters/search/empty state, keyboard case selection, visible case state, row-level `Inspect decision`, six deadline boundary rows, escalation panel, original attachments, policy dialog, Arabic `lang=ar` and `dir=auto`, redacted JSON download, audit reruns, workload navigation, responsive widths 320–1280px, no browser errors, and zero external requests.
  - Also verifies mobile deadline font sizes, UTC dates, no clipping, arrow-key table scrolling, urgent incomplete follow-up text, named meter values/ARIA snapshot, and critical text contrast of at least 4.5:1.
  - Explicit keyboard checks pass for the visible skip link, bypassing the sidebar, Tab/Enter/Space navigation, unique current-view indicator, and dialog focus return. After a routing rerun, the visible benefits workload meter still reports 7 active / 10 capacity, 3 available, one urgent, one awaiting documents and zero over capacity.
  - Synthetic overflow check: 11 active / 10 capacity, one urgent, one awaiting documents, one over capacity. The meter is bounded to 100 but retains actual overflow in accessible text; reload restores fixtures and 64% total utilization.
- **Server smoke — passed:** `curl -I --max-time 10 http://localhost:5173`
  - Returned `HTTP/1.1 200 OK` with local-only security headers.
- **Lint/typecheck:** no separate project lint or typecheck scripts exist; `npm run check` is the applicable static validation.

One earlier browser run encountered `EADDRINUSE` because an older smoke-test process still owned its fixed port. The browser test now launches its own local server on port `0`; the rerun passed and no longer depends on a fixed test port.

During this final turn, an added workload assertion initially timed out because it queried the hidden overview meter from the Audit view. The assertion now inspects the visible full-workload meter after navigation; the targeted smoke and subsequent complete verification passed. No application behavior change was needed.

## Run / next step

The current local server is running at **http://localhost:5173**. Restart it with:

```bash
npm run dev
```

Packaging handoff: the verified static payload is `dist/index.html`, `dist/styles.css`, and `dist/src/{app,data,engine}.js`. Include `README.md` and `HANDOFF.md` with the demo documentation. The requested implementation and verification are complete; no further development is required before packaging this local synthetic demo. No archive was created and no deployment was performed during this closeout.

For a final preview, open **http://localhost:5173** and select `CF-0143` to inspect urgent missing-document follow-up, deadline calculation and workload.

If extending the router later, start with `src/engine.js` for policy/state/workload behavior or `src/app.js` for decision presentation. Run `npm run check`, `npm test`, `npm run build`, and the browser command above after changes.

Remaining production gaps are intentional and documented: no authentication, persistent database, real referrals, emergency dispatch, document authenticity verification, or general-purpose PII detector. Do not add real personal information to the fixture or UI.
