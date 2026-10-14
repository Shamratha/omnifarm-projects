# GA4GH Metadata Checker

`ga4gh-metadata-checker` is a local, dependency-free quality checker for **synthetic** GA4GH-style genomic metadata. It never calls a remote service and does not require real patient data, sequencing files, or clinical systems.

## Quick start

```bash
python -m unittest discover -s tests -v
PYTHONPATH=src python -m ga4gh_qc check tests/fixtures/mixed.json --format text
PYTHONPATH=src python -m ga4gh_qc check tests/fixtures/valid.json --format json --output report.json
PYTHONPATH=src python -m ga4gh_qc check tests/fixtures/mixed.json --format csv --search provenance
PYTHONPATH=src python -m ga4gh_qc check tests/fixtures/mixed.json --format html --output report.html
```

The command exits `0` for no errors, `1` when validation errors exist, and `2` for unreadable or malformed input.

## Supported metadata

The local profile accepts these top-level arrays:

- `specimens`: subject-linked biological specimens
- `samples`: specimen-to-run sample relationships
- `sequencing_runs`: sequencing technology, assay, and provenance
- `consent_scopes`: subject consent scopes
- `phenotypes`: ontology-style phenotype terms and sources
- `file_manifests`: sample-linked file metadata and SHA-256 checksums

The checker validates required fields, controlled vocabulary values, ISO dates, duplicate identifiers and probable duplicate specimens, references, orphan runs, consent conflicts, provenance, and file checksums. Each issue has a stable ID derived from its rule, entity, and path.

## Issue queue and fixes

Use `--search`, `--severity`, and `--status` together to create a deterministic issue queue. Search is case-insensitive, trims surrounding whitespace, and uses the same fields everywhere: issue ID, severity, code, entity, path, status, message, dependencies, and suggested values. The terminal report uses `[!]`, `[~]`, and `[i]` severity markers. HTML output is self-contained, adds readable severity badges, and includes a client-side search box. JSON includes dependency IDs for issues that need a prerequisite fix. The Python API exposes `apply_fix(document, issue_id, value)` for explicit, unambiguous corrections.

Conflicting consent supports one conservative action: `apply_fix(document, issue_id, "withdrawn")` marks all consent records for that subject as withdrawn. This removes the conflict without escalating consent, and it is explicitly local suppression rather than authoritative consent certification. Approval changes are refused.

## Privacy-safe exports

```bash
PYTHONPATH=src python -m ga4gh_qc check tests/fixtures/mixed.json \
  --format json --privacy-safe --export-metadata safe-metadata.json
```

Privacy-safe metadata removes direct identifiers, pseudonymizes subject IDs deterministically, excludes withdrawn/conflicting-consent subjects, and keeps only linked samples, files, and runs. JSON and CSV issue reports do not include record payloads, so sensitive values are not copied into issue text.

## Deterministic reports

JSON uses sorted keys and stable issue ordering. CSV has a fixed header, LF line endings, and the same issue ordering. HTML/searchable queue rows use that same order and severity decisions. Filtered JSON/HTML summaries distinguish queue matches from whole-document validation totals. No timestamps, random IDs, or machine paths are included. The vocabulary profile is versioned as `2026-01` in JSON reports.

## Schema example

See `tests/fixtures/valid.json` for a complete synthetic example and `tests/fixtures/mixed.json` for intentionally flawed data. All identifiers, names, and email addresses in the fixtures are synthetic placeholders.
