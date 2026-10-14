import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeRecording, processRecording, analyzeFixations, fixationAt, heatmapAt, computeAOIDwell,
} from "./gaze-processing.mjs";

const row = (t, x = 0.5, y = 0.5, confidence = 1) => ({ t, x, y, confidence });
const process = (samples, options) => processRecording(normalizeRecording(samples), options);
const viewport = { id: "screen", label: "Screen", x: 0, y: 0, width: 1, height: 1 };
const dwell = (processed, time, options) => computeAOIDwell(processed, [viewport], time, options)[0].dwellMs;

function close(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

test("fixation radius is inclusive, closes before a violation, and uses raw coordinates", () => {
  const processed = process([
    row(0, 0), row(100, 0.125), row(200, 0.25), row(300, 0.25),
  ], { alpha: 0 });
  assert.deepEqual(analyzeFixations(processed, { radius: 0.125 }), [
    { start: 0, end: 100, durationMs: 100, x: 0.0625, y: 0.5, sampleCount: 2 },
    { start: 200, end: 300, durationMs: 100, x: 0.25, y: 0.5, sampleCount: 2 },
  ]);
  // EMA is constant, but raw points are too far apart for the default radius.
  assert.equal(analyzeFixations(processed).length, 1);
});

test("running centroid allows movement beyond the first point's radius", () => {
  const fixations = analyzeFixations(process([
    row(0, 0), row(100, 0.125), row(200, 0.1875),
  ]), { radius: 0.125 });
  assert.equal(fixations.length, 1);
  assert.equal(fixations[0].sampleCount, 3);
  close(fixations[0].x, 5 / 48);
  assert.equal(fixations[0].durationMs, 200);
});

test("each accepted point is compared with the current running centroid", () => {
  const fixations = analyzeFixations(process([
    row(0, 0), row(100, 0.25), row(200, 0.375), row(300, 0.4375),
  ]), { radius: 0.25, minDurationMs: 0 });
  assert.deepEqual(fixations.map(({ start, end, sampleCount }) => [start, end, sampleCount]),
    [[0, 300, 4]]);
});

test("radius uses Euclidean distance in both axes", () => {
  const processed = process([row(0, 0, 0), row(100, 0.1, 0.1)]);
  assert.deepEqual(analyzeFixations(processed, { radius: 0.125 }), []);
  assert.equal(analyzeFixations(processed, { radius: 0.15 }).length, 1);
});

test("minimum dwell is inclusive; singleton duration is zero", () => {
  assert.deepEqual(analyzeFixations(process([row(0), row(99)])), []);
  assert.equal(analyzeFixations(process([row(0), row(100)]))[0].durationMs, 100);
  const singleton = process([row(0)]);
  assert.deepEqual(analyzeFixations(singleton), []);
  assert.deepEqual(analyzeFixations(singleton, { radius: 0, minDurationMs: 0 }), [
    { start: 0, end: 0, durationMs: 0, x: 0.5, y: 0.5, sampleCount: 1 },
  ]);
});

test("fixations never bridge rejected rows or gaps, with strict gap threshold", () => {
  const processed = process([
    row(0), row(1000), row(2001), row(2101), row(2150, null),
    row(2200), row(2300), row(2350, 0.5, 0.5, 0.1), row(2400), row(2500),
    row(2550, 0.5, 0.5, null), row(2600), row(2700),
  ], { maxGapMs: 5000 });
  assert.deepEqual(analyzeFixations(processed).map(({ start, end }) => [start, end]),
    [[0, 1000], [2001, 2101], [2200, 2300], [2400, 2500], [2600, 2700]]);
  const split = process([row(0), row(100), row(301), row(401)], { maxGapMs: 200 });
  assert.deepEqual(analyzeFixations(split, { maxGapMs: 5000 }).map(({ durationMs }) => durationMs),
    [100, 100]);
  assert.deepEqual(analyzeFixations(process([row(0), row(100)]), { maxGapMs: 99 }), []);
});

test("heatmap includes only completed fixations with stable duration weights", () => {
  const fixations = analyzeFixations(process([
    row(0), row(100), row(150, null), row(200), row(400),
  ]));
  assert.deepEqual(heatmapAt(fixations, -1), []);
  assert.deepEqual(heatmapAt(fixations, 99), []);
  const first = { ...fixations[0], intensity: 100 };
  assert.deepEqual(heatmapAt(fixations, 100), [first]);
  assert.deepEqual(heatmapAt(fixations, 399), [first]);
  assert.deepEqual(heatmapAt(fixations, 400), [first, { ...fixations[1], intensity: 200 }]);
  assert.deepEqual(heatmapAt(fixations, 1000), heatmapAt(fixations, 400));
});

test("current fixation has inclusive bounds and no holds into gaps", () => {
  const fixations = analyzeFixations(process([
    row(0), row(100), row(150, null), row(200), row(300),
  ]));
  for (const time of [0, 50, 100]) assert.deepEqual(fixationAt(fixations, time), fixations[0]);
  for (const time of [200, 250, 300]) assert.deepEqual(fixationAt(fixations, time), fixations[1]);
  for (const time of [-1, 101, 199, 301]) assert.equal(fixationAt(fixations, time), null);
  const singleton = analyzeFixations(process([row(0)]), { minDurationMs: 0 });
  assert.deepEqual(fixationAt(singleton, 0), singleton[0]);
  assert.equal(fixationAt(singleton, 0.01), null);
});

test("AOI dwell integrates 0,100,200 to 200ms and clips partial playback intervals", () => {
  const processed = process([row(0), row(100), row(200)]);
  for (const [time, expected] of [[-0.001, 0], [0, 0], [50, 50], [100, 100], [150, 150], [200, 200], [999, 200]]) {
    assert.equal(dwell(processed, time), expected);
  }
  assert.deepEqual(computeAOIDwell(processed, [viewport], 200),
    [{ id: "screen", label: "Screen", dwellMs: 200 }]);
  const leadingBarrier = process([row(0, null), row(100), row(200)]);
  assert.equal(dwell(leadingBarrier, 99.999), 0);
  assert.equal(dwell(leadingBarrier, 100), 0);
  assert.equal(dwell(leadingBarrier, 200), 100);
});

test("AOIs use exact raw line intersections and inclusive rectangle edges", () => {
  const processed = process([row(0, 0, 0), row(100, 1, 1), row(200, 1, 0)], { alpha: 0 });
  const aois = [
    { id: "left", label: "Left", x: 0, y: 0, width: 0.5, height: 0.5 },
    { id: "right", label: "Right", x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
    { id: "miss", label: "Miss", x: 0, y: 0.6, width: 1, height: 0.4 },
    { id: "point", label: "Point", x: 0.5, y: 0.5, width: 0, height: 0 },
  ];
  // The first diagonal spends 50ms in each half; the vertical second interval
  // spends 50ms in the right AOI and another 40ms in the upper strip.
  assert.deepEqual(computeAOIDwell(processed, aois, 200).map(({ dwellMs }) => dwellMs),
    [50, 100, 80, 0]);
  assert.deepEqual(computeAOIDwell(processed, aois, 25).map(({ dwellMs }) => dwellMs),
    [25, 0, 0, 0]);
  // Accepted outside coordinates are not clamped into the viewport.
  assert.equal(dwell(process([row(0, 2), row(100, 2)]), 100), 0);
});

test("AOI dwell never bridges filtered rows or long gaps or extends singletons", () => {
  const processed = process([
    row(0), row(100), row(150, null), row(200), row(300),
    row(350, 0.5, 0.5, 0.1), row(400), row(500),
    row(550, 0.5, 0.5, null), row(600), row(1600), row(2601), row(2701),
  ], { maxGapMs: 5000 });
  assert.equal(dwell(processed, 9999), 1400); // 100 + 100 + 100 + 1000 + 100
  assert.equal(dwell(processed, 9999, { maxGapMs: 100 }), 400);
  const split = process([row(0), row(100), row(301), row(401)], { maxGapMs: 200 });
  assert.equal(dwell(split, 9999, { maxGapMs: 5000 }), 200);
  assert.equal(dwell(process([row(0)]), 1000), 0);
  assert.equal(dwell(process([row(0), row(100)]), 100, { maxGapMs: 0 }), 0);
});

test("empty accepted data and nonfinite playback queries return empty analytics", () => {
  const empty = process([row(0, null), row(100, 0.5, 0.5, 0)]);
  assert.deepEqual(analyzeFixations(empty), []);
  assert.deepEqual(heatmapAt([], 100), []);
  assert.equal(fixationAt([], 100), null);
  assert.equal(dwell(empty, 100), 0);
  assert.deepEqual(computeAOIDwell(empty, [], 100), []);
  const processed = process([row(0), row(100)]);
  const fixations = analyzeFixations(processed);
  for (const time of [NaN, Infinity, -Infinity, null, "100"]) {
    assert.deepEqual(heatmapAt(fixations, time), []);
    assert.equal(fixationAt(fixations, time), null);
    assert.equal(dwell(processed, time), 0);
  }
});

test("invalid thresholds and unsupported gap policies fail explicitly", () => {
  const processed = process([row(0), row(100)]);
  for (const key of ["radius", "minDurationMs", "maxGapMs"]) {
    for (const value of [-1, NaN, Infinity, null, "100"]) {
      assert.throws(() => analyzeFixations(processed, { [key]: value }), RangeError);
      if (key === "maxGapMs") assert.throws(() => dwell(processed, 100, { [key]: value }), RangeError);
    }
  }
  assert.throws(() => dwell(processed, 100, { gapPolicy: "bridge" }), /gapPolicy/);
});

test("frozen inputs, arbitrary seek order, repeated calls, and returned copies never double count", () => {
  const processed = deepFreeze(process([
    row(0), row(100), row(150, null), row(200), row(400),
  ]));
  const fixations = deepFreeze(analyzeFixations(processed));
  const aois = deepFreeze([viewport]);
  const before = structuredClone({ processed, fixations, aois });
  const cases = [[400, 300, 2], [50, 50, 0], [300, 200, 1], [-1, 0, 0], [100, 100, 1], [150, 100, 1]];
  for (let repeat = 0; repeat < 3; repeat += 1) {
    for (const [time, expectedDwell, completed] of cases) {
      assert.equal(computeAOIDwell(processed, aois, time)[0].dwellMs, expectedDwell);
      assert.equal(heatmapAt(fixations, time).length, completed);
      assert.deepEqual(analyzeFixations(processed), fixations);
    }
  }
  heatmapAt(fixations, 400)[0].x = 99;
  fixationAt(fixations, 50).x = 99;
  computeAOIDwell(processed, aois, 400)[0].dwellMs = 99;
  assert.equal(heatmapAt(fixations, 400)[0].x, 0.5);
  assert.equal(fixationAt(fixations, 50).x, 0.5);
  assert.equal(computeAOIDwell(processed, aois, 400)[0].dwellMs, 300);
  assert.deepEqual({ processed, fixations, aois }, before);
});
