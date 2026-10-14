"""Deterministic signals for examples and smoke tests."""

import numpy as np

from .models import TimeSeries


def generate_demo_signals(
    *,
    duration: float = 8.0,
    sample_rate: float = 128.0,
    frequency: float = 2.0,
    phase_offset: float = np.pi / 4,
    units: str = "arbitrary",
) -> tuple[TimeSeries, TimeSeries]:
    """Generate two noiseless sine signals with a known phase offset.

    The returned pair is ``(first, second)`` and the second signal is
    ``sin(2*pi*frequency*time + phase_offset)``.  Defaults produce an exact
    2 Hz FFT-bin frequency and a ``pi/4`` phase lag.
    """

    if not all(np.isfinite(v) for v in (duration, sample_rate, frequency, phase_offset)):
        raise ValueError("demo parameters must be finite")
    if duration <= 0 or sample_rate <= 0 or frequency <= 0:
        raise ValueError("duration, sample_rate, and frequency must be positive")
    if frequency >= sample_rate / 2:
        raise ValueError("frequency must be below the Nyquist frequency")
    n_samples = int(round(duration * sample_rate))
    if n_samples < 2:
        raise ValueError("duration and sample_rate must produce at least two samples")
    time = np.arange(n_samples, dtype=float) / sample_rate
    first = np.sin(2.0 * np.pi * frequency * time)
    second = np.sin(2.0 * np.pi * frequency * time + phase_offset)
    return TimeSeries(time, first, units), TimeSeries(time, second, units)
