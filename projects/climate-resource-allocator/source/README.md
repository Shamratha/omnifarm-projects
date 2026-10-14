# Climate Resource Allocator

**Status: Ready for local synthetic planning.** The final verification passed: 23 allocator tests, 60 total regression tests, the bundled sample scenario, report markup readability, command smoke verification, production build, and 19 Chromium browser smoke tests. This is a deterministic tabletop prototype, not an emergency dispatch system.

This project allocates abstract resources from depots to shelters over a synthetic road network. The planner input includes a deterministic scenario timestamp (`asOf`), resource inventory, shelter demand and priority, and roads with travel times and shared capacities.

The local dashboard shows the resulting coverage, unmet demand, shared road bottlenecks, weather alerts, shelter-level allocations, and an audit trail of planner decisions. Use the **What-if capacity** controls to scale usable inventory, road capacity, or the equity floor; every change recalculates the same deterministic plan in the browser.

## Setup

```sh
npm install
npm run dev
```

Run the test suite with:

```sh
npm test
```

The planner tests use Node's built-in test runner and ES-module assertions. They can also be run directly:

```sh
node --test tests/planner.test.js
```

Create a production build with:

```sh
npm run build
```

The development server is local-only by default. Open the URL printed by `npm run dev` (normally `http://localhost:5173`) to try the dashboard.

## Allocation report

The report uses five consistently aligned sections with right-aligned, tabular numeric columns and resource units:

- **Shelter allocations:** resource-level demand, allocation and unmet quantities, plus coverage, population and access.
- **Unmet demand:** only outstanding resource needs, including disconnected shelters.
- **Route bottlenecks:** effective scaled capacity, used/remaining shared units and travel times; closed roads are listed separately. Zero-capacity roads are labeled **No capacity**.
- **Expired supplies:** lot, resource, depot, original quantity, scaled excluded quantity and explicit UTC expiry.
- **Equity indicators:** vulnerability, per-resource floor target, final allocation and shortfall. A shelter meets the floor only when every resource target is met. A zero floor is labeled **Disabled**, not a fairness success.

Section links jump directly to each table. Tables scroll within their section on smaller screens. Display values are rounded to at most two decimal places; planner calculations retain their original precision. Equity is attempted, not guaranteed, and the report does not change the planner or its ordering.

`src/report.js` is a presentation-only module. Pass the same scenario, plan and options to `buildReport`/`renderReport` so scaled exclusions and equity targets match the plan.

The priority legend is also centralized: **1 Critical**, **2 High**, and **3 Moderate**. Each priority badge is at least 100×28px, uses contrast-checked token colors, and includes a numbered rank, visible label, and explanatory text. The legend is stacked and readable on narrow screens; the shelter table keeps its priority column reachable while scrolling horizontally.

## Presentation vocabulary and accessibility

`src/presentation.js` is the shared source for status labels, equity terms, report headings, empty states, dynamic report wording, legends, and dashboard copy. `src/tokens.css` is the single color source consumed by the dashboard and report styles. Statuses are expressed with both text and visual cues: route states use distinct line patterns, shelter coverage uses distinct shapes, and badges include descriptions in their `title` attributes.

The presentation checks independently calculate WCAG contrast. Core text and status pairs target at least 4.5:1; map road strokes target at least 3:1 against the map surface. Browser smoke checks verify the shared route, shelter, and report legends at desktop and mobile widths, actual map state classes/patterns/shapes, status badge tokens, zero-capacity and disabled-equity states, and computed contrast for dashboard/report text.

### Report verification

`npm test` runs planner, report, presentation, priority, and terminal-command regression tests. The report tests check accounting, scaled capacities, expiry, per-resource equity, disconnected shelters, empty states, fractional values, escaping and deterministic, non-mutating rendering. Terminal tests check grouped quantities, section spacing, 80-column output, and byte-for-byte repeatability across time zones and locales.

- `npm run check:sample` runs the bundled scenario and checks accounting, conservation, determinism, and capacity/closure what-ifs. Its plain-text summary uses aligned totals and separated sections; it does not require a browser or network access.
- `npm run check:report` validates generated report **markup**, captions, priority badges and input immutability. Browser readability is checked separately by `test:smoke`.
- `npm run check:commands` launches the sample and report commands as bounded subprocesses, verifies their exit status and output, and fails if either check fails.

Browser smoke checks exercise the built app in Chromium at desktop and mobile widths, verify section/number alignment and report values, follow section navigation, adjust capacity and equity controls, test zero settings, reset the report, and check focus retention and browser errors.

```sh
# One-time browser setup after npm install
npx playwright install chromium
# On Linux, missing browser system libraries may require:
# npx playwright install --with-deps chromium

npm test
npm run check:sample
npm run check:report
npm run check:commands
npm run build
npm run test:smoke
```

The smoke command starts and stops a local production preview on `127.0.0.1:4173`; that port must be free. Build first so the smoke checks use the latest assets. There are no separately configured lint or typecheck commands in this JavaScript project.

## Planner behavior

The planner is deterministic. It excludes inventory expiring at or before the scenario's `asOf` timestamp, applies inventory and road-capacity scales, and routes over open, bidirectional roads with remaining capacity. It allocates in two phases:

1. **Equity:** attempt to meet the configured floor for each resource at reachable shelters, ordered by vulnerability and then shelter ID.
2. **Priority:** fill remaining demand in critical, high, then moderate order, breaking ties by vulnerability and then shelter ID.

Inventory lots are used in earliest-expiry order with IDs breaking ties. Routes use the shortest currently feasible travel time, with road IDs breaking ties. Every shipment consumes capacity on every road along its route. Decisions are returned as strings alongside allocation, inventory, road, shelter, total, and bottleneck summaries. Defaults are `inventoryScale: 1`, `roadCapacityScale: 1`, `equityFloor: 0.4`, and `closedRoadIds: []`.

The algorithm is a greedy planner rather than an optimal flow or optimization solver. It respects demand, inventory, route, and shared road-capacity constraints, but it can produce a less globally efficient result than a full optimization model.

Resource quantities and road capacities are abstract shared transport units. They do not represent a particular physical commodity, vehicle type, or unit conversion.

Scenario data is synthetic and local; the planner makes no API or live-data requests. The bundled scenario timestamp, `2026-10-14T09:00:00Z`, is a synthetic planning snapshot, not a live clock or current incident report. This project does not perform emergency dispatch or send resources to real locations.

The tests create their own small scenarios rather than depending on bundled dataset quantities. They cover disconnected roads and closure overrides, stable priority ties, expiration boundaries, stock/demand/route conservation, shared road capacities, scaling what-ifs, and equity allocation before priority filling.
