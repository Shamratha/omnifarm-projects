"""Numerical checks for the documented delayed-sinusoid phase convention."""

import numpy as np
import pytest

from spectral_lab import TimeSeries, analyze


SAMPLE_RATE = 64.0
FREQUENCY = 4.0
SAMPLE_COUNT = 256


def delayed_sinusoid(delay_samples: int) -> tuple[TimeSeries, TimeSeries]:
    time = np.arange(SAMPLE_COUNT) / SAMPLE_RATE
    first = np.sin(2.0 * np.pi * FREQUENCY * time)
    second = np.sin(2.0 * np.pi * FREQUENCY * (time - delay_samples / SAMPLE_RATE))
    return (
        TimeSeries(time, first, "counts"),
        TimeSeries(time.copy(), second, "counts"),
    )


def test_positive_delay_has_negative_phase_and_unit_coherence():
    delay_samples = 3
    first, second = delayed_sinusoid(delay_samples)

    assert np.array_equal(first.time, second.time)
    result = analyze(first, second, nperseg=SAMPLE_COUNT, noverlap=0, window="boxcar")
    frequency_bin = int(round(FREQUENCY / (SAMPLE_RATE / SAMPLE_COUNT)))
    expected_phase = np.angle(
        np.exp(-2j * np.pi * FREQUENCY * delay_samples / SAMPLE_RATE)
    )

    assert result.frequency[frequency_bin] == FREQUENCY
    assert result.phase_lag[frequency_bin] == pytest.approx(expected_phase, rel=0, abs=1e-12)
    assert result.phase_lag[frequency_bin] < 0
    assert result.coherence[frequency_bin] == pytest.approx(1.0, rel=0, abs=1e-12)


def test_delayed_phase_is_principal_wrapped():
    delay_samples = 9
    first, second = delayed_sinusoid(delay_samples)

    result = analyze(first, second, nperseg=SAMPLE_COUNT, noverlap=0, window="boxcar")
    frequency_bin = int(round(FREQUENCY / (SAMPLE_RATE / SAMPLE_COUNT)))
    expected_phase = np.angle(
        np.exp(-2j * np.pi * FREQUENCY * delay_samples / SAMPLE_RATE)
    )

    assert expected_phase == pytest.approx(7.0 * np.pi / 8.0)
    assert result.phase_lag[frequency_bin] == pytest.approx(expected_phase, rel=0, abs=1e-12)
    assert -np.pi <= result.phase_lag[frequency_bin] <= np.pi
    assert result.coherence[frequency_bin] == pytest.approx(1.0, rel=0, abs=1e-12)


@pytest.mark.parametrize(
    "other_time",
    [
        np.arange(SAMPLE_COUNT) / SAMPLE_RATE + 1.0 / SAMPLE_RATE,
        np.arange(SAMPLE_COUNT) / (SAMPLE_RATE * 1.25),
    ],
    ids=["shifted-timestamps", "different-cadence"],
)
def test_delayed_sinusoid_requires_an_identical_time_grid(other_time):
    first, second = delayed_sinusoid(3)
    mismatched_second = TimeSeries(other_time, second.value, second.units)

    with pytest.raises(ValueError, match="sampling grid"):
        analyze(first, mismatched_second, window="boxcar")
