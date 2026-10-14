#!/usr/bin/env python3
"""Unit tests for the track contract validator and CSV importer."""

import copy
import csv
from collections import Counter
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest

from scripts.generate_render_fixture import (
    DEFAULT_EVENTS_PER_TRACK,
    DEFAULT_TRACK_COUNT,
    RENDER_EVENT_BUDGET,
    build_document,
    main as generate_main,
    write_csv,
)
from scripts.import_tracks import import_csv, main as import_main, validate_document


ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "public" / "data" / "silicon-cascade.json"
RENDER_FIXTURE = ROOT / "fixtures" / "synthetic-render-load.csv"


class ImportTracksTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with FIXTURE.open(encoding="utf-8") as handle:
            cls.document = json.load(handle)

    def assertInvalid(self, document, message):
        with self.assertRaisesRegex(ValueError, message):
            validate_document(document)

    def test_valid_fixture(self):
        validate_document(self.document)
        self.assertEqual(len(self.document["tracks"]), 41)
        self.assertEqual(max(event["timeFs"] for track in self.document["tracks"]
                             for event in track["events"]), 240)

    def test_invalid_energy(self):
        document = copy.deepcopy(self.document)
        document["tracks"][0]["events"][0]["depositedEnergyEv"] = -1
        self.assertInvalid(document, r"depositedEnergyEv: must be >= 0")

    def test_missing_parent(self):
        document = copy.deepcopy(self.document)
        document["tracks"][0]["parentId"] = 99999
        self.assertInvalid(document, r"missing parent 99999")

    def test_duplicate_id(self):
        document = copy.deepcopy(self.document)
        document["tracks"][1]["ionId"] = document["tracks"][0]["ionId"]
        self.assertInvalid(document, r"duplicate id")

    def test_nonfinite(self):
        document = copy.deepcopy(self.document)
        document["tracks"][0]["events"][0]["timeFs"] = float("nan")
        self.assertInvalid(document, r"timeFs: expected a finite number")

    def test_time_ordering(self):
        document = copy.deepcopy(self.document)
        events = document["tracks"][0]["events"]
        events[1]["timeFs"] = events[2]["timeFs"] + 1
        self.assertInvalid(document, r"events must be chronological")

    def test_csv_grouping(self):
        rows = [
            {"ion_id": "2", "parent_id": "", "species": "Ar", "kind": "primary",
             "time_fs": "12", "x_nm": "1", "y_nm": "2", "z_nm": "8",
             "deposited_energy_ev": "20"},
            {"ion_id": "1", "parent_id": "null", "species": "Ar", "kind": "primary",
             "time_fs": "0", "x_nm": "0", "y_nm": "0", "z_nm": "0",
             "deposited_energy_ev": "30"},
            {"ion_id": "2", "parent_id": "", "species": "Ar", "kind": "primary",
             "time_fs": "18", "x_nm": "2", "y_nm": "3", "z_nm": "12",
             "deposited_energy_ev": "15"},
        ]
        with tempfile.TemporaryDirectory() as directory:
            csv_path = Path(directory) / "events.csv"
            with csv_path.open("w", newline="", encoding="utf-8") as handle:
                writer = csv.DictWriter(handle, fieldnames=rows[0].keys())
                writer.writeheader()
                writer.writerows(rows)
            document = import_csv(csv_path)
        self.assertEqual([track["ionId"] for track in document["tracks"]], [2, 1])
        self.assertEqual(len(document["tracks"][0]["events"]), 2)
        self.assertEqual(document["tracks"][0]["events"][1]["positionNm"], [2.0, 3.0, 12.0])
        self.assertEqual(document["metadata"]["targetSizeNm"], [100, 100, 160])
        self.assertEqual(document["tracks"][0]["events"], [
            {"timeFs": 12.0, "positionNm": [1.0, 2.0, 8.0], "depositedEnergyEv": 20.0},
            {"timeFs": 18.0, "positionNm": [2.0, 3.0, 12.0], "depositedEnergyEv": 15.0},
        ])

    def test_event_type_is_optional_in_json_and_csv(self):
        document = copy.deepcopy(self.document)
        document["tracks"][0]["events"][0]["eventType"] = "collision"
        validate_document(document)

        rows = [{
            "ion_id": "1", "parent_id": "", "species": "Ar", "kind": "primary",
            "event_type": "  collision  ", "time_fs": "0", "x_nm": "0", "y_nm": "0",
            "z_nm": "0", "deposited_energy_ev": "5",
        }, {
            "ion_id": "1", "parent_id": "", "species": "Ar", "kind": "primary",
            "event_type": "", "time_fs": "1", "x_nm": "1", "y_nm": "0",
            "z_nm": "1", "deposited_energy_ev": "4",
        }]
        rows.extend(dict(rows[1], time_fs=str(index + 2), event_type=event_type)
                    for index, event_type in enumerate((" \t ", "Custom label", "termination")))
        with tempfile.TemporaryDirectory() as directory:
            csv_path = Path(directory) / "events-with-types.csv"
            with csv_path.open("w", newline="", encoding="utf-8") as handle:
                writer = csv.DictWriter(handle, fieldnames=list(reversed(rows[0].keys())))
                writer.writeheader()
                writer.writerows(rows)
            imported = import_csv(csv_path)
            output = Path(directory) / "tracks.json"
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(import_main([str(csv_path), str(output)]), 0)
            self.assertEqual(json.loads(output.read_text(encoding="utf-8")), imported)
        self.assertEqual(imported["tracks"][0]["events"][0]["eventType"], "collision")
        self.assertNotIn("eventType", imported["tracks"][0]["events"][1])
        self.assertNotIn("eventType", imported["tracks"][0]["events"][2])
        self.assertEqual(imported["tracks"][0]["events"][3]["eventType"], "Custom label")
        self.assertEqual(imported["tracks"][0]["events"][4]["eventType"], "termination")

    def test_event_type_must_be_nonempty_when_present(self):
        for value in (None, False, 12, [], {}, "", "  "):
            with self.subTest(value=value):
                document = copy.deepcopy(self.document)
                document["tracks"][0]["events"][0]["eventType"] = value
                self.assertInvalid(document, r"tracks\[0\].events\[0\].eventType: expected a nonempty string")

    def test_generated_render_fixture_counts(self):
        generated = build_document()
        validate_document(generated)
        self.assertEqual(len(generated["tracks"]), DEFAULT_TRACK_COUNT)
        self.assertEqual(
            sum(len(track["events"]) for track in generated["tracks"]),
            DEFAULT_TRACK_COUNT * DEFAULT_EVENTS_PER_TRACK,
        )
        self.assertGreater(
            DEFAULT_TRACK_COUNT * DEFAULT_EVENTS_PER_TRACK,
            RENDER_EVENT_BUDGET,
        )

        imported = import_csv(RENDER_FIXTURE)
        self.assertEqual(len(imported["tracks"]), DEFAULT_TRACK_COUNT)
        events = [event for track in imported["tracks"] for event in track["events"]]
        self.assertEqual(len(events), DEFAULT_TRACK_COUNT * DEFAULT_EVENTS_PER_TRACK)
        self.assertEqual({event["eventType"] for event in events}, {
            "ionization", "collision", "scattering", "termination",
        })
        self.assertEqual(imported["tracks"], generated["tracks"])
        # Literal totals protect the workload against accidental downsizing.
        self.assertEqual((len(imported["tracks"]), len(events)), (320, 20480))
        self.assertEqual(Counter(track["kind"] for track in imported["tracks"]),
                         {"primary": 8, "recoil": 312})
        self.assertEqual(Counter(event["eventType"] for event in events), {
            "ionization": 5120, "collision": 5120,
            "scattering": 5120, "termination": 5120,
        })
        self.assertEqual(sum(len(track["events"]) - 1 for track in imported["tracks"]), 20160)
        self.assertEqual(max(event["timeFs"] for event in events), 254)
        for event in events:
            x, y, z = event["positionNm"]
            self.assertTrue(-50 <= x <= 50 and -50 <= y <= 50 and 0 <= z <= 160)
            self.assertTrue(1 <= event["depositedEnergyEv"] <= 240)
        self.assertLess(RENDER_FIXTURE.stat().st_size, 1_500_000)

    def test_generated_fixture_is_reproducible_and_json_cli_is_valid(self):
        with tempfile.TemporaryDirectory() as directory:
            csv_path = Path(directory) / "generated.csv"
            write_csv(build_document(), csv_path)
            self.assertEqual(csv_path.read_bytes(), RENDER_FIXTURE.read_bytes())
            json_path = Path(directory) / "generated.json"
            with contextlib.redirect_stdout(io.StringIO()):
                generate_main(["--output", str(json_path)])
            document = json.loads(json_path.read_text(encoding="utf-8"))
            validate_document(document)
            self.assertEqual(document, build_document())
            self.assertIn("not a physics simulation", document["metadata"]["description"])


if __name__ == "__main__":
    unittest.main()
