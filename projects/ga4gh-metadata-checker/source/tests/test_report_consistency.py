"""Cross-format severity regression, including informational issues."""

import contextlib
import csv
import io
import json
import sys
import unittest
from html.parser import HTMLParser
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

from ga4gh_qc.cli import main
from ga4gh_qc.core import filter_issues, severity_counts


class IssueRows(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.severities = []
        self.ids = []
        self.in_id = False
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "tr" and "data-severity" in attrs:
            self.severities.append(attrs["data-severity"])

    def handle_data(self, data):
        if data.startswith("ISS-"):
            self.ids.append(data)


class ReportConsistencyTests(unittest.TestCase):
    def setUp(self):
        # Info's code sorts before warning's code: the old boolean severity key
        # incorrectly placed informational findings ahead of warnings.
        self.issues = [
            dict(issue_id=f"ISS-{identifier}", severity=severity, code=code,
                 entity_type="sample", entity_id=identifier, path="/samples",
                 status="open", message="Synthetic finding", dependencies=["PREREQUISITE"],
                 suggested_values=["DNA"])
            for identifier, severity, code in (
                ("I", "info", "A_INFO"), ("W", "warning", "Z_WARNING"),
                ("E2", "error", "Z_ERROR"), ("E1", "error", "A_ERROR"),
            )
        ]
        self.report = dict(tool_version="test", profile="synthetic", vocabulary_version="test",
                           valid=False, summary=severity_counts(self.issues), record_counts={}, issues=self.issues)

    def render(self, format, *filters):
        output = io.StringIO()
        with patch("ga4gh_qc.cli.load_json", return_value={}), patch(
            "ga4gh_qc.cli.check_document", return_value=dict(self.report)
        ), contextlib.redirect_stdout(output):
            exit_code = main(["check", "synthetic.json", "--format", format, *filters])
        self.assertEqual(1, exit_code)  # filters must not change validation status
        return output.getvalue()

    def test_severity_and_tie_break_order_match_in_every_format(self):
        expected = ["ISS-E1", "ISS-E2", "ISS-W", "ISS-I"]
        queue = filter_issues(self.report)
        json_issues = json.loads(self.render("json"))["issues"]
        csv_issues = list(csv.DictReader(io.StringIO(self.render("csv"))))
        html = IssueRows(self.render("html"))
        for issues in (queue, json_issues, csv_issues):
            self.assertEqual(expected, [issue["issue_id"] for issue in issues])
            self.assertEqual(["error", "error", "warning", "info"], [issue["severity"] for issue in issues])
        self.assertEqual(expected, html.ids)
        self.assertEqual(["error", "error", "warning", "info"], html.severities)
        text = self.render("text")
        self.assertEqual(expected, sorted(expected, key=text.index))
        for format in ("json", "csv"):
            self.assertEqual(self.render(format), self.render(format))

    def test_filtered_counts_do_not_override_overall_validity(self):
        filtered = json.loads(self.render("json", "--severity", "warning"))
        self.assertEqual({"error": 0, "warning": 1, "info": 0}, filtered["summary"])
        self.assertEqual(self.report["summary"], filtered["validation_summary"])
        self.assertFalse(filtered["valid"])
        html = self.render("html", "--severity", "warning")
        self.assertIn("Validation totals: 2 errors, 1 warnings, 1 infos", html)
        self.assertEqual(["warning"], IssueRows(html).severities)

    def test_searches_all_issue_fields_with_trimmed_lowercase_query(self):
        for query in ("  WARNING  ", "open", "prerequisite", "dna"):
            expected = filter_issues(self.report, search=query)
            actual = json.loads(self.render("json", "--search", query))["issues"]
            self.assertTrue(actual)
            self.assertEqual(expected, actual)


if __name__ == "__main__":
    unittest.main()
