import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import core


def make_sources(metric="loss", unit="score", rows=None, run_id="run-1"):
    rows = rows or [(1, 3.0), (2, 2.0), (3, 1.5)]
    metadata = {
        "id": run_id,
        "name": "Baseline run",
        "description": "test run",
        "seed": 7,
        "dataset": "toy",
        "model": "linear",
        "metrics": {
            metric: {"label": "Loss", "unit": unit, "direction": "min"},
        },
    }
    csv_data = "step,{0}\n".format(metric) + "\n".join(f"{step},{value}" for step, value in rows) + "\n"
    return csv_data.encode(), json.dumps(metadata, separators=(",", ":")).encode()


class CoreEngineTests(unittest.TestCase):
    def test_load_public_run_and_summaries(self):
        csv_data, metadata_data = make_sources(rows=[(1, 3), (2, 2.5), (4, 1)])
        run = core.load_run(csv_data, metadata_data)
        public = core.public_run(run)

        self.assertEqual(public["id"], "run-1")
        self.assertEqual(public["rows"], [
            {"step": 1, "loss": 3},
            {"step": 2, "loss": 2.5},
            {"step": 4, "loss": 1},
        ])
        self.assertEqual(public["summaries"]["loss"], {
            "first": 3,
            "last": 1,
            "min": 1,
            "max": 3,
            "delta": -2,
            "count": 3,
        })
        self.assertEqual(public["files"][0]["sha256"], hashlib.sha256(csv_data).hexdigest())
        json.dumps(public)
        self.assertNotIn("_csv_bytes", public)

    def test_invalid_data_has_human_errors(self):
        cases = [
            (b"step,loss\n1,2\n1,3\n", "repeats step"),
            (b"step,loss\n2,2\n1,3\n", "not increasing"),
            (b"step,loss\n1,NaN\n", "non-finite"),
            (b"step,loss\n1,\n", "missing data"),
            (b"step,loss\n1,abc\n", "non-numeric"),
            (b"step\n1\n", "missing declared metric"),
            (b"step,loss,extra\n1,2,3\n", "undeclared"),
        ]
        _, metadata_data = make_sources()
        for csv_data, message in cases:
            with self.subTest(message=message):
                with self.assertRaisesRegex(ValueError, message):
                    core.load_run(csv_data, metadata_data)
        with self.assertRaisesRegex(ValueError, "path traversal"):
            core.load_run(b"step,loss\n1,2\n", metadata_data, "../metrics.csv")

    def test_metadata_schema_and_safe_identifiers(self):
        csv_data, metadata_data = make_sources()
        metadata = json.loads(metadata_data)
        metadata["id"] = "../unsafe"
        with self.assertRaisesRegex(ValueError, "metadata.id"):
            core.load_run(csv_data, json.dumps(metadata).encode())
        metadata = json.loads(metadata_data)
        metadata["metrics"]["bad/key"] = metadata["metrics"].pop("loss")
        with self.assertRaisesRegex(ValueError, "metric key"):
            core.load_run(csv_data.replace(b"loss", b"bad/key"), json.dumps(metadata).encode())

    def test_units_are_isolated_into_separate_panels(self):
        csv_a, metadata_a = make_sources(unit="ms", run_id="run-ms")
        csv_b, metadata_b = make_sources(unit="seconds", run_id="run-seconds")
        svg = core.render_svg(
            [core.load_run(csv_a, metadata_a), core.load_run(csv_b, metadata_b)], ["loss"], "Units"
        )
        text = svg.decode("utf-8")
        self.assertTrue(text.startswith("<?xml"))
        self.assertIn("Loss [ms]", text)
        self.assertIn("Loss [seconds]", text)
        self.assertGreaterEqual(text.count("<g id=\"axes_"), 2)

    def test_svg_is_deterministic_and_contains_actual_data_text(self):
        csv_data, metadata_data = make_sources()
        run = core.load_run(csv_data, metadata_data)
        first = core.render_svg([run], ["loss"], "Experiment comparison")
        second = core.render_svg([run], ["loss"], "Experiment comparison")
        self.assertEqual(first, second)
        decoded = first.decode("utf-8")
        self.assertIn("Experiment comparison", decoded)
        self.assertIn("Baseline run", decoded)
        self.assertIn("Loss [score]", decoded)
        with self.assertRaisesRegex(ValueError, "none.*data"):
            core.render_svg([run], ["unknown"])

    def test_export_contains_sources_and_reproduces(self):
        csv_data, metadata_data = make_sources()
        run = core.load_run(csv_data, metadata_data)
        archive_bytes = core.build_export([run], ["loss"], "Exported experiment")
        with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
            names = archive.namelist()
            self.assertEqual(names[:4], ["figure.svg", "figure.tex", "manifest.json", "REPRODUCE.md"])
            self.assertIn("sources/run-1/metrics.csv", names)
            self.assertIn("sources/run-1/metadata.json", names)
            manifest = json.loads(archive.read("manifest.json"))
            self.assertEqual(manifest["schema_version"], 1)
            self.assertEqual(manifest["runs"][0]["csv_sha256"], hashlib.sha256(csv_data).hexdigest())
            self.assertEqual(manifest["runs"][0]["metadata_sha256"], hashlib.sha256(metadata_data).hexdigest())
            self.assertIn("matplotlib", manifest["software"])
            self.assertIn("\\includesvg", archive.read("figure.tex").decode())

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
                archive.extractall(root)
            output = root / "regenerated.svg"
            reproduced = core.reproduce(root / "manifest.json", output)
            self.assertEqual(reproduced, (root / "figure.svg").read_bytes())
            self.assertEqual(reproduced, output.read_bytes())
            command = [sys.executable, str(Path(core.__file__)), "reproduce", str(root / "manifest.json"), "--output", str(root / "cli.svg")]
            result = subprocess.run(command, capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((root / "cli.svg").read_bytes(), reproduced)

    def test_reproduction_detects_tampered_source_and_unsafe_manifest_path(self):
        csv_data, metadata_data = make_sources()
        run = core.load_run(csv_data, metadata_data)
        archive_bytes = core.build_export([run], ["loss"], "Tamper test")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
                archive.extractall(root)
            source = root / "sources/run-1/metrics.csv"
            source.write_bytes(source.read_bytes().replace(b"3.0", b"9.0"))
            with self.assertRaisesRegex(ValueError, "input hash mismatch"):
                core.reproduce(root / "manifest.json", root / "out.svg")
            manifest_path = root / "manifest.json"
            manifest = json.loads(manifest_path.read_text())
            manifest["runs"][0]["csv"] = "../outside.csv"
            manifest_path.write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError, "escapes"):
                core.reproduce(manifest_path, root / "out.svg")


if __name__ == "__main__":
    unittest.main()
