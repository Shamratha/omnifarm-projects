"""Validation of time grids used by spectral calculations."""

from collections.abc import Sequence
from typing import Literal

import numpy as np

from .models import SamplingInfo


def validate_sampling(
    time: Sequence[float] | np.ndarray,
    other_time: Sequence[float] | np.ndarray | None = None,
    *,
    rtol: float = 1e-7,
    atol: float = 1e-12,
    length_policy: Literal["raise", "truncate"] = "raise",
) -> SamplingInfo:
    """Validate monotonic, uniform sampling and optionally a matching grid.

    The returned ``sample_rate`` is in Hz. ``other_time`` must have the same
    cadence, length, and aligned start as ``time`` by default. With
    ``length_policy="truncate"``, unequal lengths are allowed and the returned
    sample count describes the common prefix. Both full grids are validated.
    Grid tolerance is relative to the sample interval, not absolute timestamps
    (which may be large epoch times).
    """

    if length_policy not in {"raise", "truncate"}:
        raise ValueError("length_policy must be 'raise' or 'truncate'")
    if not np.isfinite(rtol) or not np.isfinite(atol) or rtol < 0 or atol < 0:
        raise ValueError("sampling tolerances must be finite and non-negative")
    first = np.asarray(time, dtype=float)
    if first.ndim != 1 or first.size < 2:
        raise ValueError("time must be a one-dimensional array with at least two samples")
    if not np.all(np.isfinite(first)):
        raise ValueError("time must contain only finite values")
    differences = np.diff(first)
    if not np.all(np.isfinite(differences)) or np.any(differences <= 0):
        raise ValueError("time must be strictly increasing")
    interval = float(differences[0])
    if not np.allclose(differences, interval, rtol=rtol, atol=atol):
        raise ValueError("time samples must be uniformly spaced")
    sample_rate = 1.0 / interval
    if not np.isfinite(sample_rate):
        raise ValueError("sample_rate must be finite")
    common = first.size

    if other_time is not None:
        second = np.asarray(other_time, dtype=float)
        if second.ndim != 1 or second.size < 2:
            raise ValueError("signals must each have at least two time samples")
        if length_policy == "raise" and second.size != first.size:
            raise ValueError(
                "signals must have the same sampling grid length; "
                "use length_policy='truncate' for a common prefix"
            )
        second_info = validate_sampling(second, rtol=rtol, atol=atol)
        tolerance = atol + rtol * max(interval, second_info.sample_interval)
        if abs(interval - second_info.sample_interval) > tolerance:
            raise ValueError("signals must use the same sampling grid and cadence")
        common = min(first.size, second.size)
        if np.any(np.abs(first[:common] - second[:common]) > tolerance):
            raise ValueError("signals must use the same sampling grid")

    return SamplingInfo(
        sample_interval=interval,
        sample_rate=sample_rate,
        n_samples=int(common),
    )
