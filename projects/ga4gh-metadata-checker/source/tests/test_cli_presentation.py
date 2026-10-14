import contextlib
import csv
import io
import json
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

from ga4gh_qc.cli import main
from ga4gh_qc.loader import load_json
from ga4gh_qc.core import check_document, issues_csv


ROOT = Path(__file__).parent


class CliPresentationTests(unittest.TestCase):
    def test_html_report_has_severity_emphasis_and_searchable_queue(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            exit_code = main([
                "check", str(ROOT / "fixtures" / "mixed.json"),
                "--format", "html",
            ])

        html = output.getvalue()
        self.assertEqual(1, exit_code)
        self.assertIn("severity-error", html)
        self.assertIn("severity-warning", html)
        self.assertIn('id="issue-search"', html)
        self.assertIn("MISSING_PROVENANCE", html)
        self.assertIn("dataset.search", html)  # searchable row data is wired to the filter

        filtered = io.StringIO()
        with contextlib.redirect_stdout(filtered):
            main([
                "check", str(ROOT / "fixtures" / "mixed.json"),
                "--format", "html", "--search", "provenance",
            ])
        self.assertNotIn("MISSING_RUN_REFERENCE", filtered.getvalue())

    def test_html_queue_uses_same_severity_order_as_json_and_csv(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            main(["check", str(ROOT / "fixtures" / "mixed.json"), "--format", "html"])
        html = output.getvalue()
        error_position = html.index('severity-error')
        warning_position = html.index('severity-warning')
        self.assertLess(error_position, warning_position)
        self.assertIn("Validation totals:", html)
        self.assertIn("Queue matches:", html)

        report = check_document(load_json(ROOT / "fixtures" / "mixed.json"))
        expected_ids = [issue["issue_id"] for issue in report["issues"]]
        html_ids = re.findall(r'<td><code>(ISS-[A-F0-9]+)</code></td>', html)
        csv_ids = [row.split(",", 1)[0] for row in issues_csv(report["issues"]).splitlines()[1:]]
        self.assertEqual(expected_ids, html_ids)
        self.assertEqual(expected_ids, csv_ids)

        json_output = io.StringIO()
        with contextlib.redirect_stdout(json_output):
            main(["check", str(ROOT / "fixtures" / "mixed.json"), "--format", "json"])
        self.assertEqual(expected_ids, [issue["issue_id"] for issue in json.loads(json_output.getvalue())["issues"]])

    def test_text_report_emphasizes_severity(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            main([
                "check", str(ROOT / "fixtures" / "mixed.json"),
                "--format", "text", "--search", "provenance",
            ])

        text = output.getvalue()
        self.assertIn("[!] ERROR MISSING_PROVENANCE", text)
        self.assertIn("Matching issues: 2 errors", text)

    def test_search_uses_severity_and_status_fields_consistently(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            main([
                "check", str(ROOT / "fixtures" / "mixed.json"),
                "--format", "html", "--search", "warning",
            ])
        html = output.getvalue()
        self.assertIn("PROBABLE_DUPLICATE_SPECIMEN", html)
        self.assertNotIn("MISSING_PROVENANCE", html)

    def test_warning_contrast_preserves_cross_format_severity(self):
        outputs = {}
        for fmt in ("html", "json", "csv", "text"):
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                main(["check", str(ROOT / "fixtures" / "mixed.json"),
                      "--format", fmt, "--severity", "warning"])
            outputs[fmt] = output.getvalue()

        def luminance(color):
            rgb = [int(color[index:index + 2], 16) / 255 for index in (1, 3, 5)]
            linear = [value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4 for value in rgb]
            return sum(channel * weight for channel, weight in zip(linear, (0.2126, 0.7152, 0.0722)))

        def contrast(first, second):
            lighter, darker = sorted((luminance(first), luminance(second)), reverse=True)
            return (lighter + 0.05) / (darker + 0.05)

        html = outputs["html"]
        tokens = dict(re.findall(r"--(amber(?:-bg|-border)?):\s*(#[0-9a-fA-F]{6})", html))
        # Small warning badge text and both summary labels need strong contrast.
        self.assertGreaterEqual(contrast(tokens["amber"], tokens["amber-bg"]), 7)
        self.assertGreaterEqual(contrast(tokens["amber"], "#ffffff"), 7)
        self.assertGreaterEqual(contrast(tokens["amber-border"], tokens["amber-bg"]), 3)
        self.assertIn(".severity-warning", html)
        self.assertIn(".metric-warning strong, .metric-warning span", html)
        self.assertIn('class="severity severity-warning">WARNING</span>', html)
        self.assertIn("[~] WARNING", outputs["text"])
        json_issues = json.loads(outputs["json"])["issues"]
        csv_issues = list(csv.DictReader(io.StringIO(outputs["csv"])))
        self.assertTrue(json_issues)
        self.assertEqual([(issue["issue_id"], "warning") for issue in json_issues],
                         [(issue["issue_id"], issue["severity"]) for issue in csv_issues])
        self.assertTrue(all(issue["severity"] == "warning" for issue in json_issues))


if __name__ == "__main__":
    unittest.main()
