import json

import numpy as np

from spectral_lab import (
    analysis_result_to_dict,
    analysis_result_to_json,
    analyze,
    generate_demo_signals,
)


def test_demo_recovers_frequency_phase_and_coherence():
    first, second = generate_demo_signals()
    result = analyze(first, second)

    peak = int(np.argmax(result.power_first[1:])) + 1
    assert result.frequency[peak] == 2.0
    assert np.isclose(result.phase_lag[peak], np.pi / 4, atol=1e-12)
    assert np.isclose(result.coherence[peak], 1.0, atol=1e-12)


def test_analysis_result_helpers_are_json_serializable():
    first, second = generate_demo_signals()
    result = analyze(first, second)

    as_dict = analysis_result_to_dict(result)
    encoded = analysis_result_to_json(result, sort_keys=True)
    decoded = json.loads(encoded)

    assert isinstance(as_dict["frequency"], list)
    assert decoded["first_units"] == "arbitrary"
    assert decoded["phase_lag"] == as_dict["phase_lag"]
