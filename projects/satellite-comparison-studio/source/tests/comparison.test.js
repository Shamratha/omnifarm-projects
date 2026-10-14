import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, compareTiles, daysBetween, isStale } from '../src/engine.js';
import { buildReadableReport } from '../src/report.js';

const NOW = '2025-06-18T12:00:00Z';

function tile(overrides = {}) {
  return {
    id: 'tile',
    width: 2,
    height: 2,
    crs: 'LOCAL-SYNTHETIC',
    origin: [100, 200],
    resolution: [10, 10],
    date: '2025-06-18T09:00:00Z',
    values: [0.1, 0.2, 0.3, 0.4],
    cloud: [false, false, false, false],
    nodata: [false, false, false, false],
    confidence: [0.9, 0.9, 0.9, 0.9],
    ...overrides,
  };
}

test('requires aligned dimensions, origin, resolution, and CRS', () => {
  const alignmentCases = [
    ['grid dimensions', { width: 1, height: 4 }],
    ['origin', { origin: [101, 200] }],
    ['origin', { origin: [100, 200 + 1e-10] }],
    ['resolution', { resolution: [20, 10] }],
    ['resolution', { resolution: [10, 10 + 1e-10] }],
    ['crs', { crs: 'EPSG:4326' }],
  ];
  for (const [part, overrides] of alignmentCases) {
    assert.throws(
      () => compareTiles(tile(), tile(overrides), 0.1, { now: NOW }),
      new RegExp(`matching ${part}`),
    );
  }
});

test('unions cloud and nodata masks from both timestamps', () => {
  const before = tile({
    values: [0, 0.5, 0.5, 0.5],
    nodata: [true, false, false, false],
    cloud: [false, true, false, false],
  });
  const after = tile({
    values: [1, 0.8, 0.5, 0.7],
    nodata: [false, false, true, false],
    cloud: [false, false, false, true],
  });
  const result = compareTiles(before, after, 0.2, { now: NOW });

  assert.deepEqual(result.valid, [false, false, false, false]);
  assert.deepEqual(result.cloudIndices, [1, 3]);
  assert.deepEqual(result.nodataIndices, [0, 2]);
  assert.equal(result.cloudCount, 2);
  assert.equal(result.nodataCount, 2);
  assert.equal(result.validCount, 0);
});

test('excludes nodata borders at either timestamp while retaining the interior', () => {
  const before = tile({
    width: 3,
    height: 3,
    values: Array(9).fill(0),
    nodata: [true, true, true, true, false, true, false, false, false],
    cloud: Array(9).fill(false),
    confidence: Array(9).fill(0.9),
  });
  const after = {
    ...before,
    values: Array(9).fill(1),
    nodata: [false, false, false, false, false, false, true, true, true],
  };
  const result = compareTiles(before, after, 0.2, { now: NOW });
  assert.deepEqual(result.changed, [false, false, false, false, true, false, false, false, false]);
  assert.equal(result.validCount, 1);
  assert.equal(result.nodataCount, 8);
  assert.equal(result.coverage, 1 / 9);
  assert.equal(result.changedFraction, 1);
});

test('overlapping masks count each pixel once per mask and once in total exclusions', () => {
  const before = tile({
    cloud: [true, false, false, false],
    nodata: [false, true, false, false],
  });
  const after = tile({
    values: [1, 1, 0.6, 0.4],
    cloud: [true, true, false, false],
    nodata: [true, true, false, false],
  });
  const result = compareTiles(before, after, 0.2, { now: NOW });
  assert.deepEqual(result.valid, [false, false, true, true]);
  assert.equal(result.cloudCount, 2);
  assert.equal(result.nodataCount, 2);
  assert.equal(result.excludedCount, 2);
  assert.equal(result.changedCount, 1);
  assert.equal(result.changedFraction, 0.5);
  assert.equal(result.coverage, 0.5);
});

test('threshold ties are inclusive with a small floating point tolerance', () => {
  const result = compareTiles(
    tile({ values: [0.1, 0.1, 0.1, 0.1] }),
    tile({ values: [0.3, 0.3001, 0.2999, 0.1] }),
    0.2,
    { now: NOW },
  );
  assert.deepEqual(result.changed, [true, true, false, false]);
  const meaningfullyBelow = compareTiles(
    tile({ values: [0, 0, 0, 0] }),
    tile({ values: [0.2 - 1e-12, 0.2, 0.2 + 1e-12, 0] }),
    0.2,
    { now: NOW },
  );
  assert.deepEqual(meaningfullyBelow.changed, [false, true, true, false]);
});

test('zero threshold documents the inclusive >= 0 policy', () => {
  const result = compareTiles(tile(), tile(), 0, { now: NOW });
  assert.deepEqual(result.changed, [true, true, true, true]);
  assert.equal(result.changedFraction, 1);
  const masked = compareTiles(tile({ nodata: [true, false, false, false] }), tile(), 0, { now: NOW });
  assert.deepEqual(masked.changed, [false, true, true, true]);
});

test('validates values, masks, confidence, and threshold', () => {
  assert.throws(() => compareTiles(tile({ values: [0, 0, 0] }), tile(), 0.1, { now: NOW }), /values/);
  assert.throws(() => compareTiles(tile({ cloud: [false, false] }), tile(), 0.1, { now: NOW }), /cloud/);
  assert.throws(() => compareTiles(tile({ cloud: [false, 0, false, false] }), tile(), 0.1, { now: NOW }), /cloud/);
  assert.throws(() => compareTiles(tile({ confidence: [0.9, 1.2, 0.9, 0.9] }), tile(), 0.1, { now: NOW }), /confidence/);
  assert.throws(() => compareTiles(tile(), tile(), -0.1, { now: NOW }), /threshold/);
  assert.throws(() => compareTiles(tile(), tile(), 1.1, { now: NOW }), /threshold/);
  for (const threshold of [NaN, Infinity, -Infinity, '0.2', null, undefined]) {
    assert.throws(() => compareTiles(tile(), tile(), threshold, { now: NOW }), /threshold/);
  }
  assert.throws(() => compareTiles(tile({ values: [0, null, 0, 0] }), tile(), 0.1, { now: NOW }), /values/);
  assert.throws(() => compareTiles(tile({ values: new Float64Array(4) }), tile(), 0.1, { now: NOW }), /values/);
  assert.throws(() => compareTiles(tile({ nodata: new Uint8Array([0, 0, 2, 0]) }), tile(), 0.1, { now: NOW }), /nodata/);
  assert.throws(() => compareTiles(tile({ nodata: new Set() }), tile(), 0.1, { now: NOW }), /nodata/);
  assert.throws(() => compareTiles(tile({ confidence: [0.9, NaN, 0.9, 0.9] }), tile(), 0.1, { now: NOW }), /confidence/);
  assert.throws(() => compareTiles(tile({ confidence: [0.9, -0.1, 0.9, 0.9] }), tile(), 0.1, { now: NOW }), /confidence/);
});

test('rejects malformed geometry and sparse arrays', () => {
  for (const overrides of [
    { width: 0 }, { height: 1.5 }, { crs: '' }, { origin: [NaN, 0] },
    { resolution: [0, 10] }, { origin: Array(2) }, { values: Array(4) },
    { cloud: Array(4) }, { confidence: Array(4) },
  ]) {
    assert.throws(() => compareTiles(tile(overrides), tile(), 0.1, { now: NOW }));
  }
});

test('non-finite numeric samples are excluded and never leak NaN into outputs', () => {
  const result = compareTiles(
    tile({ values: [NaN, 0, 0, 0] }),
    tile({ values: [0, Infinity, -Infinity, 0.5] }),
    0.2,
    { now: NOW },
  );
  assert.deepEqual(result.valid, [false, false, false, true]);
  assert.deepEqual(result.differences, [null, null, null, 0.5]);
  assert.deepEqual(result.confidence, [null, null, null, 0.9]);
  assert.equal(result.nonFiniteCount, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  assert.throws(() => compareTiles(
    tile({ values: [-Number.MAX_VALUE, 0, 0, 0] }),
    tile({ values: [Number.MAX_VALUE, 0, 0, 0] }),
    0.2,
    { now: NOW },
  ), /finite numeric range/);
});

test('staleness is evaluated at the exact boundary with a fixed clock', () => {
  assert.equal(daysBetween(NOW, '2025-06-04T12:00:00Z'), 14);
  assert.equal(isStale('2025-06-04T12:00:00Z', NOW), false);
  assert.equal(isStale('2025-06-04T11:59:59Z', NOW), true);
  assert.equal(isStale(null, NOW), true);
  assert.throws(() => isStale('2025-06-19T00:00:00Z', NOW), /future/);
  assert.equal(isStale('not a timestamp', NOW), true);
  assert.equal(isStale('2025-06-18T12:00:00Z', NOW, 0), false);
  assert.equal(isStale('2025-06-17T12:00:00Z', NOW, 0), true);
  assert.equal(daysBetween('2025-06-18T11:00:00Z', NOW), -1 / 24);
  assert.equal(daysBetween(new Date(NOW), new Date('2025-06-18T00:00:00Z')), 0.5);
  assert.throws(() => daysBetween(NOW, null), /timestamp/);
  assert.throws(() => isStale(NOW, 'not a timestamp'), /now/);
  for (const maxAgeDays of [-1, NaN, Infinity, '14']) {
    assert.throws(() => isStale(NOW, NOW, maxAgeDays), /maxAgeDays/);
  }
});

test('comparison rejects invalid/future dates and reports each timestamp freshness separately', () => {
  for (const date of [null, 'invalid', new Date(NaN), 0]) {
    assert.throws(() => compareTiles(tile({ date }), tile(), 0.2, { now: NOW }), /date/);
    assert.throws(() => compareTiles(tile(), tile({ date }), 0.2, { now: NOW }), /date/);
  }
  assert.throws(() => compareTiles(tile(), tile({ date: '2025-06-19T00:00:00Z' }), 0.2, { now: NOW }), /future/);
  const result = compareTiles(
    tile({ date: '2025-06-03T12:00:00Z' }),
    tile({ date: '2025-06-04T12:00:00Z' }),
    0.2,
    { now: NOW },
  );
  assert.deepEqual(result.freshness, { before: false, after: true });
  assert.deepEqual(result.stale, { before: true, after: false });
  assert.equal(result.beforeAgeDays, 15);
  assert.equal(result.afterAgeDays, 14);
  assert.deepEqual(compareTiles(
    tile({ date: '2025-06-03T12:00:00Z' }), tile(), 0.2, { now: NOW, maxAgeDays: 15 },
  ).freshness, { before: true, after: true });
});

test('reports confidence maps, low-confidence valid pixels, and freshness', () => {
  const result = compareTiles(
    tile({ confidence: [0.8, 0.6, 0.7, 0.9] }),
    tile({ confidence: [0.9, 0.7, 0.5, 0.9] }),
    0.1,
    { now: NOW },
  );
  assert.deepEqual(result.confidence, [0.8, 0.6, 0.5, 0.9]);
  assert.equal(result.meanConfidence, (0.8 + 0.6 + 0.5 + 0.9) / 4);
  assert.equal(result.lowConfidenceCount, 2);
  assert.deepEqual(result.lowConfidenceIndices, [1, 2]);
  assert.equal(result.freshness.before, true);
  assert.equal(result.freshness.after, true);
  assert.equal(result.beforeAgeDays, 0.125);
});

test('confidence uses original valid indices, retains low confidence, and excludes masked samples', () => {
  const before = tile({
    cloud: [true, false, false, false],
    confidence: [0, 0.65, 0.3, 0.8],
    values: [0, 0, 0, 0],
  });
  const after = tile({ confidence: [0, 0.9, 0.4, 0.7], values: [1, 1, 1, 1] });
  const result = compareTiles(before, after, 0.5, { now: NOW });
  assert.deepEqual(result.confidence, [0, 0.65, 0.3, 0.7]);
  assert.equal(result.meanConfidence, (0.65 + 0.3 + 0.7) / 3);
  assert.deepEqual(result.lowConfidenceIndices, [2]);
  assert.equal(result.changedCount, 3);
});

test('buildReport round-trips as JSON and includes metadata, masks, pixels, and stats', () => {
  const report = buildReport(
    tile({ values: [0, 0.2, 0.3, 0.4], nodata: [true, false, false, false] }),
    tile({ values: [0.5, 0.2, 0.55, 0.4] }),
    0.2,
    { now: NOW, fixtureName: 'River bend / June 2025', band: 'infrared' },
  );
  const roundTrip = JSON.parse(JSON.stringify(report));

  assert.deepEqual(roundTrip, report);
  assert.equal(report.synthetic, true);
  assert.match(report.disclaimer, /synthetic/i);
  assert.equal(report.fixtureName, 'River bend / June 2025');
  assert.deepEqual(report.dates, {
    before: '2025-06-18T09:00:00.000Z',
    after: '2025-06-18T09:00:00.000Z',
  });
  assert.deepEqual(report.excluded.nodataIndices, [0]);
  assert.deepEqual(report.pixels.changedIndices, [2]);
  assert.equal(report.stats.changedFraction, 1 / 3);
  assert.equal(report.generatedAt, '2025-06-18T12:00:00.000Z');
  assert.equal(report.band, 'infrared');
  assert.deepEqual(report.geometry, {
    width: 2, height: 2, crs: 'LOCAL-SYNTHETIC', origin: [100, 200], resolution: [10, 10],
  });
  assert.deepEqual(report.stale, { before: false, after: false });
  assert.equal(report.threshold.value, 0.2);
  assert.equal(report.threshold.inclusive, true);
  assert.equal(report.freshnessPolicy.maxAgeDays, 14);
  assert.deepEqual(report.pixels.differences, [0.5, 0, 0.25000000000000006, 0]);
  assert.equal(report.confidencePolicy.lowConfidenceExcluded, false);
  assert.equal(report.schemaVersion, 2);
  assert.match(report.reportTitle, /change-detection report/i);
  assert.match(report.summary.staleWording, /within/i);
  assert.match(report.maskPolicy.nodata, /missing data/i);
  assert.match(report.confidencePolicy.interpretation, /synthetic review signal/i);
  assert.equal(report.legends.change.length, 3);
  assert.equal(report.pixels.changedRows.length, 1);
  const readable = buildReadableReport(report);
  assert.match(readable, /Decision summary/);
  assert.match(readable, /Confidence interpretation/);
  assert.match(readable, /Mask exclusions/);
  assert.match(readable, /Both images are within/);
  assert.match(readable, /Print \/ save PDF/);
  assert.match(readable, /Changed-pixel index/);
  report.geometry.origin[0] = 0;
  assert.equal(tile().origin[0], 100);
});

test('readable report explicitly warns about stale imagery and all-invalid results', () => {
  const stale = buildReport(tile({ date: '2025-06-01T09:00:00Z' }), tile({ date: '2025-06-01T09:00:00Z' }), .2, { now: NOW, fixtureName: 'Archive haze', band: 'infrared' });
  const readable = buildReadableReport(stale);
  assert.match(stale.summary.headline, /stale/i);
  assert.match(stale.summary.staleWording, /Stale imagery/);
  assert.match(readable, /Do not read a detected difference as a current event/);
  assert.match(readable, /STALE IMAGERY/);
  assert.match(readable, /Cloud/);
});

test('typed array inputs produce plain JSON arrays without mutating or retaining inputs', () => {
  const before = tile({
    values: new Float32Array([0, 0.25, 0.5, 0.75]),
    cloud: new Uint8Array([0, 1, 0, 0]),
    nodata: new Uint8Array([0, 0, 1, 0]),
    confidence: new Float32Array([0.8, 0.6, 0.4, 0.9]),
    resolution: [10, -10],
  });
  const after = { ...before, values: new Float32Array([0.25, 1, 1, 0.75]) };
  const original = structuredClone(before);
  const report = buildReport(before, after, 0.25, { now: new Date(NOW) });
  assert.deepEqual(before, original);
  assert.ok(Array.isArray(report.pixels.differences));
  assert.ok(Array.isArray(report.pixels.confidence));
  assert.deepEqual(report.pixels.changedIndices, [0]);
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
  report.geometry.origin[0] = 0;
  report.pixels.confidence[0] = 0;
  assert.equal(before.origin[0], 100);
  assert.ok(before.confidence[0] > 0.79);
});

test('all nodata produces zero valid pixels, no changes, and null mean confidence', () => {
  const result = compareTiles(
    tile({ nodata: [true, true, true, true] }),
    tile({ nodata: [true, true, true, true] }),
    0,
    { now: NOW },
  );
  assert.equal(result.validCount, 0);
  assert.equal(result.changedCount, 0);
  assert.equal(result.coverage, 0);
  assert.equal(result.changedFraction, 0);
  assert.equal(result.meanConfidence, null);
  assert.deepEqual(result.differences, [0, 0, 0, 0]);
  const report = buildReport(tile({ nodata: [true, true, true, true] }), tile(), 0, { now: NOW });
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
  assert.equal(report.stats.meanConfidence, null);
  assert.deepEqual(report.pixels.changedIndices, []);
});
