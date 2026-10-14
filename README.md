# Omnifarm project publication

This repository is a clean review index for eleven completed Omnifarm sessions. Each entry binds one project name to its session ID, shipped funnel record, verifier summary, replay-quality level, and static QC preflight result.

The public repository intentionally excludes raw conversation archives, debug logs, temporary Docker workspaces, credentials, tokens, private keys, and full server snapshots. Those remain in the controlled build environment and are referenced by package name only.

## Projects

| Project | Session ID | Funnel | Replay level | Replay pass rate | Verifier errors | Static QC |
|---|---|---:|---|---:|---:|---|
| [a11y-localization-dashboard](projects/a11y-localization-dashboard/summary.json) | session ses_ec9bbcafdffeFHz73fZBnqEdq4 | shipped=1 | level none | 0.333 | 0 | passed (incomplete coverage) |
| [data-completeness-observatory](projects/data-completeness-observatory/summary.json) | session ses_ec9c28439ffeAHI9QXl0zPhGAf | shipped=1 | level R | 1.0 | 0 | passed (incomplete coverage) |
| [expense-dashboard](projects/expense-dashboard/summary.json) | session ses_ec9bf07f7ffeAha0aQwKdQGd0u | shipped=1 | level S | 0.0 | 0 | passed (incomplete coverage) |
| [fhir-resource-explorer](projects/fhir-resource-explorer/summary.json) | session ses_ec9c1aad7ffeWmd3qQ2WkTMh7o | shipped=1 | level S | 0.8 | 0 | passed (incomplete coverage) |
| [pr-maintenance-dashboard](projects/pr-maintenance-dashboard/summary.json) | session ses_ec9b5fbd0ffeTnSUWESNk5n1Dd | shipped=1 | level R | 1.0 | 0 | passed (incomplete coverage) |
| [spectrum-occupancy-dashboard](projects/spectrum-occupancy-dashboard/summary.json) | session ses_ec9be2f81ffeMeCXhRlupXyZID | shipped=1 | level S | 0.833 | 0 | passed (incomplete coverage) |
| [incident-timeline](projects/incident-timeline/summary.json) | session ses_eca1f6ba2ffeqcR5NQOgH0EB5k | shipped=1 | level S | 0.4 | 0 | passed (incomplete coverage) |
| [snapshot-storage-dashboard](projects/snapshot-storage-dashboard/summary.json) | session ses_ec9bf019fffeqkS582CrxMvhjS | shipped=1 | level R | 1.0 | 0 | passed (incomplete coverage) |
| [packet-trace-dashboard](projects/packet-trace-dashboard/summary.json) | session ses_ec9bd9beaffesMlj7TPZtfVH0O | shipped=1 | level R | 1.0 | 0 | passed (incomplete coverage) |
| [binary-analysis-workbench](projects/binary-analysis-workbench/summary.json) | session ses_ec9c16e6fffemAfbORZNQUo8RM | shipped=1 | level none | 1.0 | 0 | passed (incomplete coverage) |
| [kernel-rollout-dashboard](projects/kernel-rollout-dashboard/summary.json) | session ses_ec9bfe8f9ffeRCiy1ilNf5x6I8 | shipped=1 | level S | 0.667 | 0 | passed (incomplete coverage) |

## Reading an entry

summary.json contains derived, review-safe status and quality metadata. package-index.json lists the controlled package's key source artifacts without copying private/raw traces into GitHub. A shipped funnel record means the package passed the Omnifarm packaging funnel. Replay levels are reported as produced by the verifier and are not claims that every replay is strict or fully deterministic.

## Provenance

The source packages were prepared on the designated remote build server. This repository is a publication index, not a replacement for the controlled trace archive.
