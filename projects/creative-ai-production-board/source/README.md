# Frame / 01 — The last signal

An offline-first creative-AI production board for a short-form audio-visual poem. It is designed for local editorial work: scene order, alternate cuts, storyboard frames, audio cue metadata, continuity notes, provenance, and a safe production manifest export.

## Run locally

```bash
npm start
```

Open <http://localhost:4173>.

The app is static and has no backend or live generative-model calls. The four storyboard illustrations in `assets/` are bundled, self-contained SVGs. Audio is represented as local cue metadata rather than fetched media.

## What to try

- Use **Board** to select scenes, preview the bundled frame, and reorder the active cut using drag-and-drop or the arrow controls.
- Use **Compare** to switch between *Quiet Signal* and *Pulse Edit*.
- Use **Rights & cues** to inspect asset provenance, rights labels, and carried credits.
- Run **checks** before export. The validator covers missing frame/audio references, duplicate credits, timing overlaps, out-of-order scenes, timing gaps, invalid cue entry times, invalid timing, asset types, missing rights labels, and clearance. Timing gaps are review notes; overlaps, missing cues, missing labels, and unsafe settings block delivery.
- Compare validates **both cuts**, not just the active one. Scene cards and the inspector show computed pass/review/blocked status rather than trusting editorial labels.
- Edit scene start/end and cue metadata from the inspector. Reordering keeps cue timestamps aligned with the moved scene.
- Shared credits use stable IDs. Reusing one ID across scene references merges it once in the manifest; two records with the same normalized name/role but different IDs remain a blocking duplicate.
- Open **export manifest** to see the safety gate. A safe JSON manifest contains scene timing, bundled asset references, rights labels, credits, computed continuity, timing-gap warnings, and audio cue metadata. Export revalidates current data so stale checks cannot permit an unsafe download.

## Delivery limitation — public delivery remains blocked

The bundled `frame-hands` asset (`assets/hands.svg`) is labelled editorial-only
in the sample production metadata. It restricts both bundled cuts to **internal
review**. A successful internal-review JSON export is not public-delivery
clearance, a rendered media package, or permission to publish this project.

The export summary names the active cut and distribution scope. Alternate-cut
reports retain their own warnings, blockers, and rights labels; they are
diagnostic only, not approved for delivery. Selecting **Public delivery** while
the editorial-only asset is referenced remains blocked. Public delivery would
require an appropriately cleared replacement or verified rights clearance and
a fresh validation pass; this project does not provide that clearance.

## Checks

```bash
npm test
npm run build
npm run smoke
node --check app.js
node --check validation.js
```

Tests use Node's built-in test runner. The build validates the static deployment and local references. The smoke suite uses Playwright with Chromium, blocks remote requests, and covers alternate-cut failures, export safety, real downloads, and responsive layout. None require an API key or model provider.

## Readiness — READY for local / internal review

Final verification on 2026-10-14:

| Check | Result |
| --- | --- |
| `npm test` | 71 passed, 0 failed |
| `npm run build` | 9 static files validated and emitted to `dist/` |
| `node --check` for `app.js`, `validation.js`, `board-data.js`, `validation.test.js`, `scripts/build.mjs`, and `scripts/smoke.mjs` | All passed |
| `npm run smoke` | 7/7 Chromium scenarios passed; no page errors or failed local resources |
| Exported manifest review | Safe, recovered, reordered, and alternate-warning JSON downloads reviewed successfully |

Final export-summary polish was verified with a fresh `npm test`,
`npm run build`, and `npm run smoke` run. Browser assertions now explicitly
check the internal-review export wording, active-cut scope, diagnostic-only
alternate reports, and persistent editorial-only delivery limitation. The
public-delivery option remains blocked for both bundled cuts.

Manifest review confirmed contiguous active-cut timing, updated cue times after
reordering, safe settings, merged stable credit references, and embedded frame
and audio rights labels. The deliberately damaged alternate is marked blocked
with overlap, missing-cue, and rights-label diagnostics; its report does not
misrepresent the valid active cut as unsafe or the alternate as export-ready.

Fresh verification artifacts are in `scripts/.smoke-artifacts/results.json`,
`safe-manifest.json`, `recovered-manifest.json`, `reordered-manifest.json`, and
`alternate-warning-manifest.json` in that same directory. They are ignored and
replaced on each smoke run.

Scope notes: bundled editorial-only labels restrict the sample project to
internal review; public delivery is intentionally blocked. Audio cues are
metadata, not playable audio files. Optional Google Fonts requests are blocked
during offline smoke checks; system fallback fonts keep the interface usable.
There are no live generative-model calls.
