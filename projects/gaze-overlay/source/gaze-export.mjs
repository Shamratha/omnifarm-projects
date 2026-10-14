import { computeAOIDwell, fixationAt, heatmapAt, sampleAt } from "./gaze-processing.mjs";

export const ANALYSIS_SCHEMA = "gaze-overlay.analysis";
export const ANALYSIS_VERSION = 1;
export const NORMALIZED_MAPPING_POLICY = "coordinate-preserving normalized x/y relative to sample-page content";

function clone(value) {
  return structuredClone(value);
}

function finiteOr(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Map normalized gaze to the visible sample-page content box.
 *
 * The default policy deliberately preserves normalized x/y. The source page's
 * aspect ratio is metadata only: x is relative to the target content width
 * and y is relative to its target content height. Coordinates outside 0..1
 * remain outside; callers may use displayX/displayY only for presentation.
 */
export function remapNormalizedPoint(point, {
  width = 1,
  height = 1,
  policy = NORMALIZED_MAPPING_POLICY,
} = {}) {
  if (policy !== NORMALIZED_MAPPING_POLICY) throw new RangeError(`Unsupported mapping policy: ${policy}`);
  const x = point?.x;
  const y = point?.y;
  const outside = Number.isFinite(x) && Number.isFinite(y) && (x < 0 || x > 1 || y < 0 || y > 1);
  return {
    x,
    y,
    pixelX: Number.isFinite(x) ? x * width : NaN,
    pixelY: Number.isFinite(y) ? y * height : NaN,
    displayX: Number.isFinite(x) ? Math.min(Math.max(x, 0), 1) : null,
    displayY: Number.isFinite(y) ? Math.min(Math.max(y, 0), 1) : null,
    outside,
    policy,
  };
}

export const mapNormalizedPoint = remapNormalizedPoint;

function segmentSummary(segments) {
  return segments.map((segment, index) => {
    const first = segment[0];
    const last = segment[segment.length - 1];
    return {
      index,
      startTimeMs: first.t,
      endTimeMs: last.t,
      durationMs: last.t - first.t,
      sampleCount: segment.length,
    };
  });
}

function normalizedFixation(fixation) {
  return fixation ? clone(fixation) : null;
}

/**
 * Build a seek-independent, JSON-safe analysis snapshot without changing any
 * recording, processed segment, fixation, or AOI objects supplied by callers.
 * generatedAt is supplied by the caller so the helper never reads the clock.
 */
export function buildAnalysisSummary({
  recording,
  processed,
  fixations = [],
  aois = [],
  settings = {},
  fixationSettings = {},
  currentTimeMs = 0,
  sourceName = "",
  smoothingEnabled = false,
  viewport = { width: 0, height: 0 },
  generatedAt,
  displayMode = "raw",
} = {}) {
  if (!recording || !processed) throw new TypeError("recording and processed are required");
  if (typeof generatedAt !== "string" || !Number.isFinite(Date.parse(generatedAt))) {
    throw new TypeError("generatedAt must be an ISO timestamp supplied by the caller");
  }
  const playbackTimeMs = Math.min(Math.max(finiteOr(currentTimeMs), 0), recording.duration);
  const completedFixations = heatmapAt(fixations, playbackTimeMs);
  const currentFixation = fixationAt(fixations, playbackTimeMs);
  const maxGapMs = finiteOr(settings.maxGapMs, 1000);
  const currentDwell = computeAOIDwell(processed, aois, playbackTimeMs, {
    maxGapMs,
    gapPolicy: "no-bridge",
  });
  const fullDwell = computeAOIDwell(processed, aois, recording.duration, {
    maxGapMs,
    gapPolicy: "no-bridge",
  });
  const minConfidence = finiteOr(settings.minConfidence, 0.7);
  const alpha = finiteOr(settings.alpha, 0.35);
  const radius = finiteOr(fixationSettings.radius, 0.06);
  const minDurationMs = finiteOr(fixationSettings.minDurationMs, 100);
  return {
    schema: ANALYSIS_SCHEMA,
    version: ANALYSIS_VERSION,
    generatedAt,
    units: { time: "ms", coordinates: "normalized sample-page x/y", fixationRadius: "normalized Euclidean distance" },
    policies: {
      calibration: "Assumed source calibration; no tracker calibration or accuracy verification performed",
      viewport: "Preserve normalized fractions, not DOM element positions after reflow; no scroll reconstruction",
      filtering: "Invalid coordinates/confidence and low confidence break continuity; missing confidence defaults to 1",
      time: "Milliseconds relative to earliest valid timestamp; last input row wins duplicate timestamps",
      gaps: "No bridging filtered rows or intervals strictly greater than maxGapMs; no endpoint holds",
      smoothing: "Segment-local EMA: first point unchanged; alpha * current + (1-alpha) * previous; reset per segment",
      fixations: "Raw points within radius of running sample-weighted centroid; failing point starts next run; duration last-first",
      activeFixation: "Offline full-run centroid and duration, including future samples within the current run",
      heatmap: "Completed fixations only; fixed duration color scale 0–1000 ms",
      dwell: "Exact raw linear path / inclusive rectangle time intersection; overlapping AOIs counted independently",
    },
    recordingMetadata: {
      title: clone(recording.title),
      participant: clone(recording.participant),
      sourceName,
      timeUnit: "ms",
      timeOriginMs: recording.timeOrigin,
      originalSampleCount: recording.stats.total,
    },
    playbackTimeMs,
    durationMs: recording.duration,
    viewportMapping: {
      policy: NORMALIZED_MAPPING_POLICY,
      coordinateSystem: "normalized sample-page content, top-left origin",
      renderedWidthPx: viewport.width,
      renderedHeightPx: viewport.height,
      outsideValuesRetained: true,
    },
    currentSample: {
      raw: clone(sampleAt(processed, playbackTimeMs)),
      smoothed: clone(sampleAt(processed, playbackTimeMs, { smoothed: true })),
    },
    settings: {
      minConfidence,
      smoothingEnabled: Boolean(smoothingEnabled),
      alpha,
      maxGapMs,
      displayMode: displayMode === "smoothed" && smoothingEnabled ? "smoothed" : "raw",
      units: { minConfidence: "normalized 0–1", smoothingEnabled: "boolean", alpha: "unitless 0–1", maxGapMs: "ms" },
    },
    fixationSettings: {
      radius,
      minDurationMs,
      units: { radius: "normalized units", minDurationMs: "ms" },
    },
    sampleStats: {
      inputCount: recording.stats.total,
      normalizedCount: recording.samples.length,
      duplicateTimeCount: recording.stats.total - recording.stats.invalidTime - recording.samples.length,
      acceptedCount: processed.stats.accepted,
      acceptedThroughPlaybackCount: processed.segments.reduce((count, segment) => count + segment.filter((point) => point.t <= playbackTimeMs).length, 0),
      invalidTimeCount: recording.stats.invalidTime,
      invalidCoordinatesCount: processed.stats.invalidCoordinates,
      invalidConfidenceCount: processed.stats.invalidConfidence,
      lowConfidenceCount: processed.stats.lowConfidence,
      segmentCount: processed.segments.length,
    },
    segments: segmentSummary(processed.segments),
    fixations: clone(fixations),
    fixationCount: fixations.length,
    completedFixationCount: completedFixations.length,
    currentFixation: normalizedFixation(currentFixation),
    fullSession: {
      sampleCount: recording.stats.total,
      acceptedSampleCount: processed.stats.accepted,
      segmentCount: processed.segments.length,
      fixationCount: fixations.length,
      heatmapPointCount: fixations.length,
    },
    heatmap: {
      points: clone(completedFixations),
      count: completedFixations.length,
      intensityUnit: "ms",
      intensityScaleMaxMs: 1000,
    },
    aois: clone(aois),
    aoiDwell: {
      currentTimeMs: playbackTimeMs,
      currentTime: clone(currentDwell),
      fullDuration: clone(fullDwell),
      units: "ms",
    },
  };
}

export function buildExportPayload(options) {
  if (!options?.recording) throw new TypeError("recording is required");
  return {
    recording: clone(options.recording.original),
    analysis: buildAnalysisSummary(options),
  };
}
