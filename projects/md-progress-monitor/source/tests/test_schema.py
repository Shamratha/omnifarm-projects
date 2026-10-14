import copy
import json
from pathlib import Path

import pytest

from md_monitor.schema import (
    FRAME_SCHEMA,
    FRAME_UNITS,
    MAX_SAFE_INTEGER,
    SCHEMA_VERSION,
    StreamValidationError,
    validate_frame,
    validate_units,
)
from md_monitor.trajectory import TrajectoryError, load_trajectory


ROOT = Path(__file__).resolve().parent.parent
TIMESTAMP = "2026-05-18T10:00:00.000Z"


def frame(*, step=0, sequence=0, index=0, time_fs=0, timestamp=TIMESTAMP, **overrides):
    value = {
        "schema_version": SCHEMA_VERSION,
        "sequence": sequence,
        "index": index,
        "step": step,
        "timestamp": timestamp,
        "time_fs": time_fs,
        "temperature_K": 298.4,
        "potential_energy_kj_mol": -215.84,
        "units": dict(FRAME_UNITS),
        "positions": [[0, 0, 0]],
    }
    value.update(overrides)
    return value


def trajectory_document(*frames):
    return {
        "name": "fixed test trajectory",
        "source": "test fixture",
        "schema_version": SCHEMA_VERSION,
        "units": dict(FRAME_UNITS),
        "timestep_fs": 2,
        "atoms": [{"element": "H", "label": "H1"}],
        "frames": list(frames),
    }


def write_document(tmp_path, document, *, text=None):
    path = tmp_path / "trajectory.json"
    path.write_text(text if text is not None else json.dumps(document), encoding="utf-8")
    return path


def test_contract_constants_and_static_schema_are_versioned():
    assert FRAME_SCHEMA == "md-progress-frame/v1"
    assert FRAME_UNITS == {
        "position": "angstrom",
        "time": "femtosecond",
        "temperature": "kelvin",
        "potential_energy": "kilojoule_per_mole",
    }
    schema = json.loads(
        (ROOT / "schemas" / "frame-v1.schema.json").read_text(encoding="utf-8")
    )
    assert schema["$schema"] == "https://json-schema.org/draft/2020-12/schema"
    assert schema["$id"] == FRAME_SCHEMA
    assert schema["properties"]["schema_version"] == {"type": "integer", "const": 1}


def test_validate_frame_is_strict_and_returns_a_clone():
    original = frame()
    snapshot = copy.deepcopy(original)

    validated = validate_frame(original, atom_count=1)

    assert original == snapshot
    assert validated == frame(
        temperature_K=298.4,
        potential_energy_kj_mol=-215.84,
        positions=[[0.0, 0.0, 0.0]],
    )
    assert validated is not original
    assert validated["units"] is not original["units"]
    assert validated["positions"] is not original["positions"]


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("schema_version", True),
        ("schema_version", 1.0),
        ("sequence", True),
        ("sequence", 1.0),
        ("sequence", "0"),
        ("sequence", MAX_SAFE_INTEGER + 1),
        ("index", True),
        ("index", 0.0),
        ("index", "0"),
        ("step", True),
        ("step", 0.0),
        ("step", "0"),
    ],
)
def test_validate_frame_rejects_non_strict_integer_fields(field, value):
    candidate = frame(**{field: value})
    with pytest.raises(StreamValidationError):
        validate_frame(candidate, atom_count=1)


def test_validate_frame_enforces_safe_index_equality_and_canonical_timestamp():
    with pytest.raises(StreamValidationError) as error:
        validate_frame(frame(index=1), atom_count=1)
    assert error.value.code == "frame_order"

    for timestamp in (
        "2026-05-18T10:00:00Z",
        "2026-05-18T10:00:00.00Z",
        "2026-05-18T10:00:00.000+00:00",
        "2026-02-30T10:00:00.000Z",
    ):
        with pytest.raises(StreamValidationError):
            validate_frame(frame(timestamp=timestamp), atom_count=1)


def test_validate_frame_enforces_units_coordinates_and_numeric_ranges():
    with pytest.raises(StreamValidationError) as units_error:
        validate_frame(frame(units={**FRAME_UNITS, "extra": "unit"}), atom_count=1)
    assert units_error.value.code == "invalid_units"

    for positions in ([], [[0, 0]], [[0, 0, 0], [1, 1, 1]], [[0, float("nan"), 0]], [[0, True, 0]]):
        with pytest.raises(StreamValidationError) as coordinate_error:
            validate_frame(frame(positions=positions), atom_count=1)
        assert coordinate_error.value.code == "missing_coordinates"

    for field, value in (("time_fs", -1), ("temperature_K", -0.1), ("potential_energy_kj_mol", float("inf"))):
        with pytest.raises(StreamValidationError):
            validate_frame(frame(**{field: value}), atom_count=1)


def test_validate_frame_enforces_stream_order():
    with pytest.raises(StreamValidationError) as step_error:
        validate_frame(frame(step=10), atom_count=1, previous_step=10)
    assert step_error.value.code == "duplicate_step"

    with pytest.raises(StreamValidationError) as time_error:
        validate_frame(frame(time_fs=10), atom_count=1, previous_time_fs=10)
    assert time_error.value.code == "frame_order"

    with pytest.raises(StreamValidationError) as timestamp_error:
        validate_frame(
            frame(timestamp="2026-05-18T09:59:59.999Z"),
            atom_count=1,
            previous_timestamp=TIMESTAMP,
        )
    assert timestamp_error.value.code == "frame_order"


def test_validate_units_requires_the_exact_canonical_map():
    with pytest.raises(StreamValidationError) as missing_error:
        validate_units({"position": "angstrom"})
    assert missing_error.value.code == "missing_units"

    with pytest.raises(StreamValidationError) as invalid_error:
        validate_units({**FRAME_UNITS, "time": "picosecond"})
    assert invalid_error.value.code == "invalid_units"


def test_load_bundled_trajectory_has_declared_metadata_and_inherited_frames():
    trajectory = load_trajectory()

    assert trajectory["schema_version"] == SCHEMA_VERSION
    assert trajectory["units"] == FRAME_UNITS
    assert len(trajectory["frames"]) == 12
    assert [frame["sequence"] for frame in trajectory["frames"]] == list(range(12))
    assert [frame["step"] for frame in trajectory["frames"]] == list(range(0, 240, 20))
    assert all(frame["units"] == FRAME_UNITS for frame in trajectory["frames"])


@pytest.mark.parametrize("top_level_field", ["schema_version", "units"])
def test_load_trajectory_requires_top_level_schema_and_units(tmp_path, top_level_field):
    document = trajectory_document(frame())
    del document[top_level_field]

    with pytest.raises(TrajectoryError) as error:
        load_trajectory(write_document(tmp_path, document))
    assert error.value.code == (
        "missing_schema_version" if top_level_field == "schema_version" else "missing_units"
    )


def test_load_trajectory_rejects_invalid_json(tmp_path):
    with pytest.raises(TrajectoryError) as error:
        load_trajectory(write_document(tmp_path, {}, text="{"))
    assert error.value.code == "invalid_json"


@pytest.mark.parametrize("timestep_fs", [0, -1, True, "2", float("nan"), float("inf")])
def test_load_trajectory_requires_positive_finite_timestep(tmp_path, timestep_fs):
    document = trajectory_document(frame())
    document["timestep_fs"] = timestep_fs

    with pytest.raises(TrajectoryError):
        load_trajectory(write_document(tmp_path, document))


@pytest.mark.parametrize(
    "mutate",
    [
        lambda document: document.update(schema_version=2),
        lambda document: document.update(schema_version=True),
        lambda document: document.update(schema_version=1.0),
        lambda document: document["units"].update(time="picosecond"),
        lambda document: document["frames"][0].update(schema_version=2),
        lambda document: document["frames"][0].update(index=0.0),
        lambda document: document["frames"][0].update(sequence=True),
        lambda document: document["frames"][0].update(units={"position": "angstrom"}),
    ],
)
def test_load_trajectory_does_not_overwrite_invalid_schema_or_frame_metadata(tmp_path, mutate):
    document = trajectory_document(frame())
    mutate(document)

    with pytest.raises(TrajectoryError):
        load_trajectory(write_document(tmp_path, document))


@pytest.mark.parametrize(
    "bad_positions",
    [[], [[0, 0]], [[0, 0, 0], [1, 1, 1]], [[0, 0, float("nan")]], [[0, "0", 0]]],
)
def test_load_trajectory_rejects_missing_truncated_and_nonfinite_coordinates(tmp_path, bad_positions):
    document = trajectory_document(frame(positions=bad_positions))

    with pytest.raises(TrajectoryError) as error:
        load_trajectory(write_document(tmp_path, document))
    assert error.value.code == "missing_coordinates"


@pytest.mark.parametrize(
    ("second_step", "second_time"),
    [(0, 2), (5, 0)],
)
def test_load_trajectory_rejects_duplicate_or_reordered_steps_and_time(tmp_path, second_step, second_time):
    document = trajectory_document(
        frame(step=0, time_fs=0),
        frame(step=second_step, sequence=1, index=1, time_fs=second_time, timestamp="2026-05-18T10:00:00.001Z"),
    )

    with pytest.raises(TrajectoryError) as error:
        load_trajectory(write_document(tmp_path, document))
    assert error.value.code in {"duplicate_step", "frame_order"}


def test_load_trajectory_inherits_optional_frame_metadata_without_mutating_source(tmp_path):
    source_frame = frame()
    source_frame.pop("schema_version")
    source_frame.pop("sequence")
    source_frame.pop("index")
    source_frame.pop("units")
    document = trajectory_document(source_frame)
    trajectory = load_trajectory(write_document(tmp_path, document))

    assert "schema_version" not in source_frame
    assert "sequence" not in source_frame
    assert "index" not in source_frame
    assert "units" not in source_frame
    assert trajectory["frames"][0]["units"] == FRAME_UNITS
