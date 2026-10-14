# Fieldnote — Satellite comparison studio

A zero-dependency, local browser studio inspired by computer-vision hackathons. No imagery downloads, uploads, external fonts, external vision models, or API calls.

## Run

Requires Node.js 22+ for tests and Python 3 for the local static server.

```sh
npm start
```

Open **http://localhost:4173**. ES modules need an HTTP server; opening `index.html` directly via `file://` is not supported.

## Try the flow

1. Select **River bend**, **New block**, or **Archive haze**.
2. Switch infrared / visible; inspect side-by-side, difference, mask, or confidence maps.
   Shared cloud/nodata legends and separate before/after freshness banners stay visible in every view. View-specific signal scales explain the colors; text-labeled mask badges show each tile's counts (the readout counts use the union across timestamps).
3. Adjust the threshold and hover a pixel to see both values, difference, confidence, and exclusion reason. Keyboard users can focus a canvas and use arrow keys to inspect pixels.
4. Choose **Export report** to download `fieldnote-<fixture>-<band>.html`. The standalone report includes a readable decision summary, timeline, legends, mask/confidence interpretation, print-to-PDF support, and an embedded button for the full machine-readable JSON.

The embedded JSON includes geometry, acquisition timestamps, freshness of **both** images, excluded pixel indices, per-pixel confidence/differences, changed indices, and summary statistics.

The desk and exports use the same outcome wording: **change detected**, **no change detected at the selected threshold**, or **not comparable** (no valid pixels). No-change does not mean the images are identical, and excluded pixels were not assessed. Freshness warnings identify before/after/both stale images without replacing the comparison outcome.

## Data and interpretation

- `src/fixtures.js` bundles deterministic 96 × 96 synthetic tiles in a local planar grid (10 m pixels). Coordinates do **not** refer to real satellite acquisitions.
- Visible RGB and infrared proxy values are generated locally. IR is a false-color normalized signal, **not** calibrated temperature or reflectance.
- The analysis clock is fixed at **18 June 2025, 12:00 UTC** for reproducible age decisions. It is intentionally not the wall clock.
  Reports label this clock explicitly as `analysisAt`; `generatedAt` remains an alias for compatibility, not the download time.
- Tile width/height, origin, resolution, and CRS must match exactly; no hidden resampling.
- Cloud/nodata from **either** acquisition excludes a pixel. Nonfinite samples are also excluded. Borders are missing data, not change.
- Confidence is the minimum across both timestamps. Low confidence (< 0.65) remains eligible but visible for review; confidence is synthetic, not a model probability.
- Change means `abs(after - before) >= threshold`, with a machine-epsilon tolerance for decimal threshold ties. At zero threshold, unchanged valid pixels qualify too.
- Stale means age **greater than** 14 days. Exactly 14 days is fresh. Both timestamps appear in tile captions and reports; stale data remains inspectable.
- The main changed percentage uses all pixels as its denominator; `changedFraction` in the report uses only valid pixels. Coverage distinguishes these denominators.
  The desk and HTML use one-decimal percentages; JSON retains full numeric precision. When no pixels are valid, the valid-pixel fraction is not available; the legacy numeric zero in `changedFraction` is an empty-result placeholder, not a no-change finding.
- Difference colors map absolute difference to a fixed scale; below-threshold pixels are muted. Paper colors identify exclusions. Changes are illustrative signals, not proof of land-use change.

## Verify

```sh
npm test
node --check src/app.js
node --check src/engine.js
node --check src/fixtures.js
node --check src/report.js
```

Tests cover grid alignment, timestamp masks, nodata borders, threshold ties, malformed data, confidence indexing, stale boundaries, all-missing tiles, JSON report round-tripping, no-change wording, precise thresholds, and HTML/JSON consistency. This is vanilla JavaScript: no build, typecheck, or lint toolchain is required/configured.

An optional Chromium smoke test is included in `scripts/browser-smoke.mjs`. With the server running and Playwright installed locally, run `node scripts/browser-smoke.mjs`. Alternatively set `PLAYWRIGHT_MODULE` to the absolute path of an existing Playwright `index.mjs`. The script tests browser controls, keyboard inspection, all maps, every fixture/band HTML export and its actual JSON download, zero/high thresholds, stale imagery, fully excluded comparisons, mobile overflow, and absence of external requests. Screenshots and downloaded HTML/JSON artifacts are written to ignored `test-results/`.
