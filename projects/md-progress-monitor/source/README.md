# MD Progress Monitor

A local molecular-dynamics progress dashboard with a Python replay producer and a browser UI. The monitor streams timestamped particle frames over WebSocket, including coordinates, temperature, potential energy, simulation time, and step. The interface includes:

- a projected molecular view with element colors and inferred bonds;
- live temperature and potential-energy plots;
- WebSocket connection and producer status;
- pause, resume, and replay controls;
- a bounded recent-frame buffer (28 frames by default);
- click-to-inspect frame geometry and metrics, with a return-to-live action.
- unaligned all-atom RMSD against the first received trajectory frame;
- rolling mean/min/max/population-standard-deviation summaries;
- configurable trailing plot windows, deterministic display-only downsampling, and CSV export of all retained frames.
- protocol/client diagnostics for observed sequence gaps, duplicate replays, reconnect resets, cursor expiry, retained frames, and bounded-buffer estimates;
- keyboard shortcuts and keyboard-focusable frame inspection for desktop and small-screen use.

The bundled `data/trajectory.json` is a deliberately small ethanol trajectory for local demos. Its frame shape is designed as a lightweight, MDAnalysis-inspired streaming seam: a future producer can replace the replay loop without changing the browser protocol.

This is a trajectory playback and monitoring dashboard, not a molecular-simulation engine. The bundled producer replays recorded values; it does not integrate equations of motion, calculate forces, or update temperature and energy from a physical model.

## Data source and adapter boundary

This implementation uses its **own documented local stream adapter**. The current adapter is:

1. `md_monitor/trajectory.py` loads and validates `data/trajectory.json`;
2. `md_monitor/server.py` replays normalized frames through the local WebSocket transport;
3. `public/stream-parser.mjs` validates the client-side envelope/frame contract;
4. `public/app.js` derives display analytics from received frames.

The browser consumes only the local `md-progress-frame/v1` WebSocket contract. It does not directly read MDAnalysis files, connect to a simulation engine, or depend on an external streaming service. Replacing the bundled source means implementing the adapter that maps source data into the normalized trajectory/frame contract; it does not require changing the browser protocol.

This is **not an IMDv3 integration or compatibility layer**. IMDv3 is not implemented or implied here. “MDAnalysis-inspired” describes the source idea and the shape of the adapter seam, not a claim of an official MDAnalysis or IMDv3 implementation.

## Prerequisites and local setup

Requirements:

- Python 3.11+
- a modern browser with WebSocket, Canvas, ES modules, and Blob-download support;
- Node.js 22+ only for the browser-side deterministic tests (`node --test`); no npm install or frontend build is required.

From this directory:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python -m md_monitor.server
```

Open <http://127.0.0.1:8765> in a browser. The single `python -m md_monitor.server` command starts the static browser client and the local WebSocket trajectory producer together.

The bundled source is `data/trajectory.json`. The server binds to `127.0.0.1` by default and can be stopped with Ctrl-C. Opening `public/index.html` directly with `file://` is not supported because the browser derives the WebSocket endpoint from the HTTP origin.

Useful options:

```bash
python -m md_monitor.server --port 9000 --interval 0.35
python -m md_monitor.server --host 127.0.0.1
python -m md_monitor.server --playback-mode accelerated
python -m md_monitor.server --playback-mode accelerated --repeat 100
```

The default bind address is `127.0.0.1`, so the dashboard is local-only unless you explicitly choose another host.

Playback defaults to `--playback-mode realtime`, which uses `--interval` (0.65
seconds by default, with the existing 0.1-second minimum). Accelerated playback
ignores `--interval`, omits wall-clock delays, and publishes as quickly as the
event loop and client backpressure allow. Use accelerated mode for local
diagnostics and bounded-memory checks, not for real-time simulation.

In both modes, the bounded deque remains the authoritative recent-frame history;
restart clears it and resets the sequence and validation state for a new run.
The input recording is still loaded in memory. The deterministic 1,000-frame
playback test measures bounded publication memory independently of that fixed
input.

`--repeat` lazily replays the fixed input without creating a repeated source
list. For example, `--repeat 100` turns the bundled 12-frame recording into a
1,200-frame accelerated stream while the producer's recent-frame deque remains
bounded to 28 frames. This is a local stress mode for checking retention and
backpressure, not a claim that the dashboard can simulate molecular dynamics at
that rate.

## Checks and integration tests

Run the Python trajectory/schema/reconnect/playback tests with:

```bash
python -m pytest
```

Run the producer transport disconnect/reconnect integration test:

```bash
python -m pytest tests/test_integration.py
```

Run the deterministic browser stream-parser recordings with:

```bash
node --test tests/stream_parser.test.mjs
```

Run the received-data RMSD convention and browser-export checks:

```bash
node --test tests/analytics.test.mjs tests/accessibility.test.mjs
```

The browser UI is served without a frontend build step. It uses the browser Canvas API for the molecular view and charts, and the Python `websockets` package for the local WebSocket server.

The **Stream continuity** panel reports observed protocol facts separately from
inferences: sequence gaps are gaps between accepted frame sequences; identical
duplicates are replay frames ignored by the client; reconnect resets and cursor
expiry come from server snapshot reasons; retained/capacity values come from the
client and metadata; estimated bounded-buffer drops are inferred from sequence
span and buffer bounds. These diagnostics do not infer server-side network
packet loss.

Controls have visible focus states and can be operated with Tab, Enter, and
Space. Outside text entry and native controls, the shortcuts are Space
pause/resume, `R` replay, `L` return to live inspection, and `E` export CSV.
On narrow screens, the frame table stays in a contained horizontal scroll area
and control/diagnostic cards wrap rather than widening the page.

## Received-data analytics

### RMSD assumptions

The dashboard calculates **raw, unaligned, equal-weight all-atom RMSD** in angstroms against sequence `0`:

```text
RMSD = sqrt(sum((x_i - x_i0)^2 + (y_i - y_i0)^2 + (z_i - z_i0)^2) / N)
```

Atom order and atom count are assumed to remain fixed by the stream schema. No translation removal, rotation/Kabsch fitting, atom matching, mass weighting, or periodic-boundary unwrapping is performed. Therefore, rigid-body translation or rotation contributes to the displayed RMSD. The molecular canvas may visually recenter the view, but that does not change the RMSD coordinates.

The producer includes frame `0` in metadata so late connections can calculate RMSD even after that frame leaves the bounded recent-frame buffer. If no validated reference is available, RMSD remains blank rather than silently using the first retained frame.

### Windows, summaries, and export

- The **plot window** selects all retained frames or the trailing 8, 16, or 28 frames.
- The **display point cap** deterministically downsamples only the plotted points while preserving the first and last point. It does not discard received data.
- Rolling summaries use every full-resolution retained frame in the selected window, not the downsampled display points. They show count, mean, min, max, and population standard deviation.
- **↓ CSV** exports every retained frame, including coordinates as JSON, source metrics, RMSD, units, run ID, and the `none` alignment label. It is not limited by the plot window or display cap.

The retained-data boundary is the server's bounded recent-frame buffer. Once a frame has left that buffer, the browser cannot export or summarize it from this local stream.

## Stream protocol and boundaries

The server exposes `ws://127.0.0.1:8765/ws`. Every message is an envelope with
`schema_version: 1` and a producer `run_id`. Frames use the formal
`md-progress-frame/v1` schema in `schemas/frame-v1.schema.json`. A frame has:

- a monotonic `sequence` cursor, equal to `index`;
- a strictly increasing `step` and simulation time;
- canonical UTC `timestamp`;
- coordinates for every declared atom;
- explicit canonical units: angstrom, femtosecond, kelvin, and kilojoule per mole.

A client receives:

- `metadata`: atom metadata, frame count, timestep, buffer limit, frame schema, units, `playback_mode`, and `interval_ms` (zero in accelerated mode);
- `snapshot`: the currently buffered frames when connecting or replaying. `mode` is `reset` for an initial connection or recovery, and `resume` when the requested cursor can be replayed from the bounded buffer;
- `frame`: each streamed frame, with `index`, `step`, `timestamp`, `time_fs`, `temperature_K`, `potential_energy_kj_mol`, and `positions`;
- `status`: `starting`, `running`, `paused`, or `complete`.

The handshake is ordered as `metadata`, `snapshot`, `status`. The server owns
transport state (`run_id`, cursor, bounded buffer, playback status); the client
owns validation, reconnect cursor persistence, display analytics, and CSV
export. A producer transport disconnect does not change a run by itself: when
the same producer/run reconnects, the client requests the suffix after its last
accepted sequence. A server restart or explicit replay creates a new `run_id`
and requires a reset.

| Message | Direction | Boundary |
| --- | --- | --- |
| `metadata` | server → client | Envelope/version, run identity, atom metadata, units, buffer limit, playback mode, and pinned reference frame 0. |
| `snapshot` | server → client | Initial/reset bounded history or resume suffix; includes `mode`, `reason`, `oldest_sequence`, and `latest_sequence`. |
| `frame` | server → client | One validated `md-progress-frame/v1` frame plus current buffer size. RMSD is not an incoming field. |
| `status` | server → client | Playback state and the producer's latest sequence/buffer size. |
| `error` / `pong` | server ↔ client | Protocol feedback and liveness response; errors do not become frames. |
| `pause`, `resume`, `restart`, `ping` | client → server | Control commands; the server applies them to the local replay producer. |

`schemas/frame-v1.schema.json` is the canonical static **frame** schema. It is
not a complete WebSocket-envelope schema. Stateful checks—sequence continuity,
duplicate steps, buffer cursor semantics, and message ordering—are implemented
by `md_monitor/schema.py`, `md_monitor/server.py`, and
`public/stream-parser.mjs`.

On reconnect the browser sends `?run_id=<last-run>&after=<last-accepted-sequence>`.
The server sends only the suffix after that cursor. If the cursor is outside the
bounded buffer, ahead of the producer, or from a previous run, it sends a reset
snapshot with a reason such as `cursor_expired`, `cursor_ahead`, or
`run_changed`. The browser validates each message and ignores identical duplicate
frames, so reconnect replay cannot double count frames.

The client can send `{"action":"pause"}`, `{"action":"resume"}`, or `{"action":"restart"}`. Selecting a row in the UI is client-side inspection and does not pause the producer.

Deterministic stream recordings used by the parser tests live in
`tests/recordings/stream-reconnect.json`; the Python WebSocket tests exercise the
same cursor cases against an ephemeral local server without wall-clock playback.

## Project origin and compatibility

The source idea for this local dashboard is **“Dashboard for tracking MD simulation progress with the new streaming interface (MDAnalysis)”** from Google Summer of Code 2026:

<https://summerofcode.withgoogle.com/programs/2026/projects/DzTMshtu>

That proposal is project inspiration/source context. This repository remains a
local, project-owned stream adapter and browser monitor; it does not claim to
implement IMDv3, an official MDAnalysis streaming interface, or a molecular
simulation backend.
