# Museum Tour Storyboard

A standalone, local-first tour authoring component for museum teams building geographic, timed tours. The editor combines a route canvas, scene cards, camera controls, and a timing timeline in one browser workspace.

This deliverable is **not a live Liquid Galaxy deployment**. It does not connect to a Liquid Galaxy rig, publish to a remote display, provide a live map service, or run an agent backend. It is a self-contained browser authoring component inspired by the linked GSoC proposal and intended to make the storyboard/edit/export workflow usable without external services.

## What is included

- A bundled, illustrated map of central Paris with streets, blocks, parks, the Seine, and 10 cultural landmarks.
- Four starter scenes covering Musée d’Orsay, the Louvre, Palais-Royal, and Centre Pompidou.
- Scene cards for writing titles and captions, selecting landmarks, setting hold durations, and reordering stops by drag-and-drop or arrow controls.
- Camera authoring with latitude/longitude fields, zoom, bearing, tilt, and click-to-place mode on the local map.
- Live validation for missing/invalid coordinates, camera altitude (1–100,000 m AGL), zero or invalid durations, caption timing, and overlapping captions. Each warning links to the affected scene and clears as the draft is corrected.
- Geodesic route distance calculated with the haversine formula, including shortest-path antimeridian legs, plus a visible total duration.
- A timed preview mode with scene narration, map route playback, transport controls, and a proportional timeline.
- Keyboard scene reordering with focused ArrowUp/ArrowDown controls, bounded undo/redo history, and Cmd/Ctrl shortcuts.
- A synchronized playback cursor that can be scrubbed from the editor timeline or preview. Preview mode interpolates camera latitude, longitude, altitude, zoom, tilt, and shortest-path bearing between scene keyframes, while caption visibility follows each scene's caption timing window.
- Local browser persistence through `localStorage`.
- Explicit local Save/Load plus JSON storyboard import/export so a team can move a draft between browsers without a backend.
- Delivery exports for ordered Google Earth KML `gx:Tour` and WebVTT subtitles. Both use the visible scene order and the same scene durations.

## Local setup

### Requirements

- Node.js `20.19+` or `22.12+` (Vite's supported ranges)
- npm (included with Node.js)
- A modern browser for the editor
- Chromium installed through Playwright only if you want to run the browser smoke check

Check the runtime before installing:

```bash
node --version
npm --version
```

### Install and open the editor

From the project folder:

```bash
npm install
npm run dev -- --host 127.0.0.1
```

Open the local URL printed by Vite, normally `http://127.0.0.1:5173/`. The dev server serves the browser editor only; it does not require a database, API key, geocoder, map provider, or external service.

### Production build and preview

```bash
npm run build
npm run preview -- --host 127.0.0.1
```

Open the preview URL printed by Vite, normally `http://127.0.0.1:4173/`.

### Automated checks

Run the pure domain, validation, save/load, KML, and WebVTT tests:

```bash
npm test
```

This runs `node --test src/tourModel.test.js src/storyboardFiles.test.js`.

Run the browser exercise. It starts its own Vite server on port `5174`, edits a storyboard, saves and reloads it, downloads both exports, parses the KML XML and WebVTT cue structure, tests reorder/undo/redo/playback/caption timing, and checks the narrow layout:

```bash
npx playwright install chromium
npm run test:browser
```

On Debian/Ubuntu CI hosts where browser system libraries are missing, use `npx playwright install --with-deps chromium` instead. The browser check is local-only and does not contact a production service.

The production build check is:

```bash
npm run build
```

## How to use the component

1. Edit a scene title, caption, location, camera fields, duration, or caption timing in the inspector.
2. Select a scene card and use `ArrowUp` / `ArrowDown` to reorder it. Drag-and-drop and the card buttons are also available.
3. Use `Cmd/Ctrl+Z` and `Cmd/Ctrl+Shift+Z` (or the toolbar buttons) to undo and redo document edits.
4. Use **Save** and **Load** for explicit browser-local persistence. The automatic local save remains enabled.
5. Click **Preview tour** and scrub the shared playback cursor. The map shows interpolated camera position; the caption appears only during its configured timing window.
6. Resolve the validation panel before exporting **KML** or **WebVTT**. KML and subtitles follow the current visible scene order and the same scene durations.

## Local data

Edits save automatically in the browser under the `museum-tour-storyboard-v1` local-storage key. Use **Save** and **Load** in the top bar for explicit local persistence. The left sidebar download/upload controls export and restore an editable JSON storyboard. **KML** exports a Google Earth `gx:Tour`; **WebVTT** exports timed captions. Delivery exports stay disabled until the validation panel is clear. “Reset to starter tour” restores the included Paris example.

Map geometry and landmark metadata are bundled in `src/data.js` and `src/RouteMap.jsx`. The app intentionally uses no remote map tiles or live Liquid Galaxy connection.

## Reference

The source idea for this standalone authoring component is **AI Tour Director: An Omni-Agent System for Liquid Galaxy** (Liquid Galaxy project):

https://summerofcode.withgoogle.com/programs/2026/projects/3Foj7wuK
