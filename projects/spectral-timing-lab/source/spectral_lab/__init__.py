"""Dependency-light tools for time-series spectral timing analysis.

Conventions
-----------
* Signals are sampled on a strictly increasing, uniformly spaced time grid.
  Times are in seconds and frequencies are returned in Hz.
* Spectra use one-sided real FFT bins from ``numpy.fft.rfftfreq``. The default
  is Welch-averaged density with units of ``value**2 / Hz``; non-DC/non-Nyquist
  bins are doubled to preserve total power. Windows, DC removal, averaging,
  normalization, NaN handling, and unequal-length handling are configurable.
* The cross spectrum is ``conj(FFT(first)) * FFT(second)``. Consequently,
  phase lag is ``phase(second) - phase(first)`` and is wrapped to
  ``[-pi, pi]`` radians.  A positive lag means the second signal leads in the
  Fourier phase convention used here.
"""

from .demo import generate_demo_signals
from .io import load_csv, parse_csv
from .models import (
    AnalysisResult,
    CrossSpectrum,
    SamplingInfo,
    Spectrum,
    TimeSeries,
)
from .sampling import validate_sampling
from .serialization import analysis_result_to_dict, analysis_result_to_json
from .spectral import analyze, coherence, cross_spectrum, phase_lag, power_spectrum

__all__ = [
    "AnalysisResult",
    "CrossSpectrum",
    "SamplingInfo",
    "Spectrum",
    "TimeSeries",
    "analysis_result_to_dict",
    "analysis_result_to_json",
    "analyze",
    "coherence",
    "cross_spectrum",
    "generate_demo_signals",
    "load_csv",
    "parse_csv",
    "phase_lag",
    "power_spectrum",
    "validate_sampling",
]
