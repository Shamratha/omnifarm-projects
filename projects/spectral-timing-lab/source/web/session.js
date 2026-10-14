/* global window, document, Blob, URL, FileReader */
/* Integration contract:
 * mount({ getState, configFromControls, getSegmentLength, applyRestoredSession,
 *         prepareAnalysis?, validateRestoredSession?, displayControlIds? })
 * getSegmentLength() returns the numeric/string segment-length control (DOM fallback).
 * prepareAnalysis(first, second, segmentLength, controls) must not run an FFT.
 * validateRestoredSession(candidate, prepared) may throw or return false (synchronous).
 * applyRestoredSession(candidate) is the sole commit point: update controls/state and
 * render the supplied result, without running analysis or dispatching change events.
 * Main calls refresh() after analysis, input/config changes, or clearing results.
 * saveSession() returns portable JSON; its button downloads that same JSON locally.
 * restoreSession(text) validates fully before calling the synchronous commit callback.
 * display is { controlId: primitiveValue }, for explicitly supplied displayControlIds.
 */
(() => {
  "use strict";

  const FORMAT = "spectral-timing-lab-session";
  const VERSION = 1;
  const NAN_ENCODING = "null-in-series-value-arrays";
  const ARRAY_KEYS = ["frequency", "powerFirst", "powerSecond", "crossReal", "crossImag", "phase", "coherence"];
  const CONTROL_KEYS = ["segmentLength", "timeStart", "timeEnd", "frequencyLow", "frequencyHigh", "window", "removeDC", "average", "normalization", "nanPolicy", "lengthPolicy"];
  const ENUMS = { window: ["hann", "hamming", "blackman", "boxcar"], average: ["mean", "median"], normalization: ["density", "spectrum"], nanPolicy: ["raise", "omit"], lengthPolicy: ["raise", "truncate"] };
  const RESULT_KEYS = ["interval", "sampleRate", "nSamples", "size", "overlap", "segments", "omittedSegments", "retainedSegmentStarts", "omittedSegmentStarts", "candidateSegmentStarts", "tailSamples", "commonSamples", "truncatedSamples", "timeSelection", "band", "timeSpan", ...ARRAY_KEYS, "first", "second", "inputs", "windowName", "windowPower", "windowSum", "removeDC", "average", "normalization", "nanPolicy", "lengthPolicy"];
  let context = null;
  let isBound = false;
  let importGeneration = 0;
  const $ = (id) => typeof document === "undefined" ? null : document.getElementById(id);
  const fail = (message) => { throw new Error(message); };
  const requireThat = (condition, message) => { if (!condition) fail(message); };
  const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const close = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-12 * Math.max(Math.abs(a), Math.abs(b), Number.MIN_VALUE);
  const tolerance = (dt) => Math.abs(dt) * 1e-7 + 1e-12;

  function keys(value, required, label, allowExtra = false) {
    requireThat(record(value), `${label} must be an object`);
    requireThat(required.every((key) => Object.hasOwn(value, key)), `${label} is missing required fields`);
    if (!allowExtra) requireThat(Object.keys(value).every((key) => required.includes(key)), `${label} has unsupported fields`);
  }

  // Only the four explicitly named series value arrays may encode NaN as null.
  function valuePath(path) {
    return (path.length === 2 && ["first", "second"].includes(path[0]) && path[1] === "value") ||
      (path.length === 3 && path[0] === "result" && ["first", "second"].includes(path[1]) && path[2] === "value");
  }
  function copyJSON(value, encode, path = []) {
    if (Array.isArray(value)) {
      const values = valuePath(path);
      return value.map((item, i) => {
        if (values && encode && Number.isNaN(item)) return null;
        if (values && !encode && item === null) return NaN;
        if (values) requireThat(typeof item === "number" && Number.isFinite(item), `${path.join(".")}[${i}] must be finite or an encoded NaN`);
        return copyJSON(item, encode, [...path, String(i)]);
      });
    }
    if (record(value)) {
      const out = {};
      for (const [key, item] of Object.entries(value)) {
        requireThat(!["__proto__", "constructor", "prototype"].includes(key), "Unsafe object key in session");
        out[key] = copyJSON(item, encode, [...path, key]);
      }
      return out;
    }
    requireThat(value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)), `${path.join(".")} must contain JSON-safe finite data`);
    return value;
  }

  // JSON permits -0; preserve its sign instead of JSON.stringify's conversion to 0.
  function stringify(value) {
    if (typeof value === "number" && Object.is(value, -0)) return "-0";
    if (Array.isArray(value)) return `[${value.map(stringify).join(",")}]`;
    if (record(value)) return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}:${stringify(item)}`).join(",")}}`;
    return JSON.stringify(value);
  }

  function seriesCheck(series, label) {
    keys(series, ["time", "value", "units", "source"], label);
    requireThat(typeof series.units === "string" && series.units.trim().length > 0, `${label} units must be non-empty`);
    requireThat(typeof series.source === "string", `${label} source must be text`);
    requireThat(Array.isArray(series.time) && Array.isArray(series.value) && series.time.length >= 2 && series.time.length === series.value.length, `${label} needs matching time/value arrays and at least two samples`);
    requireThat(series.time.every(Number.isFinite), `${label} times must be finite`);
    requireThat(series.value.every((x) => typeof x === "number" && (Number.isFinite(x) || Number.isNaN(x))), `${label} values must be finite or NaN`);
    const dt = series.time[1] - series.time[0];
    requireThat(dt > 0 && Number.isFinite(dt) && Number.isFinite(1 / dt), `${label} cadence must be positive and finite`);
    requireThat(series.time.every((t, i) => i === 0 || (t > series.time[i - 1] && Number.isFinite(t - series.time[i - 1]) && Math.abs(t - series.time[i - 1] - dt) <= tolerance(dt))), `${label} full time grid must be strictly increasing and uniformly sampled`);
    return dt;
  }

  function numericBound(value, label) {
    if (value === null || (typeof value === "string" && value.trim() === "")) return null;
    requireThat(typeof value === "number" || typeof value === "string", `${label} must be numeric or blank`);
    const n = Number(value);
    requireThat(Number.isFinite(n), `${label} must be finite`);
    return n;
  }
  function controlsCheck(controls) {
    keys(controls, CONTROL_KEYS, "controls");
    for (const [key, allowed] of Object.entries(ENUMS)) requireThat(allowed.includes(controls[key]), `Invalid ${key} option`);
    requireThat(typeof controls.removeDC === "boolean", "removeDC must be boolean");
    const size = numericBound(controls.segmentLength, "segment length");
    requireThat(Number.isSafeInteger(size) && size >= 2, "Segment length must be an integer of at least two");
    for (const key of ["timeStart", "timeEnd", "frequencyLow", "frequencyHigh"]) numericBound(controls[key], key);
    return size;
  }

  function windowValues(size, name) {
    return Array.from({ length: size }, (_, i) => {
      const angle = 2 * Math.PI * i / size;
      if (name === "hann") return .5 - .5 * Math.cos(angle);
      if (name === "hamming") return .54 - .46 * Math.cos(angle);
      if (name === "blackman") return .42 - .5 * Math.cos(angle) + .08 * Math.cos(2 * angle);
      return 1;
    });
  }

  // Semantic preparation only: grid checks, slicing, windows, bins and segment masks.
  // This fallback keeps restore strict even when main has not injected prepareAnalysis.
  function prepare(first, second, controls) {
    const size = controlsCheck(controls);
    const interval = seriesCheck(first, "Signal A"), secondInterval = seriesCheck(second, "Signal B");
    const gridTolerance = tolerance(Math.max(interval, secondInterval));
    const commonSamples = Math.min(first.time.length, second.time.length);
    requireThat(controls.lengthPolicy === "truncate" || first.time.length === second.time.length, "Unequal input lengths require truncation");
    requireThat(Math.abs(interval - secondInterval) <= gridTolerance && first.time.slice(0, commonSamples).every((t, i) => Math.abs(t - second.time[i]) <= gridTolerance), "Both full grids must have the same cadence and aligned common timestamps");
    const common = first.time.slice(0, commonSamples);
    const startRequest = numericBound(controls.timeStart, "time start"), endRequest = numericBound(controls.timeEnd, "time end");
    for (const t of [startRequest, endRequest]) requireThat(t === null || (t >= common[0] - tolerance(interval) && t <= common.at(-1) + tolerance(interval)), "Time bounds must lie inside the aligned data range");
    requireThat(startRequest === null || endRequest === null || endRequest > startRequest, "Time end must exceed time start");
    const start = common.findIndex((t) => startRequest === null || t >= startRequest);
    const after = endRequest === null ? -1 : common.findIndex((t) => t > endRequest);
    const endExclusive = after < 0 ? commonSamples : after;
    const nSamples = start < 0 ? 0 : Math.max(0, endExclusive - start);
    requireThat(nSamples >= 2 && size <= nSamples, "Selected range must contain at least a complete segment");
    const select = (s) => ({ ...s, time: s.time.slice(start, endExclusive), value: s.value.slice(start, endExclusive) });
    const a = select(first), b = select(second);
    requireThat(controls.nanPolicy === "omit" || a.value.concat(b.value).every(Number.isFinite), "NaN rejection includes the entire selected range, including the tail");
    const sampleRate = 1 / interval, overlap = Math.floor(size / 2);
    const frequency = Array.from({ length: Math.floor(size / 2) + 1 }, (_, k) => k * sampleRate / size);
    requireThat(frequency.every(Number.isFinite), "Frequency grid overflow");
    const low = numericBound(controls.frequencyLow, "frequency low"), high = numericBound(controls.frequencyHigh, "frequency high");
    for (const f of [low, high]) requireThat(f === null || (f >= 0 && f <= frequency.at(-1)), "Frequency bounds must lie within available FFT bins");
    requireThat(low === null || high === null || high >= low, "Frequency high must not be below frequency low");
    const binIndices = frequency.flatMap((f, i) => (low === null || f >= low) && (high === null || f <= high) ? [i] : []);
    requireThat(binIndices.length > 0, "Frequency band must include a computed bin");
    const candidateSegmentStarts = [], retainedSegmentStarts = [], omittedSegmentStarts = [];
    for (let offset = 0; offset + size <= nSamples; offset += size - overlap) {
      candidateSegmentStarts.push(offset);
      const finite = a.value.slice(offset, offset + size).every(Number.isFinite) && b.value.slice(offset, offset + size).every(Number.isFinite);
      (finite ? retainedSegmentStarts : omittedSegmentStarts).push(offset);
    }
    requireThat(retainedSegmentStarts.length > 0, "No complete finite paired segment remains");
    const window = windowValues(size, controls.window);
    const windowPower = window.reduce((sum, w) => sum + w * w, 0), windowSum = window.reduce((sum, w) => sum + w, 0);
    const denominator = controls.normalization === "density" ? sampleRate * windowPower : windowSum ** 2;
    requireThat(Number.isFinite(denominator) && denominator > 0, "Window normalization must be positive and finite");
    const summary = (original, selected) => ({ source: original.source, units: original.units, samples: original.time.length, finiteValues: original.value.filter(Number.isFinite).length, nanValues: original.value.filter(Number.isNaN).length, timeExtent: [original.time[0], original.time.at(-1)], selectedSamples: selected.time.length, selectedFiniteValues: selected.value.filter(Number.isFinite).length, selectedNaNValues: selected.value.filter(Number.isNaN).length });
    return {
      interval, sampleRate, nSamples, size, overlap, commonSamples, window, frequency,
      first: a, second: b, windowPower, windowSum,
      timeSelection: { request: { start: startRequest, end: endRequest }, commonExtent: [common[0], common.at(-1)], effectiveRange: [a.time[0], a.time.at(-1)], indexBounds: { start, endExclusive, endInclusive: endExclusive - 1 } },
      band: { request: { low, high }, availableRange: [0, frequency.at(-1)], effectiveRange: [frequency[binIndices[0]], frequency[binIndices.at(-1)]], binIndices },
      inputs: { a: summary(first, a), b: summary(second, b) },
      segments: retainedSegmentStarts.length, omittedSegments: omittedSegmentStarts.length,
      candidateSegmentStarts, retainedSegmentStarts, omittedSegmentStarts,
      tailSamples: nSamples - (candidateSegmentStarts.at(-1) + size),
      truncatedSamples: first.time.length + second.time.length - 2 * commonSamples,
      timeSpan: a.time.at(-1) - a.time[0], windowName: controls.window,
      removeDC: controls.removeDC, average: controls.average, normalization: controls.normalization,
      nanPolicy: controls.nanPolicy, lengthPolicy: controls.lengthPolicy,
    };
  }

  function same(actual, expected, label, approximate = false) {
    if (typeof expected === "number") {
      requireThat(Number.isNaN(expected) ? Number.isNaN(actual) : (approximate ? close(actual, expected) : actual === expected), `${label} does not match inputs/configuration`);
    } else if (Array.isArray(expected)) {
      requireThat(Array.isArray(actual) && actual.length === expected.length, `${label} has the wrong size`);
      expected.forEach((item, i) => same(actual[i], item, `${label}[${i}]`, approximate));
    } else if (record(expected)) {
      keys(actual, Object.keys(expected), label);
      Object.keys(expected).forEach((key) => same(actual[key], expected[key], `${label}.${key}`, approximate));
    } else requireThat(actual === expected, `${label} does not match inputs/configuration`);
  }

  function resultCheck(candidate, prepared) {
    const r = candidate.result;
    keys(r, RESULT_KEYS, "result", true); // Future finite metadata is preserved, never dropped.
    const approximate = new Set(["interval", "sampleRate", "windowPower", "windowSum", "timeSpan", "frequency"]);
    for (const key of RESULT_KEYS.filter((k) => !ARRAY_KEYS.includes(k))) same(r[key], prepared[key], `result.${key}`, approximate.has(key));
    for (const key of ARRAY_KEYS) requireThat(Array.isArray(r[key]) && r[key].length === prepared.frequency.length && r[key].every(Number.isFinite), `${key} must contain every finite FFT bin`);
    same(r.frequency, prepared.frequency, "frequency", true);
    for (let i = 0; i < r.frequency.length; i += 1) {
      const px = r.powerFirst[i], py = r.powerSecond[i], real = r.crossReal[i], imag = r.crossImag[i];
      requireThat(px >= 0 && py >= 0, "Power must be nonnegative (zero is a valid undefined-timing bin)");
      requireThat(r.phase[i] >= -Math.PI && r.phase[i] <= Math.PI, "Phase must be within [-π, π]");
      requireThat(r.coherence[i] >= 0 && r.coherence[i] <= 1, "Coherence must be within [0, 1]");
      const magnitude = Math.hypot(real, imag);
      const phase = Math.abs(real) + Math.abs(imag) > 0 ? Math.atan2(imag, real) : 0;
      const ratio = px > 0 && py > 0 ? magnitude / Math.sqrt(Math.max(px, py)) / Math.sqrt(Math.min(px, py)) : 0;
      const coh = Math.min(1, ratio) ** 2;
      requireThat(close(r.phase[i], phase) && close(r.coherence[i], coh), "Phase/coherence disagree with saved cross spectrum and powers");
      if (px === 0 || py === 0) requireThat(real === 0 && imag === 0 && r.coherence[i] === 0, "Zero power requires zero cross power and placeholder coherence");
      if (r.average === "mean") requireThat(ratio <= 1 + 1e-10, "Mean cross power violates the power/coherence bound");
    }
    for (const [key, expected] of Object.entries({ phaseDefined: r.crossReal.map((x, i) => Math.hypot(x, r.crossImag[i]) > 0), coherenceDefined: r.powerFirst.map((x, i) => x > 0 && r.powerSecond[i] > 0) })) {
      if (Object.hasOwn(r, key)) same(r[key], expected, `result.${key}`);
    }
  }

  function displayIds() {
    const ids = context.displayControlIds || [];
    requireThat(Array.isArray(ids) && ids.every((id) => typeof id === "string" && !CONTROL_KEYS.includes(id)), "displayControlIds must list display-only IDs");
    return ids;
  }
  function readDisplay() {
    const display = {};
    for (const id of displayIds()) {
      const el = $(id);
      if (el) display[id] = el.type === "checkbox" ? el.checked : el.value;
    }
    return display;
  }
  function displayCheck(display) {
    requireThat(record(display), "display must be an object");
    const allowed = displayIds();
    for (const [id, value] of Object.entries(display)) {
      requireThat(allowed.includes(id), `Unsupported display setting: ${id}`);
      requireThat(typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)), `Invalid display value: ${id}`);
      const el = $(id);
      if (!el) continue;
      if (el.type === "checkbox") requireThat(typeof value === "boolean", `${id} must be boolean`);
      else {
        requireThat(typeof value !== "boolean", `${id} must be a control value`);
        if (el.options) requireThat(Array.from(el.options).some((opt) => opt.value === String(value)), `Invalid ${id} option`);
        if (el.type === "number" || el.type === "range") {
          const n = numericBound(value, id);
          requireThat(n !== null, `${id} must be numeric`);
          if (el.min !== "" && el.min != null) requireThat(n >= Number(el.min), `${id} is below its minimum`);
          if (el.max !== "" && el.max != null) requireThat(n <= Number(el.max), `${id} exceeds its maximum`);
        }
      }
    }
  }

  function validate(payload) {
    keys(payload, ["format", "version", "savedAt", "nanEncoding", "first", "second", "controls", "result", "display"], "session");
    requireThat(payload.format === FORMAT && payload.version === VERSION, "Unsupported session format/version");
    requireThat(payload.nanEncoding === NAN_ENCODING, "Unsupported NaN encoding");
    requireThat(typeof payload.savedAt === "string" && Number.isFinite(Date.parse(payload.savedAt)), "Invalid session timestamp");
    const prepared = prepare(payload.first, payload.second, payload.controls);
    resultCheck(payload, prepared);
    displayCheck(payload.display);
    if (context.prepareAnalysis) {
      const external = context.prepareAnalysis(payload.first, payload.second, Number(payload.controls.segmentLength), payload.controls);
      requireThat(record(external) && typeof external.then !== "function", "prepareAnalysis must synchronously return prepared metadata");
      for (const key of ["interval", "sampleRate", "nSamples", "size", "overlap", "commonSamples", "window", "frequency", "first", "second", "timeSelection", "band"]) same(external[key], prepared[key], `prepareAnalysis.${key}`, ["interval", "sampleRate", "window", "frequency"].includes(key));
    }
    if (context.validateRestoredSession) {
      const accepted = context.validateRestoredSession(payload, prepared);
      requireThat(accepted !== false && !(accepted && typeof accepted.then === "function"), "Session rejected by semantic validation hook");
      // Hooks can reject, but cannot silently change the data that will be committed.
      resultCheck(payload, prepare(payload.first, payload.second, payload.controls));
      displayCheck(payload.display);
    }
    return payload;
  }

  function needContext() { requireThat(context !== null, "Session API is not mounted"); }
  function status(message, kind = "ok") {
    const el = $("sessionStatus");
    if (el) { el.textContent = message; el.dataset.kind = kind; }
  }
  function currentControls() {
    const controls = { ...context.configFromControls() };
    controls.segmentLength = context.getSegmentLength ? context.getSegmentLength() : controls.segmentLength ?? $("segmentLength")?.value;
    return controls;
  }
  function saveSession() {
    try {
      needContext();
      const state = context.getState();
      requireThat(state.first && state.second && state.result, "Run a valid analysis before saving a session");
      const payload = { format: FORMAT, version: VERSION, savedAt: new Date().toISOString(), nanEncoding: NAN_ENCODING, first: state.first, second: state.second, controls: currentControls(), result: state.result, display: readDisplay() };
      const encoded = copyJSON(payload, true);
      validate(copyJSON(encoded, false));
      const text = stringify(encoded);
      status("Session ready · local sensitive file contains both complete inputs and the full stored result.");
      return text;
    } catch (error) { status(`Session save failed: ${error.message}`, "error"); throw error; }
  }
  function restoreSession(text) {
    try {
      needContext();
      requireThat(typeof text === "string", "Session must be JSON text");
      const candidate = validate(copyJSON(JSON.parse(text.replace(/^\uFEFF/, "")), false));
      // No UI/state changes occur before this point. Main owns the atomic commit.
      const applied = context.applyRestoredSession({ first: candidate.first, second: candidate.second, result: candidate.result, controls: candidate.controls, display: candidate.display });
      requireThat(!(applied && typeof applied.then === "function"), "applyRestoredSession must be synchronous");
      refresh();
      status("Session restored · saved numeric arrays retained; no spectral recomputation.");
      return candidate;
    } catch (error) { status(`Session restore failed: ${error.message}`, "error"); throw error; }
  }

  const fmt = (x) => Number.isFinite(x) ? String(x) : "—";
  function renderReport(state) {
    const root = $("assumptionsContent");
    if (!root) return;
    root.replaceChildren();
    const r = state?.result;
    if (!r) { const p = document.createElement("p"); p.textContent = "No stored analysis. Run or restore a valid analysis to view its assumptions."; root.appendChild(p); return; }
    const block = (title, lines) => {
      const section = document.createElement("div"); section.className = "assumptions-block";
      const h = document.createElement("h3"); h.textContent = title; section.appendChild(h);
      for (const line of lines) { const p = document.createElement("p"); p.textContent = line; section.appendChild(p); }
      root.appendChild(section);
    };
    // Use saved metadata and selected series, never pending control values.
    block("Sampling and full input validation", [
      `Actual fs = ${fmt(r.sampleRate)} Hz; Δt = ${fmt(r.interval)} s. Both complete input time grids are checked for finite, strictly increasing, uniformly spaced timestamps before truncation or time selection. No resampling, interpolation or time shifting.`,
      `Cadence tolerance: |Δt| × 1e−7 + 1e−12 s; paired-grid comparisons use max(|ΔtA|, |ΔtB|) × 1e−7 + 1e−12 s, including aligned common timestamps (no relative tolerance on absolute epochs). Analysis-grid tolerance = ${fmt(tolerance(r.interval))} s.`,
      ...["a", "b"].map((key) => { const i = r.inputs[key]; return `${key === "a" ? "A" : "B"}: ${i.source} · ${i.units}; full ${i.samples} samples (${i.finiteValues} finite, ${i.nanValues} NaN), extent ${i.timeExtent.map(fmt).join(" to ")} s; selected ${i.selectedSamples} (${i.selectedFiniteValues} finite, ${i.selectedNaNValues} NaN). Time/value sizes and full values are validated; infinity is forbidden, NaN is allowed only in values.`; }),
      `Length policy: ${r.lengthPolicy}; common prefix ${r.commonSamples} samples; ${r.truncatedSamples} total samples truncated. Validation applies to both full grids, including unused tails.`,
    ]);
    block("Time selection, bins and segment accounting", [
      `Requested time: ${r.timeSelection.request.start ?? "full start"} to ${r.timeSelection.request.end ?? "full end"} s; inclusive selection snaps inward to existing samples. Effective range: ${r.timeSelection.effectiveRange.map(fmt).join(" to ")} s; ${r.nSamples} samples; span ${fmt(r.timeSpan)} s. Original indices [${r.timeSelection.indexBounds.start}, ${r.timeSelection.indexBounds.endExclusive}) (zero-based).`,
      `True sampling Nyquist = fs/2 = ${fmt(r.sampleRate / 2)} Hz. Highest returned bin = ${fmt(r.frequency.at(-1))} Hz; ${r.size % 2 ? "odd segment lengths do not include the true Nyquist bin" : "even segment lengths include the Nyquist bin"}. ${r.frequency.length} full bins; Δf = fs/N = ${fmt(r.sampleRate / r.size)} Hz.`,
      `Requested frequency band: ${r.band.request.low ?? "lowest bin"} to ${r.band.request.high ?? "highest bin"} Hz; effective ${r.band.effectiveRange.map(fmt).join(" to ")} Hz (${r.band.binIndices.length} bins). Band selection does not discard saved arrays.`,
      `N = ${r.size}; overlap = ${r.overlap} samples (${fmt(100 * r.overlap / r.size)}%); stride = ${r.size - r.overlap}. ${r.candidateSegmentStarts.length} candidate segments; ${r.segments} retained; ${r.omittedSegments} omitted; ${r.tailSamples} incomplete-tail samples discarded without padding.`,
      `Starts relative to the selected range: candidates [${r.candidateSegmentStarts.join(", ")}]; retained [${r.retainedSegmentStarts.join(", ")}]; omitted [${r.omittedSegmentStarts.join(", ")}]. Add ${r.timeSelection.indexBounds.start} for original-input indices.`,
      `NaN policy: ${r.nanPolicy}. Omission discards an entire affected segment from both channels, preserving cadence. Rejection checks all selected values, including the incomplete tail; unselected values are not analyzed.`,
    ]);
    const windows = { hann: "w[n] = 0.5 − 0.5 cos(2πn/N)", hamming: "w[n] = 0.54 − 0.46 cos(2πn/N)", blackman: "w[n] = 0.42 − 0.5 cos(2πn/N) + 0.08 cos(4πn/N)", boxcar: "w[n] = 1" };
    block("Window, averaging and normalization", [
      `${r.windowName === "boxcar" ? "Boxcar" : `Periodic ${r.windowName}`} window: ${windows[r.windowName]}, n = 0,…,N−1 (not the symmetric N−1 convention). Σw = ${fmt(r.windowSum)}; Σw² = ${fmt(r.windowPower)}.`,
      r.removeDC ? "DC removal enabled: subtract each segment's unweighted mean before windowing; the returned DC bin is not forcibly zeroed." : "DC removal disabled: offsets are retained before windowing.",
      `Averaging: ${r.average}. ${r.average === "median" ? "Uncorrected median, with separate real/imaginary cross medians; not a bias-corrected estimate of mean periodogram power." : "Arithmetic mean of retained segment periodograms."}`,
      "Xₛ = rFFT(w × detrended Aₛ), Yₛ = rFFT(w × detrended Bₛ). PAA[k] = dₖ averageₛ(|Xₛ[k]|²)/D; PBB similarly. PAB[k] = dₖ averageₛ(conj(Xₛ[k]) Yₛ[k])/D. dₖ = 1 at DC and even-N Nyquist; 2 for all other one-sided bins (including odd-N highest bin).",
      `Normalization: ${r.normalization}; Ddensity = fs Σw²; Dspectrum = (Σw)². Selected D = ${fmt(r.normalization === "density" ? r.sampleRate * r.windowPower : r.windowSum ** 2)}. Power units: (${r.first.units})²${r.normalization === "density" ? "/Hz" : ""} and (${r.second.units})²${r.normalization === "density" ? "/Hz" : ""}; cross units: (${r.first.units})×(${r.second.units})${r.normalization === "density" ? "/Hz" : ""}.`,
      `ENBW = fs Σw²/(Σw)² = ${fmt(r.sampleRate * r.windowPower / r.windowSum ** 2)} Hz; spectrum = density × ENBW. Band power = Σ selected density bins × Δf (spectrum first divided by ENBW).`,
      "For mean averaging, Σ full density bins × Δf equals meanₛ(Σ(w × detrended valuesₛ)²/Σw²). This is window-weighted power; boxcar gives segment variance with mean removal, mean-square without. Median has no such mean-power identity.",
    ]);
    block("Phase, zero power and uncertainty", [
      "Cross spectrum uses conj(FFT(A)) × FFT(B). Phase = atan2(Im PAB, Re PAB), wrapped to [−π, π]: B minus A; positive phase means B leads under the negative-exponential Fourier convention. Phase is in radians, not a time-lag estimate.",
      "Magnitude-squared coherence = |PAB|²/(PAA PBB), clipped to [0,1]. Exactly zero cross power gives phase zero; zero power in either channel gives coherence zero. These are finite placeholders for undefined quantities, not evidence of zero lag/correlation. No low-power threshold is applied.",
      "Descriptive estimates only: no confidence intervals or phase uncertainty model. Coherence confidence is limited/heuristic. Frequency-bin spacing is resolution, not a statistical uncertainty. Overlap and windowing correlate segments and neighboring bins; retained segment count is not independent degrees of freedom.",
      `${r.segments === 1 ? "This result has one segment. " : ""}Single-segment coherence is one wherever both inputs have power, even for unrelated signals. Component-wise median can violate the usual coherence bound before clipping. NaN segment omission may introduce selection bias.`,
      "This report describes the stored result rather than pending settings. Session files include complete user inputs and should be treated as local sensitive data. Saving is explicit; no automatic storage or network transfer.",
    ]);
  }

  function refresh() {
    if (!context) return;
    const state = context.getState();
    const save = $("saveSession");
    if (save) save.disabled = !(state?.first && state?.second && state?.result) || Boolean(state.lastError);
    renderReport(state);
  }

  function bind() {
    if (isBound) return;
    const save = $("saveSession"), restore = $("restoreSession"), input = $("sessionFile");
    if (!save || !restore || !input) return;
    isBound = true;
    save.addEventListener("click", () => {
      let url;
      try {
        const text = saveSession();
        url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
        const a = document.createElement("a"); a.href = url; a.download = "spectral-timing-session-v1.json"; a.click();
        status("Session downloaded · local sensitive file. Store and share with care.");
      } catch (error) { status(`Session save failed: ${error.message}`, "error"); }
      finally { if (url) setTimeout(() => URL.revokeObjectURL(url), 0); }
    });
    restore.addEventListener("click", () => input.click());
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return;
      const generation = ++importGeneration;
      const reader = new FileReader();
      reader.onload = () => {
        if (generation !== importGeneration) return;
        try { restoreSession(reader.result); } catch (_) { /* restoreSession visibly reports validation errors. */ }
        input.value = "";
      };
      reader.onerror = () => { if (generation === importGeneration) { status("Session file could not be read. Current analysis retained.", "error"); input.value = ""; } };
      reader.readAsText(file);
    });
  }

  function mount(nextContext) {
    requireThat(record(nextContext), "mount requires a context object");
    for (const key of ["getState", "configFromControls", "applyRestoredSession"]) requireThat(typeof nextContext[key] === "function", `mount requires ${key}()`);
    for (const key of ["getSegmentLength", "prepareAnalysis", "validateRestoredSession"]) requireThat(nextContext[key] == null || typeof nextContext[key] === "function", `${key} must be a function`);
    context = nextContext;
    importGeneration += 1;
    displayIds();
    bind();
    for (const id of ["restoreSession", "sessionFile"]) { const el = $(id); if (el) el.disabled = false; }
    refresh();
    status("Sessions stay local. Save includes complete inputs; restore preserves stored numeric arrays.");
    return window.SpectralSession;
  }

  window.SpectralSession = Object.freeze({ mount, refresh, saveSession, restoreSession, format: FORMAT, version: VERSION });
})();
