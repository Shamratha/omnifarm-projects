# Final sparse/promisor verification

## Local fixture

The integration fixture uses two local commits, real `.promisor` pack files,
and two absent promised blobs. `HEAD` is a shallow boundary. Sparse patterns
include `src` and exclude `src/local.py`. No remote repository is used.

The transport trap was untouched across all checks, including subprocess
exports. Missing promised objects remain absent after analysis; simulation
does not fetch them.

## Checks run

- `python -m pytest -q tests/test_promisor_edges.py`: **6 passed**.
- `python -m pytest -q`: **24 passed**.
- `python -m compileall -q git_repo_analyzer tests`: passed.

Independent CLI processes exported `simulate`, `analyze`, and `compare` in
JSON and text formats. Both exports for each command/format were read back
and verified byte-identical, including matching SHA-256 hashes. Temporary
exports are test artifacts, not permanent repository examples.

## Verified strategy totals

Snapshot-scoped costs, requesting `src/main.py`:

| Strategy | Initial objects | Deferred objects | Locally missing objects |
| --- | ---: | ---: | ---: |
| full | 7 | 0 | 2 |
| sparse | 4 | 0 | 1 |
| blobless | 4 | 3 | 2 |
| treeless | 1 | 6 | 2 |

All required/present/missing type counts reconcile. Initial plus deferred
objects equal enumerated requirements. Unknown-size totals account for the
missing objects. Predicted transfer bytes remain `null`.

## Boundary behavior

- A sparse checkout requiring the absent blob reports `incomplete` and
  `promisor_fetch_required` without a fetch.
- Sparse-excluded promised blobs do not add a fetch requirement.
- A missing promised tree reports an unknown descendant frontier rather than
  silently claiming completeness.
- Full path/patch history reports both `promisor_fetch_required` and
  `shallow_history_boundary_reached`; history remains `indeterminate`.
- Depth-one history at the shallow boundary has complete history scope but
  still reports a missing blob when patch contents are required.
- Metadata-only depth-one history is complete without requiring a blob.
- Reachability keeps the referenced `HEAD` reachable despite missing leaves.

No lint or static typecheck runner is configured in this project.
