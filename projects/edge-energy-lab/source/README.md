# Edge-AI Sensor Energy Lab

A dependency-free, offline browser lab for comparing two **simulated** tiny anomaly detectors. It uses local seeded synthetic sensor windows only. There is no backend inference, training, hardware benchmark, analytics, external font, or remote fixture.

## Try it

Open `index.html` directly in a modern browser, or serve the folder:

```sh
npm start
# Or: python3 -m http.server 4173 --bind 0.0.0.0
```

Visit **http://localhost:4173**. No `npm install` is required. The server requires Python 3; the test commands require Node 18+ (tested with Node 22).

Create a deterministic static bundle with `npm run build`. It copies only the four local runtime artifacts into `dist/` (`index.html`, `styles.css`, `lab-core.js`, and `app.js`); no bundler, network, generated timestamps, or package install is involved. Serve that output with `python3 -m http.server 4173 --directory dist --bind 0.0.0.0`.

1. Compare Micro Threshold and Tiny Linear accuracy, precision, recall, F1, latency, memory, energy, and battery cost.
2. Choose the clean, field-noise, or missing-sample fixture.
3. Select a profile, tune its independent threshold, and watch the accuracy–latency Pareto frontier update.
4. Inspect false alarms, missed events, alerts, all windows, or missing gaps. Select a chronological tile or table row (Enter/Space also works) for raw sensor values and both profiles’ score, threshold, signed margin, and decision. The active profile’s normalized features and contributions are shown below.
5. Use the best-F1 fixture-fit threshold or reset the profile default.
6. Download or copy the deployment JSON. Clipboard availability depends on browser permissions; download works independently.

### Faster-profile tradeoff

The comparison panel shows the two **current, independently tunable thresholds** and identifies the faster profile by simulated latency—not by the selected tab. On the field-noise fixture at defaults (Micro 0.08, Linear 0.50):

| Simulated result | Micro Threshold (faster) | Tiny Linear (baseline) |
| --- | --- | --- |
| Latency / window | 0.092 ms | 0.137 ms |
| Fixed modeled memory | 1,152 B | 2,048 B |
| Energy / window | 21.144 µJ | 23.836 µJ |
| Battery / 1,000 windows | 0.000132% | 0.000149% |
| False alarms / evaluated normal windows | 6 / 224 | 7 / 224 |
| Missed events / evaluated anomalies | 20 / 32 | 0 / 32 |

The faster profile has 32.8% lower modeled latency and 11.3% lower modeled acquisition/inference energy, but misses more anomalies at its default threshold. At Micro threshold 0.01, it has 7 false alarms and no misses on this fixture, with **unchanged cost estimates**. Costs depend on operations and the assigned footprint, not the threshold or number of alerts. Alert transmissions, actuation, and follow-up work can make false alarms expensive in reality, but are not modeled here. Memory is not measured peak RAM/flash, and p95 is a synthetic multiplier, not a measured distribution.

## Reproducibility and limits

### Connected window inspection

The inspector uses `inspectWindows(dataset, models, explicitThresholds)` to preserve all 256 source windows, rather than displaying only the evaluated subset. IDs **W0000–W0255** and one-second timestamps stay stable across fixture scenarios. Chronological tile colors show the active profile’s decision; the selected ID is also marked on the vibration trace. Every tile has a text ID, accessible status label, and pressed-state selection.

Selecting a tile opens All windows (or Missing gaps for an invalid window). List filters do not regenerate or renumber windows. Threshold tuning, resets, recommendations, profile tabs, and scenario changes retain the selected ID; if it no longer matches the list filter, the detail view says so instead of silently switching to a different window. Choosing a new filter selects its first matching window.

The dropout gaps are **W0007, W0036, W0065, W0094, W0123, W0152, W0181, W0210, W0239**. They remain selectable with raw `null` vibration, explicit missing-channel reasons, and **skipped** decisions for both profiles. Their scores, predictions, and margins are `null`, not zero. These 9 windows are excluded from metrics, leaving 247 evaluated windows (217 normal / 30 anomaly). Both independent thresholds remain visible even for skipped decisions.

Profile decisions use the full-precision score; the UI rounds scores/margins to three decimals for readability. Margin means `score - threshold`. A zero margin is an alert because the decision rule is `score >= threshold`. Inspector selections change neither model costs nor deployment-card inputs, so selecting a different window does not change export bytes.

`lab-core.js` bundles the fixture generator and both model profiles. The fixed 32-bit LCG seed is `0xED6E2025`. All three scenarios have 256 one-second windows and 32 labeled anomalies (12.5%). Field noise adds deterministic benign motor-start bursts; the dropout scenario additionally removes 9 vibration readings. Those windows are explicitly skipped, not imputed. Metrics use only evaluated windows and the UI/export include coverage.

Micro Threshold is a weighted rectified rules score; Tiny Linear is a sigmoid of a fixed linear score. Neither is a trained production model. A positive decision uses `score >= threshold`. Recommendations sweep 0.00–1.00 in 0.01 steps, maximize F1, then break ties by fewer false positives, higher recall, and lower threshold. This is fixture fitting, **not independent validation**. On the clean fixture a model predicting every window normal has 87.5% accuracy but zero recall/F1 — this is why imbalance-aware metrics are shown.

Latency and costs are simulated formulas:

| Estimate | Formula |
| --- | --- |
| Latency per window (ms) | `0.05 + operations × 0.003` |
| p95 latency (ms) | `latency × 1.20` |
| Energy per window (µJ) | `18 + operations × 0.06 + memoryBytes × 0.002` |
| Energy per 1,000 windows (µWh) | `energyMicroJ × 1000 / 3600` |
| Battery per 1,000 windows (%) | `energyMicroWh / (4.44 × 1,000,000) × 100` |

Battery assumes 4.44 Wh and covers acquisition + inference only. It excludes radio, idle power, peripherals, and battery losses; **it is not an estimate of whole-device battery life**.

The Pareto frontier considers accuracy (maximize) and latency (minimize) at the two current profile thresholds. A point is dominated if another is no worse on both dimensions and strictly better on at least one. Equal points remain efficient. Memory/energy are shown separately, not silently included in this two-dimensional frontier.

Deployment JSON has stable property order and contains no timestamps, hardware details, or random values. It records the scenario, seed, exact threshold, parameters, metrics/coverage, simulation warning, cost assumptions, and a fixture fingerprint. The `checksum` is FNV-1a-32 over the **UTF-8 compact JSON body, excluding `checksum`**. It detects repeatability differences; it is not a security signature. Reproduce a card using the same `lab-core.js`, `createFixture(card.dataset.scenario)`, model ID/parameters, threshold, and cost formulas.

Schema **1.1** adds structured `assumptions` and `fasterProfileComparison`. Both profile snapshots record parameters, modeled operations/memory, exact thresholds, confusion counts, rates, coverage, and costs. Deltas mean **faster minus slower baseline**; rates are fractions and battery deltas are percentage points. Display/export rates and costs are rounded deterministically; thresholds are not rounded. The comparison, including the unselected profile’s threshold, is covered by the checksum. To replay it, rebuild both profiles from these snapshots, regenerate the recorded scenario, and call `compareProfiles(dataset, models, explicitThresholds)` before `deploymentCard(..., comparison)`. Older five-argument callers receive a `null` comparison; the UI always supplies it.

## Checks

```sh
npm test
npm run check
node scripts/smoke-ui.cjs --vm
```

The dependency-free UI smoke tests also run under `npm test`. They exercise the real `app.js` handlers in a small DOM stub: clipboard success/rejection and legacy-copy true/false, exact Blob payload/filename and deferred URL cleanup, scenario/threshold comparisons, and export replay. Inspector regressions additionally cover complete filtered lists, stable-ID selection through tuning/profile/scenario changes, both decision contexts, missing gaps, and keyboard selection.

Optional actual-browser checks use existing Playwright and locally installed browser binaries; neither is an app dependency:

```sh
node scripts/smoke-ui.cjs --browser chromium --output /tmp/omnirush/ui-smoke-chromium
node scripts/smoke-ui.cjs --browser firefox --output /tmp/omnirush/ui-smoke-firefox
```

Set `PLAYWRIGHT_MODULE` to an existing Playwright module path if it is not discoverable. The script serves only loopback fixtures, checks for external requests, verifies downloads and (in Chromium) native clipboard read/write, tests failure boundaries, and checks a 375px layout. Browser permission behavior and an OS save-dialog decision cannot be guaranteed by stubs; download status therefore reports “download requested,” not confirmed disk persistence.

Tests cover missing/non-finite and sparse samples, empty/single-class datasets, class imbalance, decision boundaries, deterministic fixtures/scenarios, threshold recommendations, Pareto dominance/ties, cost arithmetic, UTF-8 fingerprints, and reproducible exports. This is a plain static app: no compilation, framework build, or typecheck is required.

`tests/window-inspection.test.js` focuses on identity-preserving inspection, all nine gaps, exact per-profile decisions, the misleading 87.5% majority-class accuracy with zero recall/F1, dropout denominators, and real-profile Pareto tradeoffs/dominance after tuning.

## Files

- `index.html`: semantic local UI
- `styles.css`: responsive technical-lab styling; only system fonts
- `app.js`: state, interaction, chart/table rendering, copy/download
- `lab-core.js`: browser/Node-compatible pure evaluation and export functions
- `tests/lab-core.test.js`: built-in Node regression suite
- `tests/app-smoke.test.js` and `scripts/smoke-ui.cjs`: repeatable local UI/export smoke checks
- `tests/window-inspection.test.js`: window identity, missing gaps, imbalance and Pareto regression tests
- `tests/final-boundaries.test.js`: final missing-sample, minority-class, Pareto-boundary, scenario comparison, endpoint export, and simulated-label coverage
- `scripts/build-static.cjs`: deterministic four-file static build into `dist/`
