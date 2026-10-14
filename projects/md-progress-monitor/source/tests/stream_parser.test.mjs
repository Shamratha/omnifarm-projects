import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  StreamParser,
  StreamProtocolError,
  buildReconnectUrl,
} from '../public/stream-parser.mjs';

const recording = JSON.parse(
  await readFile(new URL('./recordings/stream-reconnect.json', import.meta.url), 'utf8'),
);

function parserWithInitialFrames() {
  const parser = new StreamParser();
  parser.ingest(recording.metadata);
  parser.ingest(recording.initial_snapshot);
  parser.ingest(recording.status);
  return parser;
}

test('deterministic recording resumes from the accepted sequence cursor', () => {
  const parser = parserWithInitialFrames();
  assert.deepEqual(parser.cursor(), { runId: 'recording-run', after: 1 });

  const frameEvent = parser.ingest(recording.frame_2);
  assert.equal(frameEvent.accepted, true);
  assert.deepEqual(parser.frames.map((frame) => frame.sequence), [0, 1, 2]);

  parser.ingest(recording.reconnect_metadata);
  const resume = parser.ingest(recording.resume_snapshot);
  assert.equal(resume.reset, false);
  assert.deepEqual(parser.frames.map((frame) => frame.sequence), [1, 2, 3]);
  assert.deepEqual(parser.cursor(), { runId: 'recording-run', after: 3 });

  const duplicate = parser.ingest(recording.duplicate_frame_3);
  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(parser.frames.map((frame) => frame.sequence), [1, 2, 3]);
});

test('reconnect URL carries the last accepted run and sequence', () => {
  const url = buildReconnectUrl('ws://127.0.0.1:8765/ws', {
    runId: 'recording-run',
    after: 37,
  });
  assert.equal(url, 'ws://127.0.0.1:8765/ws?run_id=recording-run&after=37');
});

test('reset snapshots replace stale frames after a cursor expiry or run change', () => {
  const parser = parserWithInitialFrames();
  const reset = {
    ...recording.resume_snapshot,
    mode: 'reset',
    reason: 'cursor_expired',
    frames: recording.resume_snapshot.frames,
    oldest_sequence: 3,
  };
  parser.ingest(reset);
  assert.deepEqual(parser.frames.map((frame) => frame.sequence), [3]);
  assert.equal(parser.latestSequence, 3);
});

test('legacy metadata pins frame zero through eviction, reconnect, and same-run reset', () => {
  const parser = parserWithInitialFrames();
  const reference = parser.referenceFrame;
  const expectedReference = structuredClone(reference);

  parser.ingest(recording.frame_2);
  parser.ingest(recording.duplicate_frame_3);
  assert.deepEqual(parser.frames.map((frame) => frame.sequence), [1, 2, 3]);

  parser.ingest(recording.reconnect_metadata);
  parser.ingest({
    ...recording.resume_snapshot,
    mode: 'reset',
    reason: 'cursor_expired',
    frames: [recording.frame_2.frame, recording.resume_snapshot.frames[0]],
    oldest_sequence: 2,
  });

  assert.equal(parser.referenceFrame, reference);
  assert.deepEqual(parser.referenceFrame, expectedReference);
  assert.deepEqual(parser.frames.map((frame) => frame.sequence), [2, 3]);

  parser.ingest({
    ...recording.initial_snapshot,
    reason: 'cursor_ahead',
    frames: [],
    latest_sequence: -1,
    current_index: -1,
  });
  assert.equal(parser.referenceFrame, reference);
  assert.deepEqual(parser.frames, []);
  assert.equal(parser.latestSequence, -1);
});

test('reference frame is a deep clone separate from metadata and retained frames', () => {
  for (const source of ['metadata', 'snapshot', 'live']) {
    const parser = new StreamParser();
    const reference = structuredClone(recording.initial_snapshot.frames[0]);
    const message = structuredClone(recording.metadata);
    if (source === 'metadata') message.reference_frame = reference;
    parser.ingest(message);
    if (source === 'snapshot') parser.ingest({ ...recording.initial_snapshot, frames: [reference,
      recording.initial_snapshot.frames[1]] });
    if (source === 'live') parser.ingest({ ...recording.frame_2, frame: reference });

    const pinned = parser.referenceFrame;
    assert.deepEqual(pinned, recording.initial_snapshot.frames[0], source);
    reference.positions[0][0] = 9;
    reference.units.position = 'nanometer';
    if (source === 'metadata') {
      parser.metadata.reference_frame.positions[0][0] = 8;
      parser.metadata.reference_frame.units.position = 'nanometer';
    } else {
      parser.frames[0].positions[0][0] = 8;
      parser.frames[0].units.position = 'nanometer';
    }
    assert.deepEqual(pinned, recording.initial_snapshot.frames[0], source);
  }
});

test('metadata reference frames are normalized for same-run comparison', () => {
  const parser = new StreamParser();
  const reference = recording.initial_snapshot.frames[0];
  parser.ingest({ ...recording.metadata, reference_frame: reference });
  const pinned = parser.referenceFrame;

  const reorderedReference = {
    positions: structuredClone(reference.positions),
    units: Object.fromEntries(Object.entries(reference.units).reverse()),
    potential_energy_kj_mol: reference.potential_energy_kj_mol,
    temperature_K: reference.temperature_K,
    time_fs: reference.time_fs,
    timestamp: reference.timestamp,
    step: reference.step,
    index: reference.index,
    sequence: reference.sequence,
    schema_version: reference.schema_version,
  };
  const event = parser.ingest({
    ...recording.metadata,
    reference_frame: reorderedReference,
  });

  assert.equal(event.runChanged, false);
  assert.deepEqual(parser.referenceFrame, reference);
  assert.equal(parser.referenceFrame, pinned);
  parser.ingest(recording.reconnect_metadata);
  assert.equal(parser.referenceFrame, pinned);
});

test('a missing legacy reference stays null when a reset starts after sequence zero', () => {
  const parser = new StreamParser();
  parser.ingest(recording.metadata);
  parser.ingest({
    ...recording.initial_snapshot,
    frames: [recording.initial_snapshot.frames[1]],
    current_index: 1,
    latest_sequence: 1,
    oldest_sequence: 1,
  });

  assert.equal(parser.referenceFrame, null);
  parser.ingest(recording.frame_2);
  assert.equal(parser.referenceFrame, null);
  const before = structuredClone(parser.frames);

  parser.ingest({
    ...recording.metadata,
    reference_frame: recording.initial_snapshot.frames[0],
  });
  assert.equal(parser.referenceFrame.sequence, 0);
  assert.deepEqual(parser.frames, before);
  assert.equal(parser.latestSequence, 2);
});

test('invalid and conflicting metadata references are rejected atomically', () => {
  const malformedReferences = [
    null,
    { ...recording.initial_snapshot.frames[0], positions: [] },
    { ...recording.initial_snapshot.frames[0], positions: [[]] },
    { ...recording.initial_snapshot.frames[0], positions: [[NaN, 0, 0]] },
    { ...recording.initial_snapshot.frames[0], sequence: 1, index: 1 },
    { ...recording.initial_snapshot.frames[0], index: 1 },
    { ...recording.initial_snapshot.frames[0], units: { position: 'angstrom' } },
    { ...recording.initial_snapshot.frames[0], units: {
      ...recording.metadata.units, position: 'nanometer',
    } },
  ];

  for (const reference_frame of malformedReferences) {
    for (const run_id of ['recording-run', 'new-run']) {
      for (const parser of [new StreamParser(), parserWithInitialFrames()]) {
        const before = structuredClone({ ...parser });
        const pinned = parser.referenceFrame;
        assert.throws(() => parser.ingest({
          ...recording.metadata, run_id, reference_frame,
        }), StreamProtocolError);
        assert.deepEqual({ ...parser }, before);
        assert.equal(parser.referenceFrame, pinned);
      }
    }
  }

  for (const source of ['metadata', 'snapshot']) {
    const parser = source === 'snapshot' ? parserWithInitialFrames() : new StreamParser();
    if (source === 'metadata') {
      parser.ingest({ ...recording.metadata, reference_frame: recording.initial_snapshot.frames[0] });
      parser.ingest(recording.initial_snapshot);
    }
    const before = structuredClone({ ...parser });
    const pinned = parser.referenceFrame;
    assert.throws(() => parser.ingest({
      ...recording.metadata,
      reference_frame: { ...recording.initial_snapshot.frames[0], positions: [[9, 0, 0]] },
    }), StreamProtocolError);
    assert.deepEqual({ ...parser }, before);
    assert.equal(parser.referenceFrame, pinned);
  }
});

test('rejected snapshots neither pin nor replace a reference frame', () => {
  const invalidSnapshots = [
    { ...recording.initial_snapshot, frames: [recording.initial_snapshot.frames[0],
      { ...recording.initial_snapshot.frames[1], positions: [] }] },
    { ...recording.initial_snapshot, latest_sequence: 2, current_index: 2 },
    { ...recording.initial_snapshot, oldest_sequence: 1 },
  ];
  for (const snapshot of invalidSnapshots) {
    for (const parser of [new StreamParser(), parserWithInitialFrames()]) {
      if (!parser.metadata) parser.ingest(recording.metadata);
      const before = structuredClone({ ...parser });
      const pinned = parser.referenceFrame;
      assert.throws(() => parser.ingest(snapshot), StreamProtocolError);
      assert.deepEqual({ ...parser }, before);
      assert.equal(parser.referenceFrame, pinned);
    }
  }
});

test('reference extension is not allowed inside an individual frame', () => {
  const parser = new StreamParser();
  parser.ingest(recording.metadata);
  const before = structuredClone({ ...parser });
  assert.throws(() => parser.ingest({
    ...recording.frame_2,
    frame: { ...recording.initial_snapshot.frames[0],
      reference_frame: recording.initial_snapshot.frames[0] },
  }), StreamProtocolError);
  assert.deepEqual({ ...parser }, before);
});

test('invalid recorded frames are rejected without mutating parser state', () => {
  const cases = [
    ['duplicate step', { ...recording.frame_2, frame: { ...recording.frame_2.frame, step: 10 } }, 'duplicate_step'],
    ['missing coordinates', { ...recording.frame_2, frame: { ...recording.frame_2.frame, positions: [] } }, 'missing_coordinates'],
    ['missing units', { ...recording.frame_2, frame: { ...recording.frame_2.frame, units: { position: 'angstrom' } } }, 'missing_units'],
    ['out of order sequence', { ...recording.frame_2, frame: { ...recording.frame_2.frame, sequence: 4, index: 4 } }, 'frame_order'],
  ];

  for (const [label, message, code] of cases) {
    const parser = parserWithInitialFrames();
    assert.throws(() => parser.ingest(message), (error) => {
      assert(error instanceof StreamProtocolError, label);
      assert.equal(error.code, code, label);
      return true;
    });
    assert.deepEqual(parser.frames.map((frame) => frame.sequence), [0, 1], label);
    assert.equal(parser.latestSequence, 1, label);
  }
});

test('invalid JSON and metadata do not advance the reconnect cursor', () => {
  const parser = new StreamParser();
  assert.throws(() => parser.ingest('{'), (error) => {
    assert(error instanceof StreamProtocolError);
    assert.equal(error.code, 'invalid_json');
    return true;
  });
  assert.equal(parser.cursor(), null);

  const invalidMetadata = { ...recording.metadata, run_id: 'bad-run', units: { position: 'angstrom' } };
  assert.throws(() => parser.ingest(invalidMetadata), (error) => {
    assert(error instanceof StreamProtocolError);
    assert.equal(error.code, 'missing_units');
    return true;
  });
  assert.equal(parser.cursor(), null);

  const parserWithState = parserWithInitialFrames();
  assert.throws(() => parserWithState.ingest({ ...recording.metadata, run_id: 'new-run', frame_schema: 'unknown' }), (error) => {
    assert(error instanceof StreamProtocolError);
    assert.equal(error.code, 'unsupported_schema');
    return true;
  });
  assert.deepEqual(parserWithState.cursor(), { runId: 'recording-run', after: 1 });
});

test('a new run ID resets the client cursor and frame buffer', () => {
  const parser = parserWithInitialFrames();
  assert.equal(parser.referenceFrame.sequence, 0);
  const metadata = { ...recording.metadata, run_id: 'new-recording-run' };
  const snapshot = {
    ...recording.initial_snapshot,
    run_id: 'new-recording-run',
    frames: [recording.initial_snapshot.frames[0]],
    latest_sequence: 0,
    current_index: 0,
  };
  const metadataEvent = parser.ingest(metadata);
  assert.equal(metadataEvent.runChanged, true);
  assert.equal(parser.referenceFrame, null);
  parser.ingest(snapshot);
  assert.deepEqual(parser.cursor(), { runId: 'new-recording-run', after: 0 });
  assert.deepEqual(parser.frames.map((frame) => frame.sequence), [0]);
  assert.equal(parser.referenceFrame.sequence, 0);
});

test('new-run metadata immediately installs its own reference without adding a buffered frame', () => {
  const parser = parserWithInitialFrames();
  const reference = { ...recording.initial_snapshot.frames[0], positions: [[5, 0, 0]] };
  const event = parser.ingest({
    ...recording.metadata,
    run_id: 'new-recording-run',
    reference_frame: reference,
  });
  assert.equal(event.runChanged, true);
  assert.deepEqual(parser.referenceFrame, reference);
  assert.deepEqual(parser.frames, []);
  assert.deepEqual(parser.cursor(), { runId: 'new-recording-run', after: -1 });
  assert.equal(parser.lastStep, null);
  assert.equal(parser.lastTimeFs, null);
  assert.equal(parser.lastTimestamp, null);
});
