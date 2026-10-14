# Budget Commitment Monitor

A polished, read-only browser view for the Civic Ledger budget commitment snapshot. It surfaces projected spend and the records that need reconciliation, approval, or policy review.

## Run locally

Requirements: Node.js 18 or newer.

```bash
npm test
npm run dev
```

Open [http://localhost:4173](http://localhost:4173). The production-style start command is also available:

```bash
npm start
```

To run the configured project check:

```bash
npm run check
```

## Snapshot and data

All data is local synthetic data from `src/data.js`. The browser UI is deterministic and read-only: it does not call external APIs, load remote assets, or persist changes. Financial totals, duplicate commitment handling, flags, and money formatting come from `analyzeRequests`, `summarize`, and `formatMoney` in `src/finance.js`.

The static server listens on `127.0.0.1:4173` by default. Set `PORT` to use a different local port, for example `PORT=5000 npm start`.

## Combined filters

Flag buttons are independent toggles: a record must match **every** selected flag and the search text. Summary cards, sidebar counts, filter counts, the projection bar, and the list all use this same intersection. Counts on inactive buttons describe flags within the current view, not a hypothetical view after clicking them.

**All** clears flag filters but keeps search. **Clear filters and search** in the empty state resets both. Historical spent and the total budget remain fixed because the snapshot has no request-level historical spending breakdown. The projection adds only outstanding balances owned by visible records; duplicate ownership is established once across the full snapshot, so hiding an original record never assigns its balance to a duplicate. Cancelled records remain searchable but add no spend or attention flags.

Combined-filter regression tests are in `tests/view.test.js` and run with `npm test` alongside the finance tests.

## Policy rules and provenance

The dashboard's **Approval thresholds & exception rules** panel lists synthetic FY26 rules, including department approval for all requests, finance review above $10,000, competitive purchasing above $10,000, and community-benefit review at/above $50,000. These are demonstration policies, not actual municipal regulations or legal guidance.

Policy badges identify the rule code; open a record to see its policy name, scope, source label, reason, and evidence. Explicit exceptions reference a policy ID in `src/data.js`. Approved records with incomplete stages also receive an approval-chain exception (`PROC-AP-00`), rather than inferring a competitive-bid violation from their amount alone. Missing or unknown references display unresolved provenance. Other rules are reference guidance and do not imply automated compliance checks without supporting evidence. Policy counts remain counts of flagged records, not rule violations. Cancelled requests contribute no active exceptions.

## Commitment drawer and browser checks

Each drawer shows vendor verification and its snapshot source, exact commitment contribution, approval-chain progress with overdue days, delivery progress and the next pending milestone, and policy reasons/evidence. Progress and timing use the fixed snapshot, not the current clock. Cancelled pending stages are labelled cancelled; completed history stays visible. Duplicate requests explain why their contribution is zero. Vendor verification dates are not invented when absent from the dataset.

Exact dashboard totals are visible beneath compact figures on desktop. At 600px and below, exact amounts become the primary monetary figures: full-width cards, bright 20px tabular digits, and no split currency values. Exception badges use larger text and wrap naturally, with full-width status cells; drawer reasons and provenance have increased line spacing.

The drawer model is tested in `tests/drawer.test.js`. Repeatable browser checks in `tests/browser-smoke.mjs` validate actual UI totals, drawer contents, cancellation, duplicate handling, focus restoration, and clipping at 1440px, 600px, 480px, 390px, and 320px. Readability assertions check painted text bounds, prominent exact figures, single-line currency values, and wrapping of long exception labels and unbroken rule codes.

```bash
npm ci
npx playwright install --with-deps chromium
npm test
npm run test:browser
```

Browser checks start and stop their own loopback server on an available port. Playwright is a development-only dependency; the app has no runtime dependencies.
