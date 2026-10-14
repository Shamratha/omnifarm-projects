/* Dependency-free static and executable smoke checks: node web/smoke-test.js. */
const fs = require("fs");
const path = require("path");
const assert = require("node:assert/strict");
const vm = require("node:vm");

const root = __dirname;
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
const html = read("index.html");
const css = read("styles.css");
const app = read("app.js");
const session = read("session.js");
const checks = [
  ["HTML loads the local stylesheet", html.includes('href="styles.css"')],
  ["HTML loads the local application", html.includes('src="app.js"')],
  ["CSV inputs exist", html.includes('id="fileFirst"') && html.includes('id="fileSecond"')],
  ["Time and frequency selection controls exist", ["timeStart", "timeEnd", "frequencyLow", "frequencyHigh"].every((id) => html.includes(`id="${id}"`))],
  ["Comparison and export UI exist", html.includes('id="comparisonBody"') && html.includes('id="exportJson"')],
  ["Analysis option controls exist", ["window", "removeDC", "average", "normalization", "nanPolicy", "lengthPolicy"].every((id) => html.includes(`id="${id}"`))],
  ["All four linked canvases exist", ["timePlot", "powerPlot", "phasePlot", "coherencePlot"].every((id) => html.includes(`id="${id}"`))],
  ["Documented FFT/Welch operations are present", ["periodic Hann", "conj(FFT(A))", "windowValues", "windowPower", "normalization"].every((term) => html.includes(term) || app.includes(term))],
  ["Deterministic demo is wired", app.includes("generateDemo") && app.includes("loadDemo")],
  ["Validation and error states are wired", app.includes("validateSampling") && app.includes('setStatus(error.message, "error")')],
  ["Selections validate against aligned data and bins", app.includes("aligned common samples") && app.includes("available FFT bins") && app.includes("bandIndices")],
  ["Selected frequency band drives summaries and plots", app.includes("peakInBand") && app.includes("bandIndices(result)")],
  ["Export includes actual spectral arrays and complete configuration", ["frequency", "powerFirst", "powerSecond", "crossReal", "crossImag", "phase", "coherence", "sampleRate", "retainedSegments", "notes"].every((term) => app.includes(term))],
  ["Uncertainty language is explicit", html.includes("Coherence confidence is limited/heuristic") && html.includes("Phase uncertainty is not estimated")],
  ["Independent-workbench disclaimer is retained", html.includes("not a replacement for Stingray.jl")],
  ["No external resource is referenced", !/<(?:script|link)[^>]+(?:https?:|\/\/)/i.test(html) && !/url\(\s*["']?(?:https?:|\/\/)/i.test(css) && !/\b(?:fetch|import)\s*\(/.test(app)],
  ["Session controls, report, and plot display controls exist", ["saveSession", "restoreSession", "sessionFile", "assumptionsContent", "plotLogFrequency", "plotClearCursor"].every((id) => html.includes(`id="${id}"`))],
  ["HTML IDs are unique", (() => { const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]); return new Set(ids).size === ids.length; })()],
  ["Session API validates and restores without recomputation", session.includes("window.SpectralSession") && session.includes("saved numeric arrays retained; no spectral recomputation") && session.includes("resultCheck") && session.includes("applyRestoredSession")],
];

function test(name, callback) {
  try { callback(); checks.push([name, true]); }
  catch (error) { checks.push([name, false, error.stack]); }
}

// Run the complete browser entry point against a minimal DOM/canvas double.
// Defaults come from the HTML so missing controls or incorrect defaults fail.
const elements = new Map();
for (const match of html.matchAll(/<([a-z]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
  const [, tag, attributes, id] = match;
  const listeners = {};
  const context = new Proxy({}, { get(target, key) {
    if (key in target) return target[key];
    return (...args) => {
      if (key === "moveTo" || key === "lineTo") assert.ok(args.every(Number.isFinite), "plot coordinates must be finite");
    };
  } });
  const element = {
    type: attributes.match(/\btype="([^"]+)"/)?.[1] || tag,
     value: attributes.match(/\bvalue="([^"]*)"/)?.[1] || "", disabled: /\bdisabled\b/.test(attributes),
    checked: /\bchecked\b/.test(attributes), textContent: "", innerHTML: "",
    classList: { add() {}, remove() {} }, dataset: { plot: attributes.match(/data-plot="([^"]+)"/)?.[1] },
    addEventListener(name, callback) { listeners[name] = callback; },
    dispatch(name, event = {}) { assert.ok(listeners[name], `${id} has a ${name} listener`); listeners[name]({ currentTarget: element, ...event }); },
     querySelector() { return { textContent: "" }; }, replaceChildren(...children) { this.children = children; }, appendChild(child) { (this.children ||= []).push(child); return child; }, getContext() { return context; },
    getBoundingClientRect() { return { left: 0, width: 600 }; },
  };
  if (tag === "select") element.value = html.slice(match.index).match(/<option value="([^"]+)"/)?.[1];
  elements.set(id, element);
}
const canvases = ["timePlot", "powerPlot", "phasePlot", "coherencePlot"].map((id) => elements.get(id));
let lastDownload = null;
class FakeFileReader {
  readAsText(file) { this.result = file.text; if (this.onload) this.onload(); }
}
class FakeBlob {
  constructor(parts) { this.text = parts.join(""); }
}
const sandbox = { document: {
  getElementById(id) { assert.ok(elements.has(id), `HTML contains ${id}`); return elements.get(id); },
  querySelectorAll(selector) { return selector === "canvas[data-plot]" ? canvases : []; },
  createElement(tag) { if (tag === "a") return { set href(value) { this.url = value; }, click() { lastDownload = this; } }; return { className: "", textContent: "", appendChild(child) { (this.children ||= []).push(child); return child; } }; },
}, window: { devicePixelRatio: 1, addEventListener() {} } };
sandbox.FileReader = FakeFileReader;
sandbox.Blob = FakeBlob;
sandbox.URL = { createObjectURL(blob) { return `blob:${blob.text}`; }, revokeObjectURL() {} };
sandbox.setTimeout = (callback) => callback();
vm.createContext(sandbox);
vm.runInContext(session, sandbox);
// Expose private functions only in this test VM; the shipped browser stays private.
sandbox.analysisCalls = 0;
const instrumentedApp = app.replace("function analyze(first, second, segmentLength, options = {}) {", "function analyze(first, second, segmentLength, options = {}) { globalThis.analysisCalls += 1;");
vm.runInContext(instrumentedApp.replace(/\}\)\(\);\s*$/, "globalThis.testAPI = { analyze, parseCSV, state, runAnalysis, readFile, exportJSON, configFromControls, applyRestoredSession, prepareAnalysis, createPlotAxis, decadeTicks }; })();"), sandbox);
const { analyze, parseCSV, state, runAnalysis, readFile, exportJSON } = sandbox.testAPI;
const near = (actual, expected, tolerance = 1e-10) => assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${actual} ≈ ${expected}`);
const nearArray = (actual, expected) => { assert.equal(actual.length, expected.length); actual.forEach((value, i) => near(value, expected[i])); };
const series = (values, rate = 8) => ({ time: Array.from(values, (_, i) => i / rate), value: Array.from(values), units: "counts", source: "smoke.csv" });
const compareSpectra = (actual, expected) => ["frequency", "powerFirst", "powerSecond", "crossReal", "crossImag"].forEach((key) => nearArray(actual[key], expected[key]));
const basic = { window: "boxcar", removeDC: false };

test("Browser startup recovers demo frequency, phase, coherence and density", () => {
  assert.equal(state.lastError, null);
  const result = state.result;
  const peak = result.powerFirst.indexOf(Math.max(...result.powerFirst));
  near(result.frequency[peak], 2); near(result.phase[peak], Math.PI / 4); near(result.coherence[peak], 1);
  near(result.powerFirst[peak], 2 / 3); assert.equal(result.segments, 7);
});

test("CSV rejects blank numeric fields, malformed values and infinities", () => {
  for (const row of [",1,counts", "0,,counts", '0,"  ",counts', "  ,1,counts", ",,", "0,nope,counts", "NaN,1,counts", "0,Infinity,counts", "0,-Infinity,counts"]) {
    assert.throws(() => parseCSV(`time,value,units\n${row}\n`), /invalid numeric/);
  }
  const parsed = parseCSV('time,value,units\n\n0,"1",counts\n1,NaN,counts\n');
  assert.equal(parsed.value[0], 1); assert.ok(Number.isNaN(parsed.value[1]));
});

test("Fractional, blank and out-of-range segment lengths are rejected", () => {
  const signal = series([1, 2, 3, 4]);
  for (const length of [2.5, "3.9", "", 1, 5, Infinity]) assert.throws(() => analyze(signal, signal, length), /segment length must be an integer/);
});

test("All four periodic windows produce the expected impulse power", () => {
  const impulse = series([0, 1, 0, 0]);
  // At index 1 the periodic window weights are 0.5, 0.54, 0.34, and 1.
  const expected = { hann: [0.5, 1.5], hamming: [0.54, 1.5896], blackman: [0.34, 1.2312], boxcar: [1, 4] };
  for (const [window, [weight, energy]] of Object.entries(expected)) {
    const result = analyze(impulse, impulse, 4, { window, removeDC: false });
    nearArray(result.powerFirst, [1, 2, 1].map((factor) => factor * weight ** 2 / (8 * energy)));
  }
});

test("DC removal subtracts segment means before windowing", () => {
  const constant = series([3, 3, 3, 3]);
  nearArray(analyze(constant, constant, 4).powerFirst, [0, 0, 0]);
  near(analyze(constant, constant, 4, basic).powerFirst[0], 4.5);
  const ramp = series([0, 1, 2, 3]);
  near(analyze(ramp, ramp, 4).powerFirst[0], 1 / 12); // DC bin is not forcibly zeroed.
});

test("Density and spectrum scale power and cross consistently", () => {
  const a = series([1, 4, 2, -1, 3, 0, -2, 5]);
  const b = series([2, 0, 3, 1, -1, 2, 5, -3]);
  for (const average of ["mean", "median"]) for (const window of ["hann", "hamming", "blackman", "boxcar"]) {
    const density = analyze(a, b, 4, { window, average });
    const spectrum = analyze(a, b, 4, { window, average, normalization: "spectrum" });
    const ratio = { hann: 3, hamming: 8 * 1.5896 / 2.16 ** 2, blackman: 8 * 1.2312 / 1.68 ** 2, boxcar: 2 }[window];
    for (const key of ["powerFirst", "powerSecond", "crossReal", "crossImag"]) nearArray(spectrum[key], density[key].map((value) => value * ratio));
    nearArray(spectrum.phase, density.phase); nearArray(spectrum.coherence, density.coherence);
  }
});

test("Mean and uncorrected component-wise median aggregate the same segments", () => {
  const a = series([1, 2, 3, -2, 20, -9, 2, 1, 4, 3]);
  const b = series([4, 1, -2, 3, -4, 12, 3, 0, 1, -2]);
  for (const count of [3, 4]) {
    const length = 4 + (count - 1) * 2;
    const x = series(a.value.slice(0, length)), y = series(b.value.slice(0, length));
    const parts = Array.from({ length: count }, (_, i) => analyze(series(x.value.slice(i * 2, i * 2 + 4)), series(y.value.slice(i * 2, i * 2 + 4)), 4, basic));
    const mean = analyze(x, y, 4, { ...basic, average: "mean" });
    const median = analyze(x, y, 4, { ...basic, average: "median" });
    for (const key of ["powerFirst", "powerSecond", "crossReal", "crossImag"]) for (let k = 0; k < 3; k += 1) {
      const values = parts.map((part) => part[key][k]).sort((v, w) => v - w);
      near(mean[key][k], values.reduce((sum, value) => sum + value, 0) / count);
      near(median[key][k], count === 3 ? values[1] : (values[1] + values[2]) / 2);
    }
    assert.notEqual(mean.powerFirst[0], median.powerFirst[0]);
  }
});

test("NaN omission uses a shared mask for both powers and cross spectra", () => {
  const a = series([NaN, 2, 3, 4, 5, 6, 7, 8]);
  const b = series([1, 0, 2, 1, 3, 2, 4, NaN]);
  assert.throws(() => analyze(a, b, 4), /contains NaN/);
  for (const average of ["mean", "median"]) {
    const result = analyze(a, b, 4, { nanPolicy: "omit", average });
    assert.equal(result.segments, 1); assert.equal(result.omittedSegments, 2);
    compareSpectra(result, analyze(series(a.value.slice(2, 6)), series(b.value.slice(2, 6)), 4));
  }
  assert.throws(() => analyze(series([NaN, NaN, NaN, NaN]), series([1, 2, 3, 4]), 4, { nanPolicy: "omit" }), /no complete finite segments/);
});

test("NaN rejection includes incomplete tails; omission never allows infinity", () => {
  const a = series([1, 2, 3, 4, 5, 6, 7, 8, NaN]);
  assert.throws(() => analyze(a, a, 4), /contains NaN/);
  const omitted = analyze(a, a, 4, { nanPolicy: "omit" });
  assert.equal(omitted.segments, 3); assert.equal(omitted.omittedSegments, 0);
  a.value[8] = Infinity;
  assert.throws(() => analyze(a, a, 4, { nanPolicy: "omit" }), /infinities/);
});

test("Truncation analyzes the common prefix and validates both full grids", () => {
  const short = series([1, 2, 3, 4]);
  const long = series([2, 1, 4, 3, NaN, NaN]);
  assert.throws(() => analyze(short, long, 4), /same sampling grid length/);
  const result = analyze(short, long, 4, { lengthPolicy: "truncate" });
  assert.equal(result.nSamples, 4); assert.equal(result.second.time.length, 4); assert.equal(result.truncatedSamples, 2);
  compareSpectra(result, analyze(short, series(long.value.slice(0, 4)), 4));
  compareSpectra(analyze(long, short, 4, { lengthPolicy: "truncate" }), analyze(series(long.value.slice(0, 4)), short, 4));
  assert.throws(() => analyze(short, long, 5, { lengthPolicy: "truncate" }), /segment length/);
  for (const time of [long.time.map((t) => t + 0.01), long.time.map((t) => t * 2), [...long.time.slice(0, -1), 9]]) {
    assert.throws(() => analyze(short, { ...long, time }, 4, { lengthPolicy: "truncate" }), /same sampling grid|uniformly spaced/);
  }
});

test("Odd FFT lengths double the last bin; even Nyquist bins are not doubled", () => {
  for (const size of [4, 5]) {
    const impulse = series([1, ...new Array(size - 1).fill(0)]);
    nearArray(analyze(impulse, impulse, size, basic).powerFirst, (size === 4 ? [1, 2, 1] : [1, 2, 2]).map((factor) => factor / (8 * size)));
  }
});

test("Every analysis control reruns the browser and updates displayed units", () => {
  const settings = { segmentLength: "128", window: "hamming", removeDC: false, average: "median", normalization: "spectrum", nanPolicy: "omit", lengthPolicy: "truncate" };
  for (const [id, value] of Object.entries(settings)) {
    const before = state.result;
    const control = elements.get(id);
    if (id === "removeDC") control.checked = value; else control.value = value;
    control.dispatch("change");
    assert.equal(state.lastError, null); assert.notEqual(state.result, before);
    assert.equal(state.result[id === "segmentLength" ? "size" : id === "window" ? "windowName" : id], id === "segmentLength" ? 128 : value);
  }
  assert.match(elements.get("powerPlotSubtitle").textContent, /spectrum/);
  assert.ok(!elements.get("statPeakDetail").textContent.includes("/Hz"));
  elements.get("segmentLength").value = "128.5"; elements.get("segmentLength").dispatch("change");
  assert.equal(state.result, null); assert.match(elements.get("statusText").textContent, /integer/);
});

test("NaN and unequal-length browser flow renders gaps, counts and linked cursors", () => {
  state.first = series([NaN, 2, 3, 4, 5, 6, 7, 8]); state.second = series([1, 2, 3, 4, 5, 6]);
  elements.get("segmentLength").value = "4";
  runAnalysis(); assert.equal(state.lastError, null);
  assert.equal(state.result.segments, 1); assert.equal(state.result.omittedSegments, 1);
  assert.equal(state.result.truncatedSamples, 2);
  assert.match(elements.get("validationContent").innerHTML, /1 NaNs/);
  near(state.result.timeSpan, 5 / 8);
  for (const id of ["powerPlot", "phasePlot", "coherencePlot", "timePlot"]) {
    elements.get(id).dispatch("pointermove", { clientX: 300 });
    assert.match(elements.get("cursorReadout").textContent, id === "timePlot" ? /^t / : /^f /);
    elements.get(id).dispatch("pointerleave");
    assert.equal(state.cursor, null);
  }
  elements.get("nanPolicy").value = "raise"; elements.get("nanPolicy").dispatch("change");
  assert.equal(state.result, null); assert.match(elements.get("statusText").textContent, /contains NaN/);
});

test("Time selection validates complete grids, then cuts an aligned inclusive range", () => {
  const a = series([0, 1, 2, 3, 4, 5, 6, 7], 2), b = series([0, 2, 4, 6, 8, 10, 12, 14], 2);
  const selected = analyze(a, b, 2, { ...basic, timeStart: 1.1, timeEnd: 2.6 });
  assert.equal(selected.timeSelection.indexBounds.start, 3); assert.equal(selected.timeSelection.indexBounds.endExclusive, 6); assert.equal(selected.timeSelection.indexBounds.endInclusive, 5);
  assert.deepEqual(selected.first.value, [3, 4, 5]);
  const badGrid = { ...b, time: b.time.slice() }; badGrid.time[7] += 0.1;
  assert.throws(() => analyze(a, badGrid, 4, { ...basic, timeStart: 0, timeEnd: 1 }), /same sampling grid|uniformly spaced/);
});

test("Frequency band requires available bins and constrains plots and comparison", () => {
  const result = analyze(series([1, 0, -1, 0, 1, 0, -1, 0]), series([0, 1, 0, -1, 0, 1, 0, -1]), 8, { ...basic, frequencyLow: 1.9, frequencyHigh: 2.1 });
  assert.deepEqual(Array.from(result.band.binIndices), [2]);
  assert.throws(() => analyze(series([1, 0, -1, 0]), series([0, 1, 0, -1]), 4, { ...basic, frequencyLow: 1.1, frequencyHigh: 1.9 }), /no available FFT bins/);
  state.first = series([1, 0, -1, 0, 1, 0, -1, 0]); state.second = series([0, 1, 0, -1, 0, 1, 0, -1]);
  elements.get("segmentLength").value = "8"; elements.get("frequencyLow").value = "1.9"; elements.get("frequencyHigh").value = "2.1"; runAnalysis();
  assert.equal(state.lastError, null); assert.match(elements.get("comparisonBody").innerHTML, /Integrated band power/); assert.match(elements.get("bandHint").textContent, /2/);
});

test("Invalid controls clear stale DOM output and disable run/export", () => {
  state.first = series([1, 0, -1, 0, 1, 0, -1, 0]); state.second = series([0, 1, 0, -1, 0, 1, 0, -1]);
  elements.get("segmentLength").value = "8"; elements.get("nanPolicy").value = "raise";
  elements.get("frequencyLow").value = "99"; elements.get("frequencyHigh").value = "100"; elements.get("frequencyLow").dispatch("change");
  assert.equal(state.result, null); assert.equal(elements.get("runAnalysis").disabled, true); assert.equal(elements.get("exportJson").disabled, true); assert.match(elements.get("comparisonBody").innerHTML, /Run an analysis/);
  elements.get("frequencyLow").value = ""; elements.get("frequencyHigh").value = ""; runAnalysis(); assert.equal(state.lastError, null);
});

test("Export keeps full spectral arrays and records effective selections and policies", () => {
  state.first = series([1, 0, -1, 0, 1, 0, -1, 0]); state.second = series([0, 1, 0, -1, 0, 1, 0, -1]);
  elements.get("segmentLength").value = "8"; elements.get("nanPolicy").value = "raise";
  elements.get("timeStart").value = ""; elements.get("timeEnd").value = ""; elements.get("frequencyLow").value = "0"; elements.get("frequencyHigh").value = "4"; runAnalysis();
  exportJSON(); assert.ok(lastDownload); const payload = JSON.parse(lastDownload.url.slice(5));
  assert.equal(payload.spectralArrays.frequency.length, state.result.frequency.length); assert.equal(payload.config.time.indexBounds.start, state.result.timeSelection.indexBounds.start); assert.equal(payload.config.time.indexBounds.endExclusive, state.result.timeSelection.indexBounds.endExclusive); assert.deepEqual(Array.from(payload.config.frequencyBand.binIndices), Array.from(state.result.band.binIndices)); assert.equal(payload.config.average, state.result.average); assert.match(payload.config.conventions.frequencyResolution, /not a statistical confidence interval/); assert.equal(payload.config.segmentStarts.omittedIndices.length, state.result.omittedSegmentStarts.length);
});

test("Invalid imports invalidate the previous analysis state", () => {
  readFile(0, { name: "bad.csv", text: "time,value,units\n0,not-a-number,counts\n" });
  assert.equal(state.first, null); assert.equal(state.result, null); assert.equal(elements.get("exportJson").disabled, true); assert.match(elements.get("statusText").textContent, /bad.csv.*invalid numeric/);
});

test("Successful CSV upload triggers analysis and export through FileReader", () => {
  elements.get("segmentLength").value = "4";
  for (const id of ["timeStart", "timeEnd", "frequencyLow", "frequencyHigh"]) elements.get(id).value = "";
  const csvA = "time,value,units\n0,1,counts\n0.125,0,counts\n0.25,-1,counts\n0.375,0,counts\n";
  const csvB = "time,value,units\n0,0,counts\n0.125,1,counts\n0.25,0,counts\n0.375,-1,counts\n";
  elements.get("fileFirst").dispatch("change", { target: { files: [{ name: "uploaded-a.csv", text: csvA }] } });
  elements.get("fileSecond").dispatch("change", { target: { files: [{ name: "uploaded-b.csv", text: csvB }] } });
  assert.equal(state.first.source, "uploaded-a.csv"); assert.equal(state.second.source, "uploaded-b.csv");
  assert.equal(state.result.nSamples, 4); assert.equal(state.result.segments, 1);
  exportJSON(); assert.ok(lastDownload);
  const payload = JSON.parse(lastDownload.url.slice(5));
  assert.deepEqual(payload.config.inputs.a.source, "uploaded-a.csv");
  assert.equal(payload.spectralArrays.frequency.length, state.result.frequency.length);
});

test("A stale asynchronous file read cannot overwrite a newer selection", () => {
  const pending = [];
  class DelayedReader {
    readAsText(file) { this.file = file; pending.push(this); }
  }
  sandbox.FileReader = DelayedReader;
  readFile(0, { name: "old.csv", text: "time,value,units\n0,1,c\n1,2,c\n" });
  readFile(0, { name: "new.csv", text: "time,value,units\n0,3,c\n1,4,c\n" });
  pending[0].result = pending[0].file.text; pending[0].onload();
  pending[1].result = pending[1].file.text; pending[1].onload();
  assert.equal(state.first.source, "new.csv");
  sandbox.FileReader = FakeFileReader;
});

test("Session roundtrip preserves stored arrays and rejects tampering before commit", () => {
  state.first = series([1, 0, -1, 0, 1, 0, -1, 0]);
  state.second = series([0, 1, 0, -1, 0, 1, 0, -1]);
  elements.get("segmentLength").value = "8";
  elements.get("frequencyLow").value = ""; elements.get("frequencyHigh").value = "";
  runAnalysis(); assert.equal(state.lastError, null);
  const original = JSON.stringify(state.result);
  sandbox.window.SpectralSession.mount({
    getState: () => state,
    configFromControls: sandbox.testAPI.configFromControls,
    getSegmentLength: () => elements.get("segmentLength").value,
    prepareAnalysis: sandbox.testAPI.prepareAnalysis,
    applyRestoredSession: sandbox.testAPI.applyRestoredSession,
    displayControlIds: ["plotLogFrequency"],
  });
  const saved = sandbox.window.SpectralSession.saveSession();
  state.result.powerFirst[1] = 999;
  const calls = sandbox.analysisCalls;
  sandbox.window.SpectralSession.restoreSession(saved);
  assert.equal(sandbox.analysisCalls, calls, "restore must never recompute spectra");
  assert.equal(JSON.stringify(state.result), original);
  const tampered = JSON.parse(saved); tampered.result.powerFirst[1] = -1;
  assert.throws(() => sandbox.window.SpectralSession.restoreSession(JSON.stringify(tampered)), /Power must be nonnegative/);
  assert.equal(JSON.stringify(state.result), original);
});

test("Log axes use decade labels and cursor inversion matches shared log frequency mapping", () => {
  const ticks = sandbox.testAPI.decadeTicks([-4, 2]);
  assert.ok(ticks.every((tick) => /^1e[-+]\d+$/.test(tick.label)));
  const axis = sandbox.testAPI.createPlotAxis([1, 10, 100], "log");
  near(axis.fromFraction(.5), 10); near(axis.toFraction(10), .5);
  const snapshot = JSON.stringify(state.result), calls = sandbox.analysisCalls;
  elements.get("plotLogFrequency").checked = true;
  elements.get("plotLogFrequency").dispatch("change");
  assert.equal(JSON.stringify(state.result), snapshot); assert.equal(sandbox.analysisCalls, calls);
  assert.match(elements.get("plotFrequencyNote").textContent, /DC.*omitted/);
  const plot = elements.get("powerPlot");
  plot.dispatch("keydown", { key: "Home", preventDefault() {} });
  assert.ok(state.cursor.value > 0); assert.equal(state.cursor.pinned, true);
  assert.match(elements.get("plotInspection").textContent, /A power.*B power.*cross.*phase.*coherence/);
  plot.dispatch("pointerleave"); assert.equal(state.cursor.pinned, true);
  plot.dispatch("keydown", { key: "Escape", preventDefault() {} }); assert.equal(state.cursor, null);
});

test("NaNs, signed zero, unequal lengths and display settings survive session roundtrip", () => {
  state.first = series([NaN, 2, 3, 4, 5, 6, 7, -0]);
  state.second = series([1, 0, 2, 1, 3, 2, 4, NaN, 3, 4]);
  elements.get("segmentLength").value = "4";
  elements.get("nanPolicy").value = "omit";
  elements.get("lengthPolicy").value = "truncate";
  runAnalysis(); assert.equal(state.lastError, null);
  const before = state.result;
  const saved = sandbox.window.SpectralSession.saveSession();
  assert.equal(JSON.parse(saved).first.value[0], null);
  elements.get("plotLogFrequency").checked = false;
  sandbox.window.SpectralSession.restoreSession(saved);
  assert.ok(Number.isNaN(state.first.value[0])); assert.ok(Object.is(state.first.value[7], -0));
  assert.equal(elements.get("plotLogFrequency").checked, true);
  for (const key of ["frequency", "powerFirst", "powerSecond", "crossReal", "crossImag", "phase", "coherence"]) {
    assert.equal(state.result[key].length, before[key].length);
    state.result[key].forEach((v, i) => assert.ok(Object.is(v, before[key][i])));
  }
  const reportText = (node) => [node.textContent || "", ...(node.children || []).map(reportText)].join(" ");
  assert.match(reportText(elements.get("assumptionsContent")), /Actual fs.*Nyquist.*Normalization.*B minus A/);
  elements.get("segmentLength").value = "bad";
  elements.get("segmentLength").dispatch("input");
  assert.equal(elements.get("saveSession").disabled, true);
  assert.match(reportText(elements.get("assumptionsContent")), /No stored analysis/);
});

const failures = checks.filter(([, passed]) => !passed);
checks.forEach(([name, passed, error]) => process.stdout.write(`${passed ? "✓" : "✗"} ${name}\n${error ? `${error}\n` : ""}`));
process.stdout.write(`${checks.length - failures.length}/${checks.length} checks passed\n`);
if (failures.length) process.exitCode = 1;
