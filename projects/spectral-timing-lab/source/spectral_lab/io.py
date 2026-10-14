"""CSV input and validation."""

import csv
from os import PathLike
from pathlib import Path
from typing import Literal, TextIO

import numpy as np

from .models import TimeSeries


def parse_csv(
    source: str | PathLike[str] | TextIO,
    *,
    nan_policy: Literal["raise", "allow"] = "raise",
) -> TimeSeries:
    """Parse a CSV containing ``time``, ``value``, and ``units`` columns.

    Every row must contain a finite numeric time field and a numeric value.
    Values may be NaN when ``nan_policy="allow"``; infinities are always
    rejected. The units column must be non-empty and consistent across all
    rows. ``source`` may be a filesystem path or an open text stream.
    Additional named columns are allowed; duplicate headers and ragged rows
    are rejected. Sampling is validated separately by the analysis functions.
    Open streams stay open.
    """

    if nan_policy not in {"raise", "allow"}:
        raise ValueError("nan_policy must be 'raise' or 'allow'")
    close_source = False
    if hasattr(source, "read"):
        stream = source
    else:
        stream = Path(source).open("r", newline="", encoding="utf-8")
        close_source = True
    try:
        reader = csv.DictReader(stream, strict=True)
        if reader.fieldnames and len(set(reader.fieldnames)) != len(reader.fieldnames):
            raise ValueError("CSV column names must be unique")
        fields = set(reader.fieldnames or [])
        required = {"time", "value", "units"}
        missing = required - fields
        if missing:
            names = ", ".join(sorted(missing))
            raise ValueError(f"CSV is missing required column(s): {names}")

        times: list[float] = []
        values: list[float] = []
        units: list[str] = []
        for row_number, row in enumerate(reader, start=2):
            if None in row or any(value is None for value in row.values()):
                raise ValueError(f"incorrect number of fields on CSV row {row_number}")
            try:
                time = float(row["time"])
                value = float(row["value"])
            except (TypeError, ValueError) as error:
                raise ValueError(f"invalid numeric value on CSV row {row_number}") from error
            allowed_nan = nan_policy == "allow" and np.isnan(value)
            if not np.isfinite(time) or (not np.isfinite(value) and not allowed_nan):
                raise ValueError(f"non-finite numeric value on CSV row {row_number}")
            unit = (row["units"] or "").strip()
            if not unit:
                raise ValueError(f"units must be non-empty on CSV row {row_number}")
            times.append(time)
            values.append(value)
            units.append(unit)
        if not times:
            raise ValueError("CSV must contain at least one data row")
        if len(set(units)) != 1:
            raise ValueError("units must be consistent across CSV rows")
        return TimeSeries(np.asarray(times), np.asarray(values), units[0])
    except csv.Error as error:
        raise ValueError(f"malformed CSV: {error}") from error
    finally:
        if close_source:
            stream.close()


load_csv = parse_csv
