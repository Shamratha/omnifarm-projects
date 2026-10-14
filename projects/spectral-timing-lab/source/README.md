# Spectral Timing Lab

Spectral Timing Lab is a local, independent analysis workbench for reviewing the
timing relationship between two sampled signals. It has:

- a Python/NumPy numerical core for CSV loading, sampling validation, Welch
  power spectra, cross spectra, phase lags, coherence, and JSON-safe results;
- a dependency-free browser review interface with local CSV import, linked
  time/frequency plots, parameter controls, validation feedback, and a
  deterministic demo signal;
- deterministic test signals with a 2 Hz feature and a `π/4` phase offset so
  the core and interface can be checked against known outputs.

> **Scope:** This is an independent analysis workbench, not a replacement for
> the named Julia package or a production X-ray timing pipeline. The source idea
> is [Spectral Timing in Julia: Extending Stingray.jl for X-ray Astronomy
> (OpenAstronomy)](https://summerofcode.withgoogle.com/programs/2026/projects/0VhXusPh).

## Quick start

Create an environment and install the numerical/test dependencies:

```bash
python -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
```

Run the Python checks:

```bash
.venv/bin/python -m pytest -q
```

Run the analytic delayed-signal checks directly:

```bash
.venv/bin/python -m pytest -q tests/test_delayed_sinusoids.py
```

These create a sampled sine wave and a delayed value copy on the **same** time
grid. With `C(f) = conj(FFT(A)) * FFT(B)`, a positive delay `τ` has analytic
phase `angle(exp(-2j*pi*f*τ))`; the reported value is principal/wrapped, so a
positive delay produces a negative phase before wrapping. A timestamp shift is
not how delay is represented and is rejected.

Serve the browser interface locally:

```bash
python -m http.server 8000 --directory web
```

Then open <http://localhost:8000>. The interface does not upload files or use
external resources. Click **Load deterministic demo** to see a known 2 Hz
feature and phase relationship immediately, or import two CSV files.

## CSV format

Each file must contain a header with these columns:

```csv
time,value,units
0.000,0.125,counts
0.008,0.244,counts
0.016,0.312,counts
```

Additional columns are allowed by the Python parser, but the required columns
must be present. Values must be finite by default, units must be non-empty and
consistent, and both signals must have the same strictly increasing, uniformly
sampled time grid by default. The Python options below make missing-value and
unequal-length handling explicit.

From Python:

```python
from spectral_lab import analyze, generate_demo_signals

first, second = generate_demo_signals()
result = analyze(first, second)
```

`result.frequency` contains one-sided real-FFT bins in Hz. Power is Welch
density in value²/Hz. The default uses up to 256 samples per segment, 50%
overlap, mean subtraction, and a periodic Hann window. The cross spectrum is
`conj(FFT(first)) * FFT(second)`, so the reported phase is second-minus-first,
wrapped to `[-π, π]`; positive phase means the second signal leads under this
Fourier convention. Magnitude-squared coherence is clipped to `[0, 1]`.

### Python numerical-core options

`power_spectrum`, `cross_spectrum`, and `analyze` accept these keyword options:

| Option | Default | Behavior |
| --- | --- | --- |
| `nperseg` | `min(256, n_samples)` | Integer segment length, at least 2 and no larger than the usable signal. |
| `noverlap` | `nperseg // 2` | Integer overlap from 0 to `nperseg - 1`. |
| `window` | `"hann"` | Periodic Hann, Hamming, Blackman, or boxcar (`"rectangular"` and `None` also select boxcar); alternatively a finite, nonzero real array of length `nperseg`. |
| `remove_dc` | `True` | Subtract each segment's unweighted mean **before** windowing. `False` retains the signal offset. This is not a command to zero the returned DC bin. |
| `average` | `"mean"` | Arithmetic mean of segment periodograms, or `"median"` for an uncorrected median. Complex cross spectra use separate real/imaginary medians. |
| `normalization` | `"density"` | One-sided density in value²/Hz, or `"spectrum"` in value². |
| `nan_policy` | `"raise"` | Reject NaNs in the analyzed input, or `"omit"` to discard complete segments containing NaNs. |

Segments start at sample zero with stride `nperseg - noverlap`; incomplete
trailing segments are discarded without padding. Frequency spacing is
`sample_rate / nperseg`. The median is not bias-corrected to estimate the mean
of random periodograms, and its integrated density need not equal mean power.

`cross_spectrum`, `analyze`, and `validate_sampling` also accept
`length_policy="raise"` (default) or `"truncate"`. Truncation analyzes the first
`min(len(first), len(second))` samples of an aligned pair. Both full time grids
must be uniform with the same cadence and start time. Different cadences,
shifted starts, and irregular grids raise `ValueError`; no resampling or time
shifting is performed. Timestamp comparisons use sample-interval-based
tolerances, not relative tolerance on absolute epoch times.

For segment `s`, let `X_s = rfft(window * detrended_values_s)` and let `d_k`
be 1 at DC and at Nyquist (even segment lengths only), and 2 elsewhere. Then:

```text
Pxx[k] = d_k * average_s(abs(X_s[k])**2) / D
Pxy[k] = d_k * average_s(conj(X_s[k]) * Y_s[k]) / D
D_density  = sample_rate * sum(window**2)
D_spectrum = sum(window)**2
```

For mean averaging, `sum(Pxx) * frequency_spacing` under density normalization
equals the mean window-weighted, detrended segment power
`mean_s(sum((window * detrended_values_s)**2) / sum(window**2))`. With a boxcar
window this equals the mean segment variance when DC removal is enabled, or
mean square when disabled. Spectrum normalization is density multiplied by
the equivalent noise bandwidth `sample_rate * sum(window**2) / sum(window)**2`;
it is not a second density convention. A zero-sum custom window is invalid for
spectrum normalization. Input unit labels remain unchanged on containers;
their `normalization` field and exported JSON unit strings describe the result.

`TimeSeries` permits NaNs in **values**, but always rejects non-finite times and
infinite values. `parse_csv(..., nan_policy="allow")` explicitly admits numeric
`NaN` value fields; its default still rejects them. Empty fields are invalid.
Analysis with `nan_policy="omit"` drops affected segments, not individual rows,
so it preserves cadence. For paired analysis, a segment is used only if both
signals are finite; no valid complete segment raises `ValueError`. The default
`"raise"` also checks discarded trailing samples within the analyzed prefix.

```python
from spectral_lab import analyze, generate_demo_signals

first, second = generate_demo_signals()
result = analyze(
    first, second,
    nperseg=128, noverlap=64,
    window="hamming", remove_dc=True,
    average="mean", normalization="density",
    nan_policy="omit", length_policy="truncate",
)
```

Exactly zero cross power returns phase zero; zero power in either signal
returns coherence zero. These are finite placeholders for undefined quantities,
not evidence of zero lag or correlation. No low-power threshold is applied.
Coherence from one segment is one wherever both signals have power, even for
unrelated signals. Component-wise median estimates can violate the usual
coherence bound before clipping. Use `analyze` to ensure all estimates use the
same segments, windows, averaging, and normalization; calling `coherence` on
separately computed inputs can only check their bins and normalization.

## Browser smoke check

The browser surface has a dependency-free static check:

```bash
node --check web/app.js
node --check web/session.js
node web/smoke-test.js
```

The smoke test exercises the browser-side upload path with valid Signal A and
Signal B CSV content, runs analysis, and checks the resulting JSON export for
spectral arrays and source provenance. It also covers stale asynchronous file
reads, session round trips, cursor inspection, and tamper rejection. This is a
dependency-free browser-logic harness; it is not a replacement for full browser
automation with a native file picker.

For a real Chromium upload/download check, install the optional browser test
tools and run a local server in another terminal:

```bash
python -m pip install playwright
python -m playwright install chromium
python -m http.server 8000 --directory web
python tests/browser_upload_export.py --url http://127.0.0.1:8000/
```

The real-browser check creates two valid uniformly sampled CSV files in memory,
sets both native file inputs, waits for analysis, downloads the JSON export, and
checks its source names and spectral arrays. It is intentionally not included
in the default `pytest` run because it requires a browser binary.

The browser implementation mirrors the Python conventions for review. The
Python core remains the numerical reference implementation.

The browser also supports a validated time range and frequency-band selection.
The selected time range is cut on the shared sample grid after the complete
input grids have been checked; the frequency selection only accepts bands that
contain at least one computed FFT bin. The comparison table reports descriptive
peak, integrated-power, phase, and coherence summaries. It deliberately does
not invent confidence intervals: frequency spacing is resolution rather than a
statistical interval, phase uncertainty is not estimated, and coherence notes
are limited/heuristic (especially for a single segment, overlapping segments,
or median averaging).

**Export JSON** downloads the full unfiltered spectral arrays plus the complete
configuration and provenance: requested/effective selections, policies,
sampling, input counts, segment indices, normalization formulas, units, and
defined/undefined masks for phase and coherence. This makes the review result
portable without confusing a selected display band with discarded data.

## Browser inspection, report, and sessions

The linked plot view provides readable labels for time, frequency, power, phase,
coherence, and channel-specific units. Power uses a logarithmic vertical axis
with decade labels such as `1e-4`; zero and negative values are omitted rather
than forced into a misleading log position. The optional log-frequency display
omits DC and is display-only. Hovering snaps to the nearest actual sample or
FFT bin and shows values, powers, complex cross spectrum, phase validity, and
coherence validity. Click pins an inspection; focused plots support Left/Right,
Home/End, and Escape.

The assumptions report explains the actual stored result: measured cadence,
full-grid checks, true Nyquist versus highest returned bin, selected time range,
FFT resolution, retained/omitted segments, window and ENBW, detrending,
normalization, phase sign, zero-power placeholders, and uncertainty limits.

**Save session** writes a versioned local JSON containing both complete input
series, all controls, the full data-derived result, and display settings.
**Restore session** validates the schema, inputs, cadence, configuration,
spectral array shapes, and phase/coherence invariants before changing the UI.
Restoration reuses the stored numerical arrays and does not recompute an FFT;
the smoke test checks that the arrays remain exactly unchanged through a
round-trip and that tampered sessions are rejected without replacing the active
analysis. Session files contain user data and are not automatically saved or
sent over the network.

## Supported inputs and limitations

The workbench supports two rectangular CSV files with `time`, `value`, and
`units` columns. Each input needs at least two samples with finite, strictly
increasing, uniformly spaced timestamps. The pair must share cadence and
aligned timestamps; equal lengths are required unless explicit common-prefix
truncation is selected. Values are finite by default. NaN values can be
explicitly allowed/omitted as complete segments, but infinities, blank numeric
fields, irregular cadence, shifted grids, implicit resampling, interpolation,
and timestamp-based delay correction are unsupported.

Welch analysis uses complete segments, selected overlap/window/DC policy, and
does not pad incomplete tails. Phase is B minus A under the forward-FFT
convention and is wrapped to the principal interval. Zero-power phase and
coherence values are finite placeholders for undefined quantities. Frequency
spacing is resolution, not a confidence interval; phase uncertainty is not
estimated, and coherence confidence is limited/heuristic, particularly for a
single segment, overlapping segments, median averaging, or NaN omission.
Browser processing is local and dependency-free. Session files and exports can
contain complete user data and should be treated as sensitive local files.

This is an independent analysis workbench, not a replacement for Stingray.jl
or a production X-ray timing pipeline. The source reference is the OpenAstronomy
GSoC proposal **Spectral Timing in Julia: Extending Stingray.jl for X-ray
Astronomy**: <https://summerofcode.withgoogle.com/programs/2026/projects/0VhXusPh>.
