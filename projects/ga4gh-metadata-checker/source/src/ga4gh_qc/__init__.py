"""A dependency-free local genomic metadata quality checker."""

__version__ = "0.1.0"

from .core import check_document, export_document, filter_issues, apply_fix, issue_sort_key, severity_counts

__all__ = ["__version__", "check_document", "export_document", "filter_issues", "apply_fix", "issue_sort_key", "severity_counts"]
