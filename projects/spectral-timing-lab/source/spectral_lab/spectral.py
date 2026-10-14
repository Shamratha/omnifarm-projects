"""One-sided Welch spectral estimates implemented with NumPy.

Defaults preserve the original numerical convention: complete segments with
50% overlap, a periodic Hann window, per-segment mean subtraction, mean
averaging, and one-sided density normalization by
``sample_rate * sum(window**2)``. Public functions expose each of those
choices explicitly. ``normalization="spectrum"`` instead divides by
``sum(window)**2`` and returns value squared rather than value squared per Hz.

Paired calculations optionally allow unequal sample lengths when signals have
an aligned start and cadence; only the common prefix is analyzed. NaN-containing
segments can be rejected or omitted. Zero-power phase and coherence bins use
finite zero placeholders because their values are undefined.
"""

import operator
from typing import Literal

import numpy as np

from .models import AnalysisResult, CrossSpectrum, Spectrum, TimeSeries
from .sampling import validate_sampling

AverageMethod = Literal["mean", "median"]
Normalization = Literal["density", "spectrum"]
NanPolicy = Literal["raise", "omit"]
LengthPolicy = Literal["raise", "truncate"]


def _segment_options(n: int, nperseg: int | None, noverlap: int | None) -> tuple[int, int]:
    """Validate and resolve segment length and overlap."""

    if isinstance(nperseg, (bool, np.bool_)) or isinstance(noverlap, (bool, np.bool_)):
        raise ValueError("nperseg and noverlap must be integers, not booleans")
    try:
        size = min(256, n) if nperseg is None else operator.index(nperseg)
        overlap = size // 2 if noverlap is None else operator.index(noverlap)
    except TypeError as error:
        raise ValueError("nperseg and noverlap must be integers") from error
    if not 2 <= size <= n:
        raise ValueError("nperseg must be between 2 and the signal length")
    if not 0 <= overlap < size:
        raise ValueError("noverlap must satisfy 0 <= noverlap < nperseg")
    return size, overlap


def _window_values(size: int, window: str | np.ndarray | None) -> np.ndarray:
    """Return a finite window with exactly ``size`` samples."""

    if window is None:
        name = "boxcar"
    elif isinstance(window, str):
        name = window.lower()
    else:
        if np.iscomplexobj(window):
            raise ValueError("custom window must contain real values")
        values = np.asarray(window, dtype=float)
        if values.ndim != 1 or values.size != size:
            raise ValueError(
                "custom window must be a one-dimensional array of length nperseg"
            )
        if not np.all(np.isfinite(values)) or not np.any(values):
            raise ValueError("custom window must be finite and contain a non-zero value")
        return values

    if name in {"boxcar", "rectangular", "rect"}:
        values = np.ones(size)
    elif name in {"hann", "hanning"}:
        values = np.hanning(size + 1)[:-1]
    elif name == "hamming":
        values = np.hamming(size + 1)[:-1]
    elif name == "blackman":
        values = np.blackman(size + 1)[:-1]
    else:
        raise ValueError(
            "window must be 'hann', 'hamming', 'blackman', 'boxcar', "
            "'rectangular', or a custom array"
        )
    return values


def _validate_options(
    average: AverageMethod, normalization: Normalization, nan_policy: NanPolicy
) -> None:
    """Validate options shared by spectral functions."""

    if average not in {"mean", "median"}:
        raise ValueError("average must be 'mean' or 'median'")
    if normalization not in {"density", "spectrum"}:
        raise ValueError("normalization must be 'density' or 'spectrum'")
    if nan_policy not in {"raise", "omit"}:
        raise ValueError("nan_policy must be 'raise' or 'omit'")


def _transforms(
    values: np.ndarray,
    size: int,
    overlap: int,
    window: np.ndarray,
    remove_dc: bool,
    nan_policy: NanPolicy,
    *,
    other: np.ndarray | None = None,
) -> tuple[np.ndarray, np.ndarray | None]:
    """Return FFT rows for complete finite segments."""

    for data in (values,) if other is None else (values, other):
        if np.any(np.isinf(data)):
            raise ValueError("signal values must not contain infinities")
        if nan_policy == "raise" and np.any(np.isnan(data)):
            raise ValueError(
                "signal contains NaN values; use nan_policy='omit' "
                "to skip affected segments"
            )
    segments = np.lib.stride_tricks.sliding_window_view(values, size)[:: size - overlap]
    other_segments = (
        None
        if other is None
        else np.lib.stride_tricks.sliding_window_view(other, size)[:: size - overlap]
    )
    valid = np.all(np.isfinite(segments), axis=1)
    if other_segments is not None:
        valid &= np.all(np.isfinite(other_segments), axis=1)
    segments = segments[valid]
    if other_segments is not None:
        other_segments = other_segments[valid]
    if not len(segments):
        raise ValueError("no complete finite segments available")
    if remove_dc:
        segments = segments - np.mean(segments, axis=1, keepdims=True)
        if other_segments is not None:
            other_segments = other_segments - np.mean(
                other_segments, axis=1, keepdims=True
            )
    first_transform = np.fft.rfft(segments * window, axis=1)
    second_transform = (
        None if other_segments is None else np.fft.rfft(other_segments * window, axis=1)
    )
    return first_transform, second_transform


def _aggregate(values: np.ndarray, average: AverageMethod) -> np.ndarray:
    """Aggregate segment values, using component-wise complex medians."""

    if average == "mean":
        return np.mean(values, axis=0)
    if np.iscomplexobj(values):
        return np.median(values.real, axis=0) + 1j * np.median(values.imag, axis=0)
    return np.median(values, axis=0)


def _scale(
    values: np.ndarray,
    window: np.ndarray,
    size: int,
    sample_rate: float,
    average: AverageMethod,
    normalization: Normalization,
) -> np.ndarray:
    """Aggregate and apply one-sided density or spectrum scaling."""

    denominator = (
        sample_rate * np.sum(window**2)
        if normalization == "density"
        else np.sum(window) ** 2
    )
    if not np.isfinite(denominator) or denominator <= 0:
        raise ValueError("window normalization denominator must be positive and finite")
    scaled = _aggregate(values, average) / denominator
    if size % 2 == 0:
        scaled[1:-1] *= 2.0
    else:
        scaled[1:] *= 2.0
    return scaled


def power_spectrum(
    signal: TimeSeries,
    *,
    nperseg: int | None = None,
    noverlap: int | None = None,
    window: str | np.ndarray | None = "hann",
    remove_dc: bool = True,
    average: AverageMethod = "mean",
    normalization: Normalization = "density",
    nan_policy: NanPolicy = "raise",
) -> Spectrum:
    """Return a one-sided Welch power estimate with explicit conventions.

    The default is a mean-averaged density in ``signal.units**2 / Hz``.
    ``normalization="spectrum"`` returns ``signal.units**2``; the container's
    ``units`` remains the original signal label.

    ``nperseg`` defaults to ``min(256, n_samples)`` and ``noverlap`` to half
    that size. Incomplete trailing segments are discarded, without padding.
    Pass ``nperseg=len(signal.time), noverlap=0`` for one periodogram.
    Windows are periodic ``"hann"``, ``"hamming"``, ``"blackman"``, or
    ``"boxcar"`` (also ``"rectangular"`` or None), or a finite real array of
    length ``nperseg``. ``remove_dc`` subtracts the segment's unweighted mean
    before windowing; it does not forcibly zero the returned DC bin.

    ``average="median"`` is an uncorrected median of segment periodograms;
    unlike the mean, its integrated density need not equal average power.
    ``nan_policy="raise"`` rejects any NaN, including in the discarded tail.
    ``"omit"`` drops affected complete segments without removing samples or
    interpolating; no remaining segment raises ValueError.
    """

    _validate_options(average, normalization, nan_policy)
    if not isinstance(remove_dc, (bool, np.bool_)):
        raise ValueError("remove_dc must be a boolean")
    sampling = validate_sampling(signal.time)
    size, overlap = _segment_options(sampling.n_samples, nperseg, noverlap)
    window_values = _window_values(size, window)
    transform, _ = _transforms(
        signal.value, size, overlap, window_values, bool(remove_dc), nan_policy
    )
    frequency = np.fft.rfftfreq(size, d=sampling.sample_interval)
    power = _scale(
        np.abs(transform) ** 2,
        window_values,
        size,
        sampling.sample_rate,
        average,
        normalization,
    )
    return Spectrum(frequency, power, signal.units, normalization)


def _paired_spectra(
    first: TimeSeries,
    second: TimeSeries,
    nperseg: int | None,
    noverlap: int | None,
    window: str | np.ndarray | None,
    remove_dc: bool,
    average: AverageMethod,
    normalization: Normalization,
    nan_policy: NanPolicy,
    length_policy: LengthPolicy,
) -> tuple[Spectrum, Spectrum, CrossSpectrum, float]:
    """Compute paired spectra over the aligned common prefix."""

    _validate_options(average, normalization, nan_policy)
    if not isinstance(remove_dc, (bool, np.bool_)):
        raise ValueError("remove_dc must be a boolean")
    sampling = validate_sampling(first.time, second.time, length_policy=length_policy)
    common = sampling.n_samples
    size, overlap = _segment_options(common, nperseg, noverlap)
    window_values = _window_values(size, window)
    x, y = _transforms(
        first.value[:common],
        size,
        overlap,
        window_values,
        bool(remove_dc),
        nan_policy,
        other=second.value[:common],
    )
    assert y is not None
    frequency = np.fft.rfftfreq(size, d=sampling.sample_interval)
    px = _scale(
        np.abs(x) ** 2, window_values, size, sampling.sample_rate, average, normalization
    )
    py = _scale(
        np.abs(y) ** 2, window_values, size, sampling.sample_rate, average, normalization
    )
    cross = _scale(
        np.conj(x) * y, window_values, size, sampling.sample_rate, average, normalization
    )
    return (
        Spectrum(frequency, px, first.units, normalization),
        Spectrum(frequency, py, second.units, normalization),
        CrossSpectrum(frequency, cross, first.units, second.units, normalization),
        sampling.sample_rate,
    )


def cross_spectrum(
    first: TimeSeries,
    second: TimeSeries,
    *,
    nperseg: int | None = None,
    noverlap: int | None = None,
    window: str | np.ndarray | None = "hann",
    remove_dc: bool = True,
    average: AverageMethod = "mean",
    normalization: Normalization = "density",
    nan_policy: NanPolicy = "raise",
    length_policy: LengthPolicy = "raise",
) -> CrossSpectrum:
    """Return averaged ``conj(X) * Y`` with the selected normalization.

    Options follow :func:`power_spectrum`. ``length_policy="truncate"`` uses
    the aligned common prefix; the default rejects unequal lengths. Different
    cadences or shifted grids always raise ValueError; no resampling occurs.
    NaN omission uses a shared segment mask for both signals. Median averaging
    takes uncorrected medians of the real and imaginary components separately.
    """

    return _paired_spectra(
        first, second, nperseg, noverlap, window, remove_dc,
        average, normalization, nan_policy, length_policy,
    )[2]


def phase_lag(cross: CrossSpectrum) -> np.ndarray:
    """Return second-minus-first phase in radians, wrapped to [-pi, pi].

    An exactly zero cross value returns zero as an undefined-phase placeholder.
    No low-power threshold is applied to small but nonzero cross values.
    """

    return np.where(np.abs(cross.cross) > 0, np.angle(cross.cross), 0.0)


def coherence(first: Spectrum, second: Spectrum, cross: CrossSpectrum) -> np.ndarray:
    """Return clipped magnitude-squared coherence.

    Zero-power bins return zero as a finite placeholder for an undefined
    measurement. All inputs must use identical frequency bins and
    normalization, segment selection, window, detrending, and averaging.
    Only frequency bins and normalization can be checked from these containers.
    Prefer :func:`analyze` for consistent paired estimates, especially with NaNs
    or unequal lengths. Single-segment coherence is one wherever both signals
    have power; it is not evidence of correlation. Component-wise median
    estimates need not obey the usual coherence bound and are also clipped.
    """

    for frequency in (second.frequency, cross.frequency):
        if frequency.shape != first.frequency.shape or not np.array_equal(
            first.frequency, frequency
        ):
            raise ValueError("spectra must use the same frequency bins")
    if not first.normalization == second.normalization == cross.normalization:
        raise ValueError("spectra must use the same normalization")
    # Avoid overflowing/underflowing the product Pxx * Pyy or |Pxy|**2.
    valid = (first.power > 0) & (second.power > 0)
    result = np.zeros_like(first.power)
    larger = np.sqrt(np.maximum(first.power, second.power))
    smaller = np.sqrt(np.minimum(first.power, second.power))
    with np.errstate(over="ignore", under="ignore"):
        np.divide(np.abs(cross.cross), larger, out=result, where=valid)
        np.divide(result, smaller, out=result, where=valid)
    return np.clip(result, 0.0, 1.0) ** 2


def analyze(
    first: TimeSeries,
    second: TimeSeries,
    *,
    nperseg: int | None = None,
    noverlap: int | None = None,
    window: str | np.ndarray | None = "hann",
    remove_dc: bool = True,
    average: AverageMethod = "mean",
    normalization: Normalization = "density",
    nan_policy: NanPolicy = "raise",
    length_policy: LengthPolicy = "raise",
) -> AnalysisResult:
    """Compute powers, cross spectrum, phase, and coherence consistently.

    Options follow :func:`power_spectrum` and :func:`cross_spectrum`. All three
    spectra use identical segments, including a shared NaN-omission mask.
    Phase is second-minus-first in radians; coherence is dimensionless.
    Zero-power bins return zero phase/coherence placeholders.
    """

    px, py, cross, sample_rate = _paired_spectra(
        first, second, nperseg, noverlap, window, remove_dc,
        average, normalization, nan_policy, length_policy,
    )
    return AnalysisResult(
        frequency=px.frequency,
        power_first=px.power,
        power_second=py.power,
        cross_real=cross.cross.real,
        cross_imag=cross.cross.imag,
        phase_lag=phase_lag(cross),
        coherence=coherence(px, py, cross),
        first_units=first.units,
        second_units=second.units,
        sample_rate=sample_rate,
        normalization=normalization,
    )
