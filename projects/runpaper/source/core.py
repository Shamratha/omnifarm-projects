"""Core data engine for the experiment workbench.

The module intentionally has no Flask dependency: it provides the stable data,
plot, export, and reproduction API used by a browser-facing application.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import math
import os
from pathlib import Path
import platform
import re
import shlex
import sys
from typing import Any, Iterable
import zipfile


SCHEMA_VERSION = 1
_DEFAULT_LOAD_OPTION = object()
PALETTE = ("#6754d7", "#19a591", "#e9a345", "#dc6881", "#6694d6")
_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


def _error(message: str) -> ValueError:
    return ValueError(message)


def _safe_filename(value: str, field: str) -> str:
    if not isinstance(value, str) or not value or len(value) > 128:
        raise _error(f"{field} must be a non-empty filename of at most 128 characters")
    if value in {".", ".."} or "/" in value or "\\" in value or "\x00" in value:
        raise _error(f"{field} must be a safe filename without path traversal")
    if any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise _error(f"{field} contains a control character")
    if Path(value).name != value:
        raise _error(f"{field} must not contain a path")
    return value


def _safe_identifier(value: str, field: str) -> str:
    if not isinstance(value, str) or not _IDENTIFIER.fullmatch(value):
        raise _error(
            f"{field} must be 1-128 characters using letters, numbers, '.', '_' or '-'")
    return value


def _finite_number(value: Any, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise _error(f"{field} must be a finite number")
    try:
        number = float(value)
    except OverflowError as exc:
        raise _error(f"{field} must be a finite number") from exc
    if not math.isfinite(number):
        raise _error(f"{field} must be a finite number")
    return number


def _json_number(value: float) -> int | float:
    return int(value) if value.is_integer() else value


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _canonical_json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode(
        "utf-8"
    )


def _source_run_hash(csv_bytes: bytes, metadata_bytes: bytes) -> str:
    digest = hashlib.sha256()
    digest.update(len(csv_bytes).to_bytes(8, "big"))
    digest.update(csv_bytes)
    digest.update(len(metadata_bytes).to_bytes(8, "big"))
    digest.update(metadata_bytes)
    return digest.hexdigest()


def _metadata(metadata_bytes: bytes) -> dict[str, Any]:
    try:
        value = json.loads(metadata_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise _error(f"metadata JSON is invalid: {exc}") from exc
    if not isinstance(value, dict):
        raise _error("metadata must be a JSON object")
    required = {"id", "name", "metrics"}
    missing = sorted(required - value.keys())
    if missing:
        raise _error(f"metadata is missing required field(s): {', '.join(missing)}")
    _safe_identifier(value["id"], "metadata.id")
    if not isinstance(value["name"], str) or not value["name"].strip() or len(value["name"]) > 200:
        raise _error("metadata.name must be a non-empty string of at most 200 characters")
    if any(char in value["name"] for char in ("/", "\\", "\x00")):
        raise _error("metadata.name must not contain a path")
    if any(ord(char) < 32 or ord(char) == 127 for char in value["name"]):
        raise _error("metadata.name contains a control character")
    for optional in ("description", "dataset", "model"):
        if optional in value and not isinstance(value[optional], str):
            raise _error(f"metadata.{optional} must be a string")
    if "seed" in value:
        _finite_number(value["seed"], "metadata.seed")
    if "parameters" in value:
        _validate_parameters(value["parameters"], "metadata.parameters")
    metrics = value["metrics"]
    if not isinstance(metrics, dict) or not metrics:
        raise _error("metadata.metrics must be a non-empty object")
    for key, definition in metrics.items():
        _safe_identifier(key, f"metadata metric key {key!r}")
        if key == "step":
            raise _error("metadata.metrics cannot declare reserved key 'step'")
        if not isinstance(definition, dict):
            raise _error(f"metadata.metrics.{key} must be an object")
        for field in ("label", "unit", "direction"):
            if field not in definition:
                raise _error(f"metadata.metrics.{key} is missing {field}")
        if not isinstance(definition["label"], str) or not definition["label"].strip():
            raise _error(f"metadata.metrics.{key}.label must be a non-empty string")
        if not isinstance(definition["unit"], str):
            raise _error(f"metadata.metrics.{key}.unit must be a string")
        if definition["direction"] not in {"min", "max"}:
            raise _error(f"metadata.metrics.{key}.direction must be 'min' or 'max'")
    return value


def _validate_parameters(value: Any, field: str) -> None:
    """Validate a flat object of finite JSON scalars (no arrays or objects)."""
    if not isinstance(value, dict):
        raise _error(f"{field} must be an object")
    for key, item in value.items():
        if not isinstance(key, str):
            raise _error(f"{field} keys must be strings")
        if isinstance(item, bool) or item is None or isinstance(item, str):
            continue
        elif isinstance(item, (int, float)) and not isinstance(item, bool):
            _finite_number(item, f"{field}.{key}")
        else:
            raise _error(
                f"{field}.{key} must be a finite JSON scalar (no arrays or objects)"
            )


def _validate_load_options(allow_missing: bool, duplicate_steps: str) -> None:
    if not isinstance(allow_missing, bool):
        raise _error("allow_missing must be a boolean")
    if not isinstance(duplicate_steps, str) or duplicate_steps not in {"error", "last"}:
        raise _error("duplicate_steps must be 'error' or 'last'")


def _duplicate_policy(duplicate_steps: str) -> str:
    if duplicate_steps == "last":
        return "last duplicate row wins (the entire row, including blanks)"
    return "duplicate steps are rejected"


def _csv_rows(
    csv_bytes: bytes,
    metadata: dict[str, Any],
    *,
    allow_missing: bool,
    duplicate_steps: str,
) -> tuple[list[dict[str, float | int | None]], int, int]:
    try:
        text = csv_bytes.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise _error(f"CSV is not valid UTF-8: {exc}") from exc
    if not text.strip():
        raise _error("CSV has no data")
    try:
        reader = csv.reader(io.StringIO(text, newline=""), strict=True)
        try:
            header = next(reader)
        except StopIteration as exc:
            raise _error("CSV has no header") from exc
    except csv.Error as exc:
        raise _error(f"CSV cannot be parsed: {exc}") from exc
    if not header or any(not column for column in header):
        raise _error("CSV header contains an empty column")
    if len(header) != len(set(header)):
        raise _error("CSV header contains duplicate columns")
    expected = ["step", *metadata["metrics"].keys()]
    if header[0] != "step":
        raise _error("CSV must start with a 'step' column")
    missing = [column for column in expected if column not in header]
    extra = [column for column in header if column not in expected]
    if missing:
        raise _error(f"CSV is missing declared metric column(s): {', '.join(missing)}")
    if extra:
        raise _error(f"CSV contains undeclared column(s): {', '.join(extra)}")

    rows: list[dict[str, float | int | None]] = []
    previous_step: float | None = None
    source_rows = 0
    duplicates_collapsed = 0
    try:
        for row_number, values in enumerate(reader, start=2):
            if not values or all(not value.strip() for value in values):
                raise _error(f"CSV row {row_number} is empty")
            if len(values) != len(header):
                raise _error(f"CSV row {row_number} has {len(values)} fields; expected {len(header)}")
            parsed: dict[str, float | int | None] = {}
            for column, raw in zip(header, values):
                if not raw.strip():
                    if column == "step" or not allow_missing:
                        raise _error(f"CSV row {row_number} has missing data for '{column}'")
                    parsed[column] = None
                    continue
                try:
                    number = float(raw.strip())
                except ValueError as exc:
                    raise _error(f"CSV row {row_number} has non-numeric '{column}' data") from exc
                if not math.isfinite(number):
                    raise _error(f"CSV row {row_number} has non-finite '{column}' data")
                parsed[column] = _json_number(number)
            step = float(parsed["step"])
            source_rows += 1
            if previous_step is not None and step < previous_step:
                raise _error(f"CSV row {row_number} step {step:g} is not increasing")
            if previous_step is not None and step == previous_step:
                if duplicate_steps == "error":
                    raise _error(f"CSV row {row_number} repeats step {step:g}")
                rows[-1] = parsed
                duplicates_collapsed += 1
                continue
            previous_step = step
            rows.append(parsed)
    except csv.Error as exc:
        raise _error(f"CSV cannot be parsed: {exc}") from exc
    if not rows:
        raise _error("CSV has a header but no data rows")
    return rows, source_rows, duplicates_collapsed


def load_run(
    csv_bytes: bytes,
    json_bytes: bytes,
    csv_name: str = "metrics.csv",
    json_name: str = "metadata.json",
    *,
    allow_missing: Any = _DEFAULT_LOAD_OPTION,
    duplicate_steps: Any = _DEFAULT_LOAD_OPTION,
) -> dict[str, Any]:
    """Validate and load one run, retaining source bytes for export/reproduction."""
    if not isinstance(csv_bytes, bytes) or not isinstance(json_bytes, bytes):
        raise _error("CSV and metadata sources must be bytes")
    csv_name = _safe_filename(csv_name, "csv_name")
    json_name = _safe_filename(json_name, "json_name")
    if csv_name == json_name:
        raise _error("csv_name and json_name must be distinct")
    legacy_summaries = allow_missing is _DEFAULT_LOAD_OPTION and duplicate_steps is _DEFAULT_LOAD_OPTION
    if allow_missing is _DEFAULT_LOAD_OPTION:
        allow_missing = False
    if duplicate_steps is _DEFAULT_LOAD_OPTION:
        duplicate_steps = "error"
    _validate_load_options(allow_missing, duplicate_steps)
    metadata = _metadata(json_bytes)
    rows, source_rows, duplicates_collapsed = _csv_rows(
        csv_bytes,
        metadata,
        allow_missing=allow_missing,
        duplicate_steps=duplicate_steps,
    )
    return {
        "id": metadata["id"],
        "name": metadata["name"],
        "metadata": metadata,
        "rows": rows,
        "normalization": {
            "allow_missing": allow_missing,
            "duplicate_steps": duplicate_steps,
            "duplicates_collapsed": duplicates_collapsed,
            "source_rows": source_rows,
        },
        "duplicate_policy": _duplicate_policy(duplicate_steps),
        "_csv_bytes": csv_bytes,
        "_metadata_bytes": json_bytes,
        "_csv_name": csv_name,
        "_json_name": json_name,
        "_legacy_summaries": legacy_summaries,
    }


def summary(points: Iterable[tuple[Any, Any]], direction: str) -> dict[str, Any]:
    """Summarize measurements, choosing final and best by increasing step."""
    if direction not in {"min", "max"}:
        raise _error("summary direction must be 'min' or 'max'")
    valid: list[tuple[float, float]] = []
    for step, value in points:
        step = _finite_number(step, "summary step")
        if value is None:
            continue
        valid.append((step, _finite_number(value, "summary value")))
    valid.sort(key=lambda point: point[0])
    if not valid:
        return {
            "first": None,
            "last": None,
            "min": None,
            "max": None,
            "delta": None,
            "count": 0,
            "final": None,
            "best": None,
            "final_step": None,
            "best_step": None,
        }
    _, first = valid[0]
    final_step, final = valid[-1]
    best_step, best = valid[0]
    for step, value in valid[1:]:
        if (direction == "min" and value < best) or (direction == "max" and value > best):
            best_step, best = step, value
    return {
        "first": _json_number(first),
        "last": _json_number(final),
        "min": _json_number(min(value for _, value in valid)),
        "max": _json_number(max(value for _, value in valid)),
        "delta": _json_number(final - first) if math.isfinite(final - first) else None,
        "count": len(valid),
        "final": _json_number(final),
        "best": _json_number(best),
        "final_step": _json_number(final_step),
        "best_step": _json_number(best_step),
    }


def _run_normalization(run: dict[str, Any]) -> dict[str, Any]:
    normalization = run.get("normalization")
    if normalization is None:
        return {
            "allow_missing": False,
            "duplicate_steps": "error",
            "duplicates_collapsed": 0,
            "source_rows": len(run.get("rows", [])),
        }
    if not isinstance(normalization, dict):
        raise _error("run normalization must be an object")
    allow_missing = normalization.get("allow_missing", False)
    duplicate_steps = normalization.get("duplicate_steps", "error")
    _validate_load_options(allow_missing, duplicate_steps)
    duplicates_collapsed = normalization.get("duplicates_collapsed", 0)
    source_rows = normalization.get("source_rows", len(run.get("rows", [])))
    if (
        isinstance(duplicates_collapsed, bool)
        or not isinstance(duplicates_collapsed, int)
        or duplicates_collapsed < 0
        or isinstance(source_rows, bool)
        or not isinstance(source_rows, int)
        or source_rows < 0
    ):
        raise _error("run normalization row counts must be non-negative integers")
    return {
        "allow_missing": allow_missing,
        "duplicate_steps": duplicate_steps,
        "duplicates_collapsed": duplicates_collapsed,
        "source_rows": source_rows,
    }


def public_run(run: dict[str, Any]) -> dict[str, Any]:
    """Return the JSON-safe representation used by the browser API."""
    metadata = run["metadata"]
    metrics = [
        {
            "key": key,
            "label": definition["label"],
            "unit": definition["unit"],
            "direction": definition["direction"],
        }
        for key, definition in metadata["metrics"].items()
    ]
    rows = [
        {
            key: _json_number(float(value)) if isinstance(value, float) else value
            for key, value in row.items()
        }
        for row in run["rows"]
    ]
    summaries = {
        metric: summary(
            ((row["step"], row.get(metric)) for row in run["rows"]),
            metadata["metrics"][metric]["direction"],
        )
        for metric in metadata["metrics"]
    }
    if run.get("_legacy_summaries", False):
        # The original browser API exposes these six summary fields. Explicit
        # normalization opts into the richer aligned-data summary contract.
        summaries = {
            metric: {key: values[key] for key in ("first", "last", "min", "max", "delta", "count")}
            for metric, values in summaries.items()
        }
    normalization = _run_normalization(run)
    files = [
        {"name": run["_csv_name"], "sha256": _sha256(run["_csv_bytes"])},
        {"name": run["_json_name"], "sha256": _sha256(run["_metadata_bytes"])},
    ]
    return {
        "id": run["id"],
        "name": run["name"],
        "metadata": metadata,
        "metrics": metrics,
        "rows": rows,
        "files": files,
        "summaries": summaries,
        "normalization": normalization,
        "duplicate_policy": _duplicate_policy(normalization["duplicate_steps"]),
    }


def _series_parameters(run: dict[str, Any]) -> dict[str, Any]:
    metadata = run["metadata"]
    parameters: dict[str, Any] = {}
    for key in ("seed", "dataset", "model"):
        if key in metadata:
            parameters[key] = metadata[key]
    extra = metadata.get("parameters", {})
    if extra:
        parameters.update(extra)
    return parameters


def _recorded_metric_points(run: dict[str, Any], metric: str) -> list[tuple[float, Any]]:
    return sorted(
        [(float(row["step"]), row.get(metric)) for row in run.get("rows", [])],
        key=lambda point: point[0],
    )


def _aligned_values(run: dict[str, Any], metric: str, steps: list[float]) -> list[Any]:
    by_step = {float(row["step"]): row.get(metric) for row in run.get("rows", [])}
    return [by_step.get(step) for step in steps]


def compare_runs(
    runs: list[dict[str, Any]],
    metrics: list[str],
    alignment: str = "independent",
) -> dict[str, Any]:
    """Compare recorded steps; summaries describe the aligned values in each series.

    Top-level summaries use the original metric key, then run id (units remain
    isolated in panels). Parameters merge seed/dataset/model with metadata's
    parameters object; explicit parameters take precedence for colliding keys.
    Parameters support only finite JSON scalars, not arrays or nested objects.
    """
    if not isinstance(runs, list) or not runs:
        raise _error("cannot compare without runs")
    if not isinstance(metrics, list) or not metrics or any(not isinstance(metric, str) for metric in metrics):
        raise _error("cannot compare without selected metrics")
    if not isinstance(alignment, str) or alignment not in {"independent", "intersection", "union"}:
        raise _error("alignment must be 'independent', 'intersection', or 'union'")

    panels: list[dict[str, Any]] = []
    panel_by_key: dict[tuple[str, str], dict[str, Any]] = {}
    for metric in metrics:
        for run_index, run in enumerate(runs):
            definition = run.get("metadata", {}).get("metrics", {}).get(metric)
            if not isinstance(definition, dict):
                continue
            unit = definition["unit"]
            panel_key = (metric, unit)
            if panel_key not in panel_by_key:
                panel = {
                    "metric": metric,
                    "unit": unit,
                    "label": definition["label"],
                    "steps": [],
                    "series": [],
                    "empty": False,
                }
                panel_by_key[panel_key] = panel
                panels.append(panel)
            panel = panel_by_key[panel_key]
            points = _recorded_metric_points(run, metric)
            recorded_steps = sorted({step for step, _ in points})
            panel["series"].append(
                {
                    "run_id": run["id"],
                    "name": run["name"],
                    "run_index": run_index,
                    "_run": run,
                    "_points": points,
                    "_recorded_steps": recorded_steps,
                    "parameters": _series_parameters(run),
                    "_direction": definition["direction"],
                }
            )

    summaries: dict[str, dict[str, Any]] = {}
    assumptions = [
        f"Alignment mode: {alignment}; steps are matched by exact recorded numeric step values.",
        "Missing measurements are represented as null; no interpolation, extrapolation, zero filling, or row-index matching is used.",
        "Summaries use non-missing aligned measurements; final is the last by increasing step and best ties choose the earliest step. An overflowing delta is null.",
    ]
    if alignment == "intersection":
        assumptions.append("Intersection includes steps recorded by every participating run, including rows with missing measurements.")
    elif alignment == "union":
        assumptions.append("Union includes every recorded step and uses null where a run has no row at that step.")
    else:
        assumptions.append("Independent mode preserves each run's own sorted recorded steps.")

    for panel in panels:
        series = panel["series"]
        step_sets = [set(item["_recorded_steps"]) for item in series]
        if alignment == "intersection":
            steps = sorted(set.intersection(*step_sets)) if step_sets else []
        else:
            steps = sorted(set.union(*step_sets)) if step_sets else []
        panel["steps"] = [_json_number(step) for step in steps]
        metric = panel["metric"]
        summaries.setdefault(metric, {})
        for item in series:
            if alignment == "independent":
                series_steps = item["_recorded_steps"]
                values = [value for _, value in item["_points"]]
            else:
                series_steps = steps
                values = _aligned_values(item["_run"], metric, steps)
            item["steps"] = [_json_number(step) for step in series_steps]
            item["values"] = values
            item["summary"] = summary(zip(series_steps, values), item["_direction"])
            summaries[metric][item["run_id"]] = item["summary"]
        panel["empty"] = not any(item["summary"]["count"] for item in series)
        for item in series:
            for key in ("_run", "_points", "_recorded_steps", "_direction"):
                item.pop(key, None)

    duplicate_policies = []
    for run in runs:
        normalization = _run_normalization(run)
        duplicate_policies.append(
            f"{run['id']}: {_duplicate_policy(normalization['duplicate_steps'])}"
        )
        missing_policy = "blank metrics become null" if normalization["allow_missing"] else "blank metrics are rejected"
        assumptions.append(
            f"Run {run['id']}: {missing_policy}; steps must be finite and non-missing; "
            f"{_duplicate_policy(normalization['duplicate_steps'])}; decreasing steps are rejected. "
            f"Collapsed {normalization['duplicates_collapsed']} duplicate row(s) from "
            f"{normalization['source_rows']} source row(s)."
        )
    result = {
        "alignment": alignment,
        "panels": panels,
        "summaries": summaries,
        "assumptions": assumptions,
        "duplicate_policy": "; ".join(duplicate_policies),
    }
    return json.loads(json.dumps(result, ensure_ascii=False, allow_nan=False))


def render_svg(
    runs: list[dict[str, Any]],
    metrics: list[str],
    title: str = "Experiment comparison",
    *,
    alignment: str = "independent",
) -> bytes:
    """Render selected imported data as deterministic, text-preserving SVG."""
    if not isinstance(runs, list) or not runs:
        raise _error("cannot render without runs")
    if not isinstance(metrics, list) or not metrics or any(not isinstance(metric, str) for metric in metrics):
        raise _error("cannot render without selected metrics")
    if not isinstance(title, str) or not title.strip() or len(title) > 300:
        raise _error("plot title must be a non-empty string of at most 300 characters")

    comparison = compare_runs(runs, metrics, alignment)
    if not comparison["panels"]:
        raise _error("none of the selected metrics has data to render")

    import matplotlib

    matplotlib.use("Agg", force=True)
    import matplotlib.pyplot as plt

    matplotlib.rcParams["svg.hashsalt"] = "runpaper-experiment-workbench-v1"
    matplotlib.rcParams["svg.fonttype"] = "none"
    matplotlib.rcParams["figure.facecolor"] = "white"
    matplotlib.rcParams["axes.facecolor"] = "white"
    figure, axes = plt.subplots(
        nrows=len(comparison["panels"]), ncols=1,
        figsize=(10, max(3.2, 3.0 * len(comparison["panels"]))), squeeze=False
    )
    figure.suptitle(title, fontsize=15, fontweight="bold", color="#202124")
    for axis, panel in zip(axes[:, 0], comparison["panels"]):
        unit = panel["unit"]
        for series in panel["series"]:
            run_index = series["run_index"]
            axis.plot(
                series["steps"],
                [float(value) if value is not None else math.nan for value in series["values"]],
                color=PALETTE[run_index % len(PALETTE)],
                linewidth=2.1,
                marker="o",
                markersize=4,
                label=series["name"],
            )
        unit_suffix = f" [{unit}]" if unit else ""
        annotation = ""
        if panel["empty"]:
            annotation = (
                " — No common steps"
                if alignment == "intersection" and not panel["steps"]
                else " — No measurements"
            )
            message = "No recorded steps in common" if not panel["steps"] else "No measurements"
            axis.text(0.5, 0.5, message, transform=axis.transAxes, ha="center", va="center")
        axis.set_title(f"{panel['label']}{unit_suffix}{annotation}", loc="left", fontsize=12, pad=9)
        axis.set_xlabel("Step", fontsize=10)
        axis.set_ylabel(unit or panel["label"], fontsize=10)
        axis.grid(True, color="#d9dce3", linewidth=0.7, alpha=0.8)
        axis.spines["top"].set_visible(False)
        axis.spines["right"].set_visible(False)
        if panel["series"]:
            axis.legend(frameon=False, loc="best", fontsize=9)
    figure.tight_layout(rect=(0, 0, 1, 0.96))
    output = io.BytesIO()
    try:
        figure.savefig(output, format="svg", metadata={"Date": None}, facecolor="white")
    finally:
        plt.close(figure)
    return output.getvalue()


def _software_versions() -> dict[str, str]:
    import matplotlib
    import numpy

    return {
        "python": platform.python_version(),
        "matplotlib": matplotlib.__version__,
        "numpy": numpy.__version__,
        "platform": platform.platform(),
    }


def _zip_entry(zipped: zipfile.ZipFile, name: str, data: bytes) -> None:
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED
    info.create_system = 3
    info.external_attr = 0o100644 << 16
    zipped.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)


def _latex_escape(value: str) -> str:
    """Escape arbitrary labels once, without escaping generated commands."""
    replacements = {
        "#": r"\#", "$": r"\$", "%": r"\%", "&": r"\&", "_": r"\_",
        "{": r"\{", "}": r"\}", "~": r"\textasciitilde{}",
        "^": r"\textasciicircum{}", "\\": r"\textbackslash{}",
        "\n": " ", "\r": " ", "\t": " ",
    }
    return "".join(replacements.get(char, char) for char in value)


def _export_plot_options(panel_count: int) -> dict[str, Any]:
    """Record the renderer's fixed options without changing SVG serialization."""
    return {
        "format": "svg", "figsize": [10, max(3.2, 3.0 * panel_count)],
        "layout": {"nrows": panel_count, "ncols": 1, "squeeze": False,
                   "tight_layout_rect": [0, 0, 1, 0.96]},
        "palette": list(PALETTE), "linewidth": 2.1, "marker": "o", "markersize": 4,
        "title": {"fontsize": 15, "fontweight": "bold", "color": "#202124"},
        "panel_title": {"loc": "left", "fontsize": 12, "pad": 9},
        "xlabel": "Step", "axis_label_fontsize": 10,
        "grid": {"color": "#d9dce3", "linewidth": 0.7, "alpha": 0.8},
        "hidden_spines": ["top", "right"],
        "legend": {"frameon": False, "loc": "best", "fontsize": 9},
        "figure_facecolor": "white", "axes_facecolor": "white",
        "svg_hashsalt": "runpaper-experiment-workbench-v1", "svg_fonttype": "none",
        "svg_metadata": {"Date": None},
    }


def _export_comparison(
    runs: list[dict[str, Any]], metrics: list[str], plot: dict[str, Any],
    run_specs: list[dict[str, Any]], comparison: dict[str, Any],
) -> dict[str, Any]:
    """Attach selected definitions, raw selected rows and metadata to plotted arrays."""
    result = dict(comparison)
    selected_runs = []
    definitions = []
    for run, spec in zip(runs, run_specs):
        selected = [metric for metric in dict.fromkeys(metrics) if metric in run["metadata"]["metrics"]]
        selected_runs.append({
            "id": run["id"], "name": run["name"], "metadata": run["metadata"],
            "metadata_path": spec["metadata"], "metadata_sha256": spec["metadata_sha256"],
            "rows": [{"step": row["step"], **{metric: row.get(metric) for metric in selected}}
                     for row in run["rows"]],
            "summaries": {metric: comparison["summaries"][metric][run["id"]] for metric in selected},
            "normalization": _run_normalization(run),
        })
        definitions.extend({"run_id": run["id"], "key": metric,
                            "definition": run["metadata"]["metrics"][metric],
                            **run["metadata"]["metrics"][metric]} for metric in selected)
    result.update({"plot": plot, "selected_runs": selected_runs, "metric_definitions": definitions})
    return result


def build_export(
    runs: list[dict[str, Any]],
    metrics: list[str],
    title: str,
    alignment: str = "independent",
) -> bytes:
    """Build a deterministic ZIP containing the figure, sources, and manifest."""
    if not isinstance(runs, list) or not runs:
        raise _error("cannot export without runs")
    ids = [run.get("id") for run in runs]
    if len(ids) != len(set(ids)):
        raise _error("runs must have unique ids for export")
    comparison = compare_runs(runs, metrics, alignment)
    figure = render_svg(runs, metrics, title, alignment=alignment)
    software = _software_versions()
    manifest_runs = []
    source_files: list[tuple[str, bytes]] = []
    plot = {
        "metrics": list(metrics), "title": title, "alignment": alignment,
        "assumptions": comparison["assumptions"],
        "options": _export_plot_options(len(comparison["panels"])),
    }
    for run in runs:
        run_id = _safe_identifier(run["id"], "run id")
        csv_name = _safe_filename(run["_csv_name"], "CSV source name")
        json_name = _safe_filename(run["_json_name"], "metadata source name")
        csv_path = f"sources/{run_id}/metrics.csv"
        json_path = f"sources/{run_id}/metadata.json"
        source_files.extend(((csv_path, run["_csv_bytes"]), (json_path, run["_metadata_bytes"])))
        manifest_runs.append(
            {
                "id": run_id,
                "name": run["name"],
                "metadata_content": run["metadata"],
                "parameters": _series_parameters(run),
                "csv": csv_path,
                "metadata": json_path,
                "csv_source_name": csv_name,
                "metadata_source_name": json_name,
                "csv_sha256": _sha256(run["_csv_bytes"]),
                "metadata_sha256": _sha256(run["_metadata_bytes"]),
                "run_sha256": _source_run_hash(run["_csv_bytes"], run["_metadata_bytes"]),
                "metric_definitions": run["metadata"]["metrics"],
                "normalization": _run_normalization(run),
            }
        )
    comparison = _export_comparison(runs, metrics, plot, manifest_runs, comparison)
    comparison_bytes = _canonical_json(comparison) + b"\n"
    manifest: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "runs": manifest_runs,
        "plot": plot,
        "comparison": "comparison.json",
        "comparison_sha256": _sha256(comparison_bytes),
        "software": software,
        "output": {"figure": "figure.svg", "sha256": _sha256(figure)},
        "reproducible_command": (
            f"python {shlex.quote(str(Path(__file__).resolve()))} reproduce PATH/manifest.json --output PATH/figure.svg"
        ),
    }
    reproduce_md = (
        "# Reproduce this figure\n\n"
        "The archive contains the exact source CSV and metadata bytes used for the figure. "
        "It does not contain the Runpaper code. With the recorded dependencies installed, "
        "from the extracted archive run the project's core.py using its absolute path:\n\n"
        f"```sh\npython {shlex.quote(str(Path(__file__).resolve()))} reproduce manifest.json --output figure.svg\n```\n\n"
        "If the project has moved, replace that absolute path with its new location. "
        f"The plot alignment is `{alignment}`. The manifest records each run's "
        "allow_missing and duplicate_steps normalization options; reproduction applies "
        "those options to the original bytes. Old version-1 manifests default to "
        "independent alignment, allow_missing=false, and duplicate_steps=error.\n\n"
        "## Comparison and normalization assumptions\n\n"
        + "".join(f"- {assumption}\n" for assumption in comparison["assumptions"])
        + "\nThe aligned panels and their measurement summaries are in comparison.json. "
        "Metadata parameters must be a flat object of finite JSON scalars; "
        "explicit parameters override seed/dataset/model on key collisions.\n\n"
        "The command checks the comparison.json SHA-256 and its recorded data/configuration, "
        "checks every input SHA-256 before plotting, and checks the generated "
        "figure SHA-256 afterwards. The manifest records the Python, matplotlib, numpy, "
        "and platform versions used to create it. If the output hash differs, the command "
        "reports that installed software/version differences may affect SVG serialization "
        "and refuses to write a non-matching figure.\n"
    ).encode("utf-8")
    tex = (
        "\\documentclass{standalone}\n"
        "\\usepackage{svg}\n"
        "\\usepackage{caption}\n"
        "\\begin{document}\n"
        "\\begin{minipage}{10cm}\n"
        "\\includesvg[width=\\linewidth]{figure}\n"
        f"\\captionof{{figure}}{{{_latex_escape(title)}}}\n"
        + "".join(
            f"% Metric: {_latex_escape(item['key'])}; label: {_latex_escape(item['label'])}; "
            f"unit: {_latex_escape(item['unit'])}\n"
            for item in comparison["metric_definitions"]
        )
        + "".join(f"% Run: {_latex_escape(run['name'])}\n" for run in runs)
        + "\\end{minipage}\n"
        "\\end{document}\n"
    ).encode("utf-8")
    manifest["artifacts"] = {
        "figure": {"path": "figure.svg", "sha256": _sha256(figure)},
        "latex": {"path": "figure.tex", "sha256": _sha256(tex)},
        "reproduce": {"path": "REPRODUCE.md", "sha256": _sha256(reproduce_md)},
        "comparison": {"path": "comparison.json", "sha256": _sha256(comparison_bytes)},
        "sources": [
            {"path": path, "sha256": _sha256(data)} for path, data in source_files
        ],
    }
    manifest_bytes = _canonical_json(manifest) + b"\n"
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        _zip_entry(archive, "figure.svg", figure)
        _zip_entry(archive, "figure.tex", tex)
        _zip_entry(archive, "manifest.json", manifest_bytes)
        _zip_entry(archive, "REPRODUCE.md", reproduce_md)
        _zip_entry(archive, "comparison.json", comparison_bytes)
        for path, data in source_files:
            _zip_entry(archive, path, data)
    return output.getvalue()


def _manifest_file(root: Path, relative: str, field: str) -> Path:
    if not isinstance(relative, str) or not relative or "\\" in relative:
        raise _error(f"manifest {field} path is invalid")
    candidate = (root / relative).resolve()
    try:
        candidate.relative_to(root.resolve())
    except ValueError as exc:
        raise _error(f"manifest {field} path escapes the manifest directory") from exc
    if not candidate.is_file():
        raise _error(f"manifest {field} file does not exist: {relative}")
    return candidate


def reproduce(manifest_path: str | os.PathLike[str], output_path: str | os.PathLike[str]) -> bytes:
    """Verify manifest sources, regenerate a figure, and verify its expected hash."""
    manifest_file = Path(manifest_path).resolve()
    if not manifest_file.is_file():
        raise _error(f"manifest does not exist: {manifest_path}")
    try:
        manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise _error(f"manifest cannot be read: {exc}") from exc
    if not isinstance(manifest, dict) or manifest.get("schema_version") != SCHEMA_VERSION:
        raise _error(f"unsupported or missing manifest schema version (expected {SCHEMA_VERSION})")
    root = manifest_file.parent
    run_specs = manifest.get("runs")
    if not isinstance(run_specs, list) or not run_specs:
        raise _error("manifest runs must be a non-empty list")
    runs = []
    for index, spec in enumerate(run_specs, start=1):
        if not isinstance(spec, dict):
            raise _error(f"manifest run {index} is not an object")
        csv_file = _manifest_file(root, spec.get("csv"), f"run {index} CSV")
        metadata_file = _manifest_file(root, spec.get("metadata"), f"run {index} metadata")
        csv_bytes = csv_file.read_bytes()
        metadata_bytes = metadata_file.read_bytes()
        if _sha256(csv_bytes) != spec.get("csv_sha256"):
            raise _error(f"input hash mismatch for {csv_file.name} (CSV); source was modified")
        if _sha256(metadata_bytes) != spec.get("metadata_sha256"):
            raise _error(f"input hash mismatch for {metadata_file.name} (metadata); source was modified")
        if _source_run_hash(csv_bytes, metadata_bytes) != spec.get("run_sha256"):
            raise _error(f"input run hash mismatch for run {spec.get('id', index)}")
        normalization = spec.get("normalization", {})
        if not isinstance(normalization, dict):
            raise _error(f"manifest run {index} normalization must be an object")
        run = load_run(
            csv_bytes, metadata_bytes, csv_file.name, metadata_file.name,
            allow_missing=normalization.get("allow_missing", False),
            duplicate_steps=normalization.get("duplicate_steps", "error"),
        )
        if run["id"] != spec.get("id"):
            raise _error(f"metadata id mismatch for run {index}")
        if "name" in spec and run["name"] != spec["name"]:
            raise _error(f"metadata name mismatch for run {index}")
        for field in ("duplicates_collapsed", "source_rows"):
            if field in normalization and normalization[field] != run["normalization"][field]:
                raise _error(f"manifest run {index} normalization {field} mismatch")
        runs.append(run)
    plot = manifest.get("plot")
    if not isinstance(plot, dict):
        raise _error("manifest plot configuration is missing")
    comparison = compare_runs(runs, plot.get("metrics"), plot.get("alignment", "independent"))
    if "options" in plot and plot["options"] != _export_plot_options(len(comparison["panels"])):
        raise _error("manifest plot options do not match the supported renderer configuration")
    if "assumptions" in plot and plot["assumptions"] != comparison["assumptions"]:
        raise _error("manifest plot assumptions mismatch")
    # Both fields are optional for old schema-v1 bundles, but must be a valid
    # pair if either is present. Verify the original artifact before parsing it.
    if "comparison" in manifest or "comparison_sha256" in manifest:
        comparison_file = _manifest_file(root, manifest.get("comparison"), "comparison")
        comparison_bytes = comparison_file.read_bytes()
        if _sha256(comparison_bytes) != manifest.get("comparison_sha256"):
            raise _error("comparison hash mismatch; comparison artifact was modified")
        try:
            recorded = json.loads(comparison_bytes.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise _error(f"comparison artifact is invalid: {exc}") from exc
        if not isinstance(recorded, dict):
            raise _error("comparison artifact must be an object")
        expected_comparison = (
            _export_comparison(runs, plot.get("metrics"), plot, run_specs, comparison)
            if "selected_runs" in recorded or "plot" in recorded or "metric_definitions" in recorded
            else comparison
        )
        if recorded != expected_comparison:
            raise _error("comparison data/configuration mismatch with manifest sources and plot")
    artifacts = manifest.get("artifacts")
    if artifacts is not None:
        if not isinstance(artifacts, dict):
            raise _error("manifest artifacts must be an object")
        records = []
        for key, record in artifacts.items():
            if key == "sources":
                if not isinstance(record, list):
                    raise _error("manifest artifacts sources must be a list")
                records.extend(record)
            else:
                records.append(record)
        for record in records:
            if not isinstance(record, dict):
                raise _error("manifest artifact record must be an object")
            relative = record.get("path")
            expected_hash = record.get("sha256")
            # Some earlier schema-v1 exports recorded the optional comparison
            # artifact in the artifact table but did not include the file.
            # Keep those manifests reproducible while validating it whenever
            # the additive comparison reference is present.
            if (
                relative == "comparison.json"
                and "comparison" not in manifest
                and not (root / relative).is_file()
            ):
                continue
            artifact_file = _manifest_file(root, relative, "artifact")
            if _sha256(artifact_file.read_bytes()) != expected_hash:
                raise _error(f"artifact hash mismatch for {relative}")
    expected_figure = manifest.get("output", {}).get("sha256")
    figure_path = manifest.get("output", {}).get("figure", "figure.svg")
    if isinstance(figure_path, str):
        existing_figure = _manifest_file(root, figure_path, "output figure")
        if _sha256(existing_figure.read_bytes()) != expected_figure:
            raise _error("output figure hash mismatch; figure artifact was modified")
    figure = render_svg(
        runs, plot.get("metrics"), plot.get("title"),
        alignment=plot.get("alignment", "independent"),
    )
    expected = expected_figure
    actual = _sha256(figure)
    if actual != expected:
        versions = manifest.get("software", {})
        raise _error(
            "output figure hash mismatch: installed software/version differences may affect "
            f"SVG bytes (archive used {versions}; generated { _software_versions() })"
        )
    destination = Path(output_path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(figure)
    return figure


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Runpaper experiment workbench utilities")
    subparsers = parser.add_subparsers(dest="command", required=True)
    reproduce_parser = subparsers.add_parser("reproduce", help="verify sources and regenerate a figure")
    reproduce_parser.add_argument("manifest", help="path to manifest.json")
    reproduce_parser.add_argument("--output", required=True, help="path for the regenerated figure.svg")
    args = parser.parse_args(list(argv) if argv is not None else None)
    try:
        if args.command == "reproduce":
            reproduce(args.manifest, args.output)
            return 0
    except Exception as exc:  # CLI errors should be readable and non-zero.
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
