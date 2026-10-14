# CivicFlow — local case routing workbench

A runnable, civic-hackathon-inspired prototype for explainable public-service intake. All six cases, forms, attachment bodies, team workloads, deadlines, and policies are fictional. **No external APIs, models, fonts, analytics, or real citizen data.**

**Status: READY FOR PACKAGING — local synthetic demo.** Session complete. Final checks on 2026-10-14 passed: syntax validation, 56 unit tests, static asset build/source comparison, Chromium browser smoke, and localhost server smoke. The verified static assets are in `dist/`. See `HANDOFF.md` for packaging contents, exact commands, accessibility coverage, and production limitations.

## Run locally

Requires Node.js 20 or newer. No package installation is needed to run the app or unit tests.

```sh
npm run dev
```

Create a clean local asset bundle with:

```sh
npm run build
```

The dependency-free build writes `dist/index.html`, `dist/styles.css`, and `dist/src/*`. It does not connect to a service or package real citizen data.

Open **http://localhost:5173**. The server binds to `127.0.0.1` by default and only serves the application assets. To choose another port: `npm run dev -- --port 5174`.

The app is plain HTML, CSS, and browser ES modules. No compilation or backend integration is required; `npm run build` packages the static assets. Opening `index.html` directly with `file://` will not reliably load ES modules; use the local server.

## Try the prototype

1. Search the **Incoming queue** by case ID, original text, service, team, or preferred language.
2. Open **Filter** to show urgent cases, missing documents, or language/accessibility needs. The full queue provides the same search and filters.
3. Select a case to see its classification, priority score, route, deadline, language, document status, and review flags. The decision panel beside the route shows the exact deadline calculation, whether it came from the submitted deadline or policy SLA, the inclusive 24h/72h rules, and six boundary examples. The escalation panel shows the applicable policy rule, shared urgent boundary, active triggers, status, and next handling action.
   Each queue row also has **Inspect decision** beside its destination, so the explanation can be opened without first scrolling to the detail panel.
4. Open **Form & attachments** to inspect the original multilingual form and expand the bundled synthetic text attachments.
5. Open **Applied service policy** for matched keywords, required-document checks, SLA, and escalation rules.
6. Use **Share redacted** to inspect the safe copy and download its JSON locally. No upload occurs.
7. Inspect **Team workload** or **Audit trail**. **Re-run routing** adds another evaluation batch to the session audit while retaining the same assignments and workload counts.

## Bundled scenarios

All deadlines are evaluated against the fixed clock **2026-10-14, 10:00 UTC**.

| Case | Service | Language | Deadline | Priority | Handling requirement |
| --- | --- | --- | --- | --- | --- |
| CF-0142 | Emergency housing | Spanish | 8 hours | Urgent | Safety-risk escalation; interpreter |
| CF-0143 | Benefits renewal | English | 18 hours | Urgent | Deadline escalation and missing income declaration; intake accepted |
| CF-0144 | Public works inspection | English | 7 days | Normal | Routine inspection |
| CF-0145 | Health appointment access | Arabic | 2 days | High | Interpreter and step-free access |
| CF-0146 | Permit application | French | 3 days | High | Site plan and owner authorization missing |
| CF-0147 | General service information | English | 5 days | Normal | Large-print format |

English queue titles for the fixture set are authored display labels, not generated translations. The original Spanish, French, and Arabic text is preserved in the intake view; Arabic uses automatic text direction.

## Explainable routing rules

- **Classification:** Unicode-normalized policy keywords and optional service hints. Unknown evidence, conflicting hints, and tied classifications require assisted intake review. Confidence values are heuristics, not calibrated probabilities.
- **Deadlines:** A supplied deadline takes precedence. If absent, the policy SLA is measured from receipt. Invalid deadlines explicitly require review instead of silently receiving a substitute.
- **Deadline breakdown:** Every evaluated case retains the calculation string, source label, submitted/received timestamps, SLA hours, deadline timestamp, threshold rules, and fixed boundary examples: overdue, due now, exactly 24h, 24h+1ms, exactly 72h, and 72h+1ms. This is rendered beside the route, not hidden only in the audit log.
- **Escalation breakdown:** Every evaluated case retains the matched policy escalation text, shared safety/urgent rule, standard/review-required state, active triggers, and next handling action.
- **Priority:** Reported safety risk or a deadline within **24 hours inclusive** is urgent; within **72 hours inclusive** is high; otherwise normal. Overdue cases remain urgent. Attention scores start at 90/65/35 and add safety (8), each unique access request (2), missing documents (3), and manual classification (4), capped within the priority level.
- **Documents:** Required types must be marked received. Incomplete intake is still accepted, retains its urgency, and creates follow-up flags. Receipt does not establish document authenticity.
- **Routing:** Match the service policy and preferred-language/access capabilities, then choose the lowest projected utilization. Stable ties use active load and team ID. Capability gaps and capacity overflow create explicit provisional/manual review flags rather than silently dropping requests.
- **Accessibility:** Interpreter, step-free, large-print, and screen-reader requests are retained. Needs are not treated as diagnoses and never lower urgency. The browser UI provides keyboard buttons, visible focus, a skip link, native dialogs, and reduced-motion support. On small screens, deadline labels are at least 14px and UTC date labels at least 12px; tables have labeled, keyboard-scrollable regions. Critical labels are tested for 4.5:1 text contrast. Urgent incomplete cases have explicit text warnings and a polite selection announcement; flag icons have accessible names.
- **Redaction:** Mask personal fields, marked sensitive values, known literal fixture identities in text, and all document bodies. Keep useful routing metadata. This is fixture-aware masking, **not a general-purpose PII detector** or authorization boundary.
- **Audit:** Each evaluation explains classification, deadline/priority, documents, route, redaction, and any escalation. The browser app appends run-numbered events **in memory for this session only**. Refreshing restores the initial demo; there is no durable or tamper-proof audit store.
- **Workload:** Synthetic baseline active work plus assignments from the current batch. Re-running does not double-count work. Both workload views have labeled meters and visible urgent/awaiting-document counts. Each case is counted once even if several documents are missing. Above-capacity values remain visible in text and meter value descriptions, with a supervisor-review warning; percentage meters are bounded to 100.
- **Case state:** Every result reports `accepted` intake plus `routed`, `review-required`, or `unassigned` workflow state, complete/incomplete documents, deadline state, escalation state, and whether the case can progress without human follow-up. Missing documents never reject intake.

## Checks

```sh
npm run check
npm test
npm run build
```

The built-in Node test suite covers multilingual fields, deadline boundaries and overdue work, missing documents, accommodation retention and capability gaps, deterministic workload balancing, safe redaction, immutability, SLA fallback, and manual-review paths.

### Optional local browser checks

`scripts/browser-smoke.mjs` exercises real Chromium flows, downloads and validates redacted JSON, checks session audit appends and exact workload rerun counts, checks desktop/mobile layouts, and verifies **zero external requests**. It checks mobile deadline font sizes, clipping and critical-text contrast, the skip link, Tab/Enter/Space view navigation with a unique current-page indicator, keyboard table scrolling, dialog focus return, accessible meter names/values, and an urgent incomplete case above capacity. The capacity stress scenario changes only the synthetic fixture objects in the test browser and restores them on reload. Browser tooling is optional and is not an app dependency. These targeted accessibility checks are not a full assistive-technology certification.

For example on Linux, install it in a separate temporary tooling directory:

```sh
mkdir -p /tmp/civicflow-browser
npm install --prefix /tmp/civicflow-browser playwright
/tmp/civicflow-browser/node_modules/.bin/playwright install chromium
PLAYWRIGHT_MODULE=/tmp/civicflow-browser/node_modules/playwright/index.mjs npm run test:browser
```

Chromium may require operating-system libraries on a minimal machine (`playwright install-deps chromium`). If Playwright is already installed, point `PLAYWRIGHT_MODULE` at its `index.mjs`, or omit the variable when the package is locally resolvable. The browser test starts and stops its own localhost server on an automatically assigned free port.

## Files

- `index.html` / `styles.css` — responsive dashboard shell and design.
- `src/data.js` — synthetic forms, attachments, policies, team capabilities, and demo clock.
- `src/engine.js` — pure deterministic classification, prioritization, routing, redaction, and workload functions.
- `src/app.js` — local browser views, filters, dialogs, export, and session audit history.
- `server.js` — dependency-free, localhost-only static server with an asset allowlist and content security policy.
- `test/*.test.js` — deterministic Node regression tests.
- `scripts/browser-smoke.mjs` — optional local browser integration check.

This is a synthetic demonstration, not a production public-service decision system. Do not enter real personal data or rely on these fictional service rules for actual eligibility, health, safety, or statutory deadlines.
