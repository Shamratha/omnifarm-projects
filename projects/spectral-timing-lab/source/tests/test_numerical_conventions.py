"""Numerical contract checks, independent of implementation helpers."""

import io
import json

import numpy as np
import pytest

from spectral_lab import (
    TimeSeries, analyze, power_spectrum, parse_csv, generate_demo_signals,
    analysis_result_to_json,
)


def signal(values, rate=64):
    return TimeSeries(np.arange(len(values)) / rate, np.asarray(values), "counts")


@pytest.mark.parametrize("window", ["hann", "hamming", "blackman", "boxcar"])
@pytest.mark.parametrize("phase", [-np.pi / 3, np.pi / 4])
def test_frequency_and_signed_phase(window, phase):
    a, b = generate_demo_signals(frequency=4, phase_offset=phase)
    result = analyze(a, b, window=window)
    peak = np.argmax(result.power_first[1:]) + 1
    assert result.frequency[peak] == 4
    assert result.phase_lag[peak] == pytest.approx(phase, abs=1e-12)
    assert result.coherence[peak] == pytest.approx(1)
    swapped = analyze(b, a, window=window)
    assert swapped.phase_lag[peak] == pytest.approx(-phase, abs=1e-12)


@pytest.mark.parametrize("size", [15, 16])
@pytest.mark.parametrize("window", ["hann", "boxcar"])
def test_density_integrates_to_window_weighted_power(size, window):
    values = np.random.default_rng(92).normal(size=size)
    weights = np.ones(size) if window == "boxcar" else np.hanning(size + 1)[:-1]
    result = power_spectrum(signal(values), nperseg=size, window=window)
    expected = np.sum(((values - values.mean()) * weights) ** 2) / np.sum(weights**2)
    assert result.power.sum() * 64 / size == pytest.approx(expected)


def test_dc_removal_and_endpoint_doubling():
    constant = signal(np.full(16, 3.0))
    removed = analyze(constant, constant, window="boxcar")
    assert np.all(removed.power_first == 0)
    assert np.all(removed.phase_lag == 0)
    assert np.all(removed.coherence == 0)
    retained = power_spectrum(constant, window="boxcar", remove_dc=False)
    assert retained.power[0] == pytest.approx(9 * 16 / 64)
    for size, factors in [(4, [1, 2, 1]), (5, [1, 2, 2])]:
        impulse = power_spectrum(signal([1] + [0] * (size - 1)),
                                 nperseg=size, window="boxcar", remove_dc=False)
        np.testing.assert_allclose(impulse.power, np.asarray(factors) / (64 * size))


@pytest.mark.parametrize("average", ["mean", "median"])
def test_complete_segments_are_averaged_before_coherence(average):
    rng = np.random.default_rng(45)
    a, b = signal(rng.normal(size=25)), signal(rng.normal(size=25))
    parts = [analyze(signal(a.value[start:start + 8]), signal(b.value[start:start + 8]),
                     nperseg=8, window="boxcar") for start in range(0, 18, 4)]
    combined = analyze(a, b, nperseg=8, noverlap=4, window="boxcar", average=average)
    aggregate = np.mean if average == "mean" else np.median
    for name in ["power_first", "power_second", "cross_real", "cross_imag"]:
        np.testing.assert_allclose(getattr(combined, name),
                                   aggregate([getattr(p, name) for p in parts], axis=0))
    assert np.isfinite(combined.coherence).all()
    assert ((combined.coherence >= 0) & (combined.coherence <= 1)).all()


def test_density_spectrum_ratio_and_json_units():
    a, b = generate_demo_signals()
    density = analyze(a, b)
    spectrum = analyze(a, b, normalization="spectrum")
    weights = np.hanning(257)[:-1]
    enbw = 128 * np.sum(weights**2) / weights.sum() ** 2
    for name in ["power_first", "power_second", "cross_real", "cross_imag"]:
        np.testing.assert_allclose(getattr(spectrum, name), getattr(density, name) * enbw)
    np.testing.assert_allclose(spectrum.coherence, density.coherence, atol=1e-14)
    payload = json.loads(analysis_result_to_json(spectrum))
    assert payload["normalization"] == "spectrum"
    assert "/Hz" not in payload["cross_units"]


def test_unequal_lengths_require_opt_in_and_never_resample():
    short, long = signal(np.arange(8)), signal(np.arange(12))
    for a, b in [(short, long), (long, short)]:
        with pytest.raises(ValueError, match="length"):
            analyze(a, b)
        result = analyze(a, b, length_policy="truncate")
        expected = analyze(signal(a.value[:8]), signal(b.value[:8]))
        np.testing.assert_allclose(result.cross_real, expected.cross_real)
    for other in [signal(np.arange(12), rate=32),
                  TimeSeries(long.time + .01, long.value, long.units)]:
        with pytest.raises(ValueError, match="sampling grid"):
            analyze(short, other, length_policy="truncate")


def test_nan_segments_use_shared_mask_without_changing_cadence():
    a = signal([np.nan, 2, 3, 4, 5, 6, 7, 8])
    b = signal([1, 0, 2, 1, 3, 2, 4, np.nan])
    with pytest.raises(ValueError, match="NaN"):
        analyze(a, b, nperseg=4)
    actual = analyze(a, b, nperseg=4, nan_policy="omit")
    expected = analyze(signal(a.value[2:6]), signal(b.value[2:6]), nperseg=4)
    for name in ["power_first", "power_second", "cross_real", "cross_imag", "coherence"]:
        np.testing.assert_allclose(getattr(actual, name), getattr(expected, name))
    with pytest.raises(ValueError, match="no complete finite"):
        analyze(signal([np.nan] * 8), b, nperseg=4, nan_policy="omit")


def test_missing_csv_values_and_nonfinite_inputs_are_explicit():
    with pytest.raises(ValueError, match="non-finite"):
        parse_csv(io.StringIO("time,value,units\n0,NaN,c\n1,2,c\n"))
    parsed = parse_csv(io.StringIO("time,value,units\n0,NaN,c\n1,2,c\n"), nan_policy="allow")
    assert np.isnan(parsed.value[0])
    with pytest.raises(ValueError, match="invalid numeric"):
        parse_csv(io.StringIO("time,value,units\n0,,c\n1,2,c\n"))
    with pytest.raises(ValueError, match="finite"):
        signal([1, np.inf])
    with pytest.raises(ValueError, match="finite"):
        TimeSeries([0, np.nan], [1, 2], "c")


@pytest.mark.parametrize("kwargs", [
    {"nperseg": 2.5}, {"noverlap": 256}, {"window": "invalid"},
    {"window": np.zeros(256)}, {"average": "invalid"},
    {"normalization": "invalid"}, {"remove_dc": "yes"},
])
def test_invalid_analysis_options_raise(kwargs):
    a, b = generate_demo_signals()
    with pytest.raises(ValueError):
        analyze(a, b, **kwargs)
