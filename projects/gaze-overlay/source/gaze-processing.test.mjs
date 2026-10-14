import test from "node:test";
import assert from "node:assert/strict";
import { normalizeRecording, processRecording, sampleAt } from "./gaze-processing.mjs";

const row = (t, x = 0.5, y = 0.5, confidence = 1) => ({ t, x, y, confidence });
const process = (samples, options) => processRecording(normalizeRecording(samples), options);

function close(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
}

function point(actual, expected) {
  assert.notEqual(actual, null);
  assert.deepEqual(Object.keys(actual).sort(), ["confidence", "outside", "x", "y"]);
  close(actual.x, expected.x);
  close(actual.y, expected.y);
  close(actual.confidence, expected.confidence);
  assert.equal(actual.outside, expected.outside);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

test("seconds, nonzero origin, sorting, metadata, and invalid-coordinate origin", () => {
  const payload = {
    title: "Session", participant: "P1", timeUnit: "seconds",
    samples: [row(12.5, 0.8), row(10, null), row(11.25, 0.2)],
  };
  const recording = normalizeRecording(payload);
  assert.equal(recording.timeOrigin, 10000);
  assert.equal(recording.duration, 2500);
  assert.deepEqual(recording.samples.map(({ t }) => t), [0, 1250, 2500]);
  assert.equal(recording.samples[0].x, null);
  assert.equal(recording.title, "Session");
  assert.equal(recording.participant, "P1");
  assert.deepEqual(recording.stats, { total: 3, invalidTime: 0 });
  assert.deepEqual(recording.original, payload);
  assert.notEqual(recording.original, payload);
  const processed = processRecording(recording, { maxGapMs: 1250 });
  assert.equal(processed.duration, 2500);
  assert.equal(sampleAt(processed, 1000), null);
  point(sampleAt(processed, 1875), { x: 0.5, y: 0.5, confidence: 1, outside: false });
});

test("all collection, time, coordinate, confidence, and metadata aliases", () => {
  const rows = [
    { timestamp: 3, gazeX: 0.2, gazeY: 0.4, score: 0.8 },
    { time: 4, normalizedX: 0.6, normalizedY: 0.8 },
  ];
  for (const key of ["samples", "data", "gaze"]) {
    for (const unit of ["ms", "s", "sec", "seconds"]) {
      const result = normalizeRecording({ [key]: rows, timestampUnit: unit, name: "Alias" });
      assert.equal(result.duration, unit === "ms" ? 1 : 1000);
      assert.equal(result.timeOrigin, unit === "ms" ? 3 : 3000);
      assert.deepEqual(result.samples.map(({ x, y, confidence }) => [x, y, confidence]),
        [[0.2, 0.4, 0.8], [0.6, 0.8, 1]]);
      assert.equal(result.title, "Alias");
    }
  }
  const result = normalizeRecording(rows);
  assert.equal(result.duration, 1);
  assert.equal(result.title, "Imported session");
  assert.equal(result.participant, "");
});

test("strict finite timestamps: no coercion, fallback past invalid values, or synthetic times", () => {
  const invalid = [undefined, null, "10", NaN, Infinity, -Infinity, true, {}, []];
  const result = normalizeRecording([
    ...invalid.map((t) => row(t)), null, {},
    { t: null, timestamp: 100, x: 0.5, y: 0.5 },
    row(-10), row(-9.5),
  ]);
  assert.deepEqual(result.stats, { total: 14, invalidTime: 12 });
  assert.equal(result.timeOrigin, -10);
  assert.equal(result.duration, 0.5);
  assert.deepEqual(result.samples.map(({ t }) => t), [0, 0.5]);
  for (const payload of [[], [row("1")], [row(NaN)], [{}]]) {
    assert.throws(() => normalizeRecording(payload), /no valid timestamps/i);
  }
  for (const payload of [null, {}, { samples: "bad" }]) {
    assert.throws(() => normalizeRecording(payload), /array/);
  }
});

test("unknown units and unrepresentable millisecond times are rejected", () => {
  for (const timeUnit of ["minutes", "milliseconds", "", "S", null, 1000]) {
    assert.throws(() => normalizeRecording({ timeUnit, samples: [row(1)] }), /time unit/);
  }
  assert.throws(() => normalizeRecording({ timeUnit: "s", samples: [row(Number.MAX_VALUE)] }),
    /no valid timestamps/);
  assert.throws(() => normalizeRecording([row(-Number.MAX_VALUE), row(Number.MAX_VALUE)]),
    /duration/);
});

test("first defined alias wins, and confidence defaults only when missing", () => {
  const result = normalizeRecording([
    { t: 0, timestamp: 500, x: null, gazeX: 0.5, y: 0.5, confidence: null, score: 1 },
    { t: 1, x: 0.5, y: 0.5, confidence: undefined, score: 0.8 },
    { t: 2, x: 0.5, y: 0.5 },
    { t: 3, x: 0.5, y: 0.5, confidence: 0 },
  ]);
  assert.equal(result.samples[0].t, 0);
  assert.equal(result.samples[0].x, null);
  assert.deepEqual(result.samples.map(({ confidence }) => confidence), [null, 0.8, 1, 0]);
});

test("fractional timestamps interpolate without rounding or a minimum time denominator", () => {
  const processed = process([row(100.25, 0.2, 0.8, 0.8), row(100.75, 0.6, 0.4, 1)]);
  point(sampleAt(processed, 0.125), { x: 0.3, y: 0.7, confidence: 0.85, outside: false });
  point(sampleAt(processed, 0.5), { x: 0.6, y: 0.4, confidence: 1, outside: false });
  for (const time of [-0.001, 0.501, NaN, Infinity, "0", null]) {
    assert.equal(sampleAt(processed, time), null);
  }
});

test("hand-calculated EMA sequence and interpolation between precomputed EMA points", () => {
  const processed = process([row(0, 0, 1), row(10, 1, 0), row(20, 0, 1)], { alpha: 0.5 });
  assert.deepEqual(processed.segments[0].map(({ smoothX, smoothY }) => [smoothX, smoothY]),
    [[0, 1], [0.5, 0.5], [0.25, 0.75]]);
  point(sampleAt(processed, 15, { smoothed: true }),
    { x: 0.375, y: 0.625, confidence: 1, outside: false });
  point(sampleAt(processed, 15), { x: 0.5, y: 0.5, confidence: 1, outside: false });
  const defaults = process([row(0, 0, 1), row(10, 1, 0), row(20, 0, 1)]);
  close(defaults.segments[0][1].smoothX, 0.35);
  close(defaults.segments[0][2].smoothX, 0.2275);
  close(defaults.segments[0][2].smoothY, 0.7725);
});

test("gap threshold is strict, inclusive endpoints remain visible, and EMA resets", () => {
  const processed = process([
    row(0, 0), row(1000, 1), row(2000.25, 0.8), row(3000.25, 0.4),
  ], { alpha: 0.5 });
  assert.deepEqual(processed.segments.map((segment) => segment.map(({ t }) => t)),
    [[0, 1000], [2000.25, 3000.25]]);
  close(processed.segments[1][0].smoothX, 0.8);
  close(processed.segments[1][1].smoothX, 0.6);
  for (const time of [0, 500, 1000, 2000.25, 2500, 3000.25]) {
    assert.notEqual(sampleAt(processed, time), null);
  }
  for (const time of [1000.001, 1500, 2000.249]) assert.equal(sampleAt(processed, time), null);
  assert.equal(process([row(0), row(1)], { maxGapMs: 0 }).segments.length, 2);
});

test("each rejected row is a barrier, with exclusive counts and EMA reset", () => {
  const processed = process([
    row(0, 0), row(10, null, 0.5, null), row(20, 1),
    row(30, 0.5, 0.5, null), row(40, 0.2),
    row(50, 0.5, 0.5, 0.69), row(60, 0.8, 0.5, 0.7),
  ]);
  assert.deepEqual(processed.stats,
    { accepted: 4, invalidCoordinates: 1, invalidConfidence: 1, lowConfidence: 1 });
  assert.deepEqual(processed.segments.map((segment) => segment.length), [1, 1, 1, 1]);
  for (const time of [5, 10, 15, 25, 30, 35, 45, 50, 55]) {
    assert.equal(sampleAt(processed, time), null);
  }
  for (const segment of processed.segments) {
    const first = segment[0];
    assert.equal(first.smoothX, first.x);
    assert.equal(first.smoothY, first.y);
    assert.notEqual(sampleAt(processed, first.t), null);
  }
});

test("all-filtered recordings retain full duration and return null at every seek", () => {
  const processed = process([row(50, null), row(60, 0.5, 0.5, NaN), row(70, 0.5, 0.5, 0.1)]);
  assert.equal(processed.duration, 20);
  assert.deepEqual(processed.segments, []);
  assert.deepEqual(processed.stats,
    { accepted: 0, invalidCoordinates: 1, invalidConfidence: 1, lowConfidence: 1 });
  for (const time of [-1, 0, 5, 10, 20, 21]) assert.equal(sampleAt(processed, time), null);
});

test("single sample has zero duration, no synthetic samples, and exact-only visibility", () => {
  const recording = normalizeRecording([row(123.5, 0.2, 0.3, 0.9)]);
  assert.equal(recording.timeOrigin, 123.5);
  assert.equal(recording.duration, 0);
  assert.equal(recording.samples.length, 1);
  const processed = processRecording(recording);
  assert.equal(processed.segments[0].length, 1);
  point(sampleAt(processed, 0, { smoothed: true }),
    { x: 0.2, y: 0.3, confidence: 0.9, outside: false });
  for (const time of [-Number.EPSILON, Number.EPSILON, 123.5]) {
    assert.equal(sampleAt(processed, time), null);
  }
});

test("invalid leading and trailing rows do not extend an accepted singleton", () => {
  const processed = process([row(10, null), row(20), row(30, 0.5, 0.5, null)]);
  assert.equal(processed.duration, 20);
  for (const time of [0, 9.999, 10.001, 20]) assert.equal(sampleAt(processed, time), null);
  assert.notEqual(sampleAt(processed, 10), null);
});

test("coordinates and confidence must be numeric and finite; confidence is not clamped", () => {
  const invalid = [null, undefined, "0.5", true, NaN, Infinity, -Infinity, {}, []];
  for (const field of ["x", "y"]) {
    for (const value of invalid) {
      const processed = process([{ ...row(0), [field]: value }]);
      assert.equal(processed.stats.invalidCoordinates, 1);
      assert.deepEqual(processed.segments, []);
    }
  }
  for (const confidence of [...invalid.filter((v) => v !== undefined), -0.1, 1.1]) {
    const processed = process([{ ...row(0), confidence }]);
    assert.equal(processed.stats.invalidConfidence, 1);
  }
  assert.equal(process([row(0, 0.5, 0.5, 0)], { minConfidence: 0 }).stats.accepted, 1);
});

test("finite outside coordinates are accepted, and viewport boundaries are inside", () => {
  for (const [x, y, outside] of [
    [-0.1, 0.5, true], [1.1, 0.5, true], [0.5, -0.1, true], [0.5, 1.1, true],
    [0, 0, false], [1, 1, false], [Number.MAX_VALUE, 0.5, true],
  ]) {
    const processed = process([row(0, x, y)]);
    assert.equal(processed.stats.accepted, 1);
    point(sampleAt(processed, 0), { x, y, confidence: 1, outside });
  }
});

test("outside is based on raw interpolation rather than endpoint flags or smoothed position", () => {
  const processed = process([row(0, 0.5), row(10, 1.5), row(20, 0.5)], { alpha: 0.1 });
  point(sampleAt(processed, 5), { x: 1, y: 0.5, confidence: 1, outside: false });
  point(sampleAt(processed, 7.5, { smoothed: true }),
    { x: 0.575, y: 0.5, confidence: 1, outside: true });
  point(sampleAt(processed, 10, { smoothed: true }),
    { x: 0.6, y: 0.5, confidence: 1, outside: true });
  assert.equal(sampleAt(processed, 15).outside, false);
  const returning = process([row(0, 1.5), row(10, 0.5)], { alpha: 0.1 });
  point(sampleAt(returning, 10, { smoothed: true }),
    { x: 1.4, y: 0.5, confidence: 1, outside: false });
});

test("explicit outside flags are strict booleans and held from left until exact right", () => {
  for (const flag of [{ outsideViewport: true }, { outside: true }, { inViewport: false },
    { explicitOutside: true }]) {
    const processed = process([row(0), { ...row(10), ...flag }, row(20)]);
    assert.equal(sampleAt(processed, 9.999).outside, false);
    assert.equal(sampleAt(processed, 10).outside, true);
    assert.equal(sampleAt(processed, 19.999, { smoothed: true }).outside, true);
    assert.equal(sampleAt(processed, 20).outside, false);
    assert.equal(processed.segments[0][1].explicitOutside, true);
  }
  assert.equal(sampleAt(process([{ ...row(0), outside: "true", inViewport: 0 }]), 0).outside, false);
});

test("duplicate timestamps deterministically use the last input row, including barriers", () => {
  const payload = [row(20, 0.2), row(10, 0.1), row(20, 0.9), row(30), row(20, null)];
  const recording = normalizeRecording(payload);
  assert.deepEqual(recording.stats, { total: 5, invalidTime: 0 });
  assert.deepEqual(recording.samples.map(({ t, x }) => [t, x]), [[0, 0.1], [10, null], [20, 0.5]]);
  const processed = processRecording(recording);
  assert.equal(processed.stats.invalidCoordinates, 1);
  assert.equal(processed.segments.length, 2);
  assert.equal(sampleAt(processed, 10), null);
  const replaced = process([...payload, row(20, 0.8)]);
  assert.equal(replaced.segments.length, 1);
  assert.equal(sampleAt(replaced, 10).x, 0.8);
  assert.equal(normalizeRecording([row(5), row(5, 0.8)]).duration, 0);
});

test("option boundaries are supported and malformed options fail explicitly", () => {
  const samples = [row(0, 0), row(10, 1)];
  assert.equal(process(samples, { alpha: 0 }).segments[0][1].smoothX, 0);
  assert.equal(process(samples, { alpha: 1 }).segments[0][1].smoothX, 1);
  for (const key of ["alpha", "minConfidence"]) {
    for (const value of [-0.1, 1.1, NaN, Infinity, null, "0.5"]) {
      assert.throws(() => process(samples, { [key]: value }), RangeError);
    }
  }
  for (const maxGapMs of [-1, NaN, Infinity, null, "1000"]) {
    assert.throws(() => process(samples, { maxGapMs }), RangeError);
  }
});

test("deep frozen inputs stay untouched; processing and arbitrary repeated seeks are deterministic", () => {
  const payload = deepFreeze({
    title: "Frozen", participant: "P2", timeUnit: "s", extra: { nested: [1, { keep: true }] },
    samples: [row(6, 1.2, 0.4), row(5, 0.2, 0.8), row(7, null), row(8, 0.7, 0.3)],
  });
  const before = structuredClone(payload);
  const recording = normalizeRecording(payload);
  assert.notEqual(recording.original.samples, payload.samples);
  assert.notEqual(recording.original.extra.nested[1], payload.extra.nested[1]);
  assert.deepEqual(recording.original, before);
  deepFreeze(recording);
  const normalizedBefore = structuredClone(recording);
  const processed = deepFreeze(processRecording(recording));
  const processedBefore = structuredClone(processed);
  const times = [3000, 0, 750, 1500, 1000, 500, -1, 3001, 2000];
  const expected = times.map((time) => sampleAt(processed, time, { smoothed: true }));
  for (let repeat = 0; repeat < 3; repeat += 1) {
    assert.deepEqual(processRecording(recording), processed);
    for (let i = times.length - 1; i >= 0; i -= 1) {
      assert.deepEqual(sampleAt(processed, times[i], { smoothed: true }), expected[i]);
    }
  }
  const returned = sampleAt(processed, 0);
  returned.x = 99;
  assert.equal(sampleAt(processed, 0).x, 0.2);
  assert.deepEqual(payload, before);
  assert.deepEqual(recording, normalizedBefore);
  assert.deepEqual(processed, processedBefore);
  assert.deepEqual(normalizeRecording(payload), recording);
});
