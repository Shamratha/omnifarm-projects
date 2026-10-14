// Pure recording transforms. Times are milliseconds; coordinates are never clamped.

// First defined alias wins. Null is an explicit invalid value, not missing data.
function alias(source, keys) {
  for (const key of keys) {
    if (source?.[key] !== undefined) return source[key];
  }
  return undefined;
}

function outsideCoordinates(x, y) {
  return x < 0 || x > 1 || y < 0 || y > 1;
}

/**
 * Clone a recording and normalize its timestamped rows, retaining filter barriers.
 * Units default to ms; timeUnit (or timestampUnit) accepts ms, s, sec, seconds.
 * Duplicate timestamps use the LAST input row, even if that row is invalid.
 * stats.total counts all input rows; invalidTime counts rows discarded for time.
 * The origin and duration include rows with invalid coordinates or confidence.
 */
export function normalizeRecording(payload) {
  const original = structuredClone(payload);
  const source = Array.isArray(original) ? {} : original;
  const rows = Array.isArray(original) ? original : alias(source, ["samples", "data", "gaze"]);
  if (!Array.isArray(rows)) throw new TypeError("Expected a samples, data, or gaze array.");

  const unit = alias(source, ["timeUnit", "timestampUnit"]);
  const units = unit === undefined ? "ms" : unit;
  if (!["ms", "s", "sec", "seconds"].includes(units)) {
    throw new RangeError("Unknown time unit; expected ms, s, sec, or seconds.");
  }
  const multiplier = units === "ms" ? 1 : 1000;
  const byTime = new Map();
  let invalidTime = 0;
  for (const row of rows) {
    const rawTime = alias(row, ["t", "timestamp", "time"]);
    const t = Number.isFinite(rawTime) ? rawTime * multiplier : NaN;
    if (!Number.isFinite(t)) {
      invalidTime += 1;
      continue;
    }
    const x = alias(row, ["x", "gazeX", "normalizedX"]);
    const y = alias(row, ["y", "gazeY", "normalizedY"]);
    const rawConfidence = alias(row, ["confidence", "score"]);
    const confidence = rawConfidence === undefined ? 1 : rawConfidence;
    const explicitOutside = row.outsideViewport === true || row.outside === true
      || row.inViewport === false || row.explicitOutside === true;
    const outside = explicitOutside || (Number.isFinite(x) && Number.isFinite(y)
      && outsideCoordinates(x, y));
    byTime.set(t, { t, x, y, confidence, outside, explicitOutside });
  }
  if (byTime.size === 0) throw new Error("The recording has no valid timestamps.");

  const samples = [...byTime.values()].sort((a, b) => a.t - b.t);
  const timeOrigin = samples[0].t;
  for (const sample of samples) sample.t -= timeOrigin;
  const duration = samples[samples.length - 1].t;
  if (!Number.isFinite(duration)) throw new RangeError("Recording duration exceeds finite milliseconds.");
  return {
    original,
    samples,
    duration,
    timeOrigin,
    title: source?.title || source?.name || "Imported session",
    participant: source?.participant || "",
    stats: { total: rows.length, invalidTime },
  };
}

/**
 * Filter normalized rows and precompute segment-local EMA without mutating input.
 * Confidence must be finite and in [0, 1]. Rejection counts are exclusive, in
 * order: invalid coordinates, invalid confidence, low confidence. Every rejection
 * breaks continuity. A gap breaks continuity only when strictly > maxGapMs.
 */
export function processRecording(recording, { minConfidence = 0.7, alpha = 0.35, maxGapMs = 1000 } = {}) {
  if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) {
    throw new RangeError("minConfidence must be finite and in [0, 1].");
  }
  if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) {
    throw new RangeError("alpha must be finite and in [0, 1].");
  }
  if (!Number.isFinite(maxGapMs) || maxGapMs < 0) {
    throw new RangeError("maxGapMs must be finite and nonnegative.");
  }

  const segments = [];
  const stats = { accepted: 0, invalidCoordinates: 0, invalidConfidence: 0, lowConfidence: 0 };
  let segment = null;
  for (const row of recording.samples) {
    let rejection;
    if (!Number.isFinite(row.x) || !Number.isFinite(row.y)) rejection = "invalidCoordinates";
    else if (!Number.isFinite(row.confidence) || row.confidence < 0 || row.confidence > 1) {
      rejection = "invalidConfidence";
    } else if (row.confidence < minConfidence) rejection = "lowConfidence";
    if (rejection) {
      stats[rejection] += 1;
      segment = null;
      continue;
    }

    const previous = segment?.[segment.length - 1];
    if (!previous || row.t - previous.t > maxGapMs) {
      segment = [];
      segments.push(segment);
    }
    const first = segment.length === 0;
    const { t, x, y, confidence, explicitOutside } = row;
    segment.push({
      t, x, y, confidence,
      outside: explicitOutside || outsideCoordinates(x, y),
      explicitOutside,
      smoothX: first ? x : alpha * x + (1 - alpha) * previous.smoothX,
      smoothY: first ? y : alpha * y + (1 - alpha) * previous.smoothY,
    });
    stats.accepted += 1;
  }
  return { segments, stats, duration: recording.duration };
}

// Index of the last entry whose timestamp is <= time (or -1).
function floorIndex(entries, time, timestamp) {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2);
    if (timestamp(entries[mid]) <= time) low = mid + 1;
    else high = mid;
  }
  return low - 1;
}

// Weighted form avoids overflowing the difference between opposite finite values.
function interpolate(left, right, ratio) {
  return (1 - ratio) * left + ratio * right;
}

/**
 * Stateless binary-search seek, with inclusive segment bounds and no endpoint
 * holds into gaps. Explicit outside flags are held from the left until the exact
 * right timestamp. Outside always uses RAW interpolated coordinates, even when
 * returning smoothed coordinates. Singletons are visible only at their timestamp.
 */
export function sampleAt(processed, timeMs, { smoothed = false } = {}) {
  if (!Number.isFinite(timeMs) || timeMs < 0 || timeMs > processed.duration) return null;
  const index = floorIndex(processed.segments, timeMs, (segment) => segment[0].t);
  if (index < 0) return null;
  const segment = processed.segments[index];
  if (timeMs > segment[segment.length - 1].t) return null;
  const leftIndex = floorIndex(segment, timeMs, (point) => point.t);
  const left = segment[leftIndex];
  if (left.t === timeMs) {
    return {
      x: smoothed ? left.smoothX : left.x,
      y: smoothed ? left.smoothY : left.y,
      confidence: left.confidence,
      outside: left.outside,
    };
  }
  const right = segment[leftIndex + 1];
  const ratio = (timeMs - left.t) / (right.t - left.t);
  const rawX = interpolate(left.x, right.x, ratio);
  const rawY = interpolate(left.y, right.y, ratio);
  return {
    x: smoothed ? interpolate(left.smoothX, right.smoothX, ratio) : rawX,
    y: smoothed ? interpolate(left.smoothY, right.smoothY, ratio) : rawY,
    confidence: interpolate(left.confidence, right.confidence, ratio),
    outside: left.explicitOutside || outsideCoordinates(rawX, rawY),
  };
}

function nonnegativeOption(name, value) {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be finite and nonnegative.`);
  }
}

/**
 * A fixation is a maximal contiguous run of RAW normalized points within
 * Euclidean radius of the running (sample-weighted) centroid. A candidate must
 * be within radius of the current centroid; accepted points then update that
 * centroid. Close BEFORE a violating point; that point starts the next run.
 * Equality at the radius is accepted.
 * Segment boundaries (including filtered rows) and gaps > maxGapMs never bridge.
 * Only runs with last t - first t >= minDurationMs are returned; a singleton
 * has 0 ms. No smoothing, coordinate clamping, or endpoint dwell is applied.
 */
export function analyzeFixations(processed, { radius = 0.06, minDurationMs = 100, maxGapMs = 1000 } = {}) {
  nonnegativeOption("radius", radius);
  nonnegativeOption("minDurationMs", minDurationMs);
  nonnegativeOption("maxGapMs", maxGapMs);
  const fixations = [];
  for (const segment of processed.segments) {
    let run = null;
    const finish = () => {
      if (run && run.durationMs >= minDurationMs) fixations.push(run);
    };
    for (let i = 0; i < segment.length; i += 1) {
      const point = segment[i];
      let x;
      let y;
      let fits = run && point.t - run.end <= maxGapMs
        && Math.hypot(point.x - run.x, point.y - run.y) <= radius;
      if (fits) {
        x = interpolate(run.x, point.x, 1 / (run.sampleCount + 1));
        y = interpolate(run.y, point.y, 1 / (run.sampleCount + 1));
      }
      if (!fits) {
        finish();
        run = { start: point.t, end: point.t, durationMs: 0, x: point.x, y: point.y, sampleCount: 1 };
      } else {
        run.end = point.t;
        run.durationMs = point.t - run.start;
        run.x = x;
        run.y = y;
        run.sampleCount += 1;
      }
    }
    finish();
  }
  return fixations;
}

/**
 * Current precomputed fixation, with inclusive start/end, or null in gaps.
 * Its centroid/duration describe the complete run, not a playback-truncated run.
 * Return a copy so callers cannot mutate the supplied analysis through it.
 */
export function fixationAt(fixations, timeMs) {
  if (!Number.isFinite(timeMs)) return null;
  const index = floorIndex(fixations, timeMs, (fixation) => fixation.start);
  const fixation = fixations[index];
  return fixation && timeMs <= fixation.end ? { ...fixation } : null;
}

/**
 * Completed fixation points only (end <= timeMs). Intensity is dwell in ms,
 * without time-dependent rescaling, so seeking never changes a point's weight.
 */
export function heatmapAt(fixations, timeMs) {
  if (!Number.isFinite(timeMs)) return [];
  return fixations.filter((fixation) => fixation.end <= timeMs)
    .map((fixation) => ({ ...fixation, intensity: fixation.durationMs }));
}

/**
 * Return [{ id, label, dwellMs }] in AOI input order, recomputed on every call.
 * Only no-bridge is supported: successive accepted samples must share a segment
 * and have an interval <= maxGapMs (default 1000). Existing segment barriers
 * always win, even if a larger maxGapMs is supplied here.
 * Treat each accepted interval as a linearly interpolated gaze path. Count the
 * exact time portion whose path intersects an INCLUSIVE rectangle, clipped to
 * playback time, with no endpoint holds. This is a no-bridge policy: filtered
 * rows and segment gaps contribute no interval. Overlap counts independently
 * for each AOI. Before/at the first sample dwell is zero.
 * Nonfinite playback times produce zero dwell, matching empty playback queries.
 */
export function computeAOIDwell(processed, aois, timeMs, { gapPolicy = "no-bridge", maxGapMs = 1000 } = {}) {
  if (gapPolicy !== "no-bridge") throw new RangeError('gapPolicy must be "no-bridge".');
  nonnegativeOption("maxGapMs", maxGapMs);
  const result = aois.map(({ id, label }) => ({ id, label, dwellMs: 0 }));
  if (!Number.isFinite(timeMs)) return result;
  for (const segment of processed.segments) {
    for (let i = 1; i < segment.length; i += 1) {
      const left = segment[i - 1];
      const right = segment[i];
      if (left.t >= timeMs) break;
      const gap = right.t - left.t;
      if (gap <= 0 || gap > maxGapMs) continue;
      const intervalEnd = Math.min(right.t, timeMs);
      if (intervalEnd <= left.t) continue;
      const limit = (intervalEnd - left.t) / gap;
      for (let j = 0; j < aois.length; j += 1) {
        const aoi = aois[j];
        const portion = lineRectangleOverlap(left, right, aoi, limit);
        result[j].dwellMs += portion * gap;
      }
    }
  }
  return result;
}

// Return the fraction of the left-to-right interval that lies in an inclusive
// rectangle. Liang-Barsky clipping keeps dwell exact for diagonal gaze paths;
// it also handles a partial final interval when the user seeks into it.
function lineRectangleOverlap(left, right, aoi, limit) {
  let enter = 0;
  let exit = limit;
  const dx = right.x - left.x;
  const dy = right.y - left.y;
  const axes = [
    [left.x, dx, aoi.x, aoi.x + aoi.width],
    [left.y, dy, aoi.y, aoi.y + aoi.height],
  ];
  for (const [origin, delta, minimum, maximum] of axes) {
    if (minimum === maximum) {
      // A zero-width/height AOI has positive dwell only when the gaze remains
      // exactly on that boundary for the interval.
      if (delta !== 0 || origin !== minimum) return 0;
      continue;
    }
    if (delta === 0) {
      if (origin < minimum || origin > maximum) return 0;
      continue;
    }
    const first = (minimum - origin) / delta;
    const second = (maximum - origin) / delta;
    enter = Math.max(enter, Math.min(first, second));
    exit = Math.min(exit, Math.max(first, second));
    if (enter > exit) return 0;
  }
  return Math.max(0, exit - enter);
}
