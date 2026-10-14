# Ion Track Explorer

A greenfield Vite + TypeScript + Three.js browser viewer for a deterministic, prerecorded-style silicon ion-cascade dataset. The interface combines a rotatable target volume with an editorial dashboard for track visibility, time slicing, selection, and a small local depth-energy analysis chart.

## Setup and run

Requirements: Node.js 20+ and npm.

```bash
npm install
npm run dev
```

Open the local URL printed by Vite (normally `http://localhost:5173`). The app fetches `/data/silicon-cascade.json` from the Vite public directory at runtime.

The Python importer/validator uses Python 3.9+ and the standard library only. A
complete local check from the repository root is:

```bash
npm run test:logic
npm run build
python3 -m unittest discover -s scripts -p 'test_*.py'
python3 scripts/import_tracks.py --check public/data/silicon-cascade.json
```

Production checks and preview:

```bash
npm run build
npm run preview
```

Frontend logic tests use Node.js 22.6+ and its built-in test runner/type stripping (no additional dependencies):

```bash
npm run test:logic
```

The tests cover profile boundaries and aggregation, cascade indexing, JSON/CSV parsing, filtered event indices and highlights, deterministic render budgets, profile CSV escaping/scope/archive membership/empty bins, and session validation/round trips. Pure helpers are exported from `src/trackLogic.ts`.

The repository also contains the importer/validator checks supplied with the dataset:

```bash
python3 -m unittest scripts.test_import_tracks
python3 scripts/import_tracks.py --check public/data/silicon-cascade.json
```

## Data schema

The browser expects a JSON document with this shape:

```json
{
  "metadata": {
    "name": "string",
    "description": "string",
    "source": "string",
    "ion": "string",
    "material": "string",
    "incidentEnergyKeV": 30,
    "targetSizeNm": [100, 100, 160]
  },
  "tracks": [
    {
      "ionId": 1,
      "parentId": null,
      "species": "Ar",
      "kind": "primary",
      "events": [
        {
          "timeFs": 0,
          "positionNm": [-30, -20, 0],
          "depositedEnergyEv": 420
        }
      ]
    }
  ]
}
```

`kind` is either `primary` or `recoil`; `ionId` must be a unique integer and `parentId` an integer or `null`. Every non-null parent must reference a track in the document. The browser validates the shape and builds a cascade index before rendering; duplicate/non-integer IDs, non-integer parents, missing parents, and parent cycles (including self-parenting) stop loading with a descriptive error. Empty event arrays are rejected explicitly, and target dimensions must be positive. Events are normally chronological within each track; event numbers always refer to their original archive order. Coordinates are nanometers, time is femtoseconds, and deposited energy is electron-volts.

### Input units and coordinate convention

| Field | Unit / rule |
| --- | --- |
| `timeFs` / CSV `time_fs` | femtoseconds (`fs`), nonnegative |
| `positionNm` / CSV `x_nm`, `y_nm`, `z_nm` | nanometres (`nm`); X and Y are centered around zero, while Z runs from the target entrance at `0` to `targetSizeNm[2]` |
| `depositedEnergyEv` / CSV `deposited_energy_ev` | electron-volts (`eV`), nonnegative |
| `targetSizeNm` | target width, height, and depth in `nm`; all dimensions must be positive |
| `eventType` / CSV `event_type` | optional, nonempty label; it is a filter/category label, not a physics interpretation |

The viewer preserves the source event order and original event numbers. It does
not interpolate missing events, convert units, or infer physical meaning from
labels.

## Importer usage

The standard-library importer in `scripts/import_tracks.py` can validate a JSON document or group an event CSV into the browser schema:

```bash
python3 scripts/import_tracks.py --check public/data/silicon-cascade.json
python3 scripts/import_tracks.py events.csv public/data/imported-tracks.json
```

CSV input must contain `ion_id`, `parent_id`, `species`, `kind`, `time_fs`, `x_nm`, `y_nm`, `z_nm`, and `deposited_energy_ev`. The optional `event_type` column maps to `eventType` in JSON; absent/blank cells remain unlabelled. Importing groups rows by ion in first-seen order and performs no simulation, interpolation, or physics validation. Use **Import trajectory** in the browser for a local JSON or CSV file; the bundled `silicon-cascade.json` remains the default. Browser CSV uses the importer’s default Ar/Si, 30 keV, and 100 × 100 × 160 nm metadata and checks chronological rows per track, consistent track attributes, parent links, finite numbers, and nonnegative time/energy. It supports BOM, CRLF, quoted commas/newlines, and escaped quotes. Empty/invalid CSV or malformed JSON shows an error and retains the previous dataset. JSON preserves archive order, including unsorted events.

## Interaction model

- Drag the 3D target to orbit and scroll to zoom; **Reset view** restores the editorial camera. The viewport adds world-space X/Y axes centered on the target width/height, Z from 0 to target depth, numeric ticks, and a calibrated ruler in nanometers. On narrow screens, the Camera button group provides orbit, zoom, and reset controls without requiring drag or scroll.
- At widths ≤780 px and ≤470 px, headers and controls wrap to the available space. Camera buttons have accessible names and keyboard focus styles. Reduced-motion preferences disable decorative spinner animation and camera damping; timeline playback is opt-in and remains pausable.
- Toggle beam and recoil layers independently.
- Click a track row or visible 3D path to focus a track. The inspector’s parent and child buttons support navigating any number of cascade levels. Selecting a track reveals its layer, retains the current time, and clears event/bin selection.
- Click a 3D event marker or an event-table row to select that exact event. The same event is highlighted in the table and with a larger amber marker in 3D, and its depth bin is highlighted in the profile. Event buttons also support keyboard activation.
- Toggle event types generated from the data (including a distinct unlabelled option) and set inclusive minimum/maximum energy in eV. Blank energy bounds mean unbounded; invalid bounds leave the last valid filters applied. Filters apply to table, profile, highlights, and 3D paths/markers together with layers and `timeFs <= currentTime`.
- Click a profile bar (or focus a bin and press Enter/Space) to select the bin. All eligible members are highlighted in the table; only members within the render budget receive 3D highlights. Selection summaries distinguish eligible from rendered membership. Empty bins may be selected. Profile totals/means describe **all eligible selected-track events**, independent of table paging, render caps, and event/bin selection.
- Scrub the event-time range, use `−12` / `+12`, or play. Playback updates budget/UI at 10 Hz while the scene continues animating; unchanged capped geometry is reused. Scrubbing before a selected event, filtering it out, or hiding its layer clears event/bin selection. A bin selection follows eligibility through time and filters. The selected track remains in the inspector when its layer is hidden.
- Counts distinguish **Loaded** records, **Eligible** records (filters + layers + time), and **Rendered** records. Explicit caps in `src/trackLogic.ts` are **8,000 rendered events** and **500 rendered tracks**. Deterministic source-order prefixes reserve a track slot and at least one event for the eligible selected track. Paths use only capped event subsets; the renderer does not claim to show all eligible records. At most one group, path, marker cloud, and selection overlay are created per rendered track.
- The table renders at most **500 event rows per page**, with an honest truncation notice and Previous/Next controls to inspect the remainder. Original event numbers survive filtering, paging, and capping; full loaded data stays available for table/profile analysis.
- The profile uses **eight equal Z-depth bins** over `[0, targetSizeNm[2]]`. Each bin is lower-inclusive and upper-exclusive: `[edge, next edge)`. An exact interior edge enters the following bin; exact maximum depth enters the last bin. Depths below zero clamp to the first bin and depths above maximum clamp to the last bin. For a 160 nm target, the bins begin at 0, 20, …, 140 nm; 20 belongs to bin 2 and 160 to bin 8. Bars show total deposited energy and the line shows mean energy per event in each bin.
- Budgeted one-event tracks render markers without a line. Consecutive coincident positions are omitted only from line geometry; all budgeted events remain in the marker array and all eligible events remain available to table/profile analysis. Coincident markers overlap visually, so use the numbered event-table buttons to select a specific overlapping event.
- The legend distinguishes primary/beam, recoil/secondary, selected track, event markers, selected event/bin highlights, profile total bars, and profile mean lines. Filters define eligibility and are not color categories. The inspector shows track cascade context; selected events show original archive number, time, coordinates, deposited energy, type, depth bin, and whether that event is inside the current 3D budget. Selected bins show range, eligible count, total energy, and rendered highlighted count. With a track selected but no event/bin selected, the inspector explicitly says so.

## Exports

- **Export PNG figure** creates a self-contained static figure from the current camera, time, filters, selected track/event/bin, legend, counts, and depth profile. It renders the current Three.js scene into an explicit render target and labels the 3D portion as capped; it does not claim to show uncapped eligible records. Browser canvas/download limitations are reported in the session status.
- **Export profile CSV** is enabled when a visible selected track has eligible events. It emits one row per all eight profile bins, including empty bins, from the same filtered/time-sliced entries used by the chart—not table paging or the capped 3D budget. Each row carries dataset identity/name/source/file, selection scope, current time, filters, track, units, bin range, counts, totals, means, and original archive indices/event numbers. The scope is selected-track eligible events (time + filters).

## Sessions

**Download session** saves view state both to a JSON download and to localStorage. **Load session** accepts that JSON; **Restore local session** restores the last locally saved state. The session includes camera position, OrbitControls target, selection, event filters, time, layer toggles, and playback state, plus dataset identity/name/source/filename. Restoration pauses playback, applies the camera and controls target, and calls `controls.update()`.

Sessions **never embed trajectory records**. Imported trajectories exist only in page memory and do not survive a reload; re-import the matching file before restoring its session. A content fingerprint verifies identity. A mismatch reports the expected dataset, clears dataset-specific selections and filters, and leaves the camera unrestored. Matching sessions also validate IDs/event indices/bin indices and clear invalid or ineligible selections. JSON whitespace/key ordering does not affect identity; changed dataset content does.

## Hand-checkable fixtures

For the larger render workload, use **Import trajectory** to load
`fixtures/synthetic-render-load.csv` (320 tracks / 20,480 events). With all filters
enabled at 254 fs, expect 20,480 loaded, 20,480 eligible, and 8,000 rendered events.
See `fixtures/synthetic-render-load.md` and `scripts/generate_render_fixture.py`
for provenance and reproducible generation. These are synthetic test records,
not OpenTRIM output or a physics simulation.

The small JSON files under `fixtures/` are intentionally easy to inspect by hand:

- `fixtures/hand-checkable-cascade.json` contains root `10`, children `11` and `13`, grandchild `12`, a one-event track, coincident events, and an event exactly at 160 nm.
- `fixtures/invalid-missing-parent.json` must fail with a missing parent error.
- `fixtures/invalid-parent-cycle.json` must fail with a parent-cycle error.

The frontend logic tests load these fixtures directly, alongside exact profile-edge, zero-length, and selection-linking cases:

```bash
npm run test:logic
```

## Limitations

This is a visualization of supplied event records, not a simulation or a scientific reconstruction. The bundled data is explicitly synthetic. Track paths connect the capped eligible event subset with straight line segments; the depth profile is a descriptive aggregation of all eligible selected-track records. CSV metadata defaults must be checked against the source provenance. Rendering and table rows are bounded, but parsing, loaded data, and full-track profile calculations remain in memory and scale with archive size.

### Performance limits

The complete imported dataset remains in browser memory. To keep WebGL and DOM
work bounded, the viewer renders at most **500 tracks** and **8,000 eligible
events** in 3D, using deterministic source-order selection and retaining the
selected eligible track when possible. The event table shows at most **500 rows
per page**. The depth profile and profile CSV use all eligible events for the
selected track, not just the rendered subset, so their totals may exceed the
3D count. The generated render fixture intentionally contains 320 tracks and
20,480 events to make the loaded/eligible/rendered distinction visible.

## Inspiration and integration status

The project is inspired by the GSoC idea **“Python Bindings and Real Time 3D
Visualization for OpenTRIM”** from the Open Technologies Alliance - GFOSS:

<https://summerofcode.withgoogle.com/programs/2026/projects/lVrYry5l>

This repository is a standalone browser visualization component for recorded
trajectory data. It does **not** integrate OpenTRIM, invoke OpenTRIM, provide
Python bindings to OpenTRIM, run a physics simulation, or claim that the bundled
synthetic records are OpenTRIM output. Imported files retain the provenance
provided by their source metadata; users must verify that provenance themselves.

## Source reference

Project source reference: https://summerofcode.withgoogle.com/programs/2026/projects/lVrYry5l
