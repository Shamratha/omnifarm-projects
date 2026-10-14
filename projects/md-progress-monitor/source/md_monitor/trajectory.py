"""Load and validate the small trajectory shipped with the monitor."""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

from .schema import (
    FRAME_UNITS,
    SCHEMA_VERSION,
    StreamValidationError,
    validate_frame,
    validate_units,
)


PROJECT_ROOT = Path(__file__).resolve().parent.parent
TRAJECTORY_PATH = PROJECT_ROOT / "data" / "trajectory.json"


class TrajectoryError(StreamValidationError):
    """Raised when a trajectory does not match the stream schema."""


def _require(mapping: dict[str, Any], key: str, context: str) -> Any:
    if key not in mapping:
        code = "missing_units" if key == "units" else f"missing_{key}"
        raise TrajectoryError(f"{context} is missing required field {key!r}", code=code)
    return mapping[key]


def _finite_number(value: Any) -> bool:
    if type(value) not in (int, float):
        return False
    try:
        return math.isfinite(value)
    except (OverflowError, TypeError):
        return False


def _declared_schema_version(value: Any, context: str) -> None:
    if type(value) is not int or value != SCHEMA_VERSION:
        raise TrajectoryError(
            f"unsupported {context} schema version {value!r}",
            code="unsupported_schema",
        )


def load_trajectory(path: Path = TRAJECTORY_PATH) -> dict[str, Any]:
    """Read a JSON trajectory and return a normalized, validated stream payload."""

    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise TrajectoryError(f"trajectory file not found: {path}", code="invalid_frame") from error
    except (OSError, UnicodeError) as error:
        raise TrajectoryError(f"could not read trajectory: {error}", code="invalid_frame") from error
    except json.JSONDecodeError as error:
        raise TrajectoryError(f"trajectory is not valid JSON: {error}", code="invalid_json") from error

    try:
        if not isinstance(document, dict):
            raise TrajectoryError("trajectory root must be an object")

        schema_version = _require(document, "schema_version", "trajectory")
        _declared_schema_version(schema_version, "trajectory")
        units = validate_units(_require(document, "units", "trajectory"), "trajectory")

        atoms = _require(document, "atoms", "trajectory")
        frames = _require(document, "frames", "trajectory")
        timestep_fs = _require(document, "timestep_fs", "trajectory")

        if not isinstance(atoms, list) or not atoms:
            raise TrajectoryError("trajectory must contain at least one atom")
        if not isinstance(frames, list) or not frames:
            raise TrajectoryError("trajectory must contain at least one frame")
        if not _finite_number(timestep_fs) or float(timestep_fs) <= 0:
            raise TrajectoryError("timestep_fs must be a positive finite number")

        normalized_atoms: list[dict[str, str]] = []
        for atom_index, atom in enumerate(atoms):
            if not isinstance(atom, dict):
                raise TrajectoryError(f"atom {atom_index} must be an object")
            element = _require(atom, "element", f"atom {atom_index}")
            if not isinstance(element, str):
                raise TrajectoryError(f"atom {atom_index} has invalid element metadata")
            if "label" in atom:
                label = atom["label"]
                if not isinstance(label, str):
                    raise TrajectoryError(f"atom {atom_index} has invalid label metadata")
            else:
                label = f"{element}{atom_index + 1}"
            normalized_atoms.append({"element": element, "label": label})

        normalized_frames: list[dict[str, Any]] = []
        previous_step: int | None = None
        previous_time_fs: float | None = None
        previous_timestamp: str | None = None
        for frame_index, frame in enumerate(frames):
            if not isinstance(frame, dict):
                raise TrajectoryError(f"frame {frame_index} must be an object")

            # Stream metadata may be omitted in source recordings, but a
            # supplied value remains authoritative and is validated below.
            candidate = dict(frame)
            candidate.setdefault("schema_version", SCHEMA_VERSION)
            candidate.setdefault("sequence", frame_index)
            candidate.setdefault("index", frame_index)
            candidate.setdefault("units", units)
            try:
                normalized = validate_frame(
                    candidate,
                    atom_count=len(normalized_atoms),
                    expected_sequence=frame_index,
                    previous_step=previous_step,
                    previous_time_fs=previous_time_fs,
                    previous_timestamp=previous_timestamp,
                )
            except StreamValidationError as error:
                raise TrajectoryError(str(error), code=error.code) from error
            normalized_frames.append(normalized)
            previous_step = normalized["step"]
            previous_time_fs = normalized["time_fs"]
            previous_timestamp = normalized["timestamp"]

        name = document.get("name", "Bundled trajectory")
        source = document.get("source", "bundled")
        if not isinstance(name, str) or not isinstance(source, str):
            raise TrajectoryError("trajectory name and source must be strings")

        return {
            "name": name,
            "source": source,
            "schema_version": SCHEMA_VERSION,
            "units": dict(FRAME_UNITS),
            "timestep_fs": float(timestep_fs),
            "atoms": normalized_atoms,
            "frames": normalized_frames,
        }
    except TrajectoryError:
        raise
    except StreamValidationError as error:
        raise TrajectoryError(str(error), code=error.code) from error
    except (TypeError, ValueError, OverflowError) as error:
        raise TrajectoryError(f"invalid trajectory: {error}", code="invalid_frame") from error
