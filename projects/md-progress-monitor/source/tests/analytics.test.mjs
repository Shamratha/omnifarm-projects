import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  calculateRmsd,
  deriveFrames,
  retainedCsv,
  selectPlotFrames,
  summarizeMetrics,
} from '../public/analytics.mjs';
import { StreamParser } from '../public/stream-parser.mjs';

const recording = JSON.parse(
  await readFile(new URL('./recordings/stream-reconnect.json', import.meta.url), 'utf8'),
);

function frame(index, values = {}) {
  return {
    schema_version: 1,
    sequence: index,
    index,
    step: index * 10,
    timestamp: `2026-05-18T10:00:00.${String(index).padStart(3, '0')}Z`,
    time_fs: index * 10,
    temperature_K: 298 + index,
    potential_energy_kj_mol: -10 - index,
    units: {
      position: 'angstrom',
      time: 'femtosecond',
      temperature: 'kelvin',
      potential_energy: 'kilojoule_per_mole',
    },
    positions: [[index, index + 1, index + 2]],
    ...values,
  };
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function parseCsv(csv) {
  const records = [];
  let record = [];
  let field = '';
  let quoted = false;
  let afterQuote = false;
  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];
    if (quoted) {
      if (character === '"' && csv[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
        afterQuote = true;
      } else {
        field += character;
      }
    } else if (character === '"' && field === '') {
      assert.equal(afterQuote, false);
      quoted = true;
    } else if (character === ',') {
      record.push(field);
      field = '';
      afterQuote = false;
    } else if (character === '\r' && csv[index + 1] === '\n') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      afterQuote = false;
      index += 1;
    } else {
      assert.equal(afterQuote, false, 'characters after a quoted field');
      assert.notEqual(character, '"', 'unescaped quote');
      assert.notEqual(character, '\n', 'unquoted newline');
      assert.notEqual(character, '\r', 'record separator must be CRLF');
      field += character;
    }
  }
  assert.equal(quoted, false);
  assert.equal(field, '');
  assert.deepEqual(record, []);
  return records;
}

test('calculateRmsd averages nonuniform xyz displacements over all atoms', () => {
  assert.equal(
    calculateRmsd(
      [[4, 2, 3], [4, 5, 6], [-3, 2, 1]],
      [[1, -2, 3], [4, 5, -6], [-3, 2, 1]],
    ),
    Math.sqrt(169 / 3),
  );
  assert.equal(calculateRmsd([[3, 4, 12]], [[0, 0, 0]]), 13);
  const positions = [[-4, 5, 2], [3, 4, 1]];
  assert.equal(calculateRmsd(positions, positions), 0);
});

test('translations and rotations count as displacement without alignment or unwrapping', () => {
  const reference = [[1, 0, 0], [-1, 0, 0], [0, 2, 1]];
  const translated = reference.map(([x, y, z]) => [x + 3, y - 4, z + 12]);
  assert.equal(calculateRmsd(translated, reference), 13);
  assert.equal(
    calculateRmsd([[0, 1, 0], [0, -1, 0], [-2, 0, 1]], reference),
    2,
  );
  assert.equal(calculateRmsd([[9.5, 0, 0]], [[0.5, 0, 0]]), 9);
});

test('calculateRmsd rejects empty, mismatched, and malformed coordinates', () => {
  assert.throws(() => calculateRmsd([], []), RangeError);
  assert.throws(() => calculateRmsd([[0, 0, 0]], []), RangeError);
  assert.throws(() => calculateRmsd([[0, 0, 0]], [[0, 0, 0], [1, 1, 1]]), RangeError);
  assert.throws(() => calculateRmsd([[0, 0, 0], [1, 1, 1]], [[0, 0, 0]]), RangeError);
  const malformed = [
    null, undefined, {}, '[[0,0,0]]', new Array(1), [null], [[0, 0]],
    [[0, 0, 0, 0]], [new Array(3)], [{ 0: 0, 1: 0, 2: 0 }],
    ...[NaN, Infinity, -Infinity, '0', null, undefined, true].map((value) => [[0, value, 0]]),
  ];
  for (const positions of malformed) {
    assert.throws(() => calculateRmsd(positions, [[0, 0, 0]]), TypeError);
    assert.throws(() => calculateRmsd([[0, 0, 0]], positions), TypeError);
  }
});

test('deriveFrames adds RMSD to copies and leaves source frames unchanged', () => {
  const source = deepFreeze([frame(0, { rmsd_angstrom: 99, label: 'preserved' }), frame(1)]);
  const original = structuredClone(source);
  const derived = deriveFrames(source, source[0]);

  assert.notEqual(derived, source);
  assert.notEqual(derived[0], source[0]);
  assert.deepEqual(source, original);
  assert.equal(derived[0].rmsd_angstrom, 0);
  assert.equal(derived[1].rmsd_angstrom, Math.sqrt(3));
  assert.equal(derived[0].label, 'preserved');
  const withoutReference = source.map((item) => ({ ...item, rmsd_angstrom: null }));
  assert.deepEqual(deriveFrames(source), withoutReference);
  assert.deepEqual(deriveFrames(source, null), withoutReference);
  assert.deepEqual(deriveFrames(source, undefined), withoutReference);
  assert.deepEqual(deriveFrames([]), []);
  assert.deepEqual(deriveFrames([], source[0]), []);
  assert.throws(() => deriveFrames(source, { positions: [[NaN, 0, 0]] }), TypeError);
  assert.throws(() => deriveFrames(source, { positions: [[0, 0, 0], [1, 1, 1]] }), RangeError);
  assert.deepEqual(source, original);
});

test('summarizeMetrics ignores null and non-finite values with population stddev', () => {
  const summary = summarizeMetrics([
    { temperature_K: 1, potential_energy_kj_mol: -1, rmsd_angstrom: null },
    { temperature_K: 2, potential_energy_kj_mol: 1, rmsd_angstrom: 2 },
    { temperature_K: 3, potential_energy_kj_mol: Infinity, rmsd_angstrom: 4 },
    { temperature_K: NaN, potential_energy_kj_mol: 3, rmsd_angstrom: '5' },
    { temperature_K: null, potential_energy_kj_mol: null, rmsd_angstrom: 6 },
  ]);

  assert.equal(summary.count, 5);
  assert.deepEqual(summary.temperature_K, {
    count: 3, mean: 2, min: 1, max: 3, stddev: Math.sqrt(2 / 3),
  });
  assert.deepEqual(summary.potential_energy_kj_mol, {
    count: 3, mean: 1, min: -1, max: 3, stddev: Math.sqrt(8 / 3),
  });
  assert.deepEqual(summary.rmsd_angstrom, {
    count: 3, mean: 4, min: 2, max: 6, stddev: Math.sqrt(8 / 3),
  });
  assert.deepEqual(summarizeMetrics([]), {
    count: 0,
    temperature_K: { count: 0, mean: null, min: null, max: null, stddev: null },
    potential_energy_kj_mol: { count: 0, mean: null, min: null, max: null, stddev: null },
    rmsd_angstrom: { count: 0, mean: null, min: null, max: null, stddev: null },
  });
});

test('summaries return null for unavailable metrics and do not coerce values', () => {
  const empty = { count: 0, mean: null, min: null, max: null, stddev: null };
  assert.deepEqual(summarizeMetrics([
    {},
    { temperature_K: null, potential_energy_kj_mol: undefined, rmsd_angstrom: NaN },
    { temperature_K: '298', potential_energy_kj_mol: -Infinity, rmsd_angstrom: false },
  ]), {
    count: 3,
    temperature_K: empty,
    potential_energy_kj_mol: empty,
    rmsd_angstrom: empty,
  });
  assert.deepEqual(summarizeMetrics([{ rmsd_angstrom: 0 }]).rmsd_angstrom, {
    count: 1, mean: 0, min: 0, max: 0, stddev: 0,
  });
});

test('summaries retain variance at a large offset and give zero for constants', () => {
  const frames = [1, 2, 3, 4].map((value) => ({ temperature_K: 1e12 + value }));
  assert.deepEqual(summarizeMetrics(frames).temperature_K, {
    count: 4, mean: 1e12 + 2.5, min: 1e12 + 1, max: 1e12 + 4, stddev: Math.sqrt(1.25),
  });
  assert.deepEqual(summarizeMetrics(Array.from({ length: 10 }, () => ({
    temperature_K: 300,
  }))).temperature_K, {
    count: 10, mean: 300, min: 300, max: 300, stddev: 0,
  });
});

test('selectPlotFrames retains a trailing full-resolution window and uniform endpoints', () => {
  const frames = Array.from({ length: 10 }, (_, index) => frame(index));
  const selected = selectPlotFrames(frames, { windowSize: 4, maxPoints: 3 });
  assert.deepEqual(selected.windowFrames.map((item) => item.index), [6, 7, 8, 9]);
  assert.deepEqual(selected.displayFrames.map((item) => item.index), [6, 8, 9]);
  assert.notEqual(selected.windowFrames, frames);
  assert.notEqual(selected.displayFrames, selected.windowFrames);
  assert.deepEqual(selectPlotFrames(frames, { maxPoints: 200 }).displayFrames, frames);
  assert.deepEqual(selectPlotFrames(frames, { maxPoints: 2 }).displayFrames.map((item) => item.index), [0, 9]);
  assert.deepEqual(selectPlotFrames([], { windowSize: 3, maxPoints: 2 }), {
    windowFrames: [],
    displayFrames: [],
  });
  assert.deepEqual(selectPlotFrames(frames, { windowSize: 1 }), {
    windowFrames: [frames[9]], displayFrames: [frames[9]],
  });
  assert.deepEqual(selectPlotFrames(frames, {
    windowSize: Number.MAX_SAFE_INTEGER, maxPoints: Number.MAX_SAFE_INTEGER,
  }), { windowFrames: frames, displayFrames: frames });
});

test('uniform sampling is deterministic, index-based, duplicate-free, and handles small cases', () => {
  const frames = [1, 2, 10, 20, 21, 34, 50, 51, 80, 99].map((sequence, index) => (
    frame(index, { sequence, temperature_K: 300 })
  ));
  const expected = [frames[0], frames[3], frames[6], frames[9]];
  assert.deepEqual(selectPlotFrames(frames, { maxPoints: 4 }).displayFrames, expected);
  assert.deepEqual(selectPlotFrames(frames, { maxPoints: 4 }).displayFrames, expected);

  for (let count = 0; count <= 25; count += 1) {
    const source = Array.from({ length: count }, (_, index) => frame(index));
    for (let cap = 2; cap <= 12; cap += 1) {
      const { windowFrames, displayFrames } = selectPlotFrames(source, { maxPoints: cap });
      assert.deepEqual(windowFrames, source);
      assert.equal(displayFrames.length, Math.min(count, cap));
      assert.equal(new Set(displayFrames).size, displayFrames.length);
      if (count === 0) continue;
      assert.equal(displayFrames[0], source[0]);
      assert.equal(displayFrames.at(-1), source.at(-1));
      const idealGap = (count - 1) / (displayFrames.length - 1);
      for (let index = 1; index < displayFrames.length; index += 1) {
        const gap = displayFrames[index].index - displayFrames[index - 1].index;
        assert(gap === Math.floor(idealGap) || gap === Math.ceil(idealGap));
      }
    }
  }
  const large = Array.from({ length: 401 }, (_, index) => frame(index));
  const defaults = selectPlotFrames(large);
  assert.equal(defaults.windowFrames.length, 401);
  assert.equal(defaults.displayFrames.length, 200);
  assert.equal(defaults.displayFrames[0], large[0]);
  assert.equal(defaults.displayFrames.at(-1), large.at(-1));
});

test('selectPlotFrames validates safe bounds even for empty input', () => {
  for (const windowSize of [-1, 1.5, '2', NaN, Infinity, null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => selectPlotFrames([], { windowSize }), RangeError);
  }
  for (const maxPoints of [0, 1, -1, 2.5, '2', NaN, Infinity, null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => selectPlotFrames([], { maxPoints }), RangeError);
  }
  assert.throws(() => selectPlotFrames(null), TypeError);
  assert.throws(() => selectPlotFrames([frame(0), frame(0)]), RangeError);
  assert.throws(() => selectPlotFrames([frame(0), frame(1, { sequence: '1' })]), TypeError);
  assert.deepEqual(selectPlotFrames([{ marker: 'a' }, { marker: 'b' }], { maxPoints: 2 }).windowFrames, [
    { marker: 'a' }, { marker: 'b' },
  ]);
});

test('reconnection-retained frames remain full resolution while display frames are capped', () => {
  const parser = new StreamParser();
  parser.ingest(recording.metadata);
  parser.ingest(recording.initial_snapshot);
  const reference = parser.frames[0];
  parser.ingest(recording.frame_2);
  parser.ingest(recording.reconnect_metadata);
  parser.ingest(recording.resume_snapshot);
  const beforeDuplicate = retainedCsv(deriveFrames(parser.frames, reference), {
    runId: parser.runId, referenceSequence: reference.sequence,
  });
  const duplicate = parser.ingest(recording.duplicate_frame_3);

  assert.equal(duplicate.accepted, false);
  assert.deepEqual(parser.frames.map((item) => item.sequence), [1, 2, 3]);
  const derived = deriveFrames(parser.frames, reference);
  const plot = selectPlotFrames(derived, { maxPoints: 2 });
  assert.deepEqual(plot.windowFrames.map((item) => item.sequence), [1, 2, 3]);
  assert.deepEqual(plot.displayFrames.map((item) => item.sequence), [1, 3]);
  assert.equal(selectPlotFrames(derived, { windowSize: 1 }).displayFrames.length, 1);
  assert.deepEqual(summarizeMetrics(derived).temperature_K, {
    count: 3, mean: 300, min: 299, max: 301, stddev: Math.sqrt(2 / 3),
  });
  const csv = retainedCsv(derived, { runId: parser.runId, referenceSequence: reference.sequence });
  assert.equal(csv, beforeDuplicate);
  const records = parseCsv(csv);
  assert.equal(records.length, 4);
  assert.deepEqual(records.slice(1).map((row) => row[2]), ['1', '2', '3']);
  for (let index = 0; index < derived.length; index += 1) {
    const row = records[index + 1];
    assert.equal(row[9], String(derived[index].rmsd_angstrom));
    assert.equal(row[10], '0');
    assert.deepEqual(JSON.parse(row[16]), parser.frames[index].positions);
  }
});

test('retainedCsv emits every frame in sequence order with RFC4180-safe fields', () => {
  const frames = [
    frame(1, { rmsd_angstrom: null, positions: [[1, 2, 3], [4, 5, 6]] }),
    frame(0, {
      time_fs: 0.30000000000000004,
      temperature_K: 298.1234567890123,
      potential_energy_kj_mol: -1234.5678901234567,
      rmsd_angstrom: 1.2345678901234567e-7,
      positions: [[-1.2345678901234567, 5e-8, 1e21]],
    }),
  ];
  const runId = 'run,"quoted"\r\nnext\nline\rreturn';
  const csv = retainedCsv(frames, { runId, referenceSequence: 0 });
  assert.equal(csv.endsWith('\r\n'), true);
  const records = parseCsv(csv);
  assert.equal(records.length, 3);
  assert.deepEqual(records[0], [
    'schema_version', 'run_id', 'sequence', 'index', 'step', 'timestamp', 'time_fs',
    'temperature_K', 'potential_energy_kj_mol', 'rmsd_angstrom',
    'rmsd_reference_sequence', 'rmsd_alignment', 'position_unit', 'time_unit',
    'temperature_unit', 'potential_energy_unit', 'positions_json',
  ]);
  const first = frames[1];
  assert.deepEqual(records[1], [
    '1', runId, '0', '0', '0', first.timestamp, String(first.time_fs),
    String(first.temperature_K), String(first.potential_energy_kj_mol),
    String(first.rmsd_angstrom), '0', 'none', 'angstrom', 'femtosecond', 'kelvin',
    'kilojoule_per_mole', JSON.stringify(first.positions),
  ]);
  assert.deepEqual(JSON.parse(records[2][16]), [[1, 2, 3], [4, 5, 6]]);
  assert.equal(records[2][9], '');
  assert.equal(records[2][2], '1');
  assert.equal(records[2][7], '299');
  assert.equal(retainedCsv([]), `${records[0].join(',')}\r\n`);
  records.forEach((row) => assert.equal(row.length, 17));
});

test('retainedCsv protects formula-like text without changing numeric fields', () => {
  for (const runId of [
    '=SUM(A1:A2)', '+cmd', '-cmd', '@SUM(A1:A2)', '  =1', '\t=1', '\r=1', '\n=1',
  ]) {
    const records = parseCsv(retainedCsv([frame(0)], { runId }));
    assert.equal(records[1][1], `'${runId}`);
    assert.equal(records[1][2], '0');
    assert.equal(records[1][8], '-10');
  }
});

test('retainedCsv keeps frame units exact and leaves unavailable reference/RMSD blank', () => {
  const units = {
    position: 'angstrom,exact',
    time: 'femto"second',
    temperature: 'kelvin\nexact',
    potential_energy: 'kilojoule\r\nper_mole',
  };
  const source = [frame(0, { units, rmsd_angstrom: 2 })];
  const row = parseCsv(retainedCsv(source))[1];
  assert.equal(row[1], '');
  assert.equal(row[9], '');
  assert.equal(row[10], '');
  assert.equal(row[11], 'none');
  assert.deepEqual(row.slice(12, 16), [
    units.position, units.time, units.temperature, units.potential_energy,
  ]);
  for (const rmsd_angstrom of [null, undefined, NaN, Infinity, -Infinity]) {
    const records = parseCsv(retainedCsv([frame(0, { rmsd_angstrom })], {
      referenceSequence: 0,
    }));
    assert.equal(records[1][9], '');
    assert.equal(records[1][10], '0');
  }
});

test('all exports accept frozen inputs without mutating frames, reference, or options', () => {
  const frames = deepFreeze([frame(0), frame(1), frame(2)]);
  const reference = deepFreeze(frame(10));
  const before = structuredClone({ frames, reference });
  calculateRmsd(frames[0].positions, reference.positions);
  deriveFrames(frames, reference);
  summarizeMetrics(frames);
  const plotOptions = deepFreeze({ windowSize: 2, maxPoints: 2 });
  selectPlotFrames(frames, plotOptions);
  const unsorted = deepFreeze([frames[2], frames[0], frames[1]]);
  const csvOptions = deepFreeze({ runId: 'immutable', referenceSequence: 10 });
  retainedCsv(unsorted, csvOptions);
  assert.deepEqual({ frames, reference }, before);
  assert.deepEqual(unsorted.map((item) => item.sequence), [2, 0, 1]);
  assert.deepEqual(plotOptions, { windowSize: 2, maxPoints: 2 });
  assert.deepEqual(csvOptions, { runId: 'immutable', referenceSequence: 10 });
});
