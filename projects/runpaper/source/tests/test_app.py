import io
import base64
import json
import sys
from pathlib import Path
import unittest
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app


class BrowserApiTests(unittest.TestCase):
    def setUp(self):
        self.client = app.app.test_client()
        self.original_runs = app.RUNS.copy()

    def tearDown(self):
        app.RUNS.clear()
        app.RUNS.update(self.original_runs)

    def test_bundled_runs_and_real_plot_endpoint(self):
        response = self.client.get("/api/runs")
        self.assertEqual(response.status_code, 200)
        self.assertEqual({run["id"] for run in response.get_json()["runs"]}, {"baseline", "cosine", "warmup"})

        plot = self.client.post(
            "/api/plot",
            json={"run_ids": ["baseline", "cosine"], "metrics": ["val_loss"], "title": "Imported values"},
        )
        self.assertEqual(plot.status_code, 200)
        self.assertTrue(plot.content_type.startswith("image/svg+xml"))
        self.assertIn(b"Imported values", plot.data)

    def test_multipart_import_is_validated_and_used_in_export(self):
        metadata = {
            "id": "api-upload",
            "name": "API upload",
            "metrics": {"loss": {"label": "Loss", "unit": "nats", "direction": "min"}},
        }
        csv_data = b"step,loss\n0,3.5\n10,1.25\n"
        response = self.client.post(
            "/api/import",
            data={
                "csv": (io.BytesIO(csv_data), "uploaded.csv"),
                "metadata": (io.BytesIO(json.dumps(metadata).encode()), "uploaded.json"),
            },
            content_type="multipart/form-data",
        )
        self.assertEqual(response.status_code, 201)
        imported = response.get_json()["run"]
        self.assertEqual(imported["summaries"]["loss"]["delta"], -2.25)
        self.assertEqual(imported["rows"][-1], {"step": 10, "loss": 1.25})

        export = self.client.post(
            "/api/export",
            json={"run_ids": ["api-upload"], "metrics": ["loss"], "title": "Upload"},
        )
        self.assertEqual(export.status_code, 200)
        self.assertEqual(export.content_type, "application/zip")
        self.assertGreater(len(export.data), 1000)

    def test_api_rejects_missing_selection(self):
        response = self.client.post("/api/plot", json={"run_ids": [], "metrics": ["val_loss"]})
        self.assertEqual(response.status_code, 400)
        self.assertIn("select at least one run", response.get_json()["error"])

    def test_export_preview_matches_complete_saved_bundle(self):
        for alignment in ("independent", "intersection", "union"):
            with self.subTest(alignment=alignment):
                payload = {"run_ids": ["baseline", "cosine"], "metrics": ["val_loss"],
                           "title": "Paper #1 & 95%", "alignment": alignment}
                response = self.client.post("/api/export/preview", json=payload)
                self.assertEqual(response.status_code, 200)
                preview = response.get_json()
                saved = self.client.post("/api/export", json=payload)
                self.assertEqual(saved.status_code, 200)
                self.assertEqual(saved.data, self.client.post("/api/export", json=payload).data)
                self.assertEqual(preview["byte_size"], len(saved.data))
                with zipfile.ZipFile(io.BytesIO(saved.data)) as archive:
                    self.assertEqual([entry["name"] for entry in preview["entries"]], archive.namelist())
                    for entry in preview["entries"]:
                        self.assertEqual(entry["size"], len(archive.read(entry["name"])))
                    self.assertEqual(preview["manifest"], json.loads(archive.read("manifest.json")))
                    self.assertEqual(preview["comparison"], json.loads(archive.read("comparison.json")))
                    self.assertEqual(preview["latex"], archive.read("figure.tex").decode())
                    self.assertEqual(base64.b64decode(preview["preview_svg"].split(",", 1)[1]), archive.read("figure.svg"))
                self.assertEqual(preview["comparison"]["alignment"], alignment)

    def test_preview_rejects_invalid_selection_and_alignment(self):
        for payload in ({}, {"run_ids": ["missing"], "metrics": ["val_loss"]},
                        {"run_ids": ["baseline"], "metrics": ["val_loss"], "alignment": "guess"}):
            response = self.client.post("/api/export/preview", json=payload)
            self.assertEqual(response.status_code, 400)
            self.assertIn("error", response.get_json())

    def test_browser_import_handles_blanks_and_explicit_duplicates(self):
        metadata = {"id": "sparse", "name": "Sparse", "metrics": {
            "loss": {"label": "Loss", "unit": "nats", "direction": "min"}}}
        response = self.client.post("/api/import", data={
            "csv": (io.BytesIO(b"step,loss\n0,4\n0,3\n9,\n20,1\n"), "sparse.csv"),
            "metadata": (io.BytesIO(json.dumps(metadata).encode()), "sparse.json"),
            "duplicate_steps": "last",
        })
        self.assertEqual(response.status_code, 201)
        run = response.get_json()["run"]
        self.assertEqual(run["normalization"]["duplicates_collapsed"], 1)
        self.assertEqual(run["summaries"]["loss"]["count"], 2)
        self.assertEqual(run["rows"][1]["loss"], None)


if __name__ == "__main__":
    unittest.main()
