import csv
import io
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

from ga4gh_qc import apply_fix, check_document, export_document, filter_issues, issue_sort_key
from ga4gh_qc.core import issues_csv
from ga4gh_qc.loader import InputError, load_json


ROOT = Path(__file__).parent


class CheckerTests(unittest.TestCase):
    def fixture(self, name):
        return load_json(ROOT / "fixtures" / name)

    def test_valid_synthetic_bundle_has_no_errors(self):
        report = check_document(self.fixture("valid.json"))
        self.assertTrue(report["valid"])
        self.assertEqual({"error": 0, "warning": 0, "info": 0}, report["summary"])
        self.assertEqual(1, report["record_counts"]["specimens"])

    def test_duplicate_specimen_is_reported_and_deterministic(self):
        document = self.fixture("valid.json")
        duplicate = dict(document["specimens"][0])
        document["specimens"].append(duplicate)
        first = check_document(document)
        reordered = dict(document)
        reordered["specimens"] = list(reversed(document["specimens"]))
        second = check_document(reordered)
        first_ids = [(issue["code"], issue["entity_id"], issue["path"]) for issue in first["issues"]]
        second_ids = [(issue["code"], issue["entity_id"], issue["path"]) for issue in second["issues"]]
        self.assertIn(("DUPLICATE_IDENTIFIER", "SP-001", "/specimens"), first_ids)
        self.assertEqual(first_ids, second_ids)

    def test_conflicting_consent_is_subject_level_issue(self):
        document = self.fixture("valid.json")
        document["specimens"].append({
            "specimen_id": "SP-002", "subject_id": "SUBJ-001", "specimen_type": "saliva",
            "collection_date": "2026-01-12", "consent_status": "withdrawn",
        })
        report = check_document(document)
        conflicts = [issue for issue in report["issues"] if issue["code"] == "CONFLICTING_CONSENT"]
        self.assertEqual(1, len(conflicts))
        self.assertEqual("SUBJ-001", conflicts[0]["entity_id"])
        self.assertFalse(report["valid"])

    def test_missing_provenance_is_not_hidden_by_valid_relationships(self):
        document = self.fixture("valid.json")
        del document["sequencing_runs"][0]["provenance"]["reference_genome"]
        report = check_document(document)
        provenance = [issue for issue in report["issues"] if issue["code"] == "MISSING_PROVENANCE"]
        self.assertEqual(1, len(provenance))
        self.assertEqual("/sequencing_runs/0/provenance/reference_genome", provenance[0]["path"])

    def test_required_field_has_dependency_aware_fix(self):
        document = self.fixture("valid.json")
        del document["specimens"][0]["specimen_type"]
        report = check_document(document)
        missing = next(issue for issue in report["issues"] if issue["code"] == "REQUIRED_FIELD" and issue["entity_type"] == "specimen")
        dependent = next(issue for issue in report["issues"] if issue["code"] == "SAMPLE_COMPATIBILITY")
        self.assertIn(missing["issue_id"], dependent["dependencies"])
        with self.assertRaises(ValueError):
            apply_fix(document, dependent["issue_id"], "blood")
        fixed, _ = apply_fix(document, missing["issue_id"], "blood")
        self.assertEqual(0, check_document(fixed)["summary"]["error"])
        self.assertNotIn("SAMPLE_COMPATIBILITY", {issue["code"] for issue in check_document(fixed)["issues"]})

    def test_unknown_vocab_and_relationships_are_searchable(self):
        document = self.fixture("mixed.json")
        report = check_document(document)
        self.assertTrue(filter_issues(report, search="MISSING_RUN_REFERENCE"))
        self.assertTrue(filter_issues(report, search="SP-404"))
        self.assertTrue(filter_issues(report, severity="warning"))
        self.assertTrue(any(issue["code"] == "CONTROLLED_VOCABULARY" for issue in report["issues"]))

    def test_consent_scope_values_use_controlled_vocabularies(self):
        document = self.fixture("valid.json")
        document["consent_scopes"][0]["scope"] = "clinical"
        document["consent_scopes"][0]["status"] = "maybe"
        codes = {issue["code"] for issue in check_document(document)["issues"]}
        self.assertIn("CONTROLLED_VOCABULARY", codes)

    def test_privacy_safe_export_is_deterministic_and_restrictive(self):
        document = self.fixture("mixed.json")
        first = export_document(document, privacy_safe=True)
        second = export_document(document, privacy_safe=True)
        self.assertEqual(first, second)
        payload = json.dumps(first, sort_keys=True)
        self.assertNotIn("Synthetic Withdrawn Person", payload)
        self.assertNotIn("withdrawn@example.invalid", payload)
        self.assertNotIn('"subject_id": "SUBJ-002"', payload)
        self.assertTrue(all(item.get("subject_id") != "SUBJ-002" for item in first["specimens"]))

    def test_json_and_csv_reports_are_stable_and_semantically_equivalent(self):
        report = check_document(self.fixture("mixed.json"))
        json_one = json.dumps(report, sort_keys=True, indent=2) + "\n"
        json_two = json.dumps(check_document(self.fixture("mixed.json")), sort_keys=True, indent=2) + "\n"
        self.assertEqual(json_one, json_two)
        csv_one = issues_csv(report["issues"])
        csv_two = issues_csv(report["issues"])
        self.assertEqual(csv_one, csv_two)
        rows = list(csv.DictReader(io.StringIO(csv_one)))
        self.assertEqual(len(report["issues"]), len(rows))
        self.assertEqual(report["issues"][0]["code"], rows[0]["code"])

    def test_issue_order_is_error_then_warning_then_info(self):
        issues = [
            {"issue_id": "INFO-1", "severity": "info", "code": "A", "entity_type": "x", "entity_id": "1", "path": "/a"},
            {"issue_id": "WARN-1", "severity": "warning", "code": "Z", "entity_type": "x", "entity_id": "1", "path": "/z"},
            {"issue_id": "ERROR-2", "severity": "error", "code": "Z", "entity_type": "x", "entity_id": "2", "path": "/z"},
            {"issue_id": "ERROR-1", "severity": "error", "code": "A", "entity_type": "x", "entity_id": "1", "path": "/a"},
        ]
        report = {"issues": list(reversed(issues))}
        ordered = filter_issues(report)
        self.assertEqual(["ERROR-1", "ERROR-2", "WARN-1", "INFO-1"], [issue["issue_id"] for issue in ordered])
        self.assertEqual(sorted(issues, key=issue_sort_key), ordered)

    def test_empty_issue_csv_has_header_only(self):
        csv_text = issues_csv([])
        self.assertEqual(["issue_id", "severity", "code", "entity_type", "entity_id", "path", "status", "message", "dependencies", "suggested_values"], next(csv.reader(io.StringIO(csv_text))))
        self.assertEqual(1, csv_text.count("\n"))

    def test_duplicate_json_keys_are_rejected(self):
        path = ROOT / "duplicate.json"
        path.write_text('{"specimens": [], "specimens": []}', encoding="utf-8")
        try:
            with self.assertRaises(InputError):
                load_json(path)
        finally:
            path.unlink()


if __name__ == "__main__":
    unittest.main()
