# PATCHLINE · FreeBSD rollout planner

PATCHLINE is a local, standalone planner for rehearsing a FreeBSD kernel and
package rollout across deterministic synthetic hosts. It does **not** connect
to FreeBSD machines, call `freebsd-update`, or change a kernel.

## Run locally

Because the browser module is loaded from `app.js`, serve the folder with any
static HTTP server:

```sh
python3 -m http.server 8000
```

Open <http://localhost:8000>. The demo data is persisted in `localStorage`.
Use **Reset demo** to restore the fixture.

## Included behavior

- Deterministic host ABI, kernel/KBI, dependency, reboot-window, and risk data.
- Stable dependency ordering across canary and production groups.
- Group orders must be unique integers; invalid priorities, concurrency limits,
  and negative/fractional/non-numeric soak durations are actionable blockers,
  never inputs that can move the clock backwards.
- Blocked prerequisites propagate to their dependents; a blocked canary cannot
  release production. Self-dependencies and other cycles are visible blockers.
- Explicit apply and reboot time ranges inside an editable same-day UTC window.
  An operation can finish exactly at window close, but no apply/reboot may run
  beyond it. The scheduler uses conservative wave barriers: independent hosts
  can share a wave, while changes on the same host are serialized.
- Hard blockers for incompatible release, architecture, ABI, KBI, and pending
  reboot conditions. Compatibility checks reflect every completed same-host
  change, so a prior upgrade cannot leave later checks using the original ABI.
  If an earlier change is needed to establish compatibility, it must also be an
  explicit prerequisite. The UI shows evaluated ABI/kernel/KBI at operation start.
- OpenSSL provider what-if selector with modern, legacy, and defer branches.
- Canary membership, gate status, and a single final soak/release time per group.
  Soak overflow is a blocker; later groups wait for the gate. Health outcomes and
  time passage are synthetic, not real monitoring or a wall-clock timer.
- All blockers and their available remediation are visible without truncation.
- Every rollback operation is listed in reverse dependency order, with reboot
  requirements and alternative boot-environment/package recovery methods.
- Partial failure rehearsal preserves successful and unstarted hosts. Failed-wave
  rollback is confined to the actual failing wave and includes only changed
  operations; earlier healthy waves are not silently rolled back.
- A nonhalting simulation continues only unaffected dependency paths; a later
  healthy operation cannot erase a previous failure from the same host.
- JSON export/import containing both the source model and derived plan.

## Tests

```sh
npm test
```

The Node built-in test suite covers dependency ordering (including shuffled
inputs and cycles), incompatible ABI at window close, exact-fit and overrun
reboots, projected compatibility, conflict branching, canary gates and soak,
partial failure state preservation, and reverse/wave-scoped rollback.

### Full browser and syntax checks

```sh
node --check app.js
node --check src/planner.js
node --check test/browser-smoke.mjs
BROWSER_SMOKE=1 npm test
```

The browser test is opt-in and serves the actual application on an ephemeral
loopback port. It verifies boundary ABI blockers, repeat recalculation, canary
release/soak details, rollback, JSON download/import/persistence, invalid imports,
escaping, responsive layouts, and absence of page errors. It never replaces or
stubs the planner. Plain `npm test` skips the browser case.

Playwright and Chromium are required only for this opt-in check, not the app.
The current container's existing Playwright install is used by default; on
another machine set `PLAYWRIGHT_MODULE` to an absolute Playwright ESM entry path
and, if needed, `BROWSER_EXECUTABLE` to the Chromium binary. No browser/test
dependencies are required at runtime by the planner itself.

The default 02:00–04:00 UTC demo intentionally exposes ABI and window blockers.
Extend the window end to 06:00 to inspect more of the ordered production flow;
the incompatible legacy host remains blocked. This is a conservative planning
model, not a FreeBSD live-patching compatibility guarantee.
