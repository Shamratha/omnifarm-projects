"""Strict, versioned validation for the MD monitor's frame stream."""

from __future__ import annotations

from datetime import datetime
import math
import re
from typing import Any


SCHEMA_VERSION = 1
FRAME_SCHEMA = "md-progress-frame/v1"
FRAME_UNITS = {
    "position": "angstrom",
    "time": "femtosecond",
    "temperature": "kelvin",
    "potential_energy": "kilojoule_per_mole",
}
MAX_SAFE_INTEGER = 9_007_199_254_740_991

_TIMESTAMP_PATTERN = re.compile(
    r"^(?P<date>[0-9]{4}-[0-9]{2}-[0-9]{2})T"
    r"(?P<time>[0-9]{2}:[0-9]{2}:[0-9]{2})\.(?P<milliseconds>[0-9]{3})Z$"
)
_FRAME_FIELDS = frozenset(
    {
        "schema_version",
        "sequence",
        "index",
        "step",
        "timestamp",
        "time_fs",
        "temperature_K",
        "potential_energy_kj_mol",
        "units",
        "positions",
    }
)


class StreamValidationError(ValueError):
    """Raised when a stream message or frame violates the versioned contract."""

    def __init__(self, message: str, *, code: str = "invalid_frame") -> None:
        super().__init__(message)
        self.code = code


def _require(mapping: dict[str, Any], key: str, context: str) -> Any:
    if key not in mapping:
        code = "missing_units" if key == "units" else f"missing_{key}"
        raise StreamValidationError(
            f"{context} is missing required field {key!r}", code=code
        )
    return mapping[key]


def _is_finite_number(value: Any) -> bool:
    """Return whether value is a JSON-compatible numeric scalar."""

    if type(value) not in (int, float):
        return False
    try:
        return math.isfinite(value)
    except (OverflowError, TypeError):
        return False


def _safe_integer(value: Any) -> bool:
    return type(value) is int and 0 <= value <= MAX_SAFE_INTEGER


def _number(value: Any, field: str, context: str, *, minimum: float | None = None) -> float:
    if not _is_finite_number(value):
        raise StreamValidationError(f"{context} field {field!r} must be a finite number")
    numeric_value = float(value)
    if minimum is not None and numeric_value < minimum:
        raise StreamValidationError(
            f"{context} field {field!r} must be at least {minimum:g}"
        )
    return numeric_value


def _timestamp(value: Any, context: str) -> str:
    if not isinstance(value, str) or _TIMESTAMP_PATTERN.fullmatch(value) is None:
        raise StreamValidationError(
            f"{context} timestamp must be canonical UTC ISO format "
            "YYYY-MM-DDTHH:mm:ss.SSSZ"
        )

    try:
        parsed = datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ")
    except ValueError as error:
        raise StreamValidationError(
            f"{context} timestamp is not a valid calendar date"
        ) from error
    if parsed.strftime("%Y-%m-%dT%H:%M:%S.%f")[:23] + "Z" != value:
        raise StreamValidationError(
            f"{context} timestamp must be canonical UTC ISO format "
            "YYYY-MM-DDTHH:mm:ss.SSSZ"
        )
    return value


def validate_units(units: Any, context: str = "frame") -> dict[str, str]:
    """Validate and clone the exact canonical unit map."""

    if not isinstance(units, dict):
        raise StreamValidationError(
            f"{context} units must be an object", code="missing_units"
        )
    if set(units) != set(FRAME_UNITS):
        missing = [key for key in FRAME_UNITS if key not in units]
        extra = [str(key) for key in units if key not in FRAME_UNITS]
        details: list[str] = []
        if missing:
            details.append(f"missing {', '.join(missing)}")
        if extra:
            details.append(f"unsupported {', '.join(extra)}")
        raise StreamValidationError(
            f"{context} units are not the exact canonical map ({'; '.join(details)})",
            code="missing_units" if missing else "invalid_units",
        )
    if any(type(units[key]) is not str or units[key] != FRAME_UNITS[key] for key in FRAME_UNITS):
        raise StreamValidationError(
            f"{context} units are not the exact canonical map", code="invalid_units"
        )
    return dict(FRAME_UNITS)


def validate_frame(
    frame: Any,
    *,
    atom_count: int,
    expected_sequence: int | None = None,
    previous_step: int | None = None,
    previous_time_fs: int | float | None = None,
    previous_timestamp: str | None = None,
) -> dict[str, Any]:
    """Validate and clone one frame, including ordering and units.

    ``atom_count`` and the optional previous values provide stream context that
    cannot be expressed by the standalone JSON Schema.  Simulation time must
    increase strictly between frames; canonical UTC timestamps may remain equal
    but may not move backwards.
    """

    if not isinstance(frame, dict):
        raise StreamValidationError("frame must be an object")
    unknown_fields = set(frame) - _FRAME_FIELDS
    if unknown_fields:
        raise StreamValidationError(
            "frame contains unsupported fields: "
            f"{', '.join(sorted(str(field) for field in unknown_fields))}"
        )
    if type(atom_count) is not int or atom_count < 0:
        raise StreamValidationError("atom_count must be a non-negative integer")

    schema_version = _require(frame, "schema_version", "frame")
    if type(schema_version) is not int or schema_version != SCHEMA_VERSION:
        raise StreamValidationError(
            f"unsupported frame schema version {schema_version!r}",
            code="unsupported_schema",
        )

    sequence = _require(frame, "sequence", "frame")
    if not _safe_integer(sequence):
        raise StreamValidationError(
            "frame sequence must be a non-negative safe integer"
        )
    if expected_sequence is not None:
        if not _safe_integer(expected_sequence):
            raise StreamValidationError("expected_sequence must be a safe integer")
        if sequence != expected_sequence:
            code = "duplicate_sequence" if sequence < expected_sequence else "frame_order"
            raise StreamValidationError(
                f"expected frame sequence {expected_sequence}, received {sequence}",
                code=code,
            )

    index = _require(frame, "index", "frame")
    if not _safe_integer(index):
        raise StreamValidationError("frame index must be a non-negative safe integer")
    if index != sequence:
        raise StreamValidationError(
            f"frame index {index} must match sequence {sequence}", code="frame_order"
        )

    step = _require(frame, "step", "frame")
    if not _safe_integer(step):
        raise StreamValidationError("frame step must be a non-negative safe integer")
    if previous_step is not None:
        if not _safe_integer(previous_step):
            raise StreamValidationError("previous_step must be a safe integer")
        if step <= previous_step:
            code = "duplicate_step" if step == previous_step else "frame_order"
            raise StreamValidationError(
                f"frame step {step} must be greater than previous step {previous_step}",
                code=code,
            )

    timestamp = _timestamp(_require(frame, "timestamp", "frame"), "frame")
    time_fs = _number(
        _require(frame, "time_fs", "frame"), "time_fs", "frame", minimum=0
    )
    temperature = _number(
        _require(frame, "temperature_K", "frame"),
        "temperature_K",
        "frame",
        minimum=0,
    )
    potential_energy = _number(
        _require(frame, "potential_energy_kj_mol", "frame"),
        "potential_energy_kj_mol",
        "frame",
    )

    if previous_time_fs is not None:
        previous_time = _number(previous_time_fs, "previous_time_fs", "frame", minimum=0)
        if time_fs <= previous_time:
            raise StreamValidationError(
                f"frame time {time_fs:g} must be greater than previous time {previous_time:g}",
                code="frame_order",
            )
    if previous_timestamp is not None:
        previous_timestamp_value = _timestamp(previous_timestamp, "previous frame")
        if timestamp < previous_timestamp_value:
            raise StreamValidationError(
                f"frame timestamp {timestamp!r} must not precede "
                f"previous timestamp {previous_timestamp_value!r}",
                code="frame_order",
            )

    units = validate_units(_require(frame, "units", "frame"))

    positions = _require(frame, "positions", "frame")
    if not isinstance(positions, list) or len(positions) != atom_count:
        raise StreamValidationError(
            f"frame must contain coordinates for all {atom_count} atoms",
            code="missing_coordinates",
        )
    normalized_positions: list[list[float]] = []
    for atom_index, coordinate in enumerate(positions):
        if not isinstance(coordinate, list) or len(coordinate) != 3:
            raise StreamValidationError(
                f"frame atom {atom_index} must have an x/y/z coordinate triple",
                code="missing_coordinates",
            )
        if not all(_is_finite_number(value) for value in coordinate):
            raise StreamValidationError(
                f"frame atom {atom_index} must have finite numeric coordinates",
                code="missing_coordinates",
            )
        normalized_positions.append([float(value) for value in coordinate])

    return {
        "schema_version": SCHEMA_VERSION,
        "sequence": sequence,
        "index": index,
        "step": step,
        "timestamp": timestamp,
        "time_fs": time_fs,
        "temperature_K": temperature,
        "potential_energy_kj_mol": potential_energy,
        "units": units,
        "positions": normalized_positions,
    }
