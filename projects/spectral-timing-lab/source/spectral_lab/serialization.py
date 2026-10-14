"""JSON-safe conversion for analysis results."""

import json
from typing import Any

from .models import AnalysisResult


def analysis_result_to_dict(result: AnalysisResult) -> dict[str, Any]:
    """Convert to JSON-native values, with explicit conventions and unit labels."""

    suffix = "/Hz" if result.normalization == "density" else ""
    return {
        "frequency": result.frequency.tolist(),
        "power_first": result.power_first.tolist(),
        "power_second": result.power_second.tolist(),
        "cross_real": result.cross_real.tolist(),
        "cross_imag": result.cross_imag.tolist(),
        "phase_lag": result.phase_lag.tolist(),
        "coherence": result.coherence.tolist(),
        "first_units": result.first_units,
        "second_units": result.second_units,
        "sample_rate": float(result.sample_rate),
        "frequency_units": "Hz",
        "phase_lag_units": "rad",
        "phase_convention": "second minus first; positive means second leads",
        "normalization": result.normalization,
        "power_first_units": f"({result.first_units})^2{suffix}",
        "power_second_units": f"({result.second_units})^2{suffix}",
        "cross_units": f"({result.first_units})*({result.second_units}){suffix}",
        "coherence_units": "dimensionless",
    }


def analysis_result_to_json(result: AnalysisResult, **kwargs: Any) -> str:
    """Serialize an analysis result with :func:`json.dumps` options."""

    kwargs.setdefault("allow_nan", False)
    return json.dumps(analysis_result_to_dict(result), **kwargs)
