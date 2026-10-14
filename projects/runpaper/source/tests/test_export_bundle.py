import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import core


def make_run():
    metadata = {
        "id": "run-special",
        "name": "Run #1 & $final_{}",
        "description": "kept in the source metadata",
        "seed": 11,
        "metrics": {
            "metric_1": {
                "label": "Metric # $ % & _ { }",
                "unit": "u_&%",
                "direction": "min",
            }
        },
    }
    csv_data = b"step,metric_1\n1,4.5\n2,2.0\n"
    return core.load_run(
        csv_data,
        json.dumps(metadata, separators=(",", ":")).encode(),
        "uploaded.csv",
        "uploaded.json",
    ), csv_data, metadata


def read_archive(data):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        return {name: archive.read(name) for name in archive.namelist()}


class ExportBundleTests(unittest.TestCase):
    def test_bundle_contains_comparison_and_each_source_metadata(self):
        run, csv_data, metadata = make_run()
        files = read_archive(core.build_export([run], ["metric_1"], "Title"))

        self.assertIn("comparison.json", files)
        self.assertEqual(files["sources/run-special/metrics.csv"], csv_data)
        self.assertEqual(
            json.loads(files["sources/run-special/metadata.json"]), metadata
        )

    def test_comparison_contains_actual_rows_selected_metadata_and_summaries(self):
        run, _, metadata = make_run()
        comparison = json.loads(
            read_archive(core.build_export([run], ["metric_1"], "Title"))["comparison.json"]
        )

        self.assertEqual(comparison["plot"]["title"], "Title")
        self.assertEqual(comparison["selected_runs"][0]["metadata"], metadata)
        self.assertEqual(comparison["selected_runs"][0]["rows"], [
            {"step": 1, "metric_1": 4.5},
            {"step": 2, "metric_1": 2},
        ])
        self.assertEqual(comparison["selected_runs"][0]["summaries"]["metric_1"]["last"], 2)
        self.assertEqual(comparison["metric_definitions"][0]["label"], metadata["metrics"]["metric_1"]["label"])
        self.assertEqual(comparison["panels"][0]["series"][0]["values"], [4.5, 2])

    def test_manifest_records_and_reproduce_validates_comparison_hash(self):
        run, _, _ = make_run()
        files = read_archive(core.build_export([run], ["metric_1"], "Title"))
        manifest = json.loads(files["manifest.json"])
        comparison_hash = hashlib.sha256(files["comparison.json"]).hexdigest()
        self.assertEqual(manifest["comparison"], "comparison.json")
        self.assertEqual(manifest["comparison_sha256"], comparison_hash)
        self.assertEqual(manifest["artifacts"]["comparison"]["sha256"], comparison_hash)
        self.assertEqual(
            manifest["artifacts"]["figure"]["sha256"],
            hashlib.sha256(files["figure.svg"]).hexdigest(),
        )
        self.assertEqual(
            manifest["artifacts"]["latex"]["sha256"],
            hashlib.sha256(files["figure.tex"]).hexdigest(),
        )
        self.assertEqual(
            manifest["artifacts"]["reproduce"]["sha256"],
            hashlib.sha256(files["REPRODUCE.md"]).hexdigest(),
        )
        source_hashes = {
            record["path"]: record["sha256"]
            for record in manifest["artifacts"]["sources"]
        }
        self.assertEqual(
            source_hashes["sources/run-special/metrics.csv"],
            hashlib.sha256(files["sources/run-special/metrics.csv"]).hexdigest(),
        )
        self.assertEqual(manifest["plot"]["options"]["format"], "svg")

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name, content in files.items():
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(content)
            comparison_path = root / "comparison.json"
            comparison_path.write_bytes(comparison_path.read_bytes() + b" ")
            with self.assertRaisesRegex(ValueError, "comparison hash mismatch"):
                core.reproduce(root / "manifest.json", root / "reproduced.svg")

            manifest["artifacts"]["comparison"]["sha256"] = "0" * 64
            (root / "manifest.json").write_bytes(
                (json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n").encode()
            )
            comparison_path.write_bytes(files["comparison.json"])
            with self.assertRaisesRegex(ValueError, "artifact hash mismatch"):
                core.reproduce(root / "manifest.json", root / "reproduced.svg")

    def test_latex_escapes_title_metric_unit_and_run_labels(self):
        run, _, _ = make_run()
        tex = read_archive(
            core.build_export([run], ["metric_1"], "Title # $ % & _ { }")
        )["figure.tex"].decode()

        for escaped in (r"\#", r"\$", r"\%", r"\&", r"\_", r"\{", r"\}"):
            self.assertIn(escaped, tex)
        self.assertIn(r"\captionof{figure}", tex)

    def test_two_builds_are_byte_identical_and_reproduction_matches_figure(self):
        run, _, _ = make_run()
        first = core.build_export([run], ["metric_1"], "Title")
        self.assertEqual(first, core.build_export([run], ["metric_1"], "Title"))
        files = read_archive(first)

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name, content in files.items():
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(content)
            self.assertEqual(
                core.reproduce(root / "manifest.json", root / "reproduced.svg"),
                files["figure.svg"],
            )

    def test_reproduction_rejects_tampered_comparison_or_source(self):
        run, _, _ = make_run()
        files = read_archive(core.build_export([run], ["metric_1"], "Title"))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name, content in files.items():
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(content)

            source = root / "sources/run-special/metadata.json"
            source.write_bytes(source.read_bytes().replace(b"Run #1", b"Run #2"))
            with self.assertRaisesRegex(ValueError, "input hash mismatch"):
                core.reproduce(root / "manifest.json", root / "out.svg")


if __name__ == "__main__":
    unittest.main()
