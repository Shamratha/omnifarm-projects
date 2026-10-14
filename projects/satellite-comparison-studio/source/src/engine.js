const DAY_MS = 86_400_000;
const DEFAULT_MAX_AGE_DAYS = 14;
const LOW_CONFIDENCE_THRESHOLD = 0.65;
const THRESHOLD_EPSILON_MULTIPLIER = 8;

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseTimestamp(value, label = 'timestamp') {
  if (!(value instanceof Date) && (typeof value !== 'string' || value.trim() === '')) {
    throw new TypeError(`${label} must be a valid timestamp string or Date`);
  }
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new TypeError(`${label} must be a valid timestamp`);
  }
  return timestamp;
}

function validateNow(now) {
  return parseTimestamp(now, 'now');
}

function validateMaxAge(maxAgeDays) {
  if (!isNumber(maxAgeDays) || maxAgeDays < 0) {
    throw new RangeError('maxAgeDays must be a finite number greater than or equal to 0');
  }
  return maxAgeDays;
}

function validateThreshold(threshold) {
  if (!isNumber(threshold) || threshold < 0 || threshold > 1) {
    throw new RangeError('threshold must be a finite number between 0 and 1');
  }
}

function validatePair(name, pair, predicate) {
  if (!Array.isArray(pair) || pair.length !== 2 || !predicate(pair[0]) || !predicate(pair[1])) {
    throw new TypeError(`${name} must be an array of two finite numbers`);
  }
}

function validateMask(mask, name, size) {
  const isTypedMask = mask instanceof Uint8Array;
  if (!Array.isArray(mask) && !isTypedMask) {
    throw new TypeError(`${name} must be an Array or Uint8Array`);
  }
  if (mask.length !== size) {
    throw new RangeError(`${name} must contain one entry per pixel`);
  }
  for (let index = 0; index < mask.length; index += 1) {
    const value = mask[index];
    if (isTypedMask ? (value !== 0 && value !== 1) : typeof value !== 'boolean') {
      throw new TypeError(`${name}[${index}] must be a boolean or 0/1 mask value`);
    }
  }
}

function validateNumericMap(values, name, size, { allowNonFinite = false } = {}) {
  const isTypedMap = values instanceof Float32Array;
  if (!Array.isArray(values) && !isTypedMap) {
    throw new TypeError(`${name} must be an Array or Float32Array`);
  }
  if (values.length !== size) {
    throw new RangeError(`${name} must contain one entry per pixel`);
  }
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (typeof value !== 'number' || (!allowNonFinite && !Number.isFinite(value))) {
      throw new TypeError(`${name}[${index}] must be ${allowNonFinite ? 'a number' : 'a finite number'}`);
    }
  }
}

function validateTile(tile, label) {
  if (!tile || typeof tile !== 'object') {
    throw new TypeError(`${label} tile must be an object`);
  }
  if (typeof tile.id !== 'string' || tile.id.trim() === '') {
    throw new TypeError(`${label} id must be a non-empty string`);
  }
  if (!Number.isInteger(tile.width) || tile.width <= 0 || !Number.isInteger(tile.height) || tile.height <= 0) {
    throw new TypeError(`${label} tile width and height must be positive integers`);
  }

  const size = tile.width * tile.height;
  if (!Number.isSafeInteger(size)) {
    throw new RangeError(`${label} tile is too large`);
  }
  validatePair(`${label} origin`, tile.origin, isNumber);
  validatePair(`${label} resolution`, tile.resolution, (value) => isNumber(value) && value !== 0);
  if (typeof tile.crs !== 'string' || tile.crs.trim() === '') {
    throw new TypeError(`${label} crs must be a non-empty string`);
  }
  parseTimestamp(tile.date, `${label} date`);
  validateNumericMap(tile.values, `${label} values`, size, { allowNonFinite: true });
  validateMask(tile.cloud, `${label} cloud`, size);
  validateMask(tile.nodata, `${label} nodata`, size);
  validateNumericMap(tile.confidence, `${label} confidence`, size);
  if (tile.confidence.some((value) => value < 0 || value > 1)) {
    throw new RangeError(`${label} confidence values must be between 0 and 1`);
  }
  return size;
}

function assertAligned(before, after) {
  if (before.width !== after.width || before.height !== after.height) {
    throw new Error('Tiles must have matching grid dimensions');
  }
  if (before.crs !== after.crs) {
    throw new Error('Tiles must have matching crs');
  }
  if (before.origin[0] !== after.origin[0] || before.origin[1] !== after.origin[1]) {
    throw new Error('Tiles must have matching origin');
  }
  if (before.resolution[0] !== after.resolution[0] || before.resolution[1] !== after.resolution[1]) {
    throw new Error('Tiles must have matching resolution');
  }
}

function maskValue(mask, index) {
  return mask[index] === true || mask[index] === 1;
}

function thresholdTolerance(difference, threshold) {
  return Number.EPSILON * THRESHOLD_EPSILON_MULTIPLIER * Math.max(1, Math.abs(difference), Math.abs(threshold));
}

function isAtLeastThreshold(difference, threshold) {
  return difference >= threshold || difference + thresholdTolerance(difference, threshold) >= threshold;
}

function freshnessFor(date, nowTimestamp, maxAgeDays) {
  const timestamp = parseTimestamp(date, 'date');
  if (timestamp > nowTimestamp) {
    throw new RangeError('timestamps in the future are not supported');
  }
  const ageDays = (nowTimestamp - timestamp) / DAY_MS;
  return { stale: ageDays > maxAgeDays, ageDays };
}

/** Return elapsed days as later - earlier. */
export function daysBetween(later, earlier) {
  return (parseTimestamp(later, 'later') - parseTimestamp(earlier, 'earlier')) / DAY_MS;
}

/** Invalid or missing acquisition dates are explicitly treated as stale. */
export function isStale(date, now = new Date(), maxAgeDays = DEFAULT_MAX_AGE_DAYS) {
  validateMaxAge(maxAgeDays);
  const nowTimestamp = validateNow(now);
  if (date === null || date === undefined || date === '') {
    return true;
  }
  try {
    return freshnessFor(date, nowTimestamp, maxAgeDays).stale;
  } catch (error) {
    if (error instanceof TypeError) return true;
    throw error;
  }
}

/**
 * Compare two aligned raster tiles. A changed pixel is one whose absolute
 * difference is inclusively greater than or equal to threshold (including
 * unchanged valid pixels at zero). Non-finite samples are excluded, not coerced.
 * Finite differences and confidence are retained for masked pixels for map display;
 * only non-finite sample pairs use null values.
 */
export function compareTiles(before, after, threshold, { now = new Date(), maxAgeDays = DEFAULT_MAX_AGE_DAYS } = {}) {
  validateThreshold(threshold);
  const beforeSize = validateTile(before, 'before');
  const afterSize = validateTile(after, 'after');
  if (beforeSize !== afterSize) {
    throw new Error('Tiles must have matching grid dimensions');
  }
  assertAligned(before, after);

  const nowTimestamp = validateNow(now);
  validateMaxAge(maxAgeDays);
  const beforeFreshness = freshnessFor(before.date, nowTimestamp, maxAgeDays);
  const afterFreshness = freshnessFor(after.date, nowTimestamp, maxAgeDays);
  const total = beforeSize;
  const differences = new Array(total);
  const confidence = new Array(total);
  const valid = new Array(total);
  const changed = new Array(total);
  const cloudIndices = [];
  const nodataIndices = [];
  const lowConfidenceIndices = [];
  const nonFiniteIndices = [];
  const excludedIndices = [];

  let validCount = 0;
  let changedCount = 0;
  let confidenceSum = 0;

  for (let index = 0; index < total; index += 1) {
    const beforeValue = before.values[index];
    const afterValue = after.values[index];
    const finiteValues = Number.isFinite(beforeValue) && Number.isFinite(afterValue);
    const difference = finiteValues ? Math.abs(afterValue - beforeValue) : null;
    if (finiteValues && !Number.isFinite(difference)) {
      throw new RangeError(`difference at pixel ${index} exceeds the finite numeric range`);
    }
    if (!finiteValues) nonFiniteIndices.push(index);

    const cloud = maskValue(before.cloud, index) || maskValue(after.cloud, index);
    const nodata = maskValue(before.nodata, index) || maskValue(after.nodata, index);
    if (cloud) cloudIndices.push(index);
    if (nodata) nodataIndices.push(index);

    const minimumConfidence = Math.min(before.confidence[index], after.confidence[index]);
    const isValid = !cloud && !nodata && finiteValues;
    differences[index] = difference;
    confidence[index] = finiteValues ? minimumConfidence : null;
    valid[index] = isValid;
    const isChanged = isValid && isAtLeastThreshold(difference, threshold);
    changed[index] = isChanged;

    if (isValid) {
      validCount += 1;
      confidenceSum += minimumConfidence;
      if (minimumConfidence < LOW_CONFIDENCE_THRESHOLD) lowConfidenceIndices.push(index);
      if (isChanged) changedCount += 1;
    } else {
      excludedIndices.push(index);
    }
  }

  return {
    differences,
    confidence,
    valid,
    changed,
    validCount,
    changedCount,
    coverage: validCount / total,
    changedFraction: validCount === 0 ? 0 : changedCount / validCount,
    meanConfidence: validCount === 0 ? null : confidenceSum / validCount,
    cloudCount: cloudIndices.length,
    cloudIndices,
    nodataCount: nodataIndices.length,
    nodataIndices,
    lowConfidenceCount: lowConfidenceIndices.length,
    lowConfidenceIndices,
    nonFiniteCount: nonFiniteIndices.length,
    nonFiniteIndices,
    excludedCount: excludedIndices.length,
    excludedIndices,
    freshness: {
      before: !beforeFreshness.stale,
      after: !afterFreshness.stale,
    },
    stale: {
      before: beforeFreshness.stale,
      after: afterFreshness.stale,
    },
    beforeAgeDays: beforeFreshness.ageDays,
    afterAgeDays: afterFreshness.ageDays,
  };
}

function isoTimestamp(value, label) {
  return new Date(parseTimestamp(value, label)).toISOString();
}

/** One outcome vocabulary for the desk, readable report, and embedded JSON. */
export function buildComparisonSummary(result, threshold) {
  const totalCount = result.valid.length;
  const thresholdLabel = String(threshold);
  const outcome = result.validCount === 0 ? 'not-comparable'
    : result.changedCount === 0 ? 'no-change-detected' : 'change-detected';
  const outcomeHeadline = outcome === 'not-comparable'
    ? 'Not comparable: no valid pixels were available for comparison.'
    : outcome === 'no-change-detected'
      ? `No change detected at threshold ${thresholdLabel}.`
      : `${result.changedCount} valid pixel${result.changedCount === 1 ? ' meets' : 's meet'} the change threshold.`;
  const staleImages = result.stale.before && result.stale.after ? 'both images are stale'
    : result.stale.before ? 'the before image is stale'
      : result.stale.after ? 'the after image is stale' : null;
  const zeroThreshold = threshold === 0
    ? ' At zero threshold, unchanged valid pixels also meet the inclusive threshold; this is not proof of a physical change.' : '';
  const interpretation = outcome === 'not-comparable'
    ? 'No valid pixels were available, so no change decision is possible. The valid-pixel change fraction is not available; the numeric zero in changedFraction is an empty-result placeholder, not evidence of no change.'
    : outcome === 'no-change-detected'
      ? `No change detected at this threshold does not mean the tiles are identical. Smaller differences may exist; excluded pixels were not assessed.${zeroThreshold}`
      : `These are threshold detections in synthetic signal values, not verified real-world changes. Excluded pixels were not assessed.${zeroThreshold}`;
  return {
    outcome,
    headline: `${outcomeHeadline}${staleImages ? ` Review required: ${staleImages}.` : ''}`,
    changedWording: outcome === 'not-comparable'
      ? `0 of ${totalCount} total pixels could be scored. Valid-pixel change fraction: not available.`
      : `${result.changedCount} of ${totalCount} total pixels ${result.changedCount === 1 ? 'meets' : 'meet'} the change threshold (${(result.changedCount / totalCount * 100).toFixed(1)}%). The valid-pixel change fraction is ${(result.changedFraction * 100).toFixed(1)}%.`,
    coverageWording: `${result.validCount} of ${totalCount} pixels remain valid after applying both timestamps' masks and finite-value checks.`,
    interpretation,
    appendixWording: outcome === 'not-comparable'
      ? 'No valid pixels were available, so the changed-pixel index is empty. This comparison is not a no-change result.'
      : outcome === 'no-change-detected'
        ? `No change detected at threshold ${thresholdLabel}, so the changed-pixel index is empty. Excluded pixels were not assessed.`
        : 'The appendix lists only valid pixels that meet the inclusive change threshold.',
  };
}

/** Build a JSON-safe, self-describing report for a comparison. */
export function buildReport(
  before,
  after,
  threshold,
  { now = new Date(), maxAgeDays = DEFAULT_MAX_AGE_DAYS, fixtureName = null, band = null } = {},
) {
  for (const [label, value] of [['fixtureName', fixtureName], ['band', band]]) {
    if (value !== null && typeof value !== 'string') {
      throw new TypeError(`${label} must be a string or null`);
    }
  }
  const result = compareTiles(before, after, threshold, { now, maxAgeDays });
  const generatedAt = isoTimestamp(now, 'now');
  const dates = { before: isoTimestamp(before.date, 'before date'), after: isoTimestamp(after.date, 'after date') };
  const geometry = {
    width: before.width,
    height: before.height,
    crs: before.crs,
    origin: [...before.origin],
    resolution: [...before.resolution],
  };
  const stats = {
    totalCount: before.width * before.height,
    validCount: result.validCount,
    changedCount: result.changedCount,
    coverage: result.coverage,
    changedFraction: result.changedFraction,
    meanConfidence: result.meanConfidence,
    cloudCount: result.cloudCount,
    nodataCount: result.nodataCount,
    lowConfidenceCount: result.lowConfidenceCount,
    nonFiniteCount: result.nonFiniteCount,
    excludedCount: result.excludedCount,
  };
  const staleWording = result.stale.before || result.stale.after
    ? `Review required: ${result.stale.before && result.stale.after ? 'both images are stale' : result.stale.before ? 'the before image is stale' : 'the after image is stale'}. Stale imagery is included for transparency but should not be treated as a current observation. Freshness is evaluated separately for each timestamp.`
    : `Both images are within the ${maxAgeDays}-day freshness policy window.`;

  return {
    schemaVersion: 2,
    reportTitle: 'Fieldnote change-detection report',
    reportSubtitle: 'A self-contained, local comparison of two synthetic satellite tiles.',
    generatedAt,
    analysisAt: generatedAt,
    clockPolicy: 'All dates and ages use the supplied analysis clock in UTC. generatedAt is retained as an alias of analysisAt for compatibility; it is not the wall-clock download time.',
    fixtureName,
    band,
    tileIds: { before: before.id, after: after.id },
    synthetic: true,
    disclaimer: 'This report contains synthetic satellite data for demonstration and comparison testing.',
    headings: {
      summary: 'Decision summary',
      timeline: 'Image timeline',
      interpretation: 'How to read this report',
      masks: 'Mask exclusions',
      confidence: 'Confidence interpretation',
      legend: 'Legends',
      geometry: 'Alignment and geometry',
      pixels: 'Pixel-level appendix',
    },
    summary: {
      ...buildComparisonSummary(result, threshold),
      staleWording,
      clockWording: `Analysis clock: ${generatedAt} (UTC). Image ages are evaluated against this clock, not the download time.`,
    },
    dates,
    geometry,
    stale: { ...result.stale },
    freshness: { ...result.freshness },
    beforeAgeDays: result.beforeAgeDays,
    afterAgeDays: result.afterAgeDays,
    freshnessPolicy: { maxAgeDays, staleWhen: 'ageDays > maxAgeDays', futureTimestamps: 'rejected' },
    threshold: {
      value: threshold,
      inclusive: true,
      policy: 'A valid pixel is classified as changed when its absolute difference is greater than or equal to the threshold, with the documented floating-point tie tolerance. At zero threshold, unchanged valid pixels also qualify.',
      floatingPointTolerance: {
        epsilonMultiplier: THRESHOLD_EPSILON_MULTIPLIER,
        formula: 'Number.EPSILON * epsilonMultiplier * max(1, abs(difference), abs(threshold))',
      },
    },
    confidencePolicy: {
      aggregation: 'Minimum confidence across timestamps, averaged over valid pixels only.',
      lowConfidenceThreshold: LOW_CONFIDENCE_THRESHOLD,
      lowConfidenceExcluded: false,
      interpretation: 'Confidence is a synthetic review signal, not a calibrated probability. The report uses the lower confidence of the two timestamps for each pixel. Pixels below 65% remain in the valid comparison but should receive extra scrutiny.',
    },
    maskPolicy: {
      cloud: 'A pixel is excluded when either timestamp marks it as cloud-covered.',
      nodata: 'A pixel is excluded when either timestamp marks it as missing data. Border nodata is not a detected change.',
      nonFinite: 'A pixel is excluded when either value is not finite; it is never coerced to zero.',
      overlap: 'Mask counts are per category. A pixel present in more than one category is excluded once from the valid comparison.',
    },
    legends: {
      change: [
        { label: 'Changed', meaning: 'Absolute difference is greater than or equal to the threshold.', color: '#d95f3f' },
        { label: 'Below threshold', meaning: 'Valid pixel difference is below the threshold.', color: '#d7d7cd' },
        { label: 'Excluded', meaning: 'Cloud, nodata, or non-finite value prevented comparison.', color: '#d9cdb7' },
      ],
      masks: [
        { label: 'Cloud', meaning: 'Excluded from change scoring when present at either timestamp.', color: '#d9cdb7' },
        { label: 'No data', meaning: 'Missing pixel, including the synthetic outer border.', color: '#eeebe3' },
        { label: 'Low confidence', meaning: 'Below 65%; retained but requires review.', color: '#d88457' },
      ],
      confidence: { low: '0 ≤ confidence < 0.65 · review closely', high: '0.65 ≤ confidence ≤ 1 · higher synthetic confidence', colors: ['#d67148', '#769d7e'] },
    },
    excluded: {
      count: result.excludedCount,
      indices: [...result.excludedIndices],
      cloudCount: result.cloudCount,
      cloudIndices: [...result.cloudIndices],
      nodataCount: result.nodataCount,
      nodataIndices: [...result.nodataIndices],
      nonFiniteCount: result.nonFiniteCount,
      nonFiniteIndices: [...result.nonFiniteIndices],
    },
    pixels: {
      differences: [...result.differences],
      confidence: [...result.confidence],
      valid: [...result.valid],
      changed: [...result.changed],
      changedIndices: result.changed.flatMap((value, index) => (value ? [index] : [])),
      lowConfidenceIndices: [...result.lowConfidenceIndices],
      changedRows: result.changed.flatMap((changed, index) => changed ? [{ index, row: Math.floor(index / before.width), column: index % before.width, difference: result.differences[index], confidence: result.confidence[index] }] : []),
    },
    stats,
  };
}
