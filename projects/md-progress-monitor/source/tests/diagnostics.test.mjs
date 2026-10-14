import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { StreamParser, StreamProtocolError } from '../public/stream-parser.mjs';

const recording = JSON.parse(
  await readFile(new URL('./recordings/stream-reconnect.json', import.meta.url), 'utf8'),
);

function parserWithFrames() {
  const parser = new StreamParser();
  parser.ingest(recording.metadata);
  parser.ingest(recording.initial_snapshot);
  return parser;
}

test('diagnostics count an observed accepted sequence gap and preserve the distinction', () => {
  const parser = parserWithFrames();
  parser.ingest({
    ...recording.resume_snapshot,
    mode: 'reset',
    reason: 'cursor_expired',
    frames: [recording.resume_snapshot.frames[0]],
    oldest_sequence: 3,
  });

  assert.deepEqual(parser.diagnostics, {
    gapCount: 1,
    missingSequenceCount: 1,
    duplicateCount: 0,
    reconnectResetCount: 1,
    cursorExpiredCount: 1,
    observedDroppedBeforeReconnect: 1,
    retainedFrames: 1,
    estimatedDroppedFrames: 1,
    bufferCapacity: 3,
    bufferUsage: 1,
    bufferUsageSource: 'snapshot',
    oldestSequence: 3,
    latestSequence: 3,
    lastResetReason: 'cursor_expired',
    status: null,
  });
});

test('identical duplicates increment diagnostics while conflicting duplicates remain protocol errors', () => {
  const parser = parserWithFrames();
  const duplicate = {
    ...recording.frame_2,
    frame: recording.initial_snapshot.frames[1],
  };
  const event = parser.ingest(duplicate);

  assert.equal(event.accepted, false);
  assert.equal(event.duplicate, true);
  assert.equal(parser.diagnostics.duplicateCount, 1);

  assert.throws(() => parser.ingest({
    ...duplicate,
    frame: { ...duplicate.frame, temperature_K: 300 },
  }), (error) => error instanceof StreamProtocolError && error.code === 'duplicate_sequence');
  assert.equal(parser.diagnostics.duplicateCount, 1);
});

test('diagnostics expose retained frames and the bounded-buffer estimate from snapshot bounds', () => {
  const parser = parserWithFrames();
  parser.ingest(recording.status);
  parser.ingest(recording.frame_2);
  parser.ingest(recording.reconnect_metadata);
  parser.ingest(recording.resume_snapshot);

  assert.deepEqual(parser.frames.map((frame) => frame.sequence), [1, 2, 3]);
  assert.equal(parser.diagnostics.retainedFrames, 3);
  assert.equal(parser.diagnostics.bufferCapacity, 3);
  assert.equal(parser.diagnostics.bufferUsage, 3);
  assert.equal(parser.diagnostics.oldestSequence, 1);
  assert.equal(parser.diagnostics.latestSequence, 3);
  assert.equal(parser.diagnostics.estimatedDroppedFrames, 0);
  assert.equal(parser.diagnostics.bufferUsageSource, 'inferred');

  parser.ingest({
    ...recording.status,
    latest_sequence: 3,
    current_index: 3,
    buffer_size: 2,
  });
  assert.equal(parser.diagnostics.bufferUsage, 2);
  assert.equal(parser.diagnostics.estimatedDroppedFrames, 1);
});

test('diagnostics reset for a new run and counters continue within that run', () => {
  const parser = parserWithFrames();
  parser.ingest({
    ...recording.resume_snapshot,
    mode: 'reset',
    reason: 'cursor_expired',
    frames: [recording.resume_snapshot.frames[0]],
    oldest_sequence: 3,
  });
  assert.equal(parser.diagnostics.reconnectResetCount, 1);

  const newRunMetadata = { ...recording.metadata, run_id: 'new-run' };
  const newRunSnapshot = {
    ...recording.initial_snapshot,
    run_id: 'new-run',
    frames: [recording.initial_snapshot.frames[0]],
    current_index: 0,
    latest_sequence: 0,
    oldest_sequence: 0,
  };
  const event = parser.ingest(newRunMetadata);
  assert.equal(event.runChanged, true);
  assert.deepEqual(parser.diagnostics, {
    gapCount: 0,
    missingSequenceCount: 0,
    duplicateCount: 0,
    reconnectResetCount: 0,
    cursorExpiredCount: 0,
    observedDroppedBeforeReconnect: 0,
    retainedFrames: 0,
    estimatedDroppedFrames: 0,
    bufferCapacity: 3,
    bufferUsage: 0,
    bufferUsageSource: 'inferred',
    oldestSequence: null,
    latestSequence: -1,
    lastResetReason: null,
    status: null,
  });

  parser.ingest(newRunSnapshot);
  assert.equal(parser.diagnostics.reconnectResetCount, 0);
  assert.equal(parser.diagnostics.retainedFrames, 1);
  assert.equal(parser.diagnostics.latestSequence, 0);
});
