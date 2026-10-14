function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function validateCoordinateArray(positions, name) {
  if (!Array.isArray(positions)) {
    throw new TypeError(`${name} must be an array of coordinate triples`);
  }
  if (positions.length === 0) {
    throw new RangeError(`${name} must contain at least one atom`);
  }
  for (let atom = 0; atom < positions.length; atom += 1) {
    const coordinate = positions[atom];
    if (!Array.isArray(coordinate) || coordinate.length !== 3) {
      throw new TypeError(`${name}[${atom}] must be a finite numeric triple`);
    }
    for (let axis = 0; axis < 3; axis += 1) {
      if (!isFiniteNumber(coordinate[axis])) {
        throw new TypeError(`${name}[${atom}] must be a finite numeric triple`);
      }
    }
  }
}

/**
 * Calculate the raw, all-atom RMSD between two coordinate arrays.
 * Coordinates are not centered, fitted, or periodically unwrapped.
 */
export function calculateRmsd(positions, referencePositions) {
  validateCoordinateArray(positions, 'positions');
  validateCoordinateArray(referencePositions, 'referencePositions');
  if (positions.length !== referencePositions.length) {
    throw new RangeError('positions and referencePositions must contain the same number of atoms');
  }

  let squaredDistanceSum = 0;
  for (let atom = 0; atom < positions.length; atom += 1) {
    const position = positions[atom];
    const reference = referencePositions[atom];
    squaredDistanceSum += (position[0] - reference[0]) ** 2;
    squaredDistanceSum += (position[1] - reference[1]) ** 2;
    squaredDistanceSum += (position[2] - reference[2]) ** 2;
  }
  return Math.sqrt(squaredDistanceSum / positions.length);
}

function validateFrameArray(frames) {
  if (!Array.isArray(frames)) {
    throw new TypeError('frames must be an array');
  }
}

function validateFrameObject(frame, index) {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
    throw new TypeError(`frames[${index}] must be an object`);
  }
}

function validateAscendingFrames(frames) {
  let previousOrder = null;
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    validateFrameObject(frame, index);
    const order = frame.sequence ?? frame.index;
    if (order === undefined || order === null) continue;
    if (!isFiniteNumber(order)) {
      throw new TypeError(`frames[${index}] sequence/index must be numeric`);
    }
    if (previousOrder !== null && order <= previousOrder) {
      throw new RangeError('frames must be in strictly ascending sequence order');
    }
    previousOrder = order;
  }
}

/**
 * Add an RMSD value to each frame without changing either the frames or the
 * reference frame. The result is a new array of shallow frame copies.
 */
export function deriveFrames(frames, referenceFrame = null) {
  validateFrameArray(frames);
  frames.forEach(validateFrameObject);

  if (referenceFrame !== null && referenceFrame !== undefined) {
    if (typeof referenceFrame !== 'object' || Array.isArray(referenceFrame)) {
      throw new TypeError('referenceFrame must be a frame object or null');
    }
    validateCoordinateArray(referenceFrame.positions, 'referenceFrame.positions');
  }
  const referencePositions = referenceFrame?.positions;
  return frames.map((frame) => ({
    ...frame,
    rmsd_angstrom: referenceFrame === null || referenceFrame === undefined
      ? null
      : calculateRmsd(frame.positions, referencePositions),
  }));
}

function emptyMetric() {
  return {
    count: 0,
    mean: null,
    min: null,
    max: null,
    stddev: null,
  };
}

function summarizeValues(values) {
  let count = 0;
  let mean = 0;
  let sumOfSquaredDifferences = 0;
  let min = Infinity;
  let max = -Infinity;

  for (const value of values) {
    if (!isFiniteNumber(value)) continue;
    count += 1;
    const difference = value - mean;
    mean += difference / count;
    sumOfSquaredDifferences += difference * (value - mean);
    min = Math.min(min, value);
    max = Math.max(max, value);
  }

  if (count === 0) return emptyMetric();
  return {
    count,
    mean,
    min,
    max,
    stddev: Math.sqrt(Math.max(0, sumOfSquaredDifferences / count)),
  };
}

/** Summarize finite metric values with population standard deviation. */
export function summarizeMetrics(frames) {
  validateFrameArray(frames);
  return {
    count: frames.length,
    temperature_K: summarizeValues(frames.map((frame) => frame?.temperature_K)),
    potential_energy_kj_mol: summarizeValues(
      frames.map((frame) => frame?.potential_energy_kj_mol),
    ),
    rmsd_angstrom: summarizeValues(frames.map((frame) => frame?.rmsd_angstrom)),
  };
}

/** Select a full-resolution trailing window from already ordered, validated frames. */
export function selectPlotFrames(frames, { windowSize = 0, maxPoints = 200 } = {}) {
  validateFrameArray(frames);
  validateAscendingFrames(frames);
  if (!Number.isSafeInteger(windowSize) || windowSize < 0) {
    throw new RangeError('windowSize must be zero or a positive safe integer');
  }
  if (!Number.isSafeInteger(maxPoints) || maxPoints < 2) {
    throw new RangeError('maxPoints must be a safe integer of at least 2');
  }

  const firstIndex = windowSize === 0 ? 0 : Math.max(0, frames.length - windowSize);
  const windowFrames = frames.slice(firstIndex);
  if (windowFrames.length <= maxPoints) {
    return { windowFrames, displayFrames: windowFrames.slice() };
  }

  const displayFrames = [];
  const lastIndex = windowFrames.length - 1;
  for (let point = 0; point < maxPoints; point += 1) {
    const index = Math.round(point * lastIndex / (maxPoints - 1));
    displayFrames.push(windowFrames[index]);
  }
  return { windowFrames, displayFrames };
}

const CSV_COLUMNS = [
  'schema_version',
  'run_id',
  'sequence',
  'index',
  'step',
  'timestamp',
  'time_fs',
  'temperature_K',
  'potential_energy_kj_mol',
  'rmsd_angstrom',
  'rmsd_reference_sequence',
  'rmsd_alignment',
  'position_unit',
  'time_unit',
  'temperature_unit',
  'potential_energy_unit',
  'positions_json',
];

function csvField(value, untrustedText = false) {
  let text = value === null || value === undefined ? '' : String(value);
  if (untrustedText && /^[\t\n\r ]*[=+\-@]/.test(text)) {
    text = `'${text}`;
  }
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Export every supplied frame as RFC 4180 CSV in sequence order. */
export function retainedCsv(frames, { runId = '', referenceSequence = null } = {}) {
  validateFrameArray(frames);
  frames.forEach(validateFrameObject);
  const orderedFrames = frames.slice().sort((left, right) => left.sequence - right.sequence);
  const hasReference = referenceSequence !== null && referenceSequence !== undefined;

  const rows = [CSV_COLUMNS.join(',')];
  for (const frame of orderedFrames) {
    const units = frame.units || {};
    rows.push([
      csvField(frame.schema_version),
      csvField(runId, true),
      csvField(frame.sequence),
      csvField(frame.index),
      csvField(frame.step),
      csvField(frame.timestamp, true),
      csvField(frame.time_fs),
      csvField(frame.temperature_K),
      csvField(frame.potential_energy_kj_mol),
      csvField(hasReference && isFiniteNumber(frame.rmsd_angstrom) ? frame.rmsd_angstrom : null),
      csvField(referenceSequence),
      csvField('none'),
      csvField(units.position, true),
      csvField(units.time, true),
      csvField(units.temperature, true),
      csvField(units.potential_energy, true),
      csvField(JSON.stringify(frame.positions)),
    ].join(','));
  }
  return `${rows.join('\r\n')}\r\n`;
}
