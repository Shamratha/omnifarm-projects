"""Local browser application for the Runpaper experiment workbench."""

from __future__ import annotations

import base64
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import venv
import zipfile


ROOT = Path(__file__).resolve().parent


def _ensure_environment() -> None:
    """Make the one-command start useful on a fresh Python installation."""
    try:
        import flask  # noqa: F401
        import matplotlib  # noqa: F401
        return
    except ImportError:
        if os.environ.get("RUNPAPER_NO_BOOTSTRAP") == "1":
            raise
    environment = ROOT / ".venv"
    python = environment / "bin" / "python"
    if not python.exists():
        print("Runpaper: creating .venv for the first start...")
        venv.create(environment, with_pip=True)
    print("Runpaper: installing requirements into .venv...")
    subprocess.check_call([str(python), "-m", "pip", "install", "-r", str(ROOT / "requirements.txt")])
    os.execv(str(python), [str(python), str(ROOT / "app.py"), *sys.argv[1:]])


if __name__ == "__main__":
    _ensure_environment()

from flask import Flask, jsonify, render_template, request, send_file  # noqa: E402

import core  # noqa: E402


app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 8 * 1024 * 1024
RUNS: dict[str, dict] = {}
EXPORT_FILENAME = "runpaper-export.zip"


def _read_examples() -> None:
    examples = ROOT / "examples"
    for metadata_path in sorted(examples.glob("*.json")):
        csv_path = metadata_path.with_suffix(".csv")
        if csv_path.exists():
            run = core.load_run(csv_path.read_bytes(), metadata_path.read_bytes(), csv_path.name, metadata_path.name)
            RUNS[run["id"]] = run


def _error_response(message: str, status: int = 400):
    return jsonify({"error": message}), status


def _selected_runs(run_ids):
    if not isinstance(run_ids, list) or not run_ids:
        raise ValueError("select at least one run")
    if any(not isinstance(run_id, str) for run_id in run_ids):
        raise ValueError("run ids must be strings")
    missing = [run_id for run_id in run_ids if run_id not in RUNS]
    if missing:
        raise ValueError(f"unknown run id(s): {', '.join(missing)}")
    if len(set(run_ids)) != len(run_ids):
        raise ValueError("a run can only be selected once")
    return [RUNS[run_id] for run_id in run_ids]


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/runs")
def list_runs():
    return jsonify({"runs": [core.public_run(run) for run in RUNS.values()]})


@app.post("/api/import")
def import_run():
    csv_file = request.files.get("csv")
    metadata_file = request.files.get("metadata")
    if not csv_file or not metadata_file:
        return _error_response("choose both a metrics CSV and a metadata JSON file")
    try:
        run = core.load_run(
            csv_file.read(), metadata_file.read(), csv_file.filename or "metrics.csv", metadata_file.filename or "metadata.json",
            allow_missing=True, duplicate_steps=request.form.get("duplicate_steps", "error"),
        )
        if run["id"] in RUNS:
            return _error_response(f"a run with id '{run['id']}' is already loaded")
        RUNS[run["id"]] = run
        return jsonify({"run": core.public_run(run)}), 201
    except (ValueError, UnicodeError) as exc:
        return _error_response(str(exc))


def _plot_payload():
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        raise ValueError("request body must be a JSON object")
    runs = _selected_runs(payload.get("run_ids"))
    metrics = payload.get("metrics")
    if not isinstance(metrics, list) or not metrics:
        raise ValueError("select at least one metric")
    if any(not isinstance(metric, str) for metric in metrics):
        raise ValueError("metrics must be strings")
    if len(set(metrics)) != len(metrics):
        raise ValueError("a metric can only be selected once")
    available = {metric for run in runs for metric in run["metadata"]["metrics"]}
    missing = [metric for metric in metrics if metric not in available]
    if missing:
        raise ValueError(f"unknown selected metric(s): {', '.join(missing)}")
    title = payload.get("title", "Experiment comparison")
    alignment = payload.get("alignment", "independent")
    if not isinstance(alignment, str) or alignment not in {"independent", "intersection", "union"}:
        raise ValueError("alignment must be 'independent', 'intersection', or 'union'")
    return runs, metrics, title, alignment


@app.post("/api/plot")
def plot():
    try:
        runs, metrics, title, alignment = _plot_payload()
        figure = core.render_svg(runs, metrics, title, alignment=alignment)
        return figure, 200, {"Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": "no-store"}
    except (ValueError, KeyError, TypeError) as exc:
        return _error_response(str(exc))


@app.post("/api/compare")
def compare():
    try:
        runs, metrics, _title, alignment = _plot_payload()
        return jsonify(core.compare_runs(runs, metrics, alignment=alignment))
    except (ValueError, KeyError, TypeError) as exc:
        return _error_response(str(exc))


def _export_archive():
    runs, metrics, title, alignment = _plot_payload()
    return core.build_export(runs, metrics, title, alignment=alignment)


def _entry_kind(name: str) -> str:
    if name.startswith("sources/"):
        return "source"
    return {
        "comparison.json": "comparison",
        "figure.svg": "figure",
        "figure.tex": "latex",
        "manifest.json": "manifest",
    }.get(name, "documentation")


@app.post("/api/export/preview")
def export_preview():
    try:
        archive = _export_archive()
        with zipfile.ZipFile(io.BytesIO(archive)) as zipped:
            entries = [
                {"name": entry.filename, "size": entry.file_size, "kind": _entry_kind(entry.filename)}
                for entry in zipped.infolist()
            ]
            manifest = json.loads(zipped.read("manifest.json"))
            comparison = json.loads(zipped.read("comparison.json"))
            latex = zipped.read("figure.tex").decode("utf-8")
            preview_svg = "data:image/svg+xml;base64," + base64.b64encode(zipped.read("figure.svg")).decode("ascii")
        response = jsonify({
            "filename": EXPORT_FILENAME,
            "byte_size": len(archive),
            "entries": entries,
            "manifest": manifest,
            "comparison": comparison,
            "latex": latex,
            "preview_svg": preview_svg,
        })
        response.headers["Cache-Control"] = "no-store"
        return response
    except (ValueError, KeyError, TypeError, UnicodeError, zipfile.BadZipFile) as exc:
        return _error_response(str(exc))


@app.post("/api/export")
def export():
    try:
        archive = _export_archive()
        return send_file(
            io.BytesIO(archive),
            mimetype="application/zip",
            as_attachment=True,
            download_name=EXPORT_FILENAME,
        )
    except (ValueError, KeyError, TypeError) as exc:
        return _error_response(str(exc))


@app.errorhandler(413)
def too_large(_error):
    return _error_response("upload is too large (8 MB maximum)", 413)


_read_examples()


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", "8000")), debug=False)
