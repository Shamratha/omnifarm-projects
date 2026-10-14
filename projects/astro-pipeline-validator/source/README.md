# Astro Pipeline Validator

A dependency-free, local astronomy observation-pipeline validator. It keeps the
input bundle as plain JavaScript objects so it can be populated from FITS
headers, calibration inventories, exposure logs, weather records, and target
coordinates without requiring a network service or a FITS reader.

## Run locally

```bash
npm start
```

Open <http://localhost:4173> in a browser. All validation runs in the browser;
no data is uploaded. The bundled run is intentionally imperfect so the
dashboard has findings to inspect immediately. Use **Export Markdown + JSON** to
save the standards-oriented validation reports produced for the active run.

## Validation coverage

The core API is in `src/validator.js`:

- `sampleBundle` — representative FITS-like metadata, science exposures,
  calibration frames, weather, and target coordinates.
- `validateBundle(bundle)` — deterministic validation result containing a
  summary, checks, findings, and normalized values.
- `formatValidationReport(result)` — Markdown report with check status,
  evidence, remediation, and FITS/IAU/IERS-oriented standards references.
- `formatValidationJsonReport(result)` — deterministic JSON report with the
  same findings and explanations rendered by the dashboard.
- `createDashboardModel(result)` — the canonical dashboard projection shared
  with JSON and Markdown report generation.

The validator checks required metadata and cross-record consistency, bias/dark/
flat coverage, UTC/TAI/GPS declarations, known leap-second boundaries, MJD
consistency, coordinate/airmass/altitude/weather ranges, and exposure units.
Valid exposure values are normalized to seconds and valid timestamps to UTC
while preserving source-scale provenance.

## Checks

```bash
npm test
node --check src/app.js
node --check src/validator.js
```

The tests cover a healthy baseline plus leap-second boundaries, missing bias
frames, mixed exposure units, deterministic dashboard findings, and report
formatting.
