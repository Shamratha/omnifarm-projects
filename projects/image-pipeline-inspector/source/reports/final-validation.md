# Final validation

## Result

The final deterministic and Chromium browser suites pass: **14 unit tests and 7 browser tests**, with no skipped tests. Browser checks include real manifest downloads, local fixture requests, and page-error/non-local-request monitoring.

## Browser behavior verified

- Selecting the background, mountain, and missing legacy layer updates contextual source and mask information.
- Layers without masks do not expose the mountain's controls.
- Invert, feather (24 px), and edge shift (-3 px) survive selection changes and appear in the downloaded manifest.
- Mask inversion changes the actual preview pixels, rather than only document metadata.
- Caption visibility updates both the preview and exported visibility.
- Blend-mode changes update the layer row and export; opacity changes match the inspector and export.
- The comparison pane renders the comparator's four changed-layer records for the bundled revisions, including both layers affected by reordering.
- The bundled missing asset remains diagnosed: 1 issue, 4 / 5 references. Removing a mask in the smoke test produces 2 issues and 3 / 5 references without crashing preview rendering.
- Both export buttons download byte-identical JSON for the same state. Hidden layers, edited masks, unresolved references, local asset paths, and profile metadata are retained.
- Exported present-asset paths resolve to local SVG fixtures.

## Fixes made during this pass

- Replaced the static image-only preview with local fixture compositing in `src/preview.js`, using the tested mask-alpha helper.
- Synchronized layer-row blend labels and caption visibility with document state.
- Included asset source paths and profile metadata in the reproducible manifest.
- Added regression tests for preview/export parity, inverted source alpha, canonical export with reordered object keys, and multiple missing references.

## Commands and results

| Command | Result |
| --- | --- |
| `npm test` | 14 passed |
| `npm run test:browser` | 7 passed in headless Chromium |
| `npm run test:browser -- --grep smoke` | Local entry-point and missing-reference smoke check |
| `node --check app.js` | Passed |
| `node --check src/pipeline.js` | Passed |
| `node --check src/preview.js` | Passed |
| `node --check playwright.config.js` | Passed |

Screenshots were refreshed after waiting for the preview to finish: `reports/inspector-desktop.png` and `reports/inspector-compare.png`. A separate browser screenshot smoke run observed no page errors or failed requests.

There is no separate build, lint, or typecheck script in this static JavaScript project. The preview is a lightweight SVG/Canvas fixture renderer, not a GIMP-compatible renderer or full ICC color-management engine. The deterministic profile test covers the supported Rec. 709 grayscale pixel conversion.

## Destructive-edit and broken-reference summaries

- `summarizePipeline()` is shared by the manifest exporter and the validation UI.
- Destructive summaries report operations explicitly recorded with `destructive: true`; they do not infer pixel damage from opacity, masks, or other reversible changes. Operation order, affected layer names, operation paths, and original metadata are retained.
- Broken-reference summaries include missing assets, missing masks, missing/duplicate layer references, and reference cycles, including hidden layers. Unsupported profiles stay in general validation but do not inflate broken-reference counts.
- The validation area shows counts, empty states, review status, and expandable finding details. Compare also shows summary counts.
- Manifest JSON adds `summary.destructiveEdits`, `summary.brokenReferences`, and the full `operations` log. Layer `parentId` is retained for broken-link reproduction.
- Regressions verify mixed destructive/non-destructive histories, hidden broken references, repaired empty states, deterministic export, and UI/download parity. A synthetic destructive history is injected only inside the browser test; the bundled document remains at 0 recorded destructive edits and 1 broken reference.
- Summary screenshot: `reports/pipeline-summaries.png`.
