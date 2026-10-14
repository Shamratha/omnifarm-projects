const SCHEMA_VERSION = 1;
const FRAME_SCHEMA = 'md-progress-frame/v1';
const FRAME_UNITS = Object.freeze({
  position: 'angstrom',
  time: 'femtosecond',
  temperature: 'kelvin',
  potential_energy: 'kilojoule_per_mole',
});
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FRAME_FIELDS = ['schema_version', 'sequence', 'index', 'step', 'timestamp',
  'time_fs', 'temperature_K', 'potential_energy_kj_mol', 'units', 'positions'];

export class StreamProtocolError extends Error {
  constructor(message, code = 'invalid_frame') {
    super(message);
    this.name = 'StreamProtocolError';
    this.code = code;
  }
}

function isSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function requireField(object, field, context) {
  if (!(field in object)) {
    throw new StreamProtocolError(`${context} is missing required field '${field}'`, `missing_${field}`);
  }
  return object[field];
}

function validateUnits(units, context = 'frame') {
  if (!units || typeof units !== 'object' || Array.isArray(units)) {
    throw new StreamProtocolError(`${context} units must be an object`, 'missing_units');
  }
  const expectedKeys = Object.keys(FRAME_UNITS);
  const actualKeys = Object.keys(units);
  if (actualKeys.length !== expectedKeys.length || expectedKeys.some((key) => units[key] !== FRAME_UNITS[key])) {
    const missing = expectedKeys.filter((key) => !(key in units));
    throw new StreamProtocolError(
      `${context} units are not the exact canonical map${missing.length ? `; missing ${missing.join(', ')}` : ''}`,
      missing.length ? 'missing_units' : 'invalid_units',
    );
  }
  return { ...FRAME_UNITS };
}

function validateFiniteNumber(value, field, minimum = null) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new StreamProtocolError(`frame field '${field}' must be a finite number`);
  }
  if (minimum !== null && value < minimum) {
    throw new StreamProtocolError(`frame field '${field}' must be at least ${minimum}`);
  }
  return value;
}

function validateTimestamp(timestamp) {
  if (typeof timestamp !== 'string' || !TIMESTAMP_PATTERN.test(timestamp)
      || timestamp.startsWith('0000') || Number.isNaN(Date.parse(timestamp))
      || new Date(timestamp).toISOString() !== timestamp) {
    throw new StreamProtocolError('frame timestamp must be canonical UTC ISO format YYYY-MM-DDTHH:mm:ss.SSSZ');
  }
  return timestamp;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function createDiagnostics() {
  return {
    gapCount: 0,
    missingSequenceCount: 0,
    duplicateCount: 0,
    reconnectResetCount: 0,
    cursorExpiredCount: 0,
    observedDroppedBeforeReconnect: 0,
    retainedFrames: 0,
    estimatedDroppedFrames: 0,
    bufferCapacity: null,
    bufferUsage: 0,
    bufferUsageSource: 'inferred',
    oldestSequence: null,
    latestSequence: -1,
    lastResetReason: null,
    status: null,
  };
}

export function validateFrame(frame, { atomCount, expectedSequence = null, previousStep = null, previousTimeFs = null, previousTimestamp = null } = {}) {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
    throw new StreamProtocolError('frame must be an object');
  }
  if (Object.keys(frame).some((key) => !FRAME_FIELDS.includes(key))) {
    throw new StreamProtocolError('frame contains unsupported fields');
  }
  if (frame.schema_version !== SCHEMA_VERSION) {
    throw new StreamProtocolError(`unsupported frame schema version ${String(frame.schema_version)}`, 'unsupported_schema');
  }
  if (!isSafeInteger(frame.sequence)) {
    throw new StreamProtocolError('frame sequence must be a non-negative safe integer');
  }
  if (expectedSequence !== null && frame.sequence !== expectedSequence) {
    throw new StreamProtocolError(
      `expected frame sequence ${expectedSequence}, received ${frame.sequence}`,
      frame.sequence < expectedSequence ? 'duplicate_sequence' : 'frame_order',
    );
  }
  if (!isSafeInteger(frame.index) || frame.index !== frame.sequence) {
    throw new StreamProtocolError(`frame index must equal sequence ${frame.sequence}`, 'frame_order');
  }
  if (!isSafeInteger(frame.step)) {
    throw new StreamProtocolError('frame step must be a non-negative safe integer');
  }
  if (previousStep !== null && frame.step <= previousStep) {
    throw new StreamProtocolError(
      `frame step ${frame.step} must be greater than previous step ${previousStep}`,
      frame.step === previousStep ? 'duplicate_step' : 'frame_order',
    );
  }
  validateTimestamp(frame.timestamp);
  validateFiniteNumber(frame.time_fs, 'time_fs', 0);
  validateFiniteNumber(frame.temperature_K, 'temperature_K', 0);
  validateFiniteNumber(frame.potential_energy_kj_mol, 'potential_energy_kj_mol');
  if (previousTimeFs !== null && frame.time_fs <= previousTimeFs) {
    throw new StreamProtocolError('frame simulation time must increase', 'frame_order');
  }
  if (previousTimestamp !== null && frame.timestamp < previousTimestamp) {
    throw new StreamProtocolError('frame timestamp must not move backwards', 'frame_order');
  }
  const units = validateUnits(requireField(frame, 'units', 'frame'));
  const positions = frame.positions;
  if (!Array.isArray(positions) || positions.length !== atomCount) {
    throw new StreamProtocolError(`frame must contain coordinates for all ${atomCount} atoms`, 'missing_coordinates');
  }
  const normalizedPositions = positions.map((coordinate, atomIndex) => {
    if (!Array.isArray(coordinate) || coordinate.length !== 3 || coordinate.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
      throw new StreamProtocolError(`frame atom ${atomIndex} must have finite x/y/z coordinates`, 'missing_coordinates');
    }
    return coordinate.slice();
  });
  // Stable field order makes duplicate comparison independent of JSON key order.
  return {
    schema_version: SCHEMA_VERSION, sequence: frame.sequence, index: frame.index,
    step: frame.step, timestamp: frame.timestamp, time_fs: frame.time_fs,
    temperature_K: frame.temperature_K, potential_energy_kj_mol: frame.potential_energy_kj_mol,
    units, positions: normalizedPositions,
  };
}

function validateEnvelope(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new StreamProtocolError('stream message must be an object');
  }
  if (message.schema_version !== SCHEMA_VERSION) {
    throw new StreamProtocolError(`unsupported stream schema version ${String(message.schema_version)}`, 'unsupported_schema');
  }
  if (typeof message.run_id !== 'string' || message.run_id.length === 0) {
    throw new StreamProtocolError('stream message requires a run_id', 'missing_run_id');
  }
}

function validateMetadata(message) {
  if (message.frame_schema !== FRAME_SCHEMA) {
    throw new StreamProtocolError(`unsupported frame schema ${String(message.frame_schema)}`, 'unsupported_schema');
  }
  validateUnits(message.units, 'metadata');
  for (const key of ['atom_count', 'total_frames', 'buffer_limit']) {
    if (!isSafeInteger(message[key]) || message[key] < 1) {
      throw new StreamProtocolError(`metadata ${key} must be a positive safe integer`);
    }
  }
  if (!Array.isArray(message.atoms) || message.atoms.length !== message.atom_count
      || message.atoms.some((atom) => !atom || typeof atom.element !== 'string' || typeof atom.label !== 'string')) {
    throw new StreamProtocolError('metadata must describe every atom');
  }
  if (typeof message.name !== 'string' || typeof message.source !== 'string'
      || !Number.isFinite(message.timestep_fs) || message.timestep_fs <= 0) {
    throw new StreamProtocolError('invalid trajectory metadata');
  }
}

export class StreamParser {
  constructor() {
    this.runId = null;
    this.metadata = null;
    this.referenceFrame = null;
    this.frames = [];
    this.latestSequence = -1;
    this.lastStep = null;
    this.lastTimeFs = null;
    this.lastTimestamp = null;
    this._diagnostics = createDiagnostics();
  }

  get diagnostics() {
    // All fields are scalar: callers can inspect a stable copy without changing
    // counters. No clocks or transport assumptions enter protocol diagnostics.
    return { ...this._diagnostics };
  }

  hasCursor() {
    return Boolean(this.runId);
  }

  cursor() {
    return this.hasCursor() ? { runId: this.runId, after: this.latestSequence } : null;
  }

  _resetForRun(runId) {
    this.runId = runId;
    this.frames = [];
    this.referenceFrame = null;
    this.latestSequence = -1;
    this.lastStep = null;
    this.lastTimeFs = null;
    this.lastTimestamp = null;
    this._diagnostics = createDiagnostics();
  }

  _checkRun(message) {
    if (this.runId !== null && this.runId !== message.run_id) {
      this._resetForRun(message.run_id);
      return true;
    }
    if (this.runId === null) this.runId = message.run_id;
    return false;
  }

  _rememberFrame(frame) {
    this.frames.push(frame);
    const limit = this.metadata?.buffer_limit || 28;
    this.frames = this.frames.slice(-limit);
    this.latestSequence = frame.sequence;
    this.lastStep = frame.step;
    this.lastTimeFs = frame.time_fs;
    this.lastTimestamp = frame.timestamp;
  }

  _syncBufferDiagnostics(diagnostics, message) {
    const latest = this.latestSequence;
    const reportedSize = isSafeInteger(message.buffer_size)
      && message.buffer_size <= this.metadata.buffer_limit
      && message.buffer_size <= latest + 1;
    const reportedOldest = isSafeInteger(message.oldest_sequence)
      && message.oldest_sequence <= latest + 1;
    let usage = this.frames.length;
    let source = 'inferred';
    if (reportedSize) {
      usage = message.buffer_size;
      source = 'reported';
    } else if (message.type === 'snapshot' && message.mode === 'reset') {
      usage = message.frames.length;
      source = 'snapshot';
    } else if (message.type === 'snapshot' && reportedOldest) {
      // Resume snapshots contain only a suffix, not the entire producer buffer.
      usage = Math.min(this.metadata.buffer_limit, latest - message.oldest_sequence + 1);
    }
    diagnostics.retainedFrames = this.frames.length;
    diagnostics.bufferUsage = usage;
    diagnostics.bufferUsageSource = source;
    diagnostics.latestSequence = latest;
    // Frames and status normally report size, but not an oldest_sequence. Keep
    // the last observed lower bound until a message explicitly supplies another.
    diagnostics.oldestSequence = reportedOldest
      ? message.oldest_sequence : diagnostics.oldestSequence ?? this.frames[0]?.sequence ?? null;
    const oldest = diagnostics.oldestSequence;
    // Inferred span excess, not transport loss. Refreshing reconnect bounds or
    // rewinding via a same-run reset must not erase the largest observed estimate.
    const estimate = oldest === null ? 0 : Math.max(0, latest - oldest + 1 - usage);
    diagnostics.estimatedDroppedFrames = Math.max(
      diagnostics.estimatedDroppedFrames,
      estimate,
      diagnostics.observedDroppedBeforeReconnect,
    );
  }

  _recordAcceptedSequences(sequences, diagnostics, previousSequence) {
    let prior = previousSequence;
    for (const sequence of sequences) {
      if (prior >= 0 && sequence > prior + 1) {
        diagnostics.gapCount += 1;
        diagnostics.missingSequenceCount += sequence - prior - 1;
      }
      prior = sequence;
    }
  }

  _validateSnapshotFrames(frames, useExistingCursor) {
    let expected = useExistingCursor ? this.latestSequence + 1 : null;
    let previousStep = useExistingCursor ? this.lastStep : null;
    let previousTimeFs = useExistingCursor ? this.lastTimeFs : null;
    let previousTimestamp = useExistingCursor ? this.lastTimestamp : null;
    const validated = [];
    let reference = null;
    let previousSequence = null;
    let duplicates = 0;
    for (const frame of frames) {
      // Validate shape even when a frame is replayed and will be ignored.
      const checked = validateFrame(frame, { atomCount: this.metadata.atom_count });
      if (previousSequence !== null && checked.sequence !== previousSequence + 1) {
        throw new StreamProtocolError('snapshot frames must be contiguous and ordered', 'frame_order');
      }
      previousSequence = checked.sequence;
      if (checked.sequence === 0) reference = checked;
      if (checked.sequence <= this.latestSequence) {
        if (this._checkDuplicate(checked)) duplicates += 1;
        if (useExistingCursor) continue;
      }
      const normalized = validateFrame(frame, {
        atomCount: this.metadata.atom_count,
        expectedSequence: expected,
        previousStep,
        previousTimeFs,
        previousTimestamp,
      });
      validated.push(normalized);
      expected = normalized.sequence + 1;
      previousStep = normalized.step;
      previousTimeFs = normalized.time_fs;
      previousTimestamp = normalized.timestamp;
    }
    return { frames: validated, reference, duplicates };
  }

  _checkDuplicate(frame) {
    const existing = this.frames.find((item) => item.sequence === frame.sequence);
    if (existing && !sameJson(existing, frame)) {
      throw new StreamProtocolError(`conflicting duplicate frame sequence ${frame.sequence}`, 'duplicate_sequence');
    }
    // Evicted frames cannot be compared without unbounded storage. They are
    // stale (not new data) and never move the high-water mark or reenter charts.
    return Boolean(existing);
  }

  ingest(input) {
    let message;
    try {
      message = typeof input === 'string' ? JSON.parse(input) : input;
    } catch (error) {
      throw new StreamProtocolError(`stream message is not valid JSON: ${error.message}`, 'invalid_json');
    }
    validateEnvelope(message);
    if (message.type === 'metadata') {
      validateMetadata(message);
      const hasReference = hasOwn(message, 'reference_frame');
      const normalizedReference = hasReference
        ? validateFrame(message.reference_frame, {
          atomCount: message.atom_count,
          expectedSequence: 0,
        })
        : null;
      if (this.metadata && this.runId === message.run_id && !sameJson(this.metadata, message)) {
        // Compare objects semantically rather than their serialization order.
        const keys = ['frame_schema', 'atom_count', 'atoms', 'total_frames', 'timestep_fs', 'buffer_limit'];
        if (keys.some((key) => !sameJson(this.metadata[key], message[key]))) {
          throw new StreamProtocolError('metadata changed within the same run');
        }
      }
      if (this.metadata && this.runId === message.run_id && this.referenceFrame !== null
          && hasReference && !sameJson(this.referenceFrame, normalizedReference)) {
        throw new StreamProtocolError('reference frame changed within the same run');
      }
      const metadata = structuredClone(message);
      const runChanged = this._checkRun(message);
      this.metadata = metadata;
      this._diagnostics.bufferCapacity = message.buffer_limit;
      if (hasReference && this.referenceFrame === null) {
        this.referenceFrame = structuredClone(normalizedReference);
      }
      return { type: 'metadata', message, runChanged };
    }
    if (this.metadata === null) {
      throw new StreamProtocolError('metadata must arrive before stream data', 'missing_metadata');
    }
    if (this.runId !== message.run_id) {
      throw new StreamProtocolError(
        'stream metadata is required before data from a new run',
        'run_changed',
      );
    }
    const runChanged = false;
    if (message.type === 'snapshot') {
      if (!Array.isArray(message.frames)) {
        throw new StreamProtocolError('snapshot frames must be an array');
      }
      const isReset = message.mode === 'reset';
      if (message.mode !== 'reset' && message.mode !== 'resume') {
        throw new StreamProtocolError(`unsupported snapshot mode ${String(message.mode)}`);
      }
      if (!Number.isSafeInteger(message.latest_sequence) || message.latest_sequence < -1) {
        throw new StreamProtocolError('snapshot latest_sequence must be a safe integer');
      }
      if (message.current_index !== message.latest_sequence
          || !isSafeInteger(message.oldest_sequence)
          || message.oldest_sequence > message.latest_sequence + 1
          || message.frames.length > this.metadata.buffer_limit
          || message.latest_sequence >= this.metadata.total_frames) {
        throw new StreamProtocolError('invalid snapshot bounds', 'frame_order');
      }
      const reasons = ['initial', 'cursor_expired', 'cursor_ahead', 'run_changed'];
      if (isReset ? !reasons.includes(message.reason) : message.reason !== null) {
        throw new StreamProtocolError('invalid snapshot reset reason');
      }
      const snapshotResult = this._validateSnapshotFrames(message.frames, !isReset);
      const validated = snapshotResult.frames;
      const previousSequence = this.latestSequence;
      const lastSequence = validated.at(-1)?.sequence ?? (isReset ? -1 : this.latestSequence);
      if (lastSequence !== message.latest_sequence
          || (isReset && validated.length && validated[0].sequence !== message.oldest_sequence)) {
        throw new StreamProtocolError('snapshot bounds do not match accepted frames', 'frame_order');
      }
      // Commit only after the entire snapshot (including its bounds) validates.
      const diagnostics = this.diagnostics;
      diagnostics.duplicateCount += snapshotResult.duplicates;
      this._recordAcceptedSequences(validated.map((frame) => frame.sequence), diagnostics, previousSequence);
      if (isReset) {
        this.frames = validated.slice(-this.metadata.buffer_limit);
        this.latestSequence = lastSequence;
        const last = validated.at(-1);
        this.lastStep = last?.step ?? null;
        this.lastTimeFs = last?.time_fs ?? null;
        this.lastTimestamp = last?.timestamp ?? null;
      } else {
        validated.forEach((frame) => this._rememberFrame(frame));
      }
      if (this.referenceFrame === null && snapshotResult.reference !== null) {
        this.referenceFrame = structuredClone(snapshotResult.reference);
      }
      if (isReset) {
        diagnostics.lastResetReason = message.reason;
        if (message.reason !== 'initial') diagnostics.reconnectResetCount += 1;
        if (message.reason === 'cursor_expired') {
          diagnostics.cursorExpiredCount += 1;
          const dropped = Math.max(0, message.oldest_sequence - previousSequence - 1);
          diagnostics.observedDroppedBeforeReconnect += dropped;
          diagnostics.estimatedDroppedFrames = Math.max(diagnostics.estimatedDroppedFrames, dropped);
        }
      }
      this._syncBufferDiagnostics(diagnostics, message);
      this._diagnostics = diagnostics;
      return { type: 'snapshot', message, frames: validated, runChanged, reset: isReset };
    }
    if (message.type === 'frame') {
      const incomingSequence = message.frame?.sequence;
      if (Number.isSafeInteger(incomingSequence) && incomingSequence <= this.latestSequence) {
        const normalized = validateFrame(message.frame, {
          atomCount: this.metadata.atom_count,
        });
        if (this._checkDuplicate(normalized)) this._diagnostics.duplicateCount += 1;
        if (this.referenceFrame === null && normalized.sequence === 0) {
          this.referenceFrame = structuredClone(normalized);
        }
        // A stale envelope's buffer_size describes an earlier cursor. Replays
        // update only the identical-duplicate counter, never buffer gauges.
        return { type: 'frame', message, frame: normalized, accepted: false, duplicate: true };
      }
      const normalized = validateFrame(message.frame, {
        atomCount: this.metadata.atom_count,
        expectedSequence: this.latestSequence + 1,
        previousStep: this.lastStep,
        previousTimeFs: this.lastTimeFs,
        previousTimestamp: this.lastTimestamp,
      });
      if (normalized.sequence >= this.metadata.total_frames) {
        throw new StreamProtocolError('frame exceeds declared trajectory length', 'frame_order');
      }
      const diagnostics = this.diagnostics;
      this._recordAcceptedSequences([normalized.sequence], diagnostics, this.latestSequence);
      this._rememberFrame(normalized);
      if (this.referenceFrame === null && normalized.sequence === 0) {
        this.referenceFrame = structuredClone(normalized);
      }
      this._syncBufferDiagnostics(diagnostics, message);
      this._diagnostics = diagnostics;
      return { type: 'frame', message, frame: normalized, accepted: true, duplicate: false };
    }
    if (message.type === 'status') {
      if (message.latest_sequence !== this.latestSequence || message.current_index !== this.latestSequence) {
        throw new StreamProtocolError('status does not match the accepted frame cursor', 'frame_order');
      }
      if (!['starting', 'running', 'paused', 'complete'].includes(message.status)
          || message.paused !== (message.status === 'paused')) {
        throw new StreamProtocolError('invalid producer status');
      }
      const diagnostics = this.diagnostics;
      diagnostics.status = message.status;
      this._syncBufferDiagnostics(diagnostics, message);
      this._diagnostics = diagnostics;
      return { type: 'status', message, runChanged };
    }
    if (message.type === 'error') return { type: 'error', message, runChanged };
    if (message.type === 'pong') return { type: 'pong', message, runChanged };
    throw new StreamProtocolError(`unsupported stream message type ${String(message.type)}`);
  }
}

export function buildReconnectUrl(baseUrl, cursor) {
  if (!cursor) return baseUrl;
  const url = new URL(baseUrl);
  url.searchParams.set('run_id', cursor.runId);
  url.searchParams.set('after', String(cursor.after));
  return url.toString();
}

export { FRAME_SCHEMA, FRAME_UNITS, SCHEMA_VERSION };
