import copy
import unittest
from pathlib import Path

from ga4gh_qc import apply_fix, check_document, export_document
from ga4gh_qc.loader import load_json


ROOT = Path(__file__).parent


class ConsentConflictFixTests(unittest.TestCase):
    def document_with_conflict(self):
        document = load_json(ROOT / "fixtures" / "valid.json")
        document["specimens"].extend([
            {
                "specimen_id": "SP-002",
                "subject_id": "SUBJ-001",
                "specimen_type": "saliva",
                "collection_date": "2026-01-12",
                "consent_status": "withdrawn",
            },
            {
                "specimen_id": "SP-003",
                "subject_id": "SUBJ-001",
                "specimen_type": "tissue",
                "collection_date": "2026-01-13",
                "consent_status": "pending",
            },
            {
                "specimen_id": "SP-OTHER",
                "subject_id": "SUBJ-OTHER",
                "specimen_type": "blood",
                "collection_date": "2026-01-14",
                "consent_status": "approved",
            },
        ])
        document["consent_scopes"].extend([
            {
                "consent_id": "CON-002",
                "subject_id": "SUBJ-001",
                "scope": "broad",
                "status": "withdrawn",
            },
            {
                "consent_id": "CON-003",
                "subject_id": "SUBJ-001",
                "scope": "research-only",
                "status": "pending",
            },
            {
                "consent_id": "CON-OTHER",
                "subject_id": "SUBJ-OTHER",
                "scope": "genomics",
                "status": "approved",
            },
        ])
        document["phenotypes"].append({
            "phenotype_id": "PH-OTHER",
            "subject_id": "SUBJ-OTHER",
            "term": "HP:0000002",
            "source": "HPO",
        })
        return document

    def conflict_issue(self, document):
        conflicts = [
            issue for issue in check_document(document)["issues"]
            if issue["code"] == "CONFLICTING_CONSENT"
        ]
        self.assertEqual(1, len(conflicts))
        return conflicts[0]

    def test_approved_and_withdrawn_specimen_and_scope_states_are_found(self):
        document = self.document_with_conflict()
        issue = self.conflict_issue(document)

        self.assertEqual("SUBJ-001", issue["entity_id"])
        self.assertEqual(
            {"approved", "withdrawn", "pending"},
            {
                item["consent_status"]
                for item in document["specimens"]
                if item["subject_id"] == "SUBJ-001"
            },
        )
        self.assertEqual(
            {"approved", "withdrawn", "pending"},
            {
                item["status"]
                for item in document["consent_scopes"]
                if item["subject_id"] == "SUBJ-001"
            },
        )

    def test_explicit_withdraw_resolves_conflict_and_preserves_other_records(self):
        document = self.document_with_conflict()
        original = copy.deepcopy(document)
        issue = self.conflict_issue(document)

        fixed, returned_issue_id = apply_fix(document, issue["issue_id"], "withdrawn")

        self.assertEqual(issue["issue_id"], returned_issue_id)
        self.assertFalse(any(
            item["code"] == "CONFLICTING_CONSENT"
            for item in check_document(fixed)["issues"]
        ))
        self.assertEqual(original, document)
        self.assertTrue(all(
            item["consent_status"] == "withdrawn"
            for item in fixed["specimens"]
            if item["subject_id"] == "SUBJ-001"
        ))
        self.assertTrue(all(
            item["status"] == "withdrawn"
            for item in fixed["consent_scopes"]
            if item["subject_id"] == "SUBJ-001"
        ))
        self.assertEqual(
            [item for item in original["specimens"] if item["subject_id"] == "SUBJ-OTHER"],
            [item for item in fixed["specimens"] if item["subject_id"] == "SUBJ-OTHER"],
        )
        self.assertEqual(
            [item for item in original["consent_scopes"] if item["subject_id"] == "SUBJ-OTHER"],
            [item for item in fixed["consent_scopes"] if item["subject_id"] == "SUBJ-OTHER"],
        )

    def test_privacy_safe_export_excludes_withdrawn_subject(self):
        document = self.document_with_conflict()
        issue = self.conflict_issue(document)
        fixed, _ = apply_fix(document, issue["issue_id"], "withdrawn")

        exported = export_document(fixed, privacy_safe=True)

        for key in ("specimens", "consent_scopes", "phenotypes"):
            self.assertTrue(all(
                item.get("subject_id") != "SUBJ-001"
                for item in exported[key]
            ))
        self.assertEqual([], exported["samples"])
        self.assertEqual([], exported["file_manifests"])
        self.assertEqual([], exported["sequencing_runs"])

    def test_approving_conflict_is_refused(self):
        document = self.document_with_conflict()
        original = copy.deepcopy(document)
        issue = self.conflict_issue(document)

        with self.assertRaises(ValueError):
            apply_fix(document, issue["issue_id"], "approved")

        self.assertEqual(original, document)

    def test_stale_conflict_issue_is_refused(self):
        document = self.document_with_conflict()
        issue = self.conflict_issue(document)
        fixed, _ = apply_fix(document, issue["issue_id"], "withdrawn")

        with self.assertRaises(ValueError):
            apply_fix(fixed, issue["issue_id"], "withdrawn")


if __name__ == "__main__":
    unittest.main()
