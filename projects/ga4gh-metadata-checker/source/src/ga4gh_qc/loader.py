"""Input and output helpers for the local checker."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


class InputError(ValueError):
    """Raised when a metadata document cannot be loaded safely."""


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise InputError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def load_json(path: str | Path) -> dict[str, Any]:
    file_path = Path(path)
    try:
        text = file_path.read_text(encoding="utf-8")
        document = json.loads(text, object_pairs_hook=_reject_duplicate_keys)
    except OSError as exc:
        raise InputError(f"cannot read {file_path}: {exc.strerror or exc}") from exc
    except json.JSONDecodeError as exc:
        raise InputError(f"invalid JSON at line {exc.lineno}, column {exc.colno}: {exc.msg}") from exc
    if not isinstance(document, dict):
        raise InputError("metadata root must be a JSON object")
    return document


def write_json(value: Any, path: str | Path | None = None) -> str:
    text = json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    if path is not None:
        Path(path).write_text(text, encoding="utf-8")
    return text
