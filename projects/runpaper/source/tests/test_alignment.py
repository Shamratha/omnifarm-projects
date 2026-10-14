import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import core


def make_sources(
    run_id="run-1",
    rows=None,
    metric_defs=None,
    *,
    seed=7,
    dataset="toy",
    model="linear",
    parameters=None,
):
    metric_defs = metric_defs or {
        "loss": {"label": "Loss", "unit": "score", "direction": "min"},
    }
    if rows is None:
        rows = [
            (1, {metric: 1.0 for metric in metric_defs}),
            (2, {metric: 2.0 for metric in metric_defs}),
        ]
    metadata = {
        "id": run_id,
        "name": run_id.replace("-", " ").title(),
        "seed": seed,
        "dataset": dataset,
        "model": model,
        "metrics": metric_defs,
    }
    if parameters is not None:
        metadata["parameters"] = parameters
    columns = ["step", *metric_defs]
    csv_rows = [",".join(columns)]
    for step, values in rows:
        csv_rows.append(",".join([str(step), *("" if values[key] is None else str(values[key]) for key in metric_defs)]))
    return ("\n".join(csv_rows) + "\n").encode(), json.dumps(metadata, separators=(",", ":")).encode()


def load_run(*args, allow_missing=False, duplicate_steps="error", **kwargs):
    csv_bytes, metadata_bytes = make_sources(*args, **kwargs)
    return core.load_run(
        csv_bytes,
        metadata_bytes,
        allow_missing=allow_missing,
        duplicate_steps=duplicate_steps,
    )


def panel_for(comparison, metric="loss", unit="score"):
    return next(panel for panel in comparison["panels"] if panel["metric"] == metric and panel["unit"] == unit)


class AlignmentLoadAndSummaryTests(unittest.TestCase):
    def test_last_duplicate_replaces_entire_row_across_multiple_metrics(self):
        csv_bytes, metadata_bytes = make_sources(
            rows=[
                (0, {"loss": 9, "accuracy": 1}),
                (2, {"loss": 6, "accuracy": 2}),
                (2, {"loss": None, "accuracy": 3}),
                (2, {"loss": 5, "accuracy": None}),
                (5, {"loss": 4, "accuracy": 4}),
            ],
            metric_defs={
                "loss": {"label": "Loss", "unit": "score", "direction": "min"},
                "accuracy": {"label": "Accuracy", "unit": "%", "direction": "max"},
            },
        )
        public = core.public_run(core.load_run(
            csv_bytes, metadata_bytes, allow_missing=True, duplicate_steps="last"
        ))
        self.assertEqual(public["rows"], [
            {"step": 0, "loss": 9, "accuracy": 1},
            {"step": 2, "loss": 5, "accuracy": None},
            {"step": 5, "loss": 4, "accuracy": 4},
        ])
        self.assertEqual(public["normalization"]["duplicates_collapsed"], 2)
        self.assertEqual(public["normalization"]["source_rows"], 5)
        self.assertEqual(public["summaries"]["accuracy"]["count"], 2)

    def test_missing_values_duplicates_and_public_raw_summary(self):
        csv_bytes, metadata_bytes = make_sources(
            rows=[
                (1, {"loss": 5}),
                (2, {"loss": 4}),
                (2, {"loss": None}),
                (3, {"loss": 3}),
                (4, {"loss": None}),
            ]
        )
        run = core.load_run(
            csv_bytes,
            metadata_bytes,
            allow_missing=True,
            duplicate_steps="last",
        )
        public = core.public_run(run)

        self.assertEqual(public["rows"], [
            {"step": 1, "loss": 5},
            {"step": 2, "loss": None},
            {"step": 3, "loss": 3},
            {"step": 4, "loss": None},
        ])
        self.assertEqual(public["normalization"], {
            "allow_missing": True,
            "duplicate_steps": "last",
            "duplicates_collapsed": 1,
            "source_rows": 5,
        })
        self.assertEqual(public["summaries"]["loss"], {
            "first": 5,
            "last": 3,
            "min": 3,
            "max": 5,
            "delta": -2,
            "count": 2,
            "final": 3,
            "best": 3,
            "final_step": 3,
            "best_step": 3,
        })

    def test_max_best_and_earliest_tie_are_step_based(self):
        csv_bytes, metadata_bytes = make_sources(
            rows=[
                (10, {"accuracy": 1}),
                (20, {"accuracy": 5}),
                (30, {"accuracy": 5}),
                (40, {"accuracy": None}),
            ],
            metric_defs={"accuracy": {"label": "Accuracy", "unit": "%", "direction": "max"}},
        )
        public = core.public_run(core.load_run(csv_bytes, metadata_bytes, allow_missing=True))
        self.assertEqual(public["summaries"]["accuracy"], {
            "first": 1,
            "last": 5,
            "min": 1,
            "max": 5,
            "delta": 4,
            "count": 3,
            "final": 5,
            "best": 5,
            "final_step": 30,
            "best_step": 20,
        })

    def test_all_missing_summary_has_null_values_and_zero_count(self):
        csv_bytes, metadata_bytes = make_sources(
            rows=[(1, {"loss": None}), (3, {"loss": None})]
        )
        public = core.public_run(core.load_run(csv_bytes, metadata_bytes, allow_missing=True))
        summary = public["summaries"]["loss"]
        self.assertEqual(summary, {
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
        })

    def test_missing_step_nonfinite_step_and_nonfinite_metric_are_rejected(self):
        _, metadata_bytes = make_sources()
        invalid_csv = [
            b"step,loss\n,1\n",
            b"step,loss\n   ,1\n",
            b"step,loss\nNaN,1\n",
            b"step,loss\nInf,1\n",
            b"step,loss\n-Inf,1\n",
            b"step,loss\n1,NaN\n",
            b"step,loss\n1,Inf\n",
            b"step,loss\n1,-Inf\n",
        ]
        for csv_bytes in invalid_csv:
            with self.subTest(csv=csv_bytes):
                with self.assertRaises(ValueError):
                    core.load_run(csv_bytes, metadata_bytes, allow_missing=True)

    def test_default_missing_and_duplicate_policies_are_strict(self):
        csv_bytes, metadata_bytes = make_sources(rows=[(1, {"loss": None})])
        with self.assertRaises(ValueError):
            core.load_run(csv_bytes, metadata_bytes)

        duplicate_csv, duplicate_metadata = make_sources(
            rows=[(1, {"loss": 1}), (1, {"loss": 2})]
        )
        with self.assertRaises(ValueError):
            core.load_run(duplicate_csv, duplicate_metadata, allow_missing=True)

    def test_decreasing_steps_are_rejected_even_when_duplicates_use_last(self):
        csv_bytes, metadata_bytes = make_sources(
            rows=[(2, {"loss": 1}), (1, {"loss": 2})]
        )
        for policy in ("error", "last"):
            with self.subTest(policy=policy):
                with self.assertRaises(ValueError):
                    core.load_run(csv_bytes, metadata_bytes, duplicate_steps=policy)

    def test_min_best_ties_use_earliest_step_not_final_step(self):
        run = load_run(rows=[
            (0.5, {"loss": None}),
            (1.5, {"loss": 4}),
            (3, {"loss": 2}),
            (9, {"loss": 2}),
            (12, {"loss": 5}),
        ], allow_missing=True)
        self.assertEqual(core.public_run(run)["summaries"]["loss"], {
            "first": 4, "last": 5, "min": 2, "max": 5, "delta": 1,
            "count": 4, "final": 5, "best": 2, "final_step": 12, "best_step": 3,
        })

    def test_unsupported_normalization_values_are_rejected(self):
        csv_bytes, metadata_bytes = make_sources()
        with self.assertRaises(ValueError):
            core.load_run(csv_bytes, metadata_bytes, duplicate_steps="first")
        with self.assertRaises(ValueError):
            core.load_run(csv_bytes, metadata_bytes, allow_missing="yes")

    def test_custom_parameters_accept_only_flat_json_scalars(self):
        for parameters in ({"optimizer": {"name": "adam"}}, {"layers": [8, 16]}):
            with self.subTest(parameters=parameters):
                csv_bytes, metadata_bytes = make_sources(parameters=parameters)
                with self.assertRaises(ValueError):
                    core.load_run(csv_bytes, metadata_bytes)


class ComparisonAlignmentTests(unittest.TestCase):
    def test_independent_uses_irregular_recorded_steps_and_numeric_arrays(self):
        first = load_run(
            run_id="first",
            rows=[(1, {"loss": 8}), (4, {"loss": 5}), (9, {"loss": 3})],
        )
        second = load_run(
            run_id="second",
            rows=[(2, {"loss": 7}), (4, {"loss": 6}), (10, {"loss": 2})],
        )
        comparison = core.compare_runs([first, second], ["loss"])
        panel = panel_for(comparison)

        self.assertEqual(comparison["alignment"], "independent")
        self.assertEqual(panel["label"], "Loss")
        self.assertEqual(panel["steps"], [1, 2, 4, 9, 10])
        self.assertEqual(panel["series"], [
            {
                "run_id": "first",
                "name": "First",
                "run_index": 0,
                "steps": [1, 4, 9],
                "values": [8, 5, 3],
                "summary": comparison["summaries"]["loss"]["first"],
                "parameters": {"seed": 7, "dataset": "toy", "model": "linear"},
            },
            {
                "run_id": "second",
                "name": "Second",
                "run_index": 1,
                "steps": [2, 4, 10],
                "values": [7, 6, 2],
                "summary": comparison["summaries"]["loss"]["second"],
                "parameters": {"seed": 7, "dataset": "toy", "model": "linear"},
            },
        ])
        self.assertFalse(panel["empty"])
        self.assertTrue(comparison["assumptions"])
        self.assertTrue(comparison["duplicate_policy"])
        json.dumps(comparison, allow_nan=False)

    def test_union_has_exact_grid_none_gaps_and_aligned_summary(self):
        first = load_run(
            run_id="first",
            rows=[(1, {"loss": 8}), (4, {"loss": 5}), (9, {"loss": 3})],
        )
        second = load_run(
            run_id="second",
            rows=[(4, {"loss": 6}), (10, {"loss": 2})],
        )
        comparison = core.compare_runs([first, second], ["loss"], alignment="union")
        panel = panel_for(comparison)

        self.assertEqual(comparison["alignment"], "union")
        self.assertEqual(panel["steps"], [1, 4, 9, 10])
        self.assertEqual([series["steps"] for series in panel["series"]], [[1, 4, 9, 10]] * 2)
        self.assertEqual([series["values"] for series in panel["series"]], [
            [8, 5, 3, None],
            [None, 6, None, 2],
        ])
        self.assertEqual(comparison["summaries"]["loss"]["first"], {
            "first": 8,
            "last": 3,
            "min": 3,
            "max": 8,
            "delta": -5,
            "count": 3,
            "final": 3,
            "best": 3,
            "final_step": 9,
            "best_step": 9,
        })
        self.assertEqual(comparison["summaries"]["loss"]["second"], {
            "first": 6, "last": 2, "min": 2, "max": 6, "delta": -4,
            "count": 2, "final": 2, "best": 2, "final_step": 10, "best_step": 10,
        })

    def test_intersection_matches_exact_recorded_steps_not_row_indices(self):
        first = load_run(
            run_id="first",
            rows=[(1, {"loss": 8}), (4, {"loss": 5}), (9, {"loss": 3})],
        )
        second = load_run(
            run_id="second",
            rows=[(4, {"loss": 6}), (10, {"loss": 2})],
        )
        comparison = core.compare_runs([first, second], ["loss"], alignment="intersection")
        panel = panel_for(comparison)

        self.assertEqual(panel["steps"], [4])
        self.assertEqual([series["steps"] for series in panel["series"]], [[4], [4]])
        self.assertEqual([series["values"] for series in panel["series"]], [[5], [6]])
        self.assertEqual(comparison["summaries"]["loss"]["first"], {
            "first": 5,
            "last": 5,
            "min": 5,
            "max": 5,
            "delta": 0,
            "count": 1,
            "final": 5,
            "best": 5,
            "final_step": 4,
            "best_step": 4,
        })
        self.assertEqual(comparison["summaries"]["loss"]["second"], {
            "first": 6, "last": 6, "min": 6, "max": 6, "delta": 0,
            "count": 1, "final": 6, "best": 6, "final_step": 4, "best_step": 4,
        })
        self.assertEqual(core.public_run(first)["summaries"]["loss"]["count"], 3)
        self.assertEqual(core.public_run(first)["summaries"]["loss"]["final"], 3)

    def test_intersection_can_have_no_common_steps_and_empty_panel(self):
        first = load_run(run_id="first", rows=[(1, {"loss": 8})])
        second = load_run(run_id="second", rows=[(2, {"loss": 7})])
        comparison = core.compare_runs([first, second], ["loss"], alignment="intersection")
        panel = panel_for(comparison)

        self.assertEqual(panel["steps"], [])
        self.assertTrue(panel["empty"])
        self.assertEqual([series["steps"] for series in panel["series"]], [[], []])
        self.assertEqual([series["values"] for series in panel["series"]], [[], []])
        for run_id in ("first", "second"):
            self.assertEqual(comparison["summaries"]["loss"][run_id], {
                "first": None, "last": None, "min": None, "max": None, "delta": None,
                "count": 0, "final": None, "best": None, "final_step": None, "best_step": None,
            })

    def test_missing_cells_all_missing_and_undeclared_runs_have_distinct_participation(self):
        measured = load_run(
            run_id="measured",
            rows=[(1, {"loss": 3}), (2, {"loss": None}), (4, {"loss": 1})],
            allow_missing=True,
        )
        all_missing = load_run(
            run_id="all-missing",
            rows=[(1, {"loss": None}), (2, {"loss": None})],
            allow_missing=True,
        )
        undeclared = load_run(
            run_id="undeclared",
            rows=[(1, {"accuracy": 0.5}), (2, {"accuracy": 0.7})],
            metric_defs={"accuracy": {"label": "Accuracy", "unit": "%", "direction": "max"}},
        )
        comparison = core.compare_runs([measured, all_missing, undeclared], ["loss"], alignment="union")
        panel = panel_for(comparison)

        self.assertEqual([series["run_id"] for series in panel["series"]], ["measured", "all-missing"])
        self.assertEqual(panel["steps"], [1, 2, 4])
        self.assertEqual(panel["series"][0]["values"], [3, None, 1])
        self.assertEqual(panel["series"][1]["values"], [None, None, None])
        self.assertNotIn("undeclared", comparison["summaries"]["loss"])
        self.assertEqual(comparison["summaries"]["loss"]["all-missing"]["count"], 0)

        intersection = core.compare_runs([measured, all_missing, undeclared], ["loss"], alignment="intersection")
        intersection_panel = panel_for(intersection)
        self.assertEqual(intersection_panel["steps"], [1, 2])
        self.assertEqual([series["values"] for series in intersection_panel["series"]], [
            [3, None], [None, None],
        ])
        self.assertEqual(intersection["summaries"]["loss"]["measured"], {
            "first": 3, "last": 3, "min": 3, "max": 3, "delta": 0,
            "count": 1, "final": 3, "best": 3, "final_step": 1, "best_step": 1,
        })

    def test_custom_parameters_and_standard_metadata_are_attached_to_series(self):
        run = load_run(
            run_id="configured",
            parameters={"optimizer": "adam", "lr": 0.001, "weight_decay": False, "note": None},
        )
        comparison = core.compare_runs([run], ["loss"])
        self.assertEqual(panel_for(comparison)["series"][0]["parameters"], {
            "seed": 7,
            "dataset": "toy",
            "model": "linear",
            "optimizer": "adam",
            "lr": 0.001,
            "weight_decay": False,
            "note": None,
        })

    def test_units_are_separate_panels_and_unsupported_alignment_is_rejected(self):
        score = load_run(run_id="score", rows=[(1, {"loss": 3})])
        milliseconds = load_run(
            run_id="milliseconds",
            rows=[(7, {"loss": 30})],
            metric_defs={"loss": {"label": "Loss", "unit": "ms", "direction": "min"}},
        )
        comparison = core.compare_runs([score, milliseconds], ["loss"], alignment="intersection")
        self.assertEqual([(panel["metric"], panel["unit"]) for panel in comparison["panels"]], [
            ("loss", "score"),
            ("loss", "ms"),
        ])
        self.assertEqual(panel_for(comparison)["steps"], [1])
        self.assertEqual(panel_for(comparison, unit="ms")["steps"], [7])
        self.assertEqual([series["values"] for series in panel_for(comparison)["series"]], [[3]])
        self.assertEqual([series["values"] for series in panel_for(comparison, unit="ms")["series"]], [[30]])
        with self.assertRaises(ValueError):
            core.compare_runs([score], ["loss"], alignment="nearest")

    def test_render_svg_accepts_alignment_plots_gaps_and_annotates_empty_panel(self):
        first = load_run(run_id="first", rows=[(1, {"loss": 8})])
        second = load_run(run_id="second", rows=[(2, {"loss": 7})])
        figure = core.render_svg([first, second], ["loss"], "No common steps", alignment="intersection")
        text = figure.decode("utf-8")
        self.assertIn("No common steps", text)
        self.assertIn("Loss [score] — No common steps", text)

        with_missing = load_run(
            run_id="gapped",
            rows=[
                (1, {"loss": 8}), (3, {"loss": None}), (7, {"loss": 4}), (9, {"loss": 2}),
            ],
            allow_missing=True,
        )
        gap_figure = core.render_svg([with_missing], ["loss"], "Gaps", alignment="independent")
        self.assertIn("Gaps", gap_figure.decode("utf-8"))
        # Inspect the real SVG data path (the legend path has no clipping).
        svg = ET.fromstring(gap_figure)
        data_paths = [
            path for path in svg.iter("{http://www.w3.org/2000/svg}path")
            if "clip-path" in path.attrib and "stroke: #6754d7;" in path.get("style", "")
        ]
        self.assertEqual(len(data_paths), 1)
        commands = data_paths[0].get("d").split()
        self.assertEqual(commands.count("M"), 2)
        self.assertEqual(commands.count("L"), 1)

        with self.assertRaises(ValueError):
            core.render_svg([with_missing], ["loss"], alignment="nearest")


class ExportAlignmentTests(unittest.TestCase):
    def _runs(self):
        duplicate = load_run(
            run_id="duplicate",
            rows=[
                (1, {"loss": 4}),
                (2, {"loss": 3}),
                (2, {"loss": None}),
                (5, {"loss": 1}),
            ],
            allow_missing=True,
            duplicate_steps="last",
        )
        other = load_run(
            run_id="other",
            rows=[(2, {"loss": 8}), (4, {"loss": 6})],
        )
        return [duplicate, other]

    def _archive_files(self, archive_bytes):
        with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
            return {name: archive.read(name) for name in archive.namelist()}

    def test_export_records_alignment_comparison_normalization_and_original_hashes(self):
        runs = self._runs()
        archive_bytes = core.build_export(runs, ["loss"], "Aligned export", alignment="union")
        files = self._archive_files(archive_bytes)
        expected_names = {
            "figure.svg",
            "figure.tex",
            "manifest.json",
            "comparison.json",
            "REPRODUCE.md",
            "sources/duplicate/metrics.csv",
            "sources/duplicate/metadata.json",
            "sources/other/metrics.csv",
            "sources/other/metadata.json",
        }
        self.assertEqual(set(files), expected_names)

        manifest = json.loads(files["manifest.json"])
        comparison = json.loads(files["comparison.json"])
        self.assertEqual(manifest["plot"]["alignment"], "union")
        self.assertEqual(comparison["alignment"], "union")
        self.assertEqual(manifest["comparison"], "comparison.json")
        self.assertEqual(manifest["comparison_sha256"], hashlib.sha256(files["comparison.json"]).hexdigest())
        self.assertEqual(panel_for(comparison)["steps"], [1, 2, 4, 5])
        self.assertEqual([series["values"] for series in panel_for(comparison)["series"]], [
            [4, None, None, 1], [None, 8, 6, None],
        ])
        self.assertEqual(comparison["summaries"]["loss"]["duplicate"], {
            "first": 4, "last": 1, "min": 1, "max": 4, "delta": -3,
            "count": 2, "final": 1, "best": 1, "final_step": 5, "best_step": 5,
        })
        for run, spec in zip(runs, manifest["runs"]):
            self.assertEqual(files[spec["csv"]], run["_csv_bytes"])
            self.assertEqual(files[spec["metadata"]], run["_metadata_bytes"])
            self.assertEqual(spec["csv_sha256"], hashlib.sha256(run["_csv_bytes"]).hexdigest())
            self.assertEqual(spec["metadata_sha256"], hashlib.sha256(run["_metadata_bytes"]).hexdigest())
            combined = hashlib.sha256()
            for source in (run["_csv_bytes"], run["_metadata_bytes"]):
                combined.update(len(source).to_bytes(8, "big"))
                combined.update(source)
            self.assertEqual(spec["run_sha256"], combined.hexdigest())
        self.assertEqual(manifest["runs"][0]["normalization"], {
            "allow_missing": True,
            "duplicate_steps": "last",
            "duplicates_collapsed": 1,
            "source_rows": 4,
        })
        self.assertEqual(manifest["runs"][1]["normalization"], {
            "allow_missing": False,
            "duplicate_steps": "error",
            "duplicates_collapsed": 0,
            "source_rows": 2,
        })
        self.assertIn("alignment", files["REPRODUCE.md"].decode("utf-8"))

    def test_export_and_reproduce_are_deterministic_for_all_alignment_modes(self):
        runs = self._runs()
        for alignment in ("independent", "intersection", "union"):
            with self.subTest(alignment=alignment):
                first = core.build_export(runs, ["loss"], "Deterministic", alignment=alignment)
                second = core.build_export(runs, ["loss"], "Deterministic", alignment=alignment)
                self.assertEqual(first, second)
                with tempfile.TemporaryDirectory() as directory:
                    root = Path(directory)
                    with zipfile.ZipFile(io.BytesIO(first)) as archive:
                        archive.extractall(root)
                    reproduced = core.reproduce(root / "manifest.json", root / "reproduced.svg")
                    self.assertEqual(reproduced, (root / "figure.svg").read_bytes())
                    self.assertEqual(reproduced, (root / "reproduced.svg").read_bytes())
                    manifest = json.loads((root / "manifest.json").read_text())
                    self.assertEqual(manifest["plot"]["alignment"], alignment)
                    comparison = json.loads((root / "comparison.json").read_text())
                    self.assertEqual(comparison["alignment"], alignment)
                    self.assertEqual(
                        comparison["summaries"]["loss"]["duplicate"]["count"],
                        0 if alignment == "intersection" else 2,
                    )

    def test_reproduce_legacy_manifest_defaults_to_strict_independent(self):
        run = load_run(run_id="legacy", rows=[(1, {"loss": 3}), (2, {"loss": 1})])
        archive = self._archive_files(core.build_export([run], ["loss"], "Legacy"))
        manifest = json.loads(archive["manifest.json"])
        manifest["plot"].pop("alignment", None)
        manifest.pop("comparison", None)
        manifest.pop("comparison_sha256", None)
        for spec in manifest["runs"]:
            spec.pop("normalization", None)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
            for name, content in archive.items():
                if name not in {"manifest.json", "comparison.json"}:
                    path = root / name
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(content)
            output = root / "legacy.svg"
            reproduced = core.reproduce(root / "manifest.json", output)
            self.assertEqual(reproduced, archive["figure.svg"])

    def test_export_rejects_unsupported_alignment(self):
        run = load_run()
        with self.assertRaises(ValueError):
            core.build_export([run], ["loss"], "Invalid", alignment="nearest")


if __name__ == "__main__":
    unittest.main()
