# Gaze Overlay

A small, dependency-free usability-session observer. It replays timestamped, normalized gaze samples over a bundled sample page so an observer can pause, seek, change speed, inspect confidence, notice when gaze leaves the viewport, review time-linked heatmap, fixation, and AOI views, and export an analysis JSON snapshot.

## Scope note

This is the **recorded-sample gaze visualization scope** of the linked GSoC idea, [Real-Time Gaze Cursor Overlay for Live Observation (Uramaki LAB)](https://summerofcode.withgoogle.com/programs/2026/projects/KjuMVL6W). It is an offline local recording observer: it does not capture a live eye tracker, connect to a participant browser, provide tracker calibration, or claim real-time network observation. The sample page is bundled so the overlay can be exercised without a service.

Reference: https://summerofcode.withgoogle.com/programs/2026/projects/KjuMVL6W

## Run locally

From the project directory, use Python 3's static HTTP server. Binding to loopback keeps the recording and observer available only on this machine by default:

```bash
python3 -m http.server 4173 --bind 127.0.0.1
```

Then open [http://127.0.0.1:4173](http://127.0.0.1:4173). The demo recording is loaded as a local JSON asset, so serve this folder over HTTP rather than opening `index.html` with `file://`.

No application dependencies, runtime npm install, or build step are required. The app uses browser support for ES modules, `structuredClone`, `ResizeObserver`, and `Blob`.

For a different port, run `python3 -m http.server <port> --bind 127.0.0.1` and open the matching local URL. A different bind address can expose the observer to other devices on that network, so loopback is the suggested default for private recordings.

## Use your own recording

Choose **Import JSON** and select a recording with a `samples` array. Each sample uses finite normalized coordinates (`x` and `y`, normally from 0 to 1), a timestamp in milliseconds (`t`), and an optional confidence value from 0 to 1:

```json
{
  "title": "Checkout test",
  "timeUnit": "ms",
  "samples": [
    { "t": 0, "x": 0.42, "y": 0.25, "confidence": 0.92 },
    { "t": 500, "x": 0.56, "y": 0.41, "confidence": 0.86 },
    { "t": 1000, "x": 1.04, "y": 0.43, "confidence": 0.61, "outsideViewport": true }
  ]
}
```

The importer also accepts a top-level array, `data`, or `gaze` in place of `samples`; `timestamp`, `time`, `gazeX`, `gazeY`, and `score` are accepted aliases. Set `timeUnit` to `"s"`, `"sec"`, or `"seconds"` when timestamps are in seconds. The imported payload is cloned before any processing, so the original data remains unchanged.

Choose **Export** to download `<recording-title>-gaze-analysis.json`. The `recording` member is the original imported payload, unchanged, and `analysis` contains schema/version metadata, exact current processing and fixation settings, numeric millisecond timing, sample and segment counts, the current sample/fixation, completed heatmap points, fixation lists, AOI dwell at the current position and full duration, and the current playback position. **JSON summary** downloads the analysis member alone as `<recording-title>-analysis.json`. The export's generated timestamp is supplied by the UI at export time. Export is generated with a Blob/object URL and does not alter playback or source data.

Combined exports can be imported again: the original `recording` is reopened using the current UI settings. Saved analysis is a snapshot, not executable state. The summary-only file is not a gaze recording.

## Processing semantics

The processing layer is imported by the app's module script from `gaze-processing.mjs`. Its controls are applied to the normalized recording without modifying that recording:

- **Minimum confidence** accepts values from 0 to 1. Rows with confidence below the threshold are filtered and become barriers.
- **EMA smoothing** is optional. With alpha `α`, each accepted segment starts at the raw coordinate, then uses `smooth = α * current + (1 - α) * previousSmooth`. A filtered row or gap resets the EMA at the next accepted sample. The **Raw** and **Smoothed** buttons select both the cursor coordinates and the visible path; the active mode is shown in the inspector.
- **Max gap** is measured in milliseconds. A time difference strictly greater than this value starts a new segment. The cursor and path stop at segment ends: they do not interpolate through gaps or hold the last endpoint.
- Finite coordinates outside 0–1 are accepted and displayed as outside the viewport. Non-finite coordinates, non-finite or out-of-range confidence values, and low-confidence rows are invalid for processing and break continuity. Invalid timestamps are excluded from the normalized timeline but remain visible in the processing statistics.

### Fixations and heatmap

Fixations are analyzed from raw accepted coordinates, regardless of whether the display is using EMA smoothing. A candidate starts with one accepted sample and can absorb the next sample when its Euclidean distance from the current, sample-weighted running centroid is less than or equal to the normalized **radius**. A failing point closes the candidate before that point and starts a new run. Runs are maximal within filtered/gap-separated segments and are retained when `last timestamp - first timestamp >= minimum duration`; a singleton therefore has `0 ms`. The analysis also receives the max-gap setting and never bridges a processing segment gap.

Defaults are radius **0.06 normalized units**, minimum duration **100 ms**, and max gap **1000 ms**. Radius accepts 0–1 and duration/gap accept finite nonnegative milliseconds; invalid/empty inputs retain the last valid settings. Alpha is labeled as a unitless 0–1 EMA weight: 0 holds the segment's first coordinate, and 1 uses each raw sample. Display smoothing affects neither fixation nor AOI analysis. Path history is clipped to playback time, including an interpolated endpoint within an accepted interval; paused seeks immediately update all overlays.

The **Heatmap** view uses completed fixations only (`end <= playback time`). Each radial point uses hue `220 × (1 - clamp(durationMs / 1000, 0, 1))`, at 90% saturation and 50% lightness, mapping blue at `0 ms` to red at `>=1000 ms`. Point size and opacity are fixed (100 px and 0.7); overlapping spots blend visually, rather than representing an additional numeric heat metric. A legend and empty state are provided, and points keep their duration color when the timeline is sought. The **Fixations** view numbers completed and currently active markers in recording order and labels their full offline duration. A marker whose full interval contains the current playback time is highlighted and explicitly labeled as an active full interval; its centroid and duration use the entire precomputed run, including samples later than the seek time. Future runs are hidden. The completed fixation count is cumulative through the current time and decreases on backward seeks.

### AOIs and dwell

AOIs are inclusive normalized rectangles. They can be added, edited, or removed with the keyboard-accessible numeric form. Dwell summaries are recalculated from the accepted raw samples on every render and are clipped at the current seek time. Within each accepted interval, time is the exact linear-interpolation intersection of the gaze line with the rectangle; it uses no midpoint binning, does not add endpoint holds, and does not bridge filtered rows or gaps. Overlapping AOIs count independently, including shared edges. Values are shown in milliseconds.

The default AOIs use `(x, y, width, height)`:

- **Hero copy:** `(0.05, 0.09, 0.43, 0.28)`
- **Hero illustration:** `(0.58, 0.08, 0.39, 0.39)`

The origin is the sample page's top-left, below the decorative browser bar. All form values are normalized 0–1; `x + width` and `y + height` must not exceed 1. Zero-sized rectangles are supported by the inclusive-edge analysis. Use **Edit**, **Save AOI**, **Cancel edit**, and **Remove** to manage regions. AOIs are session-local, remaining across recording imports but returning to defaults on page reload. Dwell displays one decimal place in ms; rounding is display-only.

### Viewport mapping and overlays

The calibration assumption is that source `x` and `y` are normalized relative to the sample page content, with the top-left as `(0, 0)`. The browser chrome is excluded: `.sample-page`, the overlay layers, and the cursor share one coordinate box. The default `coordinate-preserving normalized x/y relative to sample-page content` policy maps `x * rendered page width` and `y * rendered page height`; it retains values outside 0–1 and clamps only the presentation cursor to the visible frame. The side panel reports the current rendered page width/height in pixels and mapping status. A `ResizeObserver` and window resize listener refresh those metrics without changing raw data or analytics. The pure `buildAnalysisSummary` helper accepts `generatedAt` from its caller, so analysis generation has no hidden clock dependency.

Use **Hide overlays** to inspect the underlying page. It hides the cursor, path, heatmap, fixations, AOIs, outside tag, empty state, legends, and analytics overlay status while leaving playback and the inspector available. Selecting Path, Heatmap, or Fixations shows overlays again.

No eye-tracker calibration is performed or verified by this app. Source calibration is assumed and confidence is not a measured spatial error. Normalized remapping follows viewport fractions, not reflowed DOM elements; source screen dimensions, device-pixel ratio, and scrolling are not reconstructed. The assumptions panel reports the applied settings (including the last valid values when a control is invalid).

The reduced-motion preference is honored for the UI's cursor pulse, transitions, and other decorative motion. Playback timing still advances when playing; reduced motion does not change the recorded timestamps or analysis results.

## Limitations

This implementation is limited to recorded-sample gaze visualization. It has no live eye-tracker input, tracker calibration, participant-browser connection, network participant capture, or real-time observation stream. It does not replay an actual participant page or reconstruct that page's DOM reflow, scrolling, source screen dimensions, or device-pixel ratio; normalized coordinates are mapped to the bundled/sample page viewport instead.

Fixation radius is a heuristic in normalized coordinate units, not a visual angle in degrees. The heatmap shows completed offline fixations only, while the Fixations view can show an active marker for the full precomputed fixation interval. These views are analysis visualizations rather than a calibrated measure of visual attention.

Export includes the original imported recording as well as the analysis snapshot. Downloads are generated locally and are not uploaded, so exported files should be treated as sensitive when the recording contains private data. AOIs and processing/fixation settings in an export describe a snapshot; they are not a complete restoration of the browser session. AOIs persist locally for the current page session and reset on page reload.

The page requests Google Fonts when network access is available, but includes fallbacks and remains usable offline after it has been served locally. Large recordings are held in browser memory; their performance and limits have not been benchmarked.

The bundled 17,550 ms demo contains dense small-jitter runs of different durations, plus its low-confidence and outside-coordinate examples. With the default confidence filter the low-confidence rows create no-gaze gaps; lower minimum confidence to 0.50 to inspect the outside samples. Lower max gap to see additional sampling-gap barriers.

The inspector reports accepted samples, segments, invalid coordinates, invalid confidence, low-confidence rows, and invalid timestamps. During a filtered region or gap it shows a clear status and hides the cursor.

Playback supports Play/Pause, timeline seeking, 0.5×–2× speed, Reset view, Space for play/pause, Left/Right Arrow for 500 ms seeking, Shift+Left/Right for 100 ms seeking, Home/End jumps, `1`/`2`/`3` view selection, `0` to hide overlays, and `R` to reset. Inputs, selects, textareas, and buttons are excluded from global shortcuts. Pausing, seeking, resetting, and reaching the end cancel the pending animation frame so only one playback chain can update the UI.

## Checks

```bash
node --check app.js
node --check gaze-processing.mjs
node --check gaze-export.mjs
node --test gaze-processing.test.mjs
node --test gaze-analysis.test.mjs
node --test gaze-export.test.mjs
python3 -m json.tool demo-recording.json > /dev/null
```

The standalone browser check can be run with:

```bash
node browser.test.mjs
```

It starts its own static HTTP server on a random loopback port and launches Playwright Chromium, so it does not require a user-started HTTP server. The check covers import, pause/play, 2× speed, seeking, AOI editing, export, resize, and reduced-motion preference off/on behavior. Playwright is optional and is not an application dependency. For a development-only local setup, install it without adding a package manifest or lockfile:

```bash
npm install --no-save --package-lock=false playwright
npx playwright install chromium
```

If Playwright is installed outside the project, set `PLAYWRIGHT_MODULE` to the absolute path of its installed module before running `node browser.test.mjs`. The browser check requires Chromium and is separate from the app's no-build, no-runtime-npm-dependency setup.

## Files

- `index.html` — accessible observer UI and bundled sample page
- `styles.css` — responsive visual system and gaze overlay styles
- `app.js` — module integration, processing and fixation controls, time-linked overlays, AOI editor, playback loop, and readout updates
- `gaze-export.mjs` — pure normalized viewport remapping and JSON analysis/export summary helpers
- `gaze-export.test.mjs` — remapping, immutable export, summary, and seek-order tests
- `gaze-processing.mjs` — immutable normalization, filtering, EMA smoothing, and gap-aware sampling
- `browser.test.mjs` — optional Playwright browser behavior check with an automatically managed loopback server
- `demo-recording.json` — bundled sample gaze recording
