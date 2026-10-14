# Rover Lab — local policy replay inspector

A browser-based viewer for **recorded synthetic rover simulations**. No robot APIs, hardware connections, live control, accounts, telemetry, or remote data requests. Bundled fixtures and all analysis run locally in the browser. Built with React, TypeScript, Vite, SVG, and Lucide icons.

## Run locally

Requires Node.js 22.12 or newer and npm.

```sh
npm ci
npm run dev
```

Open **http://localhost:5173**. The server binds to all interfaces for container previews; to bind only to loopback, run `npm run dev -- --host 127.0.0.1`.

For a production preview:

```sh
npm run build
npm run preview
```

The generated `dist/` directory is a static site. Once dependencies are installed, building and viewing require no internet access. There are no externally hosted fonts or assets.

## Inspect a run

- **Choose a policy:** PPO v2.4, SAC v1.8, or the rule-based baseline.
- **Scrub or play:** map position, sensor snapshot, observation age, and per-frame reward stay synchronized. Step one 500 ms frame at a time or play at 0.5×, 1×, or 2×.
- **Trace each decision:** the observation → decision ledger shows the action, exact observation timestamp, delay in milliseconds, clearance, contact state, reward, and safety flags for every recorded frame. The selected-action detail connects the observation timestamp to the decision timestamp and lists the rule evidence. The ledger scrolls to the selected frame without moving the page.
- **Timing labels:** simulation timestamps in the ledger and evidence cards use millisecond precision (for example, `23.100 s` observation → `24.000 s` decision = `900 ms` delay). Exactly 500 ms while moving is within the timing limit; only greater delays are flagged. A stale observation while stationary remains visible but is not a moving-delay violation.
- **Investigate:** the first-unsafe-action panel explains the earliest violation and jumps directly to its frame. Map waypoints and timeline event markers also seek to their recorded frames.
- **Read the evidence:** the first-unsafe panel now uses larger timestamps, labeled observation/decision/age/contact cards, explicit severity labels, and a large jump button. It stays pinned to the first unsafe frame, while the selected-action explanation below the ledger follows playback and displays larger per-rule evidence. Playback controls sit directly under the map so the enlarged evidence does not push them out of reach.
- **Inspect collisions:** collision markers on the map are larger, labeled, keyboard-focusable targets. Clicking or pressing Enter/Space on one seeks the corresponding frame and updates the decision ledger and explanation. Contact evidence is shown separately from delayed-observation evidence; co-occurrence does not prove causation.
- **Adjust the map:** toggle comparison paths and sensor clearance footprint under Layers; expand the map for a closer look.
- **Compare:** inspect the reward-ranked table and cumulative reward chart. Completion and safety have independent labels: the baseline is partial and unsafe; PPO reaches every goal but is unsafe; SAC succeeds. Select a policy to see goals remaining, per-rule counts, critical/warning counts, minimum clearance, maximum observation age, frame count, and duration. The first-unsafe link or **Open replay evidence** opens the correct policy and frame.
- **Recognize partial completion:** unfinished recorded runs show a prominent Partial completion banner with the completed/total goal count, an accessible progress indicator, goals remaining, and a separate safety status. Partial badges in the comparison table and the selected policy's completion card are larger and do not imply safety or success.
- **Review events:** filter contact, delayed-observation, or clearance events. Select a row to return to that exact replay frame.
- **Export:** download `rover-lab-warehouse-seed-18427.json`, containing the scenario, analysis rules, full summaries, ranking, per-unsafe-frame decision evidence, goals, and full frame/reward traces for all policies. The comparison view provides an **exact JSON preview** and a download action; the top-level export produces the same bytes from any tab.

## Bundled scenario and semantics

`src/lib/replay.ts` holds the typed fixtures and pure analysis functions. All three policies use the same 100 × 70 m warehouse, static obstacles, start position, goals, and seed label (18427). Fixtures are deterministic waypoint-interpolated recordings, not the output of trained policy inference. The seed identifies this scenario; no stochastic simulator runs in the viewer.

Each policy has 121 frames, from 0 to 60 seconds at 2 Hz. Coordinates use a top-down map convention (increasing y points downward). Velocity is derived from consecutive recorded positions, and steering is a normalized heading-change sample. The sensor footprint visualizes clearance, not an emulated lidar scan.

Safety rules:

1. **Contact:** any recorded obstacle contact is critical, including while stopped. Obstacle boundaries count as occupied. Contact counts are **contact frames**, not distinct collision episodes.
2. **Delayed observations:** observation age **greater than** 500 ms while moving is a warning. Exactly 500 ms and stale observations while stationary are not violations.
3. **Clearance:** distance **below** 2 m to an obstacle is a warning; exactly 2 m is allowed. Geometry models the rover as a point, not a physical footprint.

The first unsafe action is the earliest flagged frame, ordered by simulation time and then frame index. Within that frame, contact is listed before observation-age and clearance warnings. Multiple rule violations at the same frame are counted separately. `unsafeFrames` counts distinct affected frame indices; `contacts` counts contact frames, not collision episodes. `eventCounts` breaks down contact, moving-delay, and low-clearance flags. Critical events are contacts; delay and clearance events are warnings. Maximum observation age includes stationary frames, even though stale observations while stationary do not trigger moving-delay flags. Empty recordings have `no-data` safety, null minimum clearance / maximum age, and cannot count as successful.

Explanations describe recorded evidence and violated rules, not inferred policy intent or a proven causal link between delayed observations and contact. The completion numerator is the recorded run's `completedGoals`, not a count of repeated visits or independently inferred deliveries. `remainingGoals` and the complete / partial / not-started / no-goals label are based on that recorded metadata.

PPO and the baseline contact the first obstacle at 24 seconds. PPO also has a 900 ms observation delay at that frame. SAC completes all three goals without violations. The baseline reaches only two goals. A successful run must complete all goals **and** have no safety events.

Rewards are undiscounted sums of deterministic progress, goal-bonus, and contact-cost samples. Higher reward is not proof of safety. The table, curve endpoints, summary cards, and report share chronological Neumaier compensated reward summation to retain small rewards alongside large costs. Ranking uses the full-precision total reward; exact ties share competition ranks (1, 1, 3) with policy IDs providing stable, locale-independent display order. Displayed rewards round to two decimals; two values that round alike are not necessarily tied. Policy IDs must be unique; ambiguous duplicate IDs are rejected.

## Deterministic reports

Reports retain schema version 1 with additive inspection fields. Their ordering contract is:

- `summaries` and `traces`: policy ID ascending, using locale-independent string comparison.
- `ranking`: unrounded total reward descending, then policy ID; exact ties share competition rank.
- Trace frames and unsafe-frame evidence: simulation time ascending, then frame index. Duplicate frame indices within a policy are rejected instead of merging unrelated evidence. Different policies may reuse the same local frame indices.
- Goal catalogs: goal ID ascending, using the same locale-independent comparison as policies and ranking ties. Duplicate goal IDs within a policy are rejected instead of relying on their input array order; different policies may share waypoint IDs.
- Events within each frame: contact, stale-observation, clearance. Explicit rule priority preserves this order independently of the order rules are evaluated. Frame time and index take precedence over rule priority when several frames share a timestamp.
- Object fields: explicit schema projection in stable order. Extra unrecognized frame/goal fields are not exported.

Every summary includes completion counts and state, safety state, per-rule and severity counts, unsafe-frame count, contact-frame count, extrema, duration, frame count, and first unsafe event. Each unsafe frame has one evidence entry containing its linked observation/decision timing, action, steering, readings, reward, and **all** rules flagged at that frame. Complete raw traces remain available to independently inspect other frames. Comparison ranking entries carry completion and safety details as well as reward and rank.

Reports use fixed analysis rules, two-space JSON indentation, and a trailing newline. No wall-clock time, random identifiers, current tab, selected policy, filter, or scrub position is included. Exports are byte-identical for equivalent data even if policy, goal, or frame arrays, or input object key insertion order, differ. This is deterministic serialization, not a cryptographic signature or a claim of real-robot safety.

## Checks

```sh
npx vitest run src/lib/evidence-focus.test.ts src/lib/inspection-report.test.ts # 16 focused checks
npm test                  # 37 analysis, comparison, fixture, and report tests
npm run build             # TypeScript check and production bundle
npm audit                 # Dependency vulnerability check
npx playwright install --with-deps chromium  # Once, for browser tests
npm run test:e2e           # 6 Chromium user-flow tests
```

Unit coverage includes strict delayed-observation boundaries, stationary stale readings, stopped contact violations, co-occurring rules versus distinct unsafe frames, safe/unsafe partial completion, no-data behavior, exact ties and rounded near-ties, chronological compensated sums, canonical report ordering under array/key permutations, immutable analysis, full unsafe-frame evidence, aligned chart/report metrics, and fixture consistency.

`src/lib/evidence-focus.test.ts` specifically protects delay-only exported evidence, stopped contact with completed goals, exact reward ties with different safety/completion states, chronological frame/rule ordering at simultaneous timestamps, rejection of duplicate local identities, and locale-independent policy/goal ordering (including mixed-case and accented IDs). The readability browser regression checks minimum evidence text sizes, a 44px-or-larger jump target, pinned versus selected evidence, explicit partial/safety states, accessible goal progress, and mobile overflow.

Browser tests exercise playback/stepping, first-failure seeking, sensor synchronization, policy switching, stable comparison order and metrics, partial/unsafe labels, comparison-to-replay evidence links, event filtering, exact JSON preview/download equality, byte-identical exports after policy/playback/filter/tab changes, absence of external requests, and the mobile comparison/report layout. Browser coverage is Chromium only; no separate lint command is configured.
