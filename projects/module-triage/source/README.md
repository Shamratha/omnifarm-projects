# SignalDesk — local defensive module triage

Synthetic Metasploit-style metadata only. There is no Metasploit integration, exploit runner, target input, scanner, or target contact. All relationships open local metadata, never invoke a module. Runtime fonts and assets are local; the page CSP disables network connections and external assets.

## Run

Requires Node.js 22+ and Python 3.

```sh
npm ci
npm run dev
```

Open **http://localhost:4173**. The server binds to loopback. No application build step is necessary.

## Review flow

1. Search module IDs, CVEs, advisory IDs, original product labels, canonical product labels, or configured aliases. Severity, patch state, evidence confidence, and flagged filters affect only the review board.
2. Open a record to review raw and canonical products, CVSS source observations, evidence, patch confidence, and advisory groups. Expand an advisory group to see every source occurrence and its module-scoped evidence. A shared advisory ID does **not** merge modules, products, or CVEs.
3. Follow direct dependency links to metadata-only records and back to their referencing modules. The dependency panel lists the actual source-to-target relationships; unrelated records are never drawn as a chain.
4. Review the workspace-wide remediation queue. Available fixes remain pending until explicitly marked remediated in the fixture; availability does not establish deployment. Unavailable and unknown fixes get safe review/control actions.
5. Export the queue as CSV or the complete Markdown audit report. Both include all pending workspace records, regardless of board filters. Exports contain canonical/raw products, resolution decisions, direct dependency edges, all advisory occurrences, evidence, CVSS records, and patch-confidence explanations. CSV formula-leading cells are neutralized for spreadsheet safety.

## Resolution and confidence rules

- `data.js` contains the synthetic records, explicit patch observations, dependency metadata, and eight-product alias catalog. Update fixtures there; no external data is fetched.
- Product matching normalizes Unicode, case, punctuation, and spacing, then requires an exact **vendor + product** pair in the catalog or its explicit aliases. There is no fuzzy, substring, or vendor-blind resolution. Ambiguous matches retain the raw label and list candidates. Version ranges are preserved, not reinterpreted.
- Dependencies are directed, one-hop metadata references. Missing targets are marked missing. Self-links and cycles remain direct edges; there is no recursive traversal or execution.
- Advisory grouping retains every occurrence, including repeated IDs within the same record. Explicit `advisoryId` tags scope evidence/CVEs to that group. Untagged records are preserved as **module context**, not asserted to prove every advisory. The grouping pass does not mutate raw module records or inflate the queue with advisory duplicates.
- General evidence confidence is the source-confidence mean, minus 12 for conflicting CVSS (spread ≥ 0.6), 4 for duplicate advisory observations, and 8 for unknown patch state. Confidence is clamped to 0–100; high ≥ 78, medium ≥ 52, otherwise low.
- **Patch-status confidence is separate.** It uses only explicit `patchStatus.evidence`: rounded source-confidence mean, minus 25 for contradictory status observations; capped at 35 for unknown status or observations with no status. Missing patch evidence scores 0. It uses the same level thresholds. Reasons and source observations are visible in the UI and exports. High confidence in “unavailable” means good support for the absence of a fix, not good patch availability. Partial coverage includes its branch/asset limitation. These synthetic confidence values are heuristics, **not calibrated probabilities**; dates are provenance, not live freshness validation.
- Priority uses maximum CVSS × 6, severity weight (critical 12/high 9/medium 6/low 3), prerequisite weight (0–30), patch-state weight (unavailable 18/unknown 11/partial 8/available 2), and general evidence confidence ÷ 10; rounded and capped at 100. It is a review ordering signal, not authorization to execute anything.

## Verification

```sh
npm test
npm run check
npx playwright install chromium
npm run test:ui
```

On a fresh Linux environment, Playwright may also require its system dependencies (`npx playwright install-deps chromium`). Browser tests serve a separate loopback instance on port 4174 and run desktop and mobile Chromium layouts. They follow metadata links, expand duplicate evidence, check aliases/patch explanations, verify no external requests, and compare actual downloaded CSV/Markdown with the rendered queue. Unit tests cover missing/cyclic dependencies, ambiguous/wrong-vendor aliases, contradictory CVSS and patch evidence, unavailable patches, within-/cross-module duplicate advisories, raw record preservation, and export quoting/formula safety.

The final combined regression uses `tests/fixtures/alias-review.js` in both unit and browser tests: a single product alias finds two independent review records, one with multiple advisories and repeated source occurrences. It verifies scoped CVSS/evidence, missing and cyclic dependency links, independent patch confidence (known unavailable versus unknown with no evidence), and exact CSV/Markdown download agreement. Sharing a product or advisory never transfers patch certainty between review records.

Files: `triage.js` (pure passes/queue/exports), `data.js` (fixtures/catalog), `app.js` (UI), `index.html`, `styles.css`, `tests/triage.test.js`, `tests/browser/workbench.spec.js`, and `playwright.config.js`.
