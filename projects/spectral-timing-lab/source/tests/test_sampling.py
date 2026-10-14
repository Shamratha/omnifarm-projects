import numpy as np
import pytest

from spectral_lab import TimeSeries, validate_sampling
from spectral_lab.spectral import power_spectrum


@pytest.mark.parametrize(
    "time, message",
    [
        ([0.0, 0.1, 0.1, 0.3], "strictly increasing"),
        ([0.0, 0.1, 0.21, 0.3], "uniformly spaced"),
    ],
)
def test_validate_sampling_rejects_invalid_time_grid(time, message):
    with pytest.raises(ValueError, match=message):
        validate_sampling(time)


def test_validate_sampling_rejects_different_grids():
    with pytest.raises(ValueError, match="same sampling grid"):
        validate_sampling([0.0, 0.1, 0.2], [0.0, 0.11, 0.22])


def test_spectral_calculation_rejects_nonuniform_signal_grid():
    signal = TimeSeries(np.array([0.0, 0.1, 0.21, 0.3]), np.ones(4), "counts")
    with pytest.raises(ValueError, match="uniformly spaced"):
        power_spectrum(signal)
