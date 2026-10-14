from io import StringIO

import numpy as np
import pytest

from spectral_lab import parse_csv


def test_parse_csv_builds_typed_time_series():
    signal = parse_csv(
        StringIO("time,value,units\n0,1.5,counts\n0.1,2.5,counts\n0.2,3.5,counts\n")
    )

    assert signal.units == "counts"
    np.testing.assert_allclose(signal.time, [0.0, 0.1, 0.2])
    np.testing.assert_allclose(signal.value, [1.5, 2.5, 3.5])


@pytest.mark.parametrize(
    ("csv_text", "message"),
    [
        ("time,value\n0,1\n", "missing required column"),
        ("time,value,units\n0,nope,counts\n", "invalid numeric"),
        ("time,value,units\n0,1,\n", "units must be non-empty"),
        ("time,value,units\n0,1,counts\n1,2,rate\n", "consistent"),
    ],
)
def test_parse_csv_rejects_invalid_rows(csv_text, message):
    with pytest.raises(ValueError, match=message):
        parse_csv(StringIO(csv_text))
