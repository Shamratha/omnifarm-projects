"""Typed containers used by :mod:`spectral_lab`."""

from dataclasses import dataclass
from typing import Literal

import numpy as np

Normalization = Literal["density", "spectrum"]


def _vector(value: np.ndarray, name: str, *, allow_nan: bool = False) -> np.ndarray:
    """Convert a real vector, allowing missing samples only when requested."""

    if np.iscomplexobj(value):
        raise ValueError(f"{name} must contain real values")
    array = np.asarray(value, dtype=float)
    if array.ndim != 1:
        raise ValueError(f"{name} must be a one-dimensional array")
    if array.size == 0:
        raise ValueError(f"{name} must not be empty")
    if allow_nan:
        valid = np.isfinite(array) | np.isnan(array)
    else:
        valid = np.isfinite(array)
    if not np.all(valid):
        suffix = " or NaN" if allow_nan else ""
        raise ValueError(f"{name} must contain only finite values{suffix}")
    return array


@dataclass(frozen=True)
class TimeSeries:
    """A sampled scalar signal with a unit label.

    ``time`` is in seconds.  Values are intentionally not assigned a physical
    scale by this package; ``units`` is carried through to analysis output.
    Times must be finite. Values may contain NaNs so spectral functions can
    apply their explicit ``nan_policy``; infinities are always rejected.
    """

    time: np.ndarray
    value: np.ndarray
    units: str

    def __post_init__(self) -> None:
        time = _vector(self.time, "time")
        value = _vector(self.value, "value", allow_nan=True)
        if time.size != value.size:
            raise ValueError("time and value must have the same length")
        units = self.units.strip() if isinstance(self.units, str) else ""
        if not units:
            raise ValueError("units must be a non-empty string")
        object.__setattr__(self, "time", time)
        object.__setattr__(self, "value", value)
        object.__setattr__(self, "units", units)


@dataclass(frozen=True)
class SamplingInfo:
    """Validated properties of a uniform sampling grid."""

    sample_interval: float
    sample_rate: float
    n_samples: int


@dataclass(frozen=True)
class Spectrum:
    """One-sided power estimate with frequency in Hz.

    ``units`` labels the input signal. Power has units ``units**2 / Hz`` for
    density normalization or ``units**2`` for spectrum normalization.
    """

    frequency: np.ndarray
    power: np.ndarray
    units: str
    normalization: Normalization = "density"

    def __post_init__(self) -> None:
        frequency = _vector(self.frequency, "frequency")
        power = _vector(self.power, "power")
        if frequency.size != power.size:
            raise ValueError("frequency and power must have the same length")
        if np.any(power < 0):
            raise ValueError("power must be non-negative")
        if self.normalization not in {"density", "spectrum"}:
            raise ValueError("normalization must be 'density' or 'spectrum'")
        object.__setattr__(self, "frequency", frequency)
        object.__setattr__(self, "power", power)


@dataclass(frozen=True)
class CrossSpectrum:
    """One-sided ``conj(X) * Y`` estimate with frequency in Hz.

    Cross values have units ``first_units * second_units / Hz`` for density
    normalization or ``first_units * second_units`` for spectrum normalization.
    """

    frequency: np.ndarray
    cross: np.ndarray
    first_units: str
    second_units: str
    normalization: Normalization = "density"

    def __post_init__(self) -> None:
        frequency = _vector(self.frequency, "frequency")
        cross = np.asarray(self.cross, dtype=complex)
        if cross.ndim != 1 or cross.size == 0:
            raise ValueError("cross must be a non-empty one-dimensional array")
        if frequency.size != cross.size:
            raise ValueError("frequency and cross must have the same length")
        if not np.all(np.isfinite(cross)):
            raise ValueError("cross must contain only finite values")
        if self.normalization not in {"density", "spectrum"}:
            raise ValueError("normalization must be 'density' or 'spectrum'")
        object.__setattr__(self, "frequency", frequency)
        object.__setattr__(self, "cross", cross)


@dataclass(frozen=True)
class AnalysisResult:
    """Finite spectral timing arrays suitable for JSON conversion.

    ``normalization`` determines power/cross units as in :class:`Spectrum`
    and :class:`CrossSpectrum`; phase is in radians and coherence is unitless.
    Undefined zero-power phase/coherence bins use zero placeholders.
    """

    frequency: np.ndarray
    power_first: np.ndarray
    power_second: np.ndarray
    cross_real: np.ndarray
    cross_imag: np.ndarray
    phase_lag: np.ndarray
    coherence: np.ndarray
    first_units: str
    second_units: str
    sample_rate: float
    normalization: Normalization = "density"

    def __post_init__(self) -> None:
        arrays = {
            "frequency": self.frequency,
            "power_first": self.power_first,
            "power_second": self.power_second,
            "cross_real": self.cross_real,
            "cross_imag": self.cross_imag,
            "phase_lag": self.phase_lag,
            "coherence": self.coherence,
        }
        converted = {name: _vector(value, name) for name, value in arrays.items()}
        length = converted["frequency"].size
        if any(value.size != length for value in converted.values()):
            raise ValueError("all analysis arrays must have the same length")
        if np.any(converted["power_first"] < 0) or np.any(converted["power_second"] < 0):
            raise ValueError("power must be non-negative")
        if np.any(converted["coherence"] < 0) or np.any(converted["coherence"] > 1):
            raise ValueError("coherence must be between zero and one")
        for name, value in converted.items():
            object.__setattr__(self, name, value)
        if not self.first_units or not self.second_units:
            raise ValueError("analysis units must be non-empty")
        if not np.isfinite(self.sample_rate) or self.sample_rate <= 0:
            raise ValueError("sample_rate must be positive and finite")
        if self.normalization not in {"density", "spectrum"}:
            raise ValueError("normalization must be 'density' or 'spectrum'")
