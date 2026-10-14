import test from "node:test";
import assert from "node:assert/strict";
import { normalizeRecording, processRecording, analyzeFixations } from "./gaze-processing.mjs";
import { buildAnalysisSummary, buildExportPayload, remapNormalizedPoint, NORMALIZED_MAPPING_POLICY } from "./gaze-export.mjs";

const payload = { title: "Test", participant: "P1", timeUnit: "ms", extra: { keep: true }, samples: [
  { t: 0, x: 0.2, y: 0.2, confidence: 1 },
  { t: 100, x: 0.2, y: 0.2, confidence: 1 },
  { t: 200, x: 0.8, y: 0.8, confidence: 1 },
] };

test("normalized remapping preserves raw coordinates and only clamps presentation values", () => {
  const mapped = remapNormalizedPoint({ x: 1.25, y: -0.2 }, { width: 800, height: 400 });
  assert.equal(mapped.policy, NORMALIZED_MAPPING_POLICY);
  assert.deepEqual([mapped.x, mapped.y, mapped.pixelX, mapped.pixelY], [1.25, -0.2, 1000, -80]);
  assert.deepEqual([mapped.displayX, mapped.displayY, mapped.outside], [1, 0, true]);
});

test("resizing remaps pixel position without changing normalized coordinates", () => {
  const source = Object.freeze({ x: 0.25, y: 0.75 });
  const wide = remapNormalizedPoint(source, { width: 800, height: 400 });
  const tall = remapNormalizedPoint(source, { width: 400, height: 800 });
  assert.deepEqual([wide.pixelX, wide.pixelY], [200, 300]);
  assert.deepEqual([tall.pixelX, tall.pixelY], [100, 600]);
  assert.deepEqual([wide.x, wide.y, tall.x, tall.y], [0.25, 0.75, 0.25, 0.75]);
  assert.deepEqual(source, { x: 0.25, y: 0.75 });
});

test("analysis summary includes current and full-session results without mutating input", () => {
  const before = structuredClone(payload);
  const recording = normalizeRecording(payload);
  const processed = processRecording(recording, { minConfidence: 0.7, alpha: 0.35, maxGapMs: 1000 });
  const fixations = analyzeFixations(processed, { radius: 0.06, minDurationMs: 0, maxGapMs: 1000 });
  const options = { recording, processed, fixations, aois: [{ id: "a", label: "A", x: 0, y: 0, width: 0.5, height: 0.5 }], settings: { minConfidence: 0.7, alpha: 0.35, maxGapMs: 1000 }, fixationSettings: { radius: 0.06, minDurationMs: 0 }, currentTimeMs: 100, sourceName: "test", smoothingEnabled: true, generatedAt: "2026-01-01T00:00:00.000Z" };
  const summary = buildAnalysisSummary(options);
  assert.equal(summary.schema, "gaze-overlay.analysis");
  assert.equal(summary.playbackTimeMs, 100);
  assert.equal(summary.durationMs, 200);
  assert.equal(summary.completedFixationCount, 1);
  assert.equal(summary.heatmap.count, 1);
  assert.equal(summary.fullSession.heatmapPointCount, summary.fixationCount);
  assert.equal(summary.aoiDwell.fullDuration[0].dwellMs, 150);
  assert.equal(summary.settings.smoothingEnabled, true);
  assert.deepEqual(summary.viewportMapping, {
    policy: NORMALIZED_MAPPING_POLICY,
    coordinateSystem: "normalized sample-page content, top-left origin",
    renderedWidthPx: 0,
    renderedHeightPx: 0,
    outsideValuesRetained: true,
  });
  assert.deepEqual(payload, before);
});

test("export summary is deterministic for analytics when seeking in different orders", () => {
  const recording = normalizeRecording(payload);
  const processed = processRecording(recording, { minConfidence: 0.7, alpha: 0.35, maxGapMs: 1000 });
  const fixations = analyzeFixations(processed, { radius: 0.06, minDurationMs: 0 });
  const options = { recording, processed, fixations, aois: [], settings: { minConfidence: 0.7, alpha: 0.35, maxGapMs: 1000 }, fixationSettings: { radius: 0.06, minDurationMs: 0 }, generatedAt: "2026-01-01T00:00:00.000Z" };
  const first = buildAnalysisSummary({ ...options, currentTimeMs: 200 });
  buildAnalysisSummary({ ...options, currentTimeMs: 0 });
  const second = buildAnalysisSummary({ ...options, currentTimeMs: 200 });
  assert.deepEqual(first, second);
});

test("export retains original payload and adds analysis separately", () => {
  const recording = normalizeRecording(payload);
  const processed = processRecording(recording);
  const exported = buildExportPayload({ recording, processed, settings: { minConfidence: 0.7, alpha: 0.35, maxGapMs: 1000 }, fixationSettings: { radius: 0.06, minDurationMs: 100 }, currentTimeMs: 0, generatedAt: "2026-01-01T00:00:00.000Z" });
  assert.deepEqual(exported.recording, payload);
  assert.notEqual(exported.recording, payload);
  assert.equal(exported.analysis.durationMs, 200);
});

test("summary rejects an omitted clock value so time generation stays outside the pure helper", () => {
  const recording = normalizeRecording(payload);
  const processed = processRecording(recording);
  assert.throws(() => buildAnalysisSummary({ recording, processed }), /generatedAt/);
});
