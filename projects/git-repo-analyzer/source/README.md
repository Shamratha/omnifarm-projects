# Git repository analyzer

`git-repo-analyzer` inspects a local Git object database and predicts the
objects needed by common workflows. It is intentionally read-only and local:
it never runs `fetch`, `clone`, `pull`, `ls-remote`, or a URL-based Git
command, and disables Git's lazy-fetch behavior for every plumbing call.

## Commands

```bash
git-repo-analyzer inspect --repo ./repo --format text
git-repo-analyzer analyze --repo ./repo --workflow checkout --rev HEAD \
  --path src --format json --output report.json
git-repo-analyzer simulate --repo ./repo --commit HEAD --path src
git-repo-analyzer compare --repo ./repo --rev HEAD --path src
```

`analyze` supports `checkout`, `log`, `diff`, and `merge`. A report includes
the required/present/missing object sets, object-type cost, sparse-checkout
decisions, shallow-history status, promisor configuration, and pack/object
statistics. `simulate` is a report-only fetch simulation: it prints a stable
plan of missing object IDs and never performs the fetch. `compare` evaluates
`full`, `sparse`, `blobless`, and `treeless` object strategies using the same
local inventory and shows normalized initial, deferred, and locally-missing
costs for each strategy. Object byte totals are logical bytes; `transfer_bytes`
is `null` because future server-side pack compression is not knowable from a
local repository. Pack statistics distinguish unique local objects from
physical pack entries and report pack/index bytes explicitly.

Comparison is scoped to the enumerated checkout snapshot, **not** unseen
history or an entire remote clone. `full` retains its complete snapshot;
`sparse` retains the requested path closure (including its blobs, subject to
active sparse patterns); `blobless` defers blobs; `treeless` defers trees and
blobs. The `sparse` projection is an object-set model, not a claim that ordinary
Git sparse checkout filters network transfer.

Each strategy's `cost.initial` and `cost.deferred` include an object count,
zero-filled type counts, known logical bytes, and unknown-size counts.
`cost.local_missing` is the separate cost to satisfy requirements from the
actual local database. Initial plus deferred counts equal enumerated required
counts; all type counts reconcile, including missing objects whose types are
known from tree entries. These counts are lower bounds when a missing tree
prevents descendant enumeration (see `requirements.unknown_frontier`).

Normalized pack statistics live under `statistics.pack.objects` (unique OIDs
and mutually exclusive storage counts) and `statistics.pack.packs` (physical
pack/index bytes and entry counts). `packed_by_type` and `loose_by_type`
include objects present in both stores; those totals may overlap. Legacy
`count_objects` retains Git's native counters; its `size`, `size-pack`, and
`size-garbage` fields use **KiB**, not bytes.

Omitting `--path` uses all paths or the active sparse patterns. An empty active
sparse pattern file selects no paths; an explicit `--path ""` is rejected.
A shallow boundary blocks a full-history query, but not a checkout or a
bounded query that has already collected the requested number of commits.

Known missing byte totals are deliberately conservative. An object that is
absent locally has no trustworthy future pack size, so the report also shows
the count of missing objects whose size is unknown. JSON output is sorted and
contains `"network_attempted": false`.

## Development

```bash
python -m pytest
python -m git_repo_analyzer.cli inspect --repo .
```

The promisor edge-case integration tests in `tests/test_promisor_edges.py`
construct real local `.promisor` packs with absent blobs/trees and a shallow
boundary; no clone or fetch is used to create the fixtures. A non-networking
transport helper acts as a trap for implicit lazy-fetch attempts. Analyzer
subprocesses disable all transport protocols as defense in depth, including
on Git versions that do not honor `GIT_NO_LAZY_FETCH`.

The suite checks sparse negation/exclusion, missing-tree enumeration limits,
independent history and missing-object diagnostics, and byte-identical JSON
and text exports from separate CLI processes for `simulate`, `analyze`, and
`compare`. Determinism is for an unchanged repository at the same path;
reports intentionally retain their repository path.
