# SignalForge · Timing Closure Explorer

SignalForge is a local, browser-only timing-closure analysis prototype inspired by the OpenROAD GUI. It ships with a normalized demo snapshot for placement, clock, net, congestion, and timing reports so the interface is useful without a backend or chip compiler.

## Run it

```bash
npm test
npm start
```

Then open <http://localhost:4173>.

The app is intentionally dependency-free at runtime. The bundled reports are in `src/data.js`; domain calculations and deterministic what-if modeling are in `src/model.js`.

## What is included

- Overview KPIs for setup/hold WNS, TNS, violating endpoints, and route overflow.
- Worst-path table with clock domain, logic/net delay, endpoint, and reason.
- Slack distribution and ranked congestion hotspot views.
- Simplified physical die view with placement, critical nets, clock overlay, and hotspot correlation.
- Clock health for `clk_core`, `clk_bus`, and `clk_dbg`.
- What-if lab with immutable baseline and deterministic resize, placement, clock-skew, and constraint candidates.
- Sign-off report view with provenance, stale report detection, HTML/JSON/CSV export, and print/PDF.
- Tests for multi-clock paths, false paths, negative-slack ties, histogram boundaries, deterministic fixes, and stale report detection.

This prototype labels modeled numbers as **MODELED** and does not claim to run extraction, OpenSTA, DRC, LVS, or routing.
