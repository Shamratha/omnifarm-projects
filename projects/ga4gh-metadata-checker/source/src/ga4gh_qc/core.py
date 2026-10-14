"""Validation, issue search, fixes, and privacy-safe export.

The checker deliberately operates on ordinary JSON dictionaries.  This keeps
the local profile easy to inspect and lets unknown extension fields survive a
check/export round trip.
"""

from __future__ import annotations

import csv
import hashlib
import io
import re
from copy import deepcopy
from datetime import date
from typing import Any, Iterable

from . import __version__

VOCABULARIES = {
    "specimen_type": {"blood", "saliva", "tissue", "plasma"},
    "consent_status": {"approved", "pending", "withdrawn"},
    "platform": {"illumina", "ont"},
    "sample_type": {"DNA", "RNA"},
    "assay": {"WGS", "WES", "RNA-seq"},
    "consent_scope": {"broad", "genomics", "research-only", "none"},
}
REQUIRED = {
    "specimens": ("specimen_id", "subject_id", "specimen_type", "collection_date", "consent_status"),
    "samples": ("sample_id", "specimen_id", "run_id", "sample_type", "status"),
    "sequencing_runs": ("run_id", "platform", "assay", "run_date", "provenance"),
    "consent_scopes": ("consent_id", "subject_id", "scope", "status"),
    "phenotypes": ("phenotype_id", "subject_id", "term", "source"),
    "file_manifests": ("file_id", "sample_id", "uri", "sha256", "file_type"),
}
ENTITY_LABELS = {
    "specimens": "specimen", "samples": "sample", "sequencing_runs": "run",
    "consent_scopes": "consent", "phenotypes": "phenotype", "file_manifests": "file",
}
ID_FIELDS = {
    "specimens": "specimen_id", "samples": "sample_id", "sequencing_runs": "run_id",
    "consent_scopes": "consent_id", "phenotypes": "phenotype_id", "file_manifests": "file_id",
}
CSV_FIELDS = [
    "issue_id", "severity", "code", "entity_type", "entity_id", "path", "status",
    "message", "dependencies", "suggested_values",
]
SEVERITIES = ("error", "warning", "info")
SEVERITY_RANK = {severity: rank for rank, severity in enumerate(SEVERITIES)}
ISSUE_SEARCH_FIELDS = tuple(CSV_FIELDS)


def _empty_buckets(document: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    return {name: document.get(name, []) if isinstance(document.get(name, []), list) else [] for name in REQUIRED}


def _is_blank(value: Any) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


def _stable_issue(code: str, entity_type: str, entity_id: str, path: str) -> str:
    raw = f"{code}|{entity_type}|{entity_id}|{path}".encode()
    return "ISS-" + hashlib.sha256(raw).hexdigest()[:12].upper()


def _add(issues: list[dict[str, Any]], code: str, severity: str, entity_type: str,
         entity_id: str, path: str, message: str, *, dependencies: Iterable[str] = (),
         suggested_values: Iterable[str] = ()) -> dict[str, Any]:
    issue = {
        "issue_id": _stable_issue(code, entity_type, entity_id, path),
        "severity": severity,
        "code": code,
        "entity_type": entity_type,
        "entity_id": entity_id or "<unknown>",
        "path": path,
        "status": "open",
        "message": message,
        "dependencies": sorted(set(dependencies)),
        "suggested_values": sorted(set(suggested_values)),
    }
    issues.append(issue)
    return issue


def issue_sort_key(issue: dict[str, Any]) -> tuple[Any, ...]:
    """Return the one stable ordering shared by every issue presentation."""
    return (
        SEVERITY_RANK.get(issue.get("severity", ""), len(SEVERITIES)),
        str(issue.get("code", "")),
        str(issue.get("entity_type", "")),
        str(issue.get("entity_id", "")),
        str(issue.get("path", "")),
        str(issue.get("issue_id", "")),
    )


def issue_search_text(issue: dict[str, Any]) -> str:
    """Return the canonical searchable text used by API, CLI, and browser."""
    return " ".join(str(issue.get(field, "")) for field in ISSUE_SEARCH_FIELDS).lower()


def severity_counts(issues: Iterable[dict[str, Any]]) -> dict[str, int]:
    counts = dict.fromkeys(SEVERITIES, 0)
    for issue in issues:
        counts[issue["severity"]] += 1
    return counts


def _as_id(record: Any, id_field: str) -> str:
    value = record.get(id_field, "") if isinstance(record, dict) else ""
    return str(value).strip() if not _is_blank(value) else "<unknown>"


def _valid_date(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    try:
        date.fromisoformat(value)
        return True
    except ValueError:
        return False


def _record_issues(document: dict[str, Any]) -> list[dict[str, Any]]:
    buckets = _empty_buckets(document)
    issues: list[dict[str, Any]] = []
    for bucket, required_fields in REQUIRED.items():
        if bucket not in document:
            _add(issues, "REQUIRED_COLLECTION", "error", "document", "document", f"/{bucket}",
                 f"Required collection '{bucket}' is missing")
            continue
        if not isinstance(document[bucket], list):
            _add(issues, "COLLECTION_TYPE", "error", "document", "document", f"/{bucket}",
                 f"Collection '{bucket}' must be an array")
            continue
        for index, record in enumerate(buckets[bucket]):
            entity_type = ENTITY_LABELS[bucket]
            entity_id = _as_id(record, ID_FIELDS[bucket])
            if not isinstance(record, dict):
                _add(issues, "RECORD_TYPE", "error", entity_type, entity_id, f"/{bucket}/{index}",
                     "Record must be an object")
                continue
            for field in required_fields:
                if field not in record or _is_blank(record[field]):
                    _add(issues, "REQUIRED_FIELD", "error", entity_type, entity_id,
                         f"/{bucket}/{index}/{field}", f"Required field '{field}' is missing",
                         suggested_values=VOCABULARIES.get(field, ()))
            for field, allowed in VOCABULARIES.items():
                if field in record and not _is_blank(record[field]) and record[field] not in allowed:
                    _add(issues, "CONTROLLED_VOCABULARY", "error", entity_type, entity_id,
                         f"/{bucket}/{index}/{field}",
                         f"Value for '{field}' is not in the controlled vocabulary",
                         suggested_values=allowed)
            scoped_vocabularies = {}
            if bucket == "consent_scopes":
                scoped_vocabularies = {"scope": VOCABULARIES["consent_scope"], "status": VOCABULARIES["consent_status"]}
            for field, allowed in scoped_vocabularies.items():
                if field in record and not _is_blank(record[field]) and record[field] not in allowed:
                    _add(issues, "CONTROLLED_VOCABULARY", "error", entity_type, entity_id,
                         f"/{bucket}/{index}/{field}",
                         f"Value for '{field}' is not in the controlled vocabulary",
                         suggested_values=allowed)
            if "collection_date" in record and not _is_blank(record["collection_date"]) and not _valid_date(record["collection_date"]):
                _add(issues, "INVALID_DATE", "error", entity_type, entity_id,
                     f"/{bucket}/{index}/collection_date", "collection_date must be ISO 8601 YYYY-MM-DD")
            if "run_date" in record and not _is_blank(record["run_date"]) and not _valid_date(record["run_date"]):
                _add(issues, "INVALID_DATE", "error", entity_type, entity_id,
                     f"/{bucket}/{index}/run_date", "run_date must be ISO 8601 YYYY-MM-DD")
    return issues


def _duplicate_issues(document: dict[str, Any], issues: list[dict[str, Any]]) -> None:
    buckets = _empty_buckets(document)
    for bucket, id_field in ID_FIELDS.items():
        seen: dict[str, list[int]] = {}
        for index, record in enumerate(buckets[bucket]):
            if isinstance(record, dict) and not _is_blank(record.get(id_field)):
                seen.setdefault(str(record[id_field]), []).append(index)
        for identifier, indexes in sorted(seen.items()):
            if len(indexes) > 1:
                _add(issues, "DUPLICATE_IDENTIFIER", "error", ENTITY_LABELS[bucket], identifier,
                     f"/{bucket}", f"{ENTITY_LABELS[bucket].capitalize()} identifier occurs more than once")
    specimens = buckets["specimens"]
    signatures: dict[tuple[Any, ...], list[str]] = {}
    for record in specimens:
        if not isinstance(record, dict):
            continue
        signature = (record.get("subject_id"), record.get("specimen_type"), record.get("collection_date"))
        if all(not _is_blank(value) for value in signature):
            signatures.setdefault(signature, []).append(_as_id(record, "specimen_id"))
    for signature, identifiers in sorted(signatures.items(), key=lambda item: str(item[0])):
        if len(identifiers) > 1 and len(set(identifiers)) > 1:
            _add(issues, "PROBABLE_DUPLICATE_SPECIMEN", "warning", "specimen", ",".join(sorted(identifiers)),
                 "/specimens", "Specimens share subject, type, and collection date")


def _relationship_issues(document: dict[str, Any], issues: list[dict[str, Any]]) -> None:
    buckets = _empty_buckets(document)
    specimens = {str(r.get("specimen_id")): r for r in buckets["specimens"] if isinstance(r, dict) and not _is_blank(r.get("specimen_id"))}
    runs = {str(r.get("run_id")): r for r in buckets["sequencing_runs"] if isinstance(r, dict) and not _is_blank(r.get("run_id"))}
    subjects: dict[str, list[tuple[str, str]]] = {}
    for record in buckets["specimens"]:
        if isinstance(record, dict) and not _is_blank(record.get("subject_id")):
            subjects.setdefault(str(record["subject_id"]), []).append((_as_id(record, "specimen_id"), str(record.get("consent_status", ""))))
    for record in buckets["consent_scopes"]:
        if isinstance(record, dict) and not _is_blank(record.get("subject_id")):
            subjects.setdefault(str(record["subject_id"]), []).append((_as_id(record, "consent_id"), str(record.get("status", ""))))
    for index, record in enumerate(buckets["samples"]):
        if not isinstance(record, dict):
            continue
        sample_id = _as_id(record, "sample_id")
        if not _is_blank(record.get("specimen_id")) and str(record["specimen_id"]) not in specimens:
            _add(issues, "MISSING_SPECIMEN_REFERENCE", "error", "sample", sample_id, f"/samples/{index}/specimen_id",
                 f"Sample references missing specimen '{record['specimen_id']}'")
        specimen = specimens.get(str(record.get("specimen_id")))
        if not _is_blank(record.get("run_id")) and str(record["run_id"]) not in runs:
            _add(issues, "MISSING_RUN_REFERENCE", "error", "sample", sample_id, f"/samples/{index}/run_id",
                 f"Sample references missing run '{record['run_id']}'")
        if specimen and _is_blank(specimen.get("specimen_type")):
            prerequisite = _stable_issue("REQUIRED_FIELD", "specimen", _as_id(specimen, "specimen_id"),
                                         f"/specimens/{next((i for i, item in enumerate(buckets['specimens']) if item is specimen), 0)}/specimen_type")
            _add(issues, "SAMPLE_COMPATIBILITY", "warning", "sample", sample_id, "/samples/sample_type",
                 "Sample compatibility cannot be evaluated until specimen_type is supplied",
                 dependencies=[prerequisite])
    for subject_id, states in sorted(subjects.items()):
        statuses = {status for _, status in states if status}
        if "approved" in statuses and "withdrawn" in statuses:
            specimen_ids = ",".join(sorted(specimen_id for specimen_id, _ in states))
            _add(issues, "CONFLICTING_CONSENT", "error", "subject", subject_id, "/specimens/consent_status",
                 f"Subject has conflicting approved and withdrawn consent across {specimen_ids}")
    referenced_runs = {str(record.get("run_id")) for record in buckets["samples"] if isinstance(record, dict) and not _is_blank(record.get("run_id"))}
    for run_id, record in sorted(runs.items()):
        if run_id not in referenced_runs:
            _add(issues, "ORPHANED_RUN", "warning", "run", run_id, "/sequencing_runs", "Run is not referenced by any sample")


def _provenance_issues(document: dict[str, Any], issues: list[dict[str, Any]]) -> None:
    for index, record in enumerate(_empty_buckets(document)["sequencing_runs"]):
        if not isinstance(record, dict):
            continue
        run_id = _as_id(record, "run_id")
        provenance = record.get("provenance")
        if not isinstance(provenance, dict):
            _add(issues, "MISSING_PROVENANCE", "error", "run", run_id, f"/sequencing_runs/{index}/provenance",
                 "Run provenance must include pipeline, pipeline_version, and reference_genome")
            continue
        for field in ("pipeline", "pipeline_version", "reference_genome"):
            if _is_blank(provenance.get(field)) or str(provenance.get(field)).lower() in {"unknown", "not-specified", "n/a"}:
                _add(issues, "MISSING_PROVENANCE", "error", "run", run_id,
                     f"/sequencing_runs/{index}/provenance/{field}", f"Required provenance field '{field}' is missing or a placeholder")


def _domain_issues(document: dict[str, Any], issues: list[dict[str, Any]]) -> None:
    buckets = _empty_buckets(document)
    subject_ids = {str(item.get("subject_id")) for item in buckets["specimens"]
                   if isinstance(item, dict) and not _is_blank(item.get("subject_id"))}
    for index, record in enumerate(buckets["consent_scopes"]):
        if isinstance(record, dict) and not _is_blank(record.get("subject_id")) and str(record["subject_id"]) not in subject_ids:
            _add(issues, "MISSING_SUBJECT_REFERENCE", "error", "consent", _as_id(record, "consent_id"),
                 f"/consent_scopes/{index}/subject_id", "Consent scope references an unknown subject")
    sample_ids = {str(item.get("sample_id")) for item in buckets["samples"] if isinstance(item, dict) and not _is_blank(item.get("sample_id"))}
    for index, record in enumerate(buckets["file_manifests"]):
        if isinstance(record, dict) and not _is_blank(record.get("sample_id")) and str(record["sample_id"]) not in sample_ids:
            _add(issues, "MISSING_SAMPLE_REFERENCE", "error", "file", _as_id(record, "file_id"),
                 f"/file_manifests/{index}/sample_id", "File manifest references an unknown sample")
        if isinstance(record, dict) and record.get("sha256") and not re.fullmatch(r"[0-9a-fA-F]{64}", str(record["sha256"])):
            _add(issues, "INVALID_CHECKSUM", "error", "file", _as_id(record, "file_id"),
                 f"/file_manifests/{index}/sha256", "sha256 must be a 64-character hexadecimal digest")


def check_document(document: dict[str, Any], *, profile: str = "synthetic-ga4gh") -> dict[str, Any]:
    """Return a stable validation report without mutating the caller's document."""
    working = deepcopy(document)
    issues = _record_issues(working)
    _duplicate_issues(working, issues)
    _relationship_issues(working, issues)
    _provenance_issues(working, issues)
    _domain_issues(working, issues)
    issues.sort(key=issue_sort_key)
    counts = severity_counts(issues)
    buckets = _empty_buckets(document)
    return {
        "tool_version": __version__,
        "profile": profile,
        "vocabulary_version": "2026-01",
        "valid": counts["error"] == 0,
        "summary": counts,
        "record_counts": {key: len(value) for key, value in sorted(buckets.items())},
        "issues": issues,
    }


def filter_issues(report: dict[str, Any], *, search: str = "", severity: str = "", status: str = "") -> list[dict[str, Any]]:
    query = search.lower().strip()
    result = []
    for issue in sorted(report.get("issues", []), key=issue_sort_key):
        if severity and issue["severity"] != severity:
            continue
        if status and issue["status"] != status:
            continue
        if query and query not in issue_search_text(issue):
            continue
        result.append(issue)
    return result


def issues_csv(issues: Iterable[dict[str, Any]]) -> str:
    output = io.StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=CSV_FIELDS, lineterminator="\n")
    writer.writeheader()
    for issue in sorted(issues, key=issue_sort_key):
        row = {field: issue.get(field, "") for field in CSV_FIELDS}
        row["dependencies"] = ";".join(issue.get("dependencies", []))
        row["suggested_values"] = ";".join(issue.get("suggested_values", []))
        writer.writerow(row)
    return output.getvalue()


def _pseudonym(value: str, salt: str) -> str:
    return "SUBJ-" + hashlib.sha256(f"{salt}|{value}".encode()).hexdigest()[:10].upper()


def export_document(document: dict[str, Any], *, privacy_safe: bool = False, salt: str = "synthetic-ga4gh") -> dict[str, Any]:
    """Create a deterministic metadata export; privacy mode removes direct identifiers."""
    exported = deepcopy(document)
    if not privacy_safe:
        return exported
    withdrawn_subjects = {
        str(item.get("subject_id")) for item in exported.get("specimens", [])
        if isinstance(item, dict) and item.get("consent_status") == "withdrawn"
    }
    conflict_subjects = {
        issue["entity_id"] for issue in check_document(document)["issues"] if issue["code"] == "CONFLICTING_CONSENT"
    }
    restricted = withdrawn_subjects | conflict_subjects
    subject_map: dict[str, str] = {}
    def map_subject(value: Any) -> Any:
        if _is_blank(value):
            return value
        original = str(value)
        subject_map.setdefault(original, _pseudonym(original, salt))
        return subject_map[original]
    for key in ("specimens", "consent_scopes", "phenotypes"):
        filtered = []
        for item in exported.get(key, []):
            if not isinstance(item, dict):
                continue
            if str(item.get("subject_id")) in restricted:
                continue
            item.pop("participant_name", None)
            item.pop("email", None)
            item.pop("date_of_birth", None)
            if "subject_id" in item:
                item["subject_id"] = map_subject(item["subject_id"])
            filtered.append(item)
        exported[key] = filtered
    allowed_specimens = {item.get("specimen_id") for item in exported.get("specimens", []) if isinstance(item, dict)}
    exported["samples"] = [item for item in exported.get("samples", []) if isinstance(item, dict) and item.get("specimen_id") in allowed_specimens]
    allowed_samples = {item.get("sample_id") for item in exported["samples"]}
    exported["file_manifests"] = [item for item in exported.get("file_manifests", []) if isinstance(item, dict) and item.get("sample_id") in allowed_samples]
    used_runs = {item.get("run_id") for item in exported["samples"]}
    exported["sequencing_runs"] = [item for item in exported.get("sequencing_runs", []) if isinstance(item, dict) and item.get("run_id") in used_runs]
    for key in ("specimens", "consent_scopes", "phenotypes"):
        for item in exported[key]:
            if isinstance(item, dict):
                item.pop("participant_name", None)
                item.pop("email", None)
                item.pop("date_of_birth", None)
    return exported


def apply_fix(document: dict[str, Any], issue_id: str, value: str) -> tuple[dict[str, Any], str]:
    """Apply one explicit, safe field fix and return the new document and issue id.

    Fixes are dependency-aware: an issue with unresolved dependencies cannot be
    edited, and consent escalation is never automated.  Resolving a consent
    conflict with withdrawal is only conservative local suppression; it is not
    certification of authoritative consent.
    """
    current = check_document(document)
    target = next((issue for issue in current["issues"] if issue["issue_id"] == issue_id), None)
    if target is None:
        raise ValueError(f"issue not found: {issue_id}")
    if target["dependencies"]:
        open_ids = {issue["issue_id"] for issue in current["issues"]}
        blocked = sorted(set(target["dependencies"]) & open_ids)
        if blocked:
            raise ValueError(f"fix is blocked by unresolved dependencies: {', '.join(blocked)}")
    if target["code"] == "CONFLICTING_CONSENT":
        if value != "withdrawn":
            raise ValueError("CONFLICTING_CONSENT can only be resolved with value 'withdrawn'")
        updated = deepcopy(document)
        subject_id = target["entity_id"]
        for record in updated.get("specimens", []):
            if isinstance(record, dict) and str(record.get("subject_id")) == subject_id:
                record["consent_status"] = "withdrawn"
        for record in updated.get("consent_scopes", []):
            if isinstance(record, dict) and str(record.get("subject_id")) == subject_id:
                record["status"] = "withdrawn"
        return updated, target["issue_id"]
    if target["code"] == "MISSING_PROVENANCE":
        raise ValueError(f"{target['code']} requires authoritative metadata; it cannot be auto-fixed")
    if target["code"] not in {"REQUIRED_FIELD", "CONTROLLED_VOCABULARY", "MISSING_RUN_REFERENCE", "MISSING_SPECIMEN_REFERENCE"}:
        raise ValueError(f"no safe fix is defined for {target['code']}")
    if target["suggested_values"] and value not in target["suggested_values"]:
        raise ValueError(f"value must be one of: {', '.join(target['suggested_values'])}")
    path_parts = [part for part in target["path"].split("/") if part]
    if len(path_parts) < 3:
        raise ValueError("issue path cannot be fixed")
    bucket, index_text, field = path_parts[-3:]
    if bucket not in REQUIRED or not index_text.isdigit():
        raise ValueError("issue path cannot be fixed")
    if target["code"] == "MISSING_RUN_REFERENCE":
        valid_runs = {str(item.get("run_id")) for item in document.get("sequencing_runs", []) if isinstance(item, dict)}
        if value not in valid_runs:
            raise ValueError(f"run reference must identify an existing run: {value}")
    if target["code"] == "MISSING_SPECIMEN_REFERENCE":
        valid_specimens = {str(item.get("specimen_id")) for item in document.get("specimens", []) if isinstance(item, dict)}
        if value not in valid_specimens:
            raise ValueError(f"specimen reference must identify an existing specimen: {value}")
    updated = deepcopy(document)
    updated[bucket][int(index_text)][field] = value
    return updated, target["issue_id"]
