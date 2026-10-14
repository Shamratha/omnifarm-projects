/* global document, FileReader, ResizeObserver, Blob, URL */

(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const state = { first: null, second: null, result: null, cursor: null, lastError: null, imports: [0, 0], importErrors: [null, null], fileGenerations: [0, 0] };
  const COLORS = { a: "#0b8c89", b: "#e87945", blue: "#4667a8", teal: "#0b8c89", grid: "#dfe6ec", axis: "#8b98a8", ink: "#25364c", cursor: "#263b59" };

  function finite(value) { return Number.isFinite(value); }
  function format(value, digits = 3) {
    if (!finite(value)) return "—";
    if (Math.abs(value) >= 1000 || (Math.abs(value) > 0 && Math.abs(value) < 0.001)) return value.toExponential(2);
    return value.toLocaleString(undefined, { maximumFractionDigits: digits });
  }
  function formatSigned(value, digits = 3) { return `${value >= 0 ? "+" : ""}${format(value, digits)}`; }

  // Small RFC-4180-style parser: quoted fields, escaped quotes, and newlines are supported.
  function csvRows(text) {
    const rows = [], row = [], chars = String(text).replace(/^\uFEFF/, "");
    let field = "", quoted = false;
    for (let i = 0; i < chars.length; i += 1) {
      const char = chars[i];
      if (quoted) {
        if (char === '"' && chars[i + 1] === '"') { field += '"'; i += 1; }
        else if (char === '"') quoted = false;
        else field += char;
      } else if (char === '"' && field.length === 0) quoted = true;
      else if (char === ",") { row.push(field); field = ""; }
      else if (char === "\n" || char === "\r") {
        if (char === "\r" && chars[i + 1] === "\n") i += 1;
        row.push(field); field = "";
        if (row.length > 1 || row[0].trim() !== "") rows.push(row.splice(0));
        else row.length = 0;
      } else field += char;
    }
    if (quoted) throw new Error("malformed CSV: unterminated quoted field");
    row.push(field);
    if (row.length > 1 || row[0].trim() !== "") rows.push(row);
    return rows;
  }

  function parseCSV(text, sourceName = "CSV") {
    const rows = csvRows(text);
    if (!rows.length) throw new Error(`${sourceName} is empty`);
    const headers = rows[0].map((header) => header.trim());
    if (new Set(headers).size !== headers.length) throw new Error("CSV column names must be unique");
    const required = ["time", "value", "units"];
    const missing = required.filter((name) => !headers.includes(name));
    if (missing.length) throw new Error(`CSV is missing required column(s): ${missing.join(", ")}`);
    const indexes = Object.fromEntries(required.map((name) => [name, headers.indexOf(name)]));
    const time = [], value = [], units = [];
    rows.slice(1).forEach((cells, index) => {
      const rowNumber = index + 2;
      if (cells.length !== headers.length) throw new Error(`incorrect number of fields on CSV row ${rowNumber}`);
      const timeText = cells[indexes.time].trim();
      const valueText = cells[indexes.value].trim();
      if (!timeText || !valueText) throw new Error(`invalid numeric value on CSV row ${rowNumber}`);
      const t = Number(timeText);
      const v = Number(valueText);
      const unit = cells[indexes.units].trim();
      const explicitNaN = /^[-+]?nan$/i.test(valueText);
      if (!finite(t) || (Number.isNaN(v) && !explicitNaN) || (!finite(v) && !Number.isNaN(v))) throw new Error(`invalid numeric value on CSV row ${rowNumber}`);
      if (!unit) throw new Error(`units must be non-empty on CSV row ${rowNumber}`);
      time.push(t); value.push(v); units.push(unit);
    });
    if (!time.length) throw new Error(`${sourceName} must contain at least one data row`);
    if (new Set(units).size !== 1) throw new Error("units must be consistent across CSV rows");
    return { time, value, units: units[0], source: sourceName };
  }

  function validateSampling(first, second, lengthPolicy = "raise") {
    if (!["raise", "truncate"].includes(lengthPolicy)) throw new Error("length policy must be 'raise' or 'truncate'");
    if (!first || first.time.length < 2) throw new Error("time must have at least two samples");
    const check = (series) => {
      if (series.time.length < 2 || series.time.some((x) => !finite(x))) throw new Error("time must contain only finite values and at least two samples");
      if (series.value.length !== series.time.length) throw new Error("time and value arrays must have equal lengths");
      if (series.value.some((x) => !finite(x) && !Number.isNaN(x))) throw new Error("signal values must not contain infinities or non-numeric values");
      const interval = series.time[1] - series.time[0];
      if (!finite(interval) || !(interval > 0) || series.time.some((x, i) => i > 0 && (!finite(x - series.time[i - 1]) || !(x > series.time[i - 1])))) throw new Error("time must be strictly increasing with finite intervals");
      const tolerance = Math.abs(interval) * 1e-7 + 1e-12;
      if (series.time.slice(1).some((x, i) => Math.abs((x - series.time[i]) - interval) > tolerance)) throw new Error("time samples must be uniformly spaced");
      if (!finite(1 / interval)) throw new Error("sample rate must be finite");
      return interval;
    };
    const interval = check(first);
    if (!second || second.time.length < 2) throw new Error("signals must each have at least two time samples");
    const secondInterval = check(second);
    if (lengthPolicy === "raise" && second.time.length !== first.time.length) throw new Error("signals must have the same sampling grid length; use unequal-length truncation for a common prefix");
    const tolerance = Math.max(Math.abs(interval), Math.abs(secondInterval)) * 1e-7 + 1e-12;
    const common = Math.min(first.time.length, second.time.length);
    if (Math.abs(interval - secondInterval) > tolerance || second.time.slice(0, common).some((x, i) => Math.abs(x - first.time[i]) > tolerance)) throw new Error("signals must use the same sampling grid");
    return { interval, sampleRate: 1 / interval, nSamples: common };
  }

  function segmentOptions(n, requested) {
    const size = requested == null ? Math.min(256, n) : Number(requested);
    if (!finite(size) || Math.floor(size) !== size || size < 2 || size > n) throw new Error(`segment length must be an integer between 2 and ${n}`);
    return { size, overlap: Math.floor(size / 2) };
  }

  function windowValues(size, name) {
    const selected = String(name || "hann").toLowerCase();
    if (selected === "boxcar" || selected === "rectangular") return new Array(size).fill(1);
    if (!["hann", "hamming", "blackman"].includes(selected)) throw new Error("window must be hann, hamming, blackman, or boxcar");
    return Array.from({ length: size }, (_, i) => {
      const angle = 2 * Math.PI * i / size;
      if (selected === "hann") return 0.5 - 0.5 * Math.cos(angle);
      if (selected === "hamming") return 0.54 - 0.46 * Math.cos(angle);
      return 0.42 - 0.5 * Math.cos(angle) + 0.08 * Math.cos(2 * angle);
    });
  }

  function aggregate(values, method) {
    if (method === "mean") return values.reduce((sum, value) => sum + value, 0) / values.length;
    const sorted = values.slice().sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function optionalBound(value, label) {
    if (value == null || (typeof value === "string" && value.trim() === "")) return null;
    const number = Number(value);
    if (!finite(number)) throw new Error(`${label} must be a finite number or blank`);
    return number;
  }

  // Always validate the complete input grids before selecting the common time range.
  function prepareAnalysis(first, second, segmentLength, options) {
    if (!["mean", "median"].includes(options.average || "mean")) throw new Error("average must be mean or median");
    if (!["density", "spectrum"].includes(options.normalization || "density")) throw new Error("normalization must be density or spectrum");
    if (!["raise", "omit"].includes(options.nanPolicy || "raise")) throw new Error("NaN policy must be raise or omit");
    if (typeof (options.removeDC ?? true) !== "boolean") throw new Error("DC removal must be a boolean");
    const sampling = validateSampling(first, second, options.lengthPolicy || "raise");
    const timeStart = optionalBound(options.timeStart, "time start"), timeEnd = optionalBound(options.timeEnd, "time end");
    const commonTime = first.time.slice(0, sampling.nSamples);
    const commonStart = commonTime[0], commonEnd = commonTime.at(-1), tolerance = Math.abs(sampling.interval) * 1e-7 + 1e-12;
    if (timeStart != null && (timeStart < commonStart - tolerance || timeStart > commonEnd + tolerance)) throw new Error(`time start must be within the aligned data range ${format(commonStart, 6)} to ${format(commonEnd, 6)} s`);
    if (timeEnd != null && (timeEnd < commonStart - tolerance || timeEnd > commonEnd + tolerance)) throw new Error(`time end must be within the aligned data range ${format(commonStart, 6)} to ${format(commonEnd, 6)} s`);
    if (timeStart != null && timeEnd != null && timeEnd <= timeStart) throw new Error("time end must be greater than time start");
    const start = commonTime.findIndex((t) => timeStart == null || t >= timeStart);
    let endExclusive = commonTime.length;
    if (timeEnd != null) { const after = commonTime.findIndex((t) => t > timeEnd); if (after >= 0) endExclusive = after; }
    const count = start < 0 ? 0 : Math.max(0, endExclusive - start);
    if (count < 2) throw new Error(`time range must contain at least two aligned common samples (selected ${count})`);
    const { size, overlap } = segmentOptions(count, segmentLength);
    const window = windowValues(size, options.window || "hann");
    const frequency = Array.from({ length: Math.floor(size / 2) + 1 }, (_, k) => k * sampling.sampleRate / size);
    const low = optionalBound(options.frequencyLow, "frequency low"), high = optionalBound(options.frequencyHigh, "frequency high");
    if ((low != null && low < frequency[0]) || (high != null && high < frequency[0])) throw new Error("frequency bounds must be nonnegative and within the available FFT bins");
    if (low != null && low > frequency.at(-1)) throw new Error(`frequency low must be within the available bins 0–${format(frequency.at(-1), 6)} Hz`);
    if (high != null && high > frequency.at(-1)) throw new Error(`frequency high must be within the available bins 0–${format(frequency.at(-1), 6)} Hz`);
    if (low != null && high != null && high < low) throw new Error("frequency high must be greater than or equal to frequency low");
    const bandIndices = frequency.flatMap((f, i) => (low == null || f >= low) && (high == null || f <= high) ? [i] : []);
    if (!bandIndices.length) throw new Error(`frequency band contains no available FFT bins (available 0–${format(frequency.at(-1), 6)} Hz; spacing ${format(sampling.sampleRate / size, 6)} Hz)`);
    const select = (series) => ({ ...series, time: series.time.slice(start, endExclusive), value: series.value.slice(start, endExclusive) });
    const selectedFirst = select(first), selectedSecond = select(second);
    const values = selectedFirst.value.concat(selectedSecond.value);
    if (values.some((value) => value === Infinity || value === -Infinity)) throw new Error("signal values must not contain infinities");
    if ((options.nanPolicy || "raise") === "raise" && values.some(Number.isNaN)) throw new Error("signal contains NaN values; use NaN omission to skip affected segments");
    let finiteSegment = false;
    for (let offset = 0; offset + size <= count; offset += size - overlap) {
      if (selectedFirst.value.slice(offset, offset + size).every(finite) && selectedSecond.value.slice(offset, offset + size).every(finite)) { finiteSegment = true; break; }
    }
    if (!finiteSegment) throw new Error("no complete finite segments available");
    return {
      ...sampling, commonSamples: sampling.nSamples, nSamples: count, size, overlap, window, frequency, bandIndices,
      first: selectedFirst, second: selectedSecond,
      timeSelection: { request: { start: timeStart, end: timeEnd }, commonExtent: [commonTime[0], commonTime.at(-1)], effectiveRange: [commonTime[start], commonTime[endExclusive - 1]], indexBounds: { start, endExclusive, endInclusive: endExclusive - 1 } },
      band: { request: { low, high }, availableRange: [0, frequency.at(-1)], effectiveRange: [frequency[bandIndices[0]], frequency[bandIndices.at(-1)]], binIndices: bandIndices },
    };
  }

  function fft(realInput) {
    const n = realInput.length;
    const real = realInput.slice();
    const imag = new Array(n).fill(0);
    const powerOfTwo = (n & (n - 1)) === 0;
    if (!powerOfTwo) {
      const outReal = new Array(n).fill(0), outImag = new Array(n).fill(0);
      for (let k = 0; k < n; k += 1) for (let t = 0; t < n; t += 1) {
        const angle = -2 * Math.PI * k * t / n;
        outReal[k] += realInput[t] * Math.cos(angle); outImag[k] += realInput[t] * Math.sin(angle);
      }
      return { real: outReal, imag: outImag };
    }
    // In-place radix-2 Cooley–Tukey transform; this is enough for the small review workloads.
    for (let i = 1, j = 0; i < n; i += 1) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [real[i], real[j]] = [real[j], real[i]]; }
    }
    for (let length = 2; length <= n; length <<= 1) {
      const half = length / 2, angleStep = -2 * Math.PI / length;
      for (let start = 0; start < n; start += length) for (let k = 0; k < half; k += 1) {
        const angle = angleStep * k, cosine = Math.cos(angle), sine = Math.sin(angle);
        const even = start + k, odd = even + half;
        const oddReal = real[odd] * cosine - imag[odd] * sine;
        const oddImag = real[odd] * sine + imag[odd] * cosine;
        real[odd] = real[even] - oddReal; imag[odd] = imag[even] - oddImag;
        real[even] += oddReal; imag[even] += oddImag;
      }
    }
    return { real, imag };
  }

  function analyze(first, second, segmentLength, options = {}) {
    const windowName = options.window || "hann";
    const removeDC = options.removeDC ?? true;
    const average = options.average || "mean";
    const normalization = options.normalization || "density";
    const nanPolicy = options.nanPolicy || "raise";
    const lengthPolicy = options.lengthPolicy || "raise";
    if (!["mean", "median"].includes(average)) throw new Error("average must be mean or median");
    if (!["density", "spectrum"].includes(normalization)) throw new Error("normalization must be density or spectrum");
    if (!["raise", "omit"].includes(nanPolicy)) throw new Error("NaN policy must be raise or omit");
    if (typeof removeDC !== "boolean") throw new Error("DC removal must be a boolean");
    const prepared = prepareAnalysis(first, second, segmentLength, options);
    const { size, overlap, window } = prepared;
    const sampling = { interval: prepared.interval, sampleRate: prepared.sampleRate, nSamples: prepared.nSamples };
    const firstValues = prepared.first.value;
    const secondValues = prepared.second.value;
    const allValues = firstValues.concat(secondValues);
    if (allValues.some((value) => value === Infinity || value === -Infinity)) throw new Error("signal values must not contain infinities");
    if (nanPolicy === "raise" && allValues.some((value) => Number.isNaN(value))) throw new Error("signal contains NaN values; use NaN omission to skip affected segments");
    const starts = [];
    for (let start = 0; start + size <= sampling.nSamples; start += size - overlap) starts.push(start);
    const windowPower = window.reduce((sum, x) => sum + x * x, 0);
    const bins = Math.floor(size / 2) + 1;
    const periodograms = [], retainedSegmentStarts = [], omittedSegmentStarts = [];
    starts.forEach((start) => {
      const rawX = firstValues.slice(start, start + size), rawY = secondValues.slice(start, start + size);
      if (nanPolicy === "omit" && (rawX.some((value) => !finite(value)) || rawY.some((value) => !finite(value)))) { omittedSegmentStarts.push(start); return; }
      const xMean = removeDC ? rawX.reduce((sum, value) => sum + value, 0) / size : 0;
      const yMean = removeDC ? rawY.reduce((sum, value) => sum + value, 0) / size : 0;
      const x = rawX.map((value, i) => (value - xMean) * window[i]);
      const y = rawY.map((value, i) => (value - yMean) * window[i]);
      const tx = fft(x), ty = fft(y);
      const px = new Array(bins), py = new Array(bins), crossReal = new Array(bins), crossImag = new Array(bins);
      for (let k = 0; k < bins; k += 1) {
        px[k] = tx.real[k] ** 2 + tx.imag[k] ** 2;
        py[k] = ty.real[k] ** 2 + ty.imag[k] ** 2;
        // conj(X) * Y = (Xr - iXi) * (Yr + iYi)
        crossReal[k] = tx.real[k] * ty.real[k] + tx.imag[k] * ty.imag[k];
        crossImag[k] = tx.real[k] * ty.imag[k] - tx.imag[k] * ty.real[k];
      }
      periodograms.push({ px, py, crossReal, crossImag });
      retainedSegmentStarts.push(start);
    });
    if (!periodograms.length) throw new Error("no complete finite segments available");
    const px = [], py = [], crossReal = [], crossImag = [];
    for (let k = 0; k < bins; k += 1) {
      px.push(aggregate(periodograms.map((segment) => segment.px[k]), average));
      py.push(aggregate(periodograms.map((segment) => segment.py[k]), average));
      crossReal.push(aggregate(periodograms.map((segment) => segment.crossReal[k]), average));
      crossImag.push(aggregate(periodograms.map((segment) => segment.crossImag[k]), average));
    }
    const denominator = normalization === "density" ? sampling.sampleRate * windowPower : window.reduce((sum, value) => sum + value, 0) ** 2;
    if (!finite(denominator) || denominator <= 0) throw new Error("window normalization denominator must be positive and finite");
    const multiplier = (k) => (k === 0 || (size % 2 === 0 && k === bins - 1)) ? 1 : 2;
    for (let k = 0; k < bins; k += 1) { const factor = multiplier(k) / denominator; px[k] *= factor; py[k] *= factor; crossReal[k] *= factor; crossImag[k] *= factor; }
    if ([px, py, crossReal, crossImag].some((array) => array.some((value) => !finite(value)))) throw new Error("spectral calculation overflowed; reduce signal magnitudes");
    const frequency = Array.from({ length: bins }, (_, k) => k * sampling.sampleRate / size);
    const phase = crossReal.map((real, k) => (Math.abs(real) + Math.abs(crossImag[k]) > 0 ? Math.atan2(crossImag[k], real) : 0));
    const coherence = px.map((power, k) => power > 0 && py[k] > 0 ? Math.min(1, Math.hypot(crossReal[k], crossImag[k]) / Math.sqrt(Math.max(power, py[k])) / Math.sqrt(Math.min(power, py[k]))) ** 2 : 0);
    const inputSummary = (original, selected) => ({ source: original.source, units: original.units, samples: original.time.length, finiteValues: original.value.filter(finite).length, nanValues: original.value.filter(Number.isNaN).length, timeExtent: [original.time[0], original.time.at(-1)], selectedSamples: selected.value.length, selectedFiniteValues: selected.value.filter(finite).length, selectedNaNValues: selected.value.filter(Number.isNaN).length });
    return { ...sampling, size, overlap, segments: periodograms.length, omittedSegments: omittedSegmentStarts.length, retainedSegmentStarts, omittedSegmentStarts, candidateSegmentStarts: starts, tailSamples: sampling.nSamples - (starts.at(-1) + size), commonSamples: prepared.commonSamples, truncatedSamples: first.time.length + second.time.length - 2 * prepared.commonSamples, timeSelection: prepared.timeSelection, band: prepared.band, timeSpan: prepared.first.time.at(-1) - prepared.first.time[0], frequency, powerFirst: px, powerSecond: py, crossReal, crossImag, phase, coherence, first: prepared.first, second: prepared.second, inputs: { a: inputSummary(first, prepared.first), b: inputSummary(second, prepared.second) }, windowName, windowPower, windowSum: window.reduce((sum, value) => sum + value, 0), removeDC, average, normalization, nanPolicy, lengthPolicy };
  }

  function setStatus(message, type = "ok") {
    const banner = $("statusBanner"); banner.className = `status-banner${type === "ok" ? "" : ` ${type}`}`;
    $("statusText").textContent = message; $("statusBanner").querySelector(".status-symbol").textContent = type === "error" ? "!" : type === "warning" ? "i" : "✓";
  }
  function setFileCard(index, series) {
    const name = index === 0 ? "fileFirstName" : "fileSecondName";
    const meta = index === 0 ? "fileFirstMeta" : "fileSecondMeta";
    $(name).textContent = series.source;
    $(meta).textContent = `${series.time.length.toLocaleString()} samples · ${series.units}`;
  }
  function setValidation(result, error) {
    const panel = $("validationPanel"), stateLabel = $("validationState"), content = $("validationContent");
    if (error) {
      panel.classList.add("has-error"); stateLabel.textContent = "CHECK"; stateLabel.classList.add("error");
      content.innerHTML = `<div class="validation-item fail"><span class="check">!</span><span>${escapeHTML(error.message || error)}</span></div>`;
      return;
    }
    panel.classList.remove("has-error"); stateLabel.textContent = "PASS"; stateLabel.classList.remove("error");
    const checks = [
      `A · ${result.first.value.filter(finite).length.toLocaleString()} finite samples · ${result.first.value.filter(Number.isNaN).length} NaNs`,
      `B · ${result.second.value.filter(finite).length.toLocaleString()} finite samples · ${result.second.value.filter(Number.isNaN).length} NaNs`,
      `Matched grid · Δt ${format(result.interval, 6)} s`,
      `Uniform sampling · ${format(result.sampleRate, 4)} Hz`,
      `${result.segments} finite Welch segment${result.segments === 1 ? "" : "s"} · ${result.omittedSegments} omitted`,
      `Time selection · ${format(result.timeSelection.effectiveRange[0], 6)}–${format(result.timeSelection.effectiveRange[1], 6)} s · ${result.nSamples} aligned samples`,
      `Frequency band · ${format(result.band.effectiveRange[0], 6)}–${format(result.band.effectiveRange[1], 6)} Hz · ${result.band.binIndices.length} available bins`,
      `Window · ${result.windowName} · ${result.average} average · ${result.normalization}`,
      `Length policy · ${result.lengthPolicy} · ${result.truncatedSamples} samples truncated`,
      `Units · ${result.first.units} / ${result.second.units}`,
    ];
    content.innerHTML = checks.map((text) => `<div class="validation-item"><span class="check">✓</span><span>${escapeHTML(text)}</span></div>`).join("");
  }
  function escapeHTML(text) { return String(text).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char])); }

  function bandIndices(result) { return result.band.binIndices; }
  function peakInBand(values, result) {
    return bandIndices(result).reduce((best, index) => values[index] > values[best] ? index : best, bandIndices(result)[0]);
  }
  function integrateBand(values, result) {
    const sum = bandIndices(result).reduce((total, index) => total + values[index], 0);
    const enbw = result.sampleRate * result.windowPower / result.windowSum ** 2;
    return sum * (result.sampleRate / result.size) / (result.normalization === "spectrum" ? enbw : 1);
  }
  function bandMean(values, result) { const indexes = bandIndices(result); return indexes.reduce((sum, index) => sum + values[index], 0) / indexes.length; }

  function uncertaintyNotes(result) {
    const notes = ["Coherence confidence is limited/heuristic.", "Phase uncertainty is not estimated unless supported; this browser review has no phase uncertainty model.", "Descriptive estimates only: no statistical confidence intervals are estimated.", "Frequency spacing is resolution, not a confidence interval.", "Zero-power phase/coherence are undefined; exported zeros are placeholders.", "Overlapping segments and neighboring windowed frequency bins are correlated; segment count is not independent degrees of freedom."];
    if (result.segments === 1) notes.push("Single-segment coherence is one at nonzero-power bins even for unrelated signals; do not infer correlation.");
    if (result.average === "median") notes.push("Median estimates are uncorrected; cross components are median-averaged separately and coherence can exceed one before clipping.");
    if (result.omittedSegments) notes.push("NaN omission discarded segments from both channels and can introduce selection bias.");
    return notes;
  }

  function renderComparison(result) {
    const peakA = peakInBand(result.powerFirst, result), peakB = peakInBand(result.powerSecond, result);
    const peakValid = result.powerFirst[peakA] > 0 && result.powerSecond[peakA] > 0;
    const timing = peakValid ? `${format(result.phase[peakA], 4)} rad · coherence ${format(result.coherence[peakA], 4)}` : "Undefined (zero power)";
    const validBins = bandIndices(result).filter((i) => result.powerFirst[i] > 0 && result.powerSecond[i] > 0);
    const realSum = validBins.reduce((sum, i) => sum + result.crossReal[i], 0);
    const imagSum = validBins.reduce((sum, i) => sum + result.crossImag[i], 0);
    const bandPhase = Math.hypot(realSum, imagSum) > 0 ? Math.atan2(imagSum, realSum) : NaN;
    const bandCoherence = validBins.length ? validBins.reduce((sum, i) => sum + result.coherence[i], 0) / validBins.length : NaN;
    const bandText = `${format(result.band.effectiveRange[0], 4)}–${format(result.band.effectiveRange[1], 4)} Hz (${result.band.binIndices.length} bins)`;
    const rows = [
      ["Peak frequency", `${format(result.frequency[peakA], 4)} Hz`, `${format(result.frequency[peakB], 4)} Hz`, "—", "Highest power within the selected band"],
      ["Peak power", `${format(result.powerFirst[peakA], 4)} ${result.first.units}²${result.normalization === "density" ? "/Hz" : ""}`, `${format(result.powerSecond[peakB], 4)} ${result.second.units}²${result.normalization === "density" ? "/Hz" : ""}`, `Band ${bandText}`, "One-sided estimate at each channel's own peak"],
      ["Integrated band power", `${format(integrateBand(result.powerFirst, result), 4)} ${result.first.units}²`, `${format(integrateBand(result.powerSecond, result), 4)} ${result.second.units}²`, `Σ density × Δf; Δf ${format(result.sampleRate / result.size, 5)} Hz`, "Spectrum converted to density using equivalent noise bandwidth before integration"],
      ["Cross timing at A peak", "—", "—", timing, "Phase is B minus A; positive phase means B leads"],
      ["Band cross summary", "—", "—", `${format(bandPhase, 4)} rad · coherence ${format(bandCoherence, 4)}`, "Phase = arg(sum of complex cross bins); coherence = mean over positive-power bins. No band-coherence estimator or uncertainty implied."],
    ];
    $("comparisonBody").innerHTML = rows.map((row) => `<tr>${row.map((cell, index) => `<${index === 0 ? "th scope=\"row\"" : "td"}>${escapeHTML(cell)}</${index === 0 ? "th" : "td"}>`).join("")}</tr>`).join("");
    $("uncertaintyNote").textContent = uncertaintyNotes(result).join(" ");
  }

  function renderStats(result) {
    const peakIndex = peakInBand(result.powerFirst, result);
    const peakFrequency = result.frequency[peakIndex];
    $("statRate").textContent = `${format(result.sampleRate, 3)} Hz`;
    $("statSamples").textContent = `${result.nSamples.toLocaleString()} samples · ${result.segments} segments`;
    $("statDuration").textContent = `${format(result.timeSpan, 3)} s`;
    $("statGrid").textContent = `Δt ${format(result.interval, 6)} s · ${result.size}-sample windows`;
    $("statPeak").textContent = `${format(peakFrequency, 3)} Hz`;
    $("statPeakDetail").textContent = `Signal A ${result.normalization} ${format(result.powerFirst[peakIndex], 3)} ${result.first.units}²${result.normalization === "density" ? "/Hz" : ""}`;
    $("statTiming").textContent = `${format(result.phase[peakIndex], 3)} rad · ${format(result.coherence[peakIndex], 3)}`;
    $("statTimingDetail").textContent = `at ${format(peakFrequency, 3)} Hz · B minus A`;
    $("binSpacingHint").textContent = `${format(result.sampleRate / result.size, 4)} Hz`;
    $("windowHint").textContent = `periodic ${result.windowName}`;
    $("normalizationHint").textContent = `One-sided ${result.normalization}`;
    $("powerPlotSubtitle").textContent = `Welch ${result.normalization} · log scale`;
    $("frequencyRangeHint").textContent = `Available bins ${format(result.frequency[0], 4)}–${format(result.frequency.at(-1), 4)} Hz · ${result.band.binIndices.length} selected`;
    $("timeRangeHint").textContent = `Aligned range ${format(result.timeSelection.commonExtent[0], 6)}–${format(result.timeSelection.commonExtent[1], 6)} s`;
    $("bandHint").textContent = `selected band ${format(result.band.effectiveRange[0], 4)}–${format(result.band.effectiveRange[1], 4)} Hz`;
    renderComparison(result);
  }

  function niceBounds(values, mode = "linear", fixed = null) {
    if (fixed) return fixed;
    // Iterate rather than spreading arrays into Math.min/max (large imports are valid).
    let min = Infinity, max = -Infinity;
    for (const raw of values) {
      if (!finite(raw) || (mode === "log" && raw <= 0)) continue;
      const value = mode === "log" ? Math.log10(raw) : raw;
      min = Math.min(min, value); max = Math.max(max, value);
    }
    if (min === Infinity) return [0, 1];
    if (mode === "log") {
      min = Math.floor(min); max = Math.ceil(max);
      return min === max ? [min - 1, max + 1] : [min, max];
    }
    const pad = min === max ? (Math.abs(min) || 1) * .2 : (max / 10 - min / 10);
    return [finite(min - pad) ? min - pad : min, finite(max + pad) ? max + pad : max];
  }

  const plotViews = new WeakMap();
  function* plotValues(series) { for (const line of series) yield* line.values; }
  function plotUnits(result) {
    const suffix = result.normalization === "density" ? "/Hz" : "";
    return { a: result.first.units, b: result.second.units,
      powerA: `(${result.first.units})²${suffix}`, powerB: `(${result.second.units})²${suffix}`,
      cross: `(${result.first.units}) × (${result.second.units})${suffix}` };
  }
  function phaseDefined(result, index) {
    return finite(result.phase[index]) && finite(result.crossReal[index]) && finite(result.crossImag[index]) &&
      (result.crossReal[index] !== 0 || result.crossImag[index] !== 0);
  }
  function coherenceDefined(result, index) {
    return finite(result.coherence[index]) && finite(result.powerFirst[index]) && finite(result.powerSecond[index]) &&
      result.powerFirst[index] > 0 && result.powerSecond[index] > 0;
  }
  function plotFrequencySelection(result) {
    const mode = $("plotLogFrequency")?.checked ? "log" : "linear";
    const indexes = bandIndices(result).filter((i) => finite(result.frequency[i]) && (mode !== "log" || result.frequency[i] > 0));
    const values = indexes.map((i) => result.frequency[i]);
    return { indexes, values, mode, axis: createPlotAxis(values, mode) };
  }
  function plotFraction(value, min, max) {
    // Halving avoids overflow in max - min for large, finite linear values.
    return (value / 2 - min / 2) / (max / 2 - min / 2);
  }
  function scientificTick(exponent) { return `1e${exponent >= 0 ? "+" : ""}${exponent}`; }
  function decadeTicks(bounds, limit = 6) {
    const first = Math.ceil(bounds[0]), last = Math.floor(bounds[1]);
    const step = Math.max(1, Math.ceil((last - first) / Math.max(1, limit - 1)));
    const ticks = [];
    for (let exponent = first; exponent <= last; exponent += step) ticks.push({ value: exponent, label: scientificTick(exponent) });
    return ticks;
  }
  function createPlotAxis(values, mode = "linear") {
    let min = Infinity, max = -Infinity;
    for (const value of values) {
      if (!finite(value) || (mode === "log" && value <= 0)) continue;
      const transformed = mode === "log" ? Math.log10(value) : value;
      min = Math.min(min, transformed); max = Math.max(max, transformed);
    }
    const empty = min === Infinity, single = !empty && min === max;
    if (empty) { min = 0; max = 1; }
    else if (single) {
      const pad = mode === "log" ? .5 : (Math.abs(min) * .05 || .5);
      min -= pad; max += pad;
    }
    const toFraction = (raw) => {
      if (!finite(raw) || (mode === "log" && raw <= 0)) return NaN;
      return plotFraction(mode === "log" ? Math.log10(raw) : raw, min, max);
    };
    const fromFraction = (fraction) => {
      const transformed = (1 - fraction) * min + fraction * max;
      return mode === "log" ? 10 ** transformed : transformed;
    };
    let ticks = [];
    if (!empty && single) ticks = [{ value: (min + max) / 2, label: format(values[0], 6) }];
    else if (!empty && mode === "log") {
      ticks = decadeTicks([min, max]);
      if (ticks.length < 2) ticks = [min, max].map((value) => ({ value, label: (10 ** value).toExponential(2) }));
    } else if (!empty) ticks = Array.from({ length: 5 }, (_, i) => {
      const value = (1 - i / 4) * min + (i / 4) * max;
      return { value, label: format(value, 4) };
    });
    return { mode, min, max, empty, single, toFraction, fromFraction, ticks };
  }
  function plotGeometry(canvas) {
    const width = canvas.clientWidth || 600, height = canvas.clientHeight || 270;
    const pad = { left: 72, right: 22, top: 20, bottom: 48 };
    return { width, height, pad, plotW: Math.max(1, width - pad.left - pad.right), plotH: Math.max(1, height - pad.top - pad.bottom) };
  }
  function drawPlot(canvas, config) {
    if (!canvas) return;
    const { width, height, pad, plotW, plotH } = plotGeometry(canvas), dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, width, height);
    const xValues = config.xValues, axis = config.xAxis || createPlotAxis(xValues);
    plotViews.set(canvas, { axis, kind: config.kind, values: xValues, indexes: config.indexes });
    const yBounds = niceBounds(plotValues(config.series), config.yMode, config.yBounds);
    const xMap = (x) => pad.left + axis.toFraction(x) * plotW;
    const yPosition = (value) => pad.top + (1 - plotFraction(value, yBounds[0], yBounds[1])) * plotH;
    const yMap = (y) => yPosition(config.yMode === "log" ? (y > 0 ? Math.log10(y) : NaN) : y);
    const drawable = (value, i) => finite(value) && finite(xValues[i]) &&
      (config.yMode !== "log" || value > 0) && (axis.mode !== "log" || xValues[i] > 0);
    const hasValues = config.series.some((line) => line.values.some(drawable));
    const yTicks = config.yMode === "log" ? (hasValues ? decadeTicks(yBounds) : []) : Array.from({ length: 5 }, (_, i) => {
      const value = (1 - i / 4) * yBounds[0] + i / 4 * yBounds[1];
      return { value, label: format(value, config.yDigits ?? 2) };
    });
    ctx.font = "11px ui-sans-serif, system-ui, sans-serif"; ctx.lineWidth = 1;
    for (const tick of yTicks) {
      const y = yPosition(tick.value); ctx.strokeStyle = COLORS.grid; ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + plotW, y); ctx.stroke();
      ctx.fillStyle = COLORS.ink; ctx.textAlign = "right"; ctx.fillText(tick.label, pad.left - 8, y + 4);
    }
    for (const tick of axis.ticks) {
      const x = pad.left + plotFraction(tick.value, axis.min, axis.max) * plotW;
      ctx.strokeStyle = COLORS.grid; ctx.beginPath(); ctx.moveTo(x, pad.top); ctx.lineTo(x, pad.top + plotH); ctx.stroke();
      ctx.fillStyle = COLORS.ink; ctx.textAlign = "center"; ctx.fillText(tick.label, x, height - 27);
    }
    // All data paths, sample dots and linked cursors are clipped to the axes.
    ctx.save(); ctx.beginPath(); ctx.rect(pad.left, pad.top, plotW, plotH); ctx.clip();
    config.series.forEach((line) => {
      ctx.beginPath(); ctx.strokeStyle = line.color; ctx.lineWidth = 1.7;
      let drawing = false;
      line.values.forEach((value, i) => {
        if (!drawable(value, i)) { drawing = false; return; }
        const x = xMap(xValues[i]), y = yMap(value);
        if (!finite(x) || !finite(y)) { drawing = false; return; }
        if (!drawing) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        drawing = true;
      });
      ctx.stroke();
      // Isolated bins/samples remain visible instead of becoming invisible moveTo paths.
      ctx.fillStyle = line.color;
      line.values.forEach((value, i) => {
        if (!drawable(value, i)) return;
        if (xValues.length > 24 && (drawable(line.values[i - 1], i - 1) || drawable(line.values[i + 1], i + 1))) return;
        const x = xMap(xValues[i]), y = yMap(value);
        if (finite(x) && finite(y)) { ctx.beginPath(); ctx.arc(x, y, 2.5, 0, 2 * Math.PI); ctx.fill(); }
      });
    });
    if (state.cursor?.kind === config.kind) {
      const x = xMap(state.cursor.value);
      if (finite(x) && x >= pad.left && x <= pad.left + plotW) {
        ctx.strokeStyle = COLORS.cursor; ctx.lineWidth = 1; ctx.setLineDash(state.cursor.pinned ? [] : [3, 3]);
        ctx.beginPath(); ctx.moveTo(x, pad.top); ctx.lineTo(x, pad.top + plotH); ctx.stroke(); ctx.setLineDash([]);
      }
    }
    ctx.restore();
    if (!hasValues || axis.empty) {
      ctx.fillStyle = COLORS.ink; ctx.textAlign = "center";
      ctx.fillText(axis.empty ? "No positive-frequency bins to display" : (config.emptyLabel || "No finite samples to display"), pad.left + plotW / 2, pad.top + plotH / 2, plotW - 12);
    }
    ctx.fillStyle = COLORS.ink; ctx.textAlign = "center"; ctx.fillText(config.xLabel, pad.left + plotW / 2, height - 7);
    ctx.save(); ctx.translate(15, pad.top + plotH / 2); ctx.rotate(-Math.PI / 2); ctx.fillText(config.yLabel, 0, 0, plotH); ctx.restore();
  }

  function renderPlots(result) {
    const units = plotUnits(result), selection = plotFrequencySelection(result), { indexes, values: frequencies, axis } = selection;
    if (state.cursor) {
      const values = state.cursor.kind === "time" ? result.first.time : frequencies;
      if (!values.length) state.cursor = null;
      else {
        const position = closestIndex(values, state.cursor.value, state.cursor.kind === "time" ? "linear" : selection.mode);
        state.cursor = { ...state.cursor, value: values[position], index: state.cursor.kind === "time" ? position : indexes[position] };
      }
    }
    if ($("timePlotUnits")) $("timePlotUnits").textContent = `A: ${units.a} · B: ${units.b}${units.a !== units.b ? " · shared numeric scale; units differ" : ""}`;
    if ($("powerPlotUnits")) $("powerPlotUnits").textContent = `A: ${units.powerA} · B: ${units.powerB}${units.a !== units.b ? " · shared numeric scale; units differ" : ""}`;
    if ($("plotFrequencyNote")) $("plotFrequencyNote").textContent = selection.mode === "log"
      ? `Log frequency display: DC (0 Hz) omitted; positive selected bins only.${indexes.length ? "" : " No positive-frequency bins in this band."}`
      : "Linear frequency display includes DC (0 Hz) when selected.";
    $("powerPlotSubtitle").textContent = `Welch ${result.normalization} · logarithmic power · nonpositive values omitted`;
    const timeLabel = units.a === units.b ? `value (${units.a})` : "value (channel units below)";
    const powerLabel = units.a === units.b ? `${result.normalization} (${units.powerA})` : `${result.normalization} (channel units below)`;
    drawPlot($("timePlot"), { kind: "time", xValues: result.first.time, xLabel: "time (s)", yLabel: timeLabel, yDigits: 2,
      series: [{ values: result.first.value, color: COLORS.a }, { values: result.second.value, color: COLORS.b }] });
    // The same axis object is used by drawing, pointer inversion and every linked frequency view.
    const shared = { kind: "frequency", xValues: frequencies, indexes, xAxis: axis, xLabel: `frequency (Hz)${selection.mode === "log" ? " · log" : ""}` };
    drawPlot($("powerPlot"), { ...shared, yLabel: powerLabel, yMode: "log", emptyLabel: "No positive power in displayed bins (zero/nonpositive omitted)",
      series: [{ values: indexes.map((i) => result.powerFirst[i]), color: COLORS.a }, { values: indexes.map((i) => result.powerSecond[i]), color: COLORS.b }] });
    drawPlot($("phasePlot"), { ...shared, yLabel: "phase (rad)", yBounds: [-Math.PI, Math.PI], emptyLabel: "Phase undefined: no nonzero cross power",
      series: [{ values: indexes.map((i) => phaseDefined(result, i) ? result.phase[i] : NaN), color: COLORS.blue }] });
    drawPlot($("coherencePlot"), { ...shared, yLabel: "coherence (dimensionless)", yBounds: [0, 1], emptyLabel: "Coherence undefined: power must be positive in A and B",
      series: [{ values: indexes.map((i) => coherenceDefined(result, i) ? result.coherence[i] : NaN), color: COLORS.teal }] });
    renderCursorReadout();
  }
  function redraw() { if (state.result) renderPlots(state.result); else renderCursorReadout(); }
  function renderCursorReadout() {
    const result = state.result, cursor = state.cursor;
    let text = result ? "Hover to inspect · click to pin · focus a plot and use ←/→ · Escape clears" : "No current analysis";
    if (cursor && result) {
      const units = plotUnits(result), i = cursor.index, pin = cursor.pinned ? " · pinned" : "";
      if (cursor.kind === "time") {
        const sample = (value, unit) => finite(value) ? `${format(value, 6)} ${unit}` : `missing (NaN) ${unit}`;
        text = `t ${format(result.first.time[i], 6)} s · sample ${i} · A ${sample(result.first.value[i], units.a)} · B ${sample(result.second.value[i], units.b)}${pin}`;
      } else {
        const phase = phaseDefined(result, i) ? `${formatSigned(result.phase[i], 6)} rad (valid)` : "undefined (zero/nonfinite cross power)";
        const coherence = coherenceDefined(result, i) ? `${format(result.coherence[i], 6)} (valid, dimensionless)` : "undefined (zero/nonpositive channel power)";
        text = `f ${format(result.frequency[i], 6)} Hz · bin ${i} · A power ${format(result.powerFirst[i], 6)} ${units.powerA} · B power ${format(result.powerSecond[i], 6)} ${units.powerB} · cross (${format(result.crossReal[i], 6)} ${result.crossImag[i] < 0 ? "−" : "+"} ${format(Math.abs(result.crossImag[i]), 6)}i) ${units.cross} · phase ${phase} · coherence ${coherence}${pin}`;
      }
    }
    $("cursorReadout").textContent = text;
    if ($("plotInspection")) $("plotInspection").textContent = text;
    // Announce explicit inspection actions without a live announcement on every hover.
    if ($("plotInspectionLive")) $("plotInspectionLive").textContent = cursor?.pinned ? text : "";
  }
  function closestIndex(values, target, mode = "linear") {
    if (!values.length) return -1;
    if (mode === "log" && (!finite(target) || target <= 0)) return 0;
    let low = 0, high = values.length - 1;
    while (low < high) { const mid = Math.floor((low + high) / 2); if (values[mid] < target) low = mid + 1; else high = mid; }
    if (low === 0) return 0;
    const transform = mode === "log" ? Math.log10 : (value) => value;
    return Math.abs(transform(values[low - 1]) - transform(target)) <= Math.abs(transform(values[low]) - transform(target)) ? low - 1 : low;
  }
  function setPlotCursor(view, position, pinned = false) {
    state.cursor = { kind: view.kind, index: view.indexes ? view.indexes[position] : position, value: view.values[position], pinned };
  }

  function handlePointer(event, pin = false) {
    if (!state.result || (!pin && state.cursor?.pinned)) return;
    const canvas = event.currentTarget, view = plotViews.get(canvas);
    if (!view?.values.length) return;
    const rect = canvas.getBoundingClientRect(), { width, pad, plotW } = plotGeometry(canvas);
    const localX = (event.clientX - rect.left) * width / (rect.width || width);
    const fraction = Math.max(0, Math.min(1, (localX - pad.left) / plotW));
    const position = closestIndex(view.values, view.axis.fromFraction(fraction), view.axis.mode);
    setPlotCursor(view, position, pin);
    if (pin) canvas.focus?.();
    redraw();
  }
  function handlePlotKey(event) {
    if (event.key === "Escape") { event.preventDefault(); state.cursor = null; redraw(); return; }
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || !state.result) return;
    const view = plotViews.get(event.currentTarget);
    if (!view?.values.length) return;
    event.preventDefault();
    const current = state.cursor?.kind === view.kind ? closestIndex(view.values, state.cursor.value, view.axis.mode) : -1;
    let position = current < 0 ? (event.key === "ArrowLeft" ? view.values.length - 1 : 0) : current + (event.key === "ArrowLeft" ? -1 : 1);
    if (event.key === "Home") position = 0;
    if (event.key === "End") position = view.values.length - 1;
    setPlotCursor(view, Math.max(0, Math.min(view.values.length - 1, position)), true); redraw();
  }
  function bindPlots() {
    document.querySelectorAll("canvas[data-plot]").forEach((canvas) => {
      canvas.addEventListener("pointermove", handlePointer);
      canvas.addEventListener("click", (event) => handlePointer(event, true));
      canvas.addEventListener("keydown", handlePlotKey);
      canvas.addEventListener("pointerleave", () => { if (!state.cursor?.pinned) { state.cursor = null; redraw(); } });
    });
    $("plotLogFrequency")?.addEventListener("change", redraw);
    $("plotClearCursor")?.addEventListener("click", () => { state.cursor = null; redraw(); });
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(redraw).observe(document.querySelector(".plot-grid"));
    window.addEventListener("resize", redraw);
  }

  function generateDemo() {
    const sampleRate = 128, n = 1024, frequency = 2, phase = Math.PI / 4;
    const time = Array.from({ length: n }, (_, i) => i / sampleRate);
    return [{ time, value: time.map((t) => Math.sin(2 * Math.PI * frequency * t)), units: "arbitrary", source: "deterministic-demo-A.csv" }, { time: time.slice(), value: time.map((t) => Math.sin(2 * Math.PI * frequency * t + phase)), units: "arbitrary", source: "deterministic-demo-B.csv" }];
  }
  function refreshSession() { window.SpectralSession?.refresh(); }
  function loadDemo() { [state.first, state.second] = generateDemo(); setFileCard(0, state.first); setFileCard(1, state.second); runAnalysis(true); }
  function clearRenderedResult() {
    state.result = null; state.cursor = null;
    ["statRate", "statDuration", "statPeak", "statTiming", "statSamples", "statGrid", "statPeakDetail", "statTimingDetail"].forEach((id) => { $(id).textContent = "—"; });
    $("comparisonBody").innerHTML = '<tr><td colspan="5" class="empty-table">Run an analysis to populate the comparison.</td></tr>';
    $("exportJson").disabled = true;
    $("runAnalysis").disabled = true;
    $("cursorReadout").textContent = "No current analysis";
    $("uncertaintyNote").textContent = "No current analysis; correct the configuration to review estimates.";
    renderCursorReadout();
    document.querySelectorAll("canvas[data-plot]").forEach((canvas) => { const ctx = canvas.getContext("2d"); if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height); });
    refreshSession();
  }
  function clearFileCard(index) {
    const name = index === 0 ? "fileFirstName" : "fileSecondName", meta = index === 0 ? "fileFirstMeta" : "fileSecondMeta";
    $(name).textContent = "Drop CSV here or browse"; $(meta).textContent = "time · value · units";
  }
  function configFromControls() {
    ["timeStart", "timeEnd", "frequencyLow", "frequencyHigh", "segmentLength"].forEach((id) => {
      if ($(id).validity?.badInput) throw new Error(`${id} must contain a valid numeric value`);
    });
    return { timeStart: $("timeStart").value, timeEnd: $("timeEnd").value, frequencyLow: $("frequencyLow").value, frequencyHigh: $("frequencyHigh").value, window: $("window").value, removeDC: $("removeDC").checked, average: $("average").value, normalization: $("normalization").value, nanPolicy: $("nanPolicy").value, lengthPolicy: $("lengthPolicy").value };
  }
  function validateControls() {
    try {
      if (!state.first || !state.second) throw new Error("Choose both CSV files, or load the deterministic demo");
      prepareAnalysis(state.first, state.second, Number($("segmentLength").value), configFromControls());
      $("runAnalysis").disabled = false;
      state.lastError = null;
      setStatus("Configuration valid. Run analysis to review the selected range.", "warning");
      $("validationPanel").classList.remove("has-error"); $("validationState").classList.remove("error"); $("validationState").textContent = "READY";
      $("validationContent").textContent = "Time range, frequency bins, spectral options and finite segments validated. Analysis pending.";
      return null;
    } catch (error) {
      $("runAnalysis").disabled = true; $("exportJson").disabled = true; state.lastError = error; setValidation(null, error); setStatus(error.message, "error"); return error;
    }
  }
  function runAnalysis(isDemo = false) {
    try {
      if (!state.first || !state.second) throw new Error("Choose both CSV files, or load the deterministic demo");
      const length = Number($("segmentLength").value);
      state.result = analyze(state.first, state.second, length, configFromControls());
      state.cursor = null;
      renderStats(state.result); renderPlots(state.result); setValidation(state.result); setStatus(isDemo ? "Deterministic demo loaded. Ready to review." : `Analysis complete · ${state.result.segments} Welch segment${state.result.segments === 1 ? "" : "s"}.`); state.lastError = null;
      $("runAnalysis").disabled = false; $("exportJson").disabled = false; refreshSession();
    } catch (error) { clearRenderedResult(); state.lastError = error; setValidation(null, error); setStatus(error.message, "error"); $("runAnalysis").disabled = true; }
  }
  function readFile(index, file) {
    const generation = ++state.fileGenerations[index];
    const reader = new FileReader();
    reader.onload = () => {
      if (generation !== state.fileGenerations[index]) return;
      try {
        const series = parseCSV(reader.result, file.name);
        if (index === 0) state.first = series; else state.second = series;
        state.importErrors[index] = null; state.imports[index] += 1;
        setFileCard(index, series); clearRenderedResult();
        setStatus(`${file.name} loaded. Run analysis when both signals are ready.`, "warning");
        if (state.first && state.second) runAnalysis();
      } catch (error) {
        if (index === 0) state.first = null; else state.second = null;
        state.importErrors[index] = error.message; state.lastError = error;
        clearFileCard(index); clearRenderedResult(); setValidation(null, error); setStatus(`${file.name}: ${error.message}`, "error");
      }
    };
    reader.onerror = () => {
      if (generation !== state.fileGenerations[index]) return;
      const error = new Error(`Could not read ${file.name}`);
      if (index === 0) state.first = null; else state.second = null;
      state.importErrors[index] = error.message; state.lastError = error;
      clearFileCard(index); clearRenderedResult(); setValidation(null, error); setStatus(error.message, "error");
    };
    reader.readAsText(file);
  }

  function applyRestoredSession(candidate) {
    const controls = candidate.controls;
    $("segmentLength").value = String(controls.segmentLength);
    ["timeStart", "timeEnd", "frequencyLow", "frequencyHigh"].forEach((id) => { $(id).value = controls[id] == null ? "" : String(controls[id]); });
    ["window", "average", "normalization", "nanPolicy", "lengthPolicy"].forEach((id) => { $(id).value = controls[id]; });
    $("removeDC").checked = controls.removeDC;
    for (const [id, value] of Object.entries(candidate.display || {})) { const el = $(id); if (el) el.type === "checkbox" ? (el.checked = value) : (el.value = String(value)); }
    state.first = candidate.first; state.second = candidate.second; state.result = candidate.result; state.cursor = null; state.lastError = null;
    setFileCard(0, state.first); setFileCard(1, state.second); renderStats(state.result); renderPlots(state.result); setValidation(state.result); setStatus("Session restored · saved numeric arrays retained; no spectral recomputation.");
    $("runAnalysis").disabled = false; $("exportJson").disabled = false;
  }

  function mountSession() {
    if (!window.SpectralSession) return;
    window.SpectralSession.mount({
      getState: () => state,
      configFromControls,
      getSegmentLength: () => $("segmentLength").value,
      applyRestoredSession,
      prepareAnalysis: (first, second, size, controls) => prepareAnalysis(first, second, size, controls),
      displayControlIds: ["plotLogFrequency"],
    });
  }

  function exportJSON() {
    if (!state.result) return;
    const result = state.result;
    const payload = { format: "spectral-timing-lab-review-v1", exportedAt: new Date().toISOString(), spectralArrays: { frequency: result.frequency, powerFirst: result.powerFirst, powerSecond: result.powerSecond, crossReal: result.crossReal, crossImag: result.crossImag, phase: result.phase, coherence: result.coherence }, config: { time: { request: result.timeSelection.request, effectiveRange: result.timeSelection.effectiveRange, indexBounds: result.timeSelection.indexBounds, commonExtent: result.timeSelection.commonExtent }, frequencyBand: { request: result.band.request, effectiveRange: result.band.effectiveRange, binIndices: result.band.binIndices, availableRange: result.band.availableRange }, segmentLength: result.size, overlap: result.overlap, window: result.windowName, DCRemoval: result.removeDC, average: result.average, normalization: result.normalization, nanPolicy: result.nanPolicy, lengthPolicy: result.lengthPolicy, interval: result.interval, sampleRate: result.sampleRate, inputs: result.inputs, counts: { commonSamples: result.commonSamples, analyzedSamples: result.nSamples, candidateSegments: result.candidateSegmentStarts.length, retainedSegments: result.segments, omittedSegments: result.omittedSegments, tailSamples: result.tailSamples, truncatedSamples: result.truncatedSamples }, segmentStarts: { candidateIndices: result.candidateSegmentStarts, retainedIndices: result.retainedSegmentStarts, omittedIndices: result.omittedSegmentStarts }, formulas: { crossSpectrum: "conj(FFT(A)) × FFT(B)", phase: "atan2(imag(cross), real(cross)), wrapped to [−π, π]", coherence: "|cross|² / (powerA × powerB), bounded to [0, 1]", integratedBandPower: "Σ selected one-sided power bins × Δf" }, conventions: { frequencyResolution: "sample rate / segment length; this is frequency resolution, not a statistical confidence interval", oneSided: "positive-frequency bins with interior bins doubled", windowNormalization: "density: sample rate × sum(window²); spectrum: sum(window)²", notes: ["Complete segments use 50% overlap; incomplete tails are discarded.", "NaN omission drops the same segment from both channels without interpolation.", "Median averaging is uncorrected and uses separate component-wise medians.", "No statistical confidence intervals are estimated by this browser review.", "Phase band summary is an arithmetic mean, not a circular uncertainty estimate."] } }, inputs: { A: result.first, B: result.second } };
    payload.config.formulas.integratedBandPower = "Σ density bins × Δf; spectrum converted to density by dividing by ENBW";
    payload.config.formulas.bandPhase = "arg(sum of complex cross bins with positive power in both channels)";
    payload.config.formulas.bandCoherence = "arithmetic mean over positive-power bins; descriptive, not a band-coherence estimator";
    payload.config.conventions.notes = uncertaintyNotes(result);
    payload.config.conventions.phaseSign = "B minus A; positive means B leads";
    payload.config.conventions.meanRemoval = "Unweighted per-segment mean before windowing; DC bin is not forcibly zeroed";
    payload.config.conventions.samplingTolerance = { relativeToCadence: 1e-7, absoluteSeconds: 1e-12 };
    payload.config.segmentStarts.indexOrigin = "Zero-based relative to effective time selection; add time.indexBounds.start for original input indices";
    payload.config.windowDefinition = { periodic: result.windowName !== "boxcar", sum: result.windowSum, sumSquares: result.windowPower, equivalentNoiseBandwidthHz: result.sampleRate * result.windowPower / result.windowSum ** 2 };
    payload.units = { frequency: "Hz", powerFirst: `(${result.first.units})²${result.normalization === "density" ? "/Hz" : ""}`, powerSecond: `(${result.second.units})²${result.normalization === "density" ? "/Hz" : ""}`, cross: `(${result.first.units})×(${result.second.units})${result.normalization === "density" ? "/Hz" : ""}`, phase: "rad", coherence: "dimensionless" };
    payload.spectralArrays.phaseDefined = result.crossReal.map((real, i) => Math.hypot(real, result.crossImag[i]) > 0);
    payload.spectralArrays.coherenceDefined = result.powerFirst.map((power, i) => power > 0 && result.powerSecond[i] > 0);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = "spectral-timing-review.json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  $("loadDemo").addEventListener("click", loadDemo); $("runAnalysis").addEventListener("click", () => runAnalysis()); $("exportJson").addEventListener("click", exportJSON); $("fileFirst").addEventListener("change", (event) => { if (event.target.files[0]) readFile(0, event.target.files[0]); }); $("fileSecond").addEventListener("change", (event) => { if (event.target.files[0]) readFile(1, event.target.files[0]); });
  ["timeStart", "timeEnd", "frequencyLow", "frequencyHigh", "segmentLength", "window", "removeDC", "average", "normalization", "nanPolicy", "lengthPolicy"].forEach((id) => $(id).addEventListener("change", () => { if (state.first && state.second) runAnalysis(); else validateControls(); }));
  ["timeStart", "timeEnd", "frequencyLow", "frequencyHigh", "segmentLength"].forEach((id) => $(id).addEventListener("input", () => { clearRenderedResult(); validateControls(); refreshSession(); }));
  document.querySelectorAll(".file-drop").forEach((drop) => { ["dragenter", "dragover"].forEach((eventName) => drop.addEventListener(eventName, (event) => { event.preventDefault(); drop.classList.add("dragover"); })); ["dragleave", "drop"].forEach((eventName) => drop.addEventListener(eventName, (event) => { event.preventDefault(); drop.classList.remove("dragover"); })); drop.addEventListener("drop", (event) => { const file = event.dataTransfer.files[0]; if (file) readFile(drop.htmlFor === "fileFirst" ? 0 : 1, file); }); });
  bindPlots(); mountSession(); loadDemo();
})();
