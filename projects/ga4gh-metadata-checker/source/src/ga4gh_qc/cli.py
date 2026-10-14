"""Command line interface for the local checker."""

from __future__ import annotations

import argparse
from html import escape
import sys
from pathlib import Path

from .core import SEVERITIES, check_document, export_document, filter_issues, issue_search_text, issues_csv, severity_counts
from .loader import InputError, load_json, write_json


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Check synthetic GA4GH-style genomic metadata locally.")
    subparsers = parser.add_subparsers(dest="command", required=True)
    check = subparsers.add_parser("check", help="validate a metadata JSON document")
    check.add_argument("input", type=Path)
    check.add_argument("--format", choices=("json", "csv", "html", "text"), default="text")
    check.add_argument("--output", type=Path)
    check.add_argument("--search", default="", help="search all issue fields (case-insensitive, trimmed)")
    check.add_argument("--severity", choices=SEVERITIES, default="")
    check.add_argument("--status", choices=("open", "resolved"), default="")
    check.add_argument("--privacy-safe", action="store_true", help="export metadata without direct identifiers")
    check.add_argument("--export-metadata", type=Path, help="also write the checked metadata export")
    return parser


def _text_report(report: dict, issues: list[dict]) -> str:
    status = "PASS" if report["valid"] else "FAIL"
    symbols = {"error": "[!]", "warning": "[~]", "info": "[i]"}
    total = report.get("validation_summary", report["summary"])
    lines = [f"{status} profile={report['profile']}",
             f"Validation totals: {total['error']} errors  {total['warning']} warnings  {total['info']} infos",
             f"Matching issues: {report['summary']['error']} errors  {report['summary']['warning']} warnings  {report['summary']['info']} infos",
             f"Records: {sum(report['record_counts'].values())}"]
    if not issues:
        lines.append("No issues match the selected filters.")
    for issue in issues:
        lines.extend(["", f"{symbols[issue['severity']]} {issue['severity'].upper()} {issue['code']} [{issue['issue_id']}]:",
                      f"  {issue['entity_type']}={issue['entity_id']} {issue['path']}", f"  {issue['message']}"])
        if issue["dependencies"]:
            lines.append(f"  blocked by: {', '.join(issue['dependencies'])}")
    return "\n".join(lines) + "\n"


def _html_report(report: dict, issues: list[dict]) -> str:
    """Render a deterministic, self-contained issue queue for a local browser."""
    status = "PASS" if report["valid"] else "FAIL"
    total = report.get("validation_summary", report["summary"])
    severity_cards = "".join(
        f'<div class="metric metric-{severity}"><strong id="count-{severity}">{report["summary"][severity]}</strong>'
        f'<span>{severity}s</span></div>'
        for severity in SEVERITIES
    )
    rows = []
    for issue in issues:
        searchable = issue_search_text(issue)
        dependencies = ", ".join(issue["dependencies"]) or "None"
        rows.append(
            f'<tr data-search="{escape(searchable, quote=True)}" data-severity="{escape(issue["severity"], quote=True)}">'
            f'<td><span class="severity severity-{escape(issue["severity"])}">{escape(issue["severity"].upper())}</span></td>'
            f'<td><code>{escape(issue["code"])}</code></td>'
            f'<td>{escape(issue["entity_type"])}<br><code>{escape(issue["entity_id"])}</code></td>'
            f'<td><code>{escape(issue["path"])}</code></td>'
            f'<td>{escape(issue["message"])}<br><small>Status: {escape(issue["status"])} · Dependencies: {escape(dependencies)}'
            f'<br>Suggested values: {escape(", ".join(issue["suggested_values"]) or "None")}</small></td>'
            f'<td><code>{escape(issue["issue_id"])}</code></td>'
            "</tr>"
        )
    row_markup = "\n".join(rows)
    row_markup += f'<tr id="empty-queue" class="{"hidden" if issues else ""}"><td colspan="6" class="empty">No issues match the selected filters.</td></tr>'
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GA4GH metadata quality report</title>
<style>
:root {{ color-scheme: light; --ink:#172033; --muted:#5d6b82; --line:#d8e0eb; --panel:#fff; --bg:#f4f7fb; --red:#b42318; --red-bg:#fff0ee; --amber:#6b4700; --amber-bg:#fff4cc; --amber-border:#9a6700; --blue:#155eef; --blue-bg:#eef4ff; }}
* {{ box-sizing:border-box; }} body {{ margin:0; background:var(--bg); color:var(--ink); font:15px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }}
main {{ max-width:1280px; margin:0 auto; padding:32px 20px 52px; }} h1 {{ margin:0; font-size:30px; }} h2 {{ margin:0 0 16px; font-size:20px; }} .subtitle {{ color:var(--muted); margin:4px 0 24px; }}
.banner {{ display:flex; align-items:center; gap:12px; padding:14px 16px; border-radius:10px; background:var(--panel); border-left:6px solid var(--blue); margin-bottom:18px; }} .banner.fail {{ border-left-color:var(--red); }} .banner strong {{ font-size:18px; }}
 .metrics {{ display:flex; flex-wrap:wrap; gap:12px; margin-bottom:28px; }} .metric {{ background:var(--panel); border:1px solid var(--line); border-radius:10px; min-width:130px; padding:13px 16px; }} .metric strong {{ display:block; font-size:24px; }} .metric span {{ color:var(--muted); text-transform:capitalize; }} .metric-error strong {{ color:var(--red); }} .metric-warning {{ border-color:var(--amber-border); background:var(--amber-bg); }} .metric-warning strong, .metric-warning span {{ color:var(--amber); font-weight:800; }} .metric-info strong {{ color:var(--blue); }}
 .queue {{ background:var(--panel); border:1px solid var(--line); border-radius:12px; overflow:hidden; }} .queue-header {{ padding:18px; border-bottom:1px solid var(--line); }} label {{ display:block; color:var(--muted); font-weight:600; margin-bottom:7px; }} input {{ width:100%; border:1px solid #aebbd0; border-radius:7px; padding:11px 12px; font:inherit; }} input:focus {{ outline:3px solid #d6e4ff; border-color:var(--blue); }} .table-wrap {{ overflow:auto; }} table {{ width:100%; min-width:940px; border-collapse:collapse; }} th,td {{ padding:13px 14px; text-align:left; vertical-align:top; border-bottom:1px solid var(--line); }} th {{ background:#f8faff; color:var(--muted); font-size:12px; letter-spacing:.05em; text-transform:uppercase; }} tr:last-child td {{ border-bottom:0; }} code {{ font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace; overflow-wrap:anywhere; }} small {{ color:var(--muted); }} .severity {{ display:inline-block; border-radius:999px; padding:3px 8px; font-size:11px; font-weight:800; letter-spacing:.04em; }} .severity-error {{ color:var(--red); background:var(--red-bg); }} .severity-warning {{ color:var(--amber); background:var(--amber-bg); border:1px solid var(--amber-border); }} .severity-info {{ color:var(--blue); background:var(--blue-bg); }} .empty {{ color:var(--muted); text-align:center; padding:30px; }} .hidden {{ display:none; }}
</style>
</head>
<body><main>
<h1>GA4GH metadata quality report</h1>
<p class="subtitle">Profile: <code>{escape(report["profile"])}</code> · Vocabulary: <code>{escape(report["vocabulary_version"])}</code> · Records: {sum(report["record_counts"].values())}</p>
<div class="banner {'' if report['valid'] else 'fail'}"><strong>{escape(status)}</strong><span>Validation totals: {total["error"]} errors, {total["warning"]} warnings, {total["info"]} infos</span></div>
<p>Queue matches (within the exported CLI filters):</p>
<div class="metrics">{severity_cards}</div>
<section class="queue" aria-labelledby="queue-heading"><div class="queue-header"><h2 id="queue-heading">Issue queue</h2><label for="issue-search">Search issue ID, severity, status, code, entity, path, message, dependencies, or suggested value</label><input id="issue-search" type="search" placeholder="e.g. warning, provenance, RUN-001" autocomplete="off"><p id="queue-count" class="subtitle" aria-live="polite">Queue matches: {len(issues)} issue(s)</p></div>
<div class="table-wrap"><table><thead><tr><th>Severity</th><th>Rule</th><th>Entity</th><th>Path</th><th>Finding</th><th>Issue ID</th></tr></thead><tbody id="issue-rows">{row_markup}</tbody></table></div></section>
<script>
const search = document.getElementById('issue-search');
const rows = Array.from(document.querySelectorAll('#issue-rows tr[data-search]'));
const count = document.getElementById('queue-count');
search.addEventListener('input', () => {{
  const query = search.value.trim().toLowerCase(); let visible = 0;
  const totals = {{error: 0, warning: 0, info: 0}};
  rows.forEach(row => {{ const match = row.dataset.search.includes(query); row.classList.toggle('hidden', !match); if (match) {{ visible++; totals[row.dataset.severity]++; }} }});
  Object.entries(totals).forEach(([severity, value]) => {{ document.getElementById('count-' + severity).textContent = value; }});
  document.getElementById('empty-queue').classList.toggle('hidden', visible !== 0);
  count.textContent = 'Queue matches: ' + visible + ' issue(s)';
}});
</script>
</main></body></html>
"""


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        document = load_json(args.input)
    except InputError as exc:
        print(f"input error: {exc}", file=sys.stderr)
        return 2
    report = check_document(document)
    issues = filter_issues(report, search=args.search, severity=args.severity, status=args.status)
    report["validation_summary"] = report["summary"]
    report["summary"] = severity_counts(issues)
    if args.format == "json":
        value = dict(report)
        value["issues"] = issues
        output = write_json(value)
    elif args.format == "csv":
        output = issues_csv(issues)
    elif args.format == "html":
        output = _html_report(report, issues)
    else:
        output = _text_report(report, issues)
    if args.output:
        args.output.write_text(output, encoding="utf-8")
    else:
        sys.stdout.write(output)
    if args.export_metadata:
        write_json(export_document(document, privacy_safe=args.privacy_safe), args.export_metadata)
    return 1 if not report["valid"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
