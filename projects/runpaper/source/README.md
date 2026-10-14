# Runpaper

Runpaper is a small, local Flask/matplotlib research-run comparison browser
workbench. It makes experiment logs easy to inspect and turns recorded values
into repeatable charts without a database or hosted service. This is an
independent, scoped experiment-publication workbench—not an official Visdom,
FOSSASIA, or Google Summer of Code implementation.

The bundled runs are **synthetic illustrative data**. They demonstrate the
interface and file format; they are not real training logs, measurements, or
scientific findings.

## Setup and start

Requirements: Python 3.10 or newer with the `venv` module available. The
shortest setup is:

```bash
python app.py
```

On first start, the app creates `.venv` and installs `requirements.txt` if
dependencies are missing. Once it is running, open <http://localhost:8000>.
For a manual setup:

```bash
python -m venv .venv && .venv/bin/pip install -r requirements.txt
```

Run the calculation and API tests with:

```bash
.venv/bin/python -m unittest discover -s tests -v
```

## Input formats

Each run is a pair of files with the same basename:

```text
examples/
├── baseline.csv    ── baseline.json
├── cosine.csv      ── cosine.json
└── warmup.csv      ── warmup.json
```

### CSV

The first column must be `step`. Every remaining column must be declared in the
sidecar JSON's `metrics` object.

```csv
step,val_loss,accuracy
0,2.3026,10.000
1000,2.1727,16.643
2000,2.0486,22.591
```

Steps must be finite numbers and nondecreasing. A missing or non-finite step is
always invalid. Metric values must be finite numbers unless missing values are
allowed for that run. An allowed blank metric cell is represented as JSON
`null`; it remains a gap and is never interpolated or extrapolated.

The engine API defaults to strict normalization:

```python
run = core.load_run(csv_bytes, metadata_bytes)
```

The optional arguments are:

- `allow_missing=False`: set to `True` to accept blank metric cells. Missing
  steps and `NaN`/`Inf` in either steps or metrics remain invalid.
- `duplicate_steps="error"`: the default rejects adjacent duplicate steps.
  `duplicate_steps="last"` is also supported. It keeps the entire last row,
  including its `null` metric cells. A decreasing step is always rejected.

The public run representation records normalization in `normalization`:
`allow_missing`, `duplicate_steps`, `duplicates_collapsed`, and `source_rows`.
Raw public summaries include `first`, `last`, `min`, `max`, `delta`, `count`,
`final`, `best`, `final_step`, and `best_step`. `count` excludes missing values.
These summaries use the normalized rows after duplicate collapse. `first` and
`last` are the first and last measured values, and `delta` is last minus first.
`final` is the last measured value by step. `best` follows the metric direction
(`min` or `max`), and equal best values use the earliest step. An all-missing
metric has null value fields and `count: 0`.

### JSON metadata

The sidecar identifies the run and describes each metric:

```json
{
  "id": "baseline",
  "name": "Baseline",
  "description": "Synthetic illustrative baseline.",
  "seed": 101,
  "dataset": "CIFAR-10",
  "model": "ResNet-18",
  "parameters": {
    "optimizer": "adam",
    "learning_rate": 0.001,
    "weight_decay": false
  },
  "metrics": {
    "val_loss": {
      "label": "Validation loss",
      "unit": "nats",
      "direction": "min"
    },
    "accuracy": {
      "label": "Accuracy",
      "unit": "%",
      "direction": "max"
    }
  }
}
```

`id`, `name`, and `metrics` are required. Each metric requires `label`,
`unit`, and `direction`, where direction is `min` or `max`. Units are used to
keep incompatible panels separate; Runpaper does not convert units.

`seed`, `dataset`, and `model` are standard parameter metadata. Custom
`parameters` must be a flat JSON object whose values are scalar JSON values
(strings, numbers, booleans, or null). Nested objects and arrays are not part
of the reproducible parameter schema.

The bundled examples each have 31 numeric observations at steps 0, 1000, ...,
30000 for validation loss (nats, minimize), accuracy (percent, maximize), and
step time (milliseconds, minimize). Their example dataset is CIFAR-10 and their
example model is ResNet-18.

## Comparison and alignment

The calculation API is:

```python
comparison = core.compare_runs(
    runs,
    metrics,
    alignment="independent",
)
```

The default is `independent`: each run keeps its own recorded step array.
The browser also defaults to Independent. Its alignment selector supports:

- **Independent** — each series uses its own recorded steps.
- **Intersection** — for each metric/unit panel, use only exact step values
  recorded by every participating run. Blank cells are still recorded steps,
  so they participate in the grid. The result can have zero common steps.
- **Union** — use the union of all recorded steps. A run has `null` at a step
  it did not record; those cells remain gaps.

Alignment is exact step matching. Runpaper performs no interpolation,
extrapolation, nearest-step matching, or row-index matching. A run that
declares the selected metric participates even when every value is missing. A
run that does not declare that metric is skipped for that metric. Metrics with
different units form separate panels.

`compare_runs` returns `alignment`, `panels`, and
`summaries[metric_key][run_id]`, plus `assumptions` and `duplicate_policy`.
Panels contain the metric, unit, label, aligned `steps`, per-run `series`, and
an explicit `empty` flag. Each series includes `run_id`, `name`, `run_index`,
aligned `steps`, aligned `values`, its aligned summary, and parameter metadata.

Comparison summaries are calculated from the aligned values. They can therefore
differ from the public raw summaries shown by `public_run`, especially for
intersection comparisons. Union inserts null gaps without adding measurements,
so its nonmissing summary values match the raw normalized summaries.
Empty aligned series have null summary
fields and `count: 0`.

The browser import workflow uses `allow_missing=True` for imported CSVs. The
duplicate-step selector offers `error` and `last`; strict error
handling remains the engine default. The browser's alignment selector offers
Independent, Intersection, and Union and explains that intersection means
exact shared recorded steps.

## SVG plots and exports

`render_svg(..., alignment="independent")` uses the same alignment calculation.
Missing values create visible plot gaps. Empty panels are retained and
explicitly annotated rather than silently omitted.

`build_export(..., alignment="independent")` creates a deterministic ZIP with:

- `figure.svg`, the generated SVG;
- `figure.tex`, a standalone LaTeX figure wrapper with an escaped caption and
  escaped run/metric labels (including `# $ % & _ { } ~ ^` and backslashes);
- `manifest.json`, including plot alignment and rendering settings, software
  versions, source and artifact hashes, and per-run normalization metadata;
- `comparison.json`, the exact plotted arrays (including null gaps), aligned
  summaries, selected metadata, metric definitions, and assumptions;
- `REPRODUCE.md`, with extraction and reproduction instructions; and
- `sources/<run-id>/`, containing the exact original CSV and JSON bytes.

Click **Preview export** before saving. The review dialog shows the exact exported
SVG, file names and sizes, selected runs/metrics, alignment, and assumptions.
Expandable sections let you inspect the plotted data and metadata, LaTeX, and
manifest. **Save ZIP** uses the selection captured by that preview, not any later
changes to the controls. Preview generation stays in memory and writes no files.

ZIP entry timestamps and order are fixed, JSON is canonicalized, and SVG IDs
are deterministic. Unchanged inputs and settings produce byte-identical bundles
in the same project location and software environment. Software/font/platform
changes can affect SVG bytes; exports record the environment rather than claiming
cross-environment byte equivalence.

`figure.tex` uses the LaTeX `svg` and `caption` packages. SVG inclusion normally
requires Inkscape and compilation with `--shell-escape`; the app does not compile
LaTeX. You can also copy its `minipage`/`includesvg`/caption portion into a paper
that loads those packages.

The manifest records SHA-256 hashes for each original source, SVG, LaTeX,
comparison, and reproduction instructions. Reproduction verifies those hashes,
reloads the original sources with
their recorded normalization settings, uses the recorded plot alignment, and
checks the generated figure hash. Older manifests without an alignment field
reproduce with the legacy defaults: strict normalization and independent
alignment.

To reproduce an extracted export:

```bash
.venv/bin/python core.py reproduce path/to/manifest.json --output reproduced.svg
```

Run this from the Runpaper project with its dependencies installed. The archive
contains data and artifacts; `REPRODUCE.md` identifies the project's `core.py`
entry point. Exact SVG hashes depend on the recorded software versions.
The command does not start training or retrieve data from a network.

## Tests

```bash
.venv/bin/python -m unittest discover -s tests -v
```

The focused alignment contract tests can be run with:

```bash
.venv/bin/python -m unittest discover -s tests -p test_alignment.py -v
```

Runpaper keeps imports local and in memory. It does not claim access to live
training, real scientific findings, or an external experiment tracker.

## Inspiration

Runpaper was inspired by the following source idea:

> [Publication & Reproducibility Suite for Visdom: From Experiment Tracking to Paper-Ready Outputs](https://summerofcode.withgoogle.com/programs/2026/projects/dkDLJ2XY)
> (FOSSASIA)

This is a source-idea reference only; Runpaper is not affiliated with that
project, FOSSASIA, Google Summer of Code, or its authors.
