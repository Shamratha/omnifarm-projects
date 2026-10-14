import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDashboardModel,
  createValidationReport,
  formatValidationJsonReport,
  formatValidationReport,
  parseTimeValue,
  sampleBundle,
  validateBundle,
} from '../src/validator.js';
import { boundaryRegressionBundle } from '../src/regression-bundle.js';

function healthyBundle() {
  return {
    metadata: {
      SIMPLE: true,
      BITPIX: -32,
      NAXIS: 2,
      NAXIS1: 2048,
      NAXIS2: 2048,
      OBJECT: 'M31',
      TARGET: 'M31',
      'DATE-OBS': '2024-01-01T02:00:00Z',
      TIMESYS: 'UTC',
      'MJD-OBS': 60310.0833333333,
      OBSERVAT: 'Cerro Paranal',
      TELESCOP: 'VLT-UT1',
    },
    observatory: { name: 'Cerro Paranal' },
    telescope: { name: 'VLT-UT1', observatory: 'Cerro Paranal' },
    target: {
      name: 'M31',
      coordinates: { raDeg: 10.6847, decDeg: 41.2688 },
    },
    exposureLogs: [
      {
        id: 'science-r-001',
        start: '2024-01-01T02:00:00Z',
        timeSystem: 'UTC',
        exposure: 30,
        exposureUnit: 's',
        filter: 'R',
        airmass: 1.2,
        altitudeDeg: 50,
        mjd: 60310.0833333333,
      },
      {
        id: 'science-r-002',
        start: '2024-01-01T02:02:00Z',
        timeSystem: 'UTC',
        exposure: 60,
        exposureUnit: 's',
        filter: 'R',
        airmass: 1.22,
        altitudeDeg: 49,
      },
    ],
    calibrationFrames: [
      { id: 'bias-001', type: 'bias' },
      { id: 'dark-30s', type: 'dark', exposure: 30, exposureUnit: 's' },
      { id: 'dark-60s', type: 'dark', exposure: 60, exposureUnit: 's' },
      { id: 'flat-r', type: 'flat', filter: 'R', exposure: 5, exposureUnit: 's' },
    ],
    weather: {
      id: 'weather-healthy',
      temperatureC: 10,
      humidityPct: 45,
      windSpeedMps: 3,
      pressureHpa: 745,
    },
  };
}

test('healthy baseline passes all checks and exposes normalized values', () => {
  const result = validateBundle(healthyBundle());

  assert.equal(result.summary.status, 'pass');
  assert.equal(result.summary.valid, true);
  assert.equal(result.findings.length, 0);
  assert.deepEqual(result.normalized.exposureUnits, ['s']);
  assert.equal(result.normalized.exposureLogs[0].exposureSeconds, 30);
  assert.equal(result.normalized.exposureLogs[0].startUtc, '2024-01-01T02:00:00.000Z');
});

test('boundary regression bundle has only the missing bias and source-scale boundary findings', () => {
  const result = validateBundle(boundaryRegressionBundle);

  assert.deepEqual(Object.keys(result), ['summary', 'findings', 'checks', 'normalized']);
  assert.deepEqual(result.findings.map((finding) => finding.id), [
    'CAL-BIAS-MISSING',
    'TIME-TIMESTAMP-BOUNDARY-TAI-002',
    'TIME-SYSTEM-MIXED',
  ]);
  assert.equal(result.summary.status, 'fail');
  assert.equal(result.summary.errors, 3);
  assert.equal(result.summary.warnings, 0);
  assert.equal(result.summary.checksPassed, 3);
  assert.equal(result.summary.checksFailed, 2);
  assert.deepEqual(result.normalized.exposureLogs.map((entry) => entry.exposureSeconds), [30, 30]);
  assert.deepEqual(result.normalized.exposureUnits, ['s']);

  const boundary = result.findings[1];
  assert.deepEqual(boundary.evidence, {
    record: 'boundary-tai-002',
    rawTimestamp: '2016-12-31T23:59:60Z',
    declaredSourceSystem: 'TAI',
    error: 'leap-second-non-utc',
  });
  assert.deepEqual(result.findings[2].evidence.systems, ['TAI', 'UTC']);
  assert.equal(result.normalized.exposureLogs[1].startUtc, null);
  assert.equal(result.normalized.exposureLogs[1].timeError, 'leap-second-non-utc');
});

test('adding the missing bias alone leaves only the boundary and mixed-scale findings', () => {
  const bundle = structuredClone(boundaryRegressionBundle);
  bundle.calibrationFrames.push({ id: 'bias-001', type: 'bias' });

  const result = validateBundle(bundle);
  assert.deepEqual(result.findings.map((finding) => finding.id), [
    'TIME-TIMESTAMP-BOUNDARY-TAI-002',
    'TIME-SYSTEM-MIXED',
  ]);
  assert.equal(result.checks.find((check) => check.id === 'calibration-coverage').status, 'pass');
});

test('adding a bias and correcting only the offending source scale makes the regression bundle pass', () => {
  const bundle = structuredClone(boundaryRegressionBundle);
  bundle.calibrationFrames.push({ id: 'bias-001', type: 'bias' });
  bundle.exposureLogs[1].timeSystem = 'UTC';

  const result = validateBundle(bundle);
  assert.deepEqual(result.findings, []);
  assert.equal(result.summary.status, 'pass');
  assert.equal(result.summary.valid, true);
  assert.equal(result.summary.checksPassed, 5);
  assert.ok(result.checks.every((check) => check.status === 'pass'));
  assert.equal(result.normalized.exposureLogs[1].leapSecond, true);
  assert.deepEqual(result.normalized.timeSystems, ['UTC']);
});

test('accepts a known UTC leap-second boundary in the regression bundle', () => {
  const validBoundary = parseTimeValue('2016-12-31T23:59:60Z', 'UTC');
  assert.equal(validBoundary.valid, true);
  assert.equal(validBoundary.leapSecond, true);
  assert.equal(validBoundary.utcMs, Date.parse('2017-01-01T00:00:00Z'));

  const bundle = structuredClone(boundaryRegressionBundle);
  bundle.calibrationFrames.push({ id: 'bias-001', type: 'bias' });
  bundle.metadata['DATE-OBS'] = '2016-12-31T23:59:60Z';
  bundle.metadata['MJD-OBS'] = 57754;
  bundle.exposureLogs[0].start = '2016-12-31T23:59:60Z';
  bundle.exposureLogs[1].timeSystem = 'UTC';
  const result = validateBundle(bundle);
  assert.equal(result.normalized.metadata.dateObsLeapSecond, true);
  assert.equal(result.normalized.exposureLogs[0].leapSecond, true);
  assert.deepEqual(result.findings, []);
  assert.equal(result.summary.status, 'pass');
});

test('rejects an invented UTC leap-second boundary with its raw timestamp and scale', () => {
  const timestamp = '2017-01-01T23:59:60Z';
  const parsed = parseTimeValue(timestamp, 'UTC');
  assert.equal(parsed.valid, false);
  assert.equal(parsed.error, 'invalid-leap-second');

  const bundle = structuredClone(boundaryRegressionBundle);
  bundle.calibrationFrames.push({ id: 'bias-001', type: 'bias' });
  bundle.exposureLogs[1].start = timestamp;
  bundle.exposureLogs[1].timeSystem = 'UTC';
  const result = validateBundle(bundle);
  assert.deepEqual(result.findings.map((finding) => finding.id), ['TIME-TIMESTAMP-BOUNDARY-TAI-002']);
  const finding = result.findings[0];
  assert.deepEqual(finding.evidence, {
    record: 'boundary-tai-002',
    rawTimestamp: timestamp,
    declaredSourceSystem: 'UTC',
    error: 'invalid-leap-second',
  });
  assert.match(finding.explanation, /UTC.*outside a known UTC leap-second boundary/);
  assert.match(finding.remediation, /UTC leap-second table/);
  assert.match(finding.remediation, /correct the UTC date\/time/);
});

for (const system of ['TAI', 'GPS']) {
  test(`rejects :60 in ${system} even at a known UTC leap-second boundary`, () => {
    const timestamp = '2016-12-31T23:59:60Z';
    const parsed = parseTimeValue(timestamp, system);
    assert.equal(parsed.valid, false);
    assert.equal(parsed.error, 'leap-second-non-utc');

    const bundle = structuredClone(boundaryRegressionBundle);
    bundle.calibrationFrames.push({ id: 'bias-001', type: 'bias' });
    bundle.exposureLogs[1].timeSystem = system;
    const result = validateBundle(bundle);
    assert.deepEqual(result.findings.map((finding) => finding.id), [
      'TIME-TIMESTAMP-BOUNDARY-TAI-002',
      'TIME-SYSTEM-MIXED',
    ]);
    const finding = result.findings[0];
    assert.deepEqual(finding.evidence, {
      record: 'boundary-tai-002',
      rawTimestamp: timestamp,
      declaredSourceSystem: system,
      error: 'leap-second-non-utc',
    });
    assert.match(finding.explanation, new RegExp(`${system} source scale is continuous`));
    assert.match(finding.explanation, /Only UTC may use :60/);
    assert.match(finding.remediation, new RegExp(`${system} timestamp with seconds 00–59`));
    assert.match(finding.remediation, /Declare UTC only if.*actually recorded in UTC/);
  });
}

for (const { utc, tai, offset } of [
  { utc: '2017-01-01T00:00:00Z', tai: '2017-01-01T00:00:37Z', offset: 37 },
  { utc: '2016-12-31T00:00:00Z', tai: '2016-12-31T00:00:36Z', offset: 36 },
]) {
  test(`normal TAI and UTC midnight timestamps agree at offset ${offset} seconds`, () => {
    const parsedUtc = parseTimeValue(utc, 'UTC');
    const parsedTai = parseTimeValue(tai, 'TAI');
    assert.equal(parsedUtc.valid, true);
    assert.equal(parsedTai.valid, true);
    assert.equal(parsedTai.leapSecond, false);
    assert.equal(parsedTai.utcMs, parsedUtc.utcMs);
    assert.equal(parsedTai.sourceMs - parsedTai.utcMs, offset * 1000);

    const bundle = structuredClone(boundaryRegressionBundle);
    bundle.calibrationFrames.push({ id: 'bias-001', type: 'bias' });
    bundle.exposureLogs[0].start = utc;
    bundle.exposureLogs[1].start = tai;
    const result = validateBundle(bundle);
    assert.deepEqual(result.findings.map((finding) => finding.id), ['TIME-SYSTEM-MIXED']);
    assert.equal(result.normalized.exposureLogs[1].timeError, null);
    assert.equal(result.normalized.exposureLogs[0].startUtc, result.normalized.exposureLogs[1].startUtc);
  });
}

test('reports a missing bias frame even when dark and flat coverage exists', () => {
  const bundle = structuredClone(boundaryRegressionBundle);
  bundle.exposureLogs[1].timeSystem = 'UTC';

  const result = validateBundle(bundle);
  assert.deepEqual(result.findings.map((entry) => entry.id), ['CAL-BIAS-MISSING']);
  const finding = result.findings.find((entry) => entry.id === 'CAL-BIAS-MISSING');

  assert.ok(finding);
  assert.equal(finding.severity, 'error');
  assert.equal(finding.category, 'calibration');
  assert.deepEqual(finding.evidence, { scienceExposureCount: 2, biasFrameCount: 0 });
  assert.match(finding.explanation, /local reduction profile requires a bias/);
  assert.deepEqual(finding.standards, [
    'Astro Pipeline Local Reduction Profile v1.0 (local bias/dark/flat calibration requirements)',
  ]);
  assert.match(finding.remediation, /bias/i);
});

test('reports bundle observatory metadata that disagrees with the site descriptor', () => {
  const bundle = healthyBundle();
  bundle.observatory.name = 'La Silla';

  const result = validateBundle(bundle);
  const finding = result.findings.find((entry) => entry.id === 'META-OBSERVATORY-DESCRIPTOR-MISMATCH');

  assert.ok(finding);
  assert.equal(finding.category, 'metadata');
  assert.deepEqual(finding.evidence, {
    OBSERVAT: 'Cerro Paranal',
    descriptor: 'La Silla',
  });
});

test('does not count an invalid flat frame as filter calibration coverage', () => {
  const bundle = healthyBundle();
  bundle.calibrationFrames = bundle.calibrationFrames.filter((frame) => frame.type !== 'flat');
  bundle.calibrationFrames.push({
    id: 'flat-invalid-r',
    type: 'flat',
    filter: 'R',
    exposure: 'not-a-number',
    exposureUnit: 's',
  });

  const result = validateBundle(bundle);
  const finding = result.findings.find((entry) => entry.id === 'CAL-FLAT-COVERAGE-R');

  assert.ok(finding);
  assert.ok(result.findings.some((entry) => entry.id === 'EXPOSURE-UNIT-INVALID-FLAT-INVALID-R'));
});

test('detects mixed exposure units while normalizing values to seconds', () => {
  const bundle = healthyBundle();
  bundle.exposureLogs[1].exposure = 60000;
  bundle.exposureLogs[1].exposureUnit = 'ms';

  const result = validateBundle(bundle);
  const finding = result.findings.find((entry) => entry.id === 'EXPOSURE-UNITS-MIXED');

  assert.ok(finding);
  assert.deepEqual(result.normalized.exposureUnits, ['ms', 's']);
  assert.equal(result.normalized.exposureLogs[1].exposureSeconds, 60);
  assert.deepEqual(finding.evidence.units, ['ms', 's']);
});

test('sample bundle provides deterministic dashboard findings and a standards report', () => {
  const first = validateBundle(sampleBundle);
  const second = validateBundle(sampleBundle);

  assert.equal(first.summary.status, 'fail');
  assert.deepEqual(first.findings, second.findings);
  assert.ok(first.findings.some((finding) => finding.id === 'CAL-BIAS-MISSING'));
  assert.ok(first.findings.some((finding) => finding.id === 'META-OBJECT-TARGET-MISMATCH'));
  assert.ok(first.findings.some((finding) => finding.id === 'EXPOSURE-UNITS-MIXED'));

  const report = formatValidationReport(first);
  assert.match(report, /^# Observation Pipeline Validation Report/m);
  assert.match(report, /## Findings/);
  assert.match(report, /Standards/);
  assert.match(report, /CAL-BIAS-MISSING/);
});

test('boundary regression reports preserve JSON parity and deterministic results without mutating the bundle', () => {
  const original = structuredClone(boundaryRegressionBundle);
  const first = validateBundle(boundaryRegressionBundle);
  const second = validateBundle(boundaryRegressionBundle);
  const dashboard = createDashboardModel(first);
  const report = createValidationReport(first);
  const json = formatValidationJsonReport(first);

  assert.deepEqual(boundaryRegressionBundle, original);
  assert.deepEqual(first, second);
  assert.equal(json, formatValidationJsonReport(second));
  assert.deepEqual(JSON.parse(json), report);
  assert.deepEqual(report.summary, first.summary);
  assert.deepEqual(report.findings, first.findings);
  assert.deepEqual(report.checks, first.checks);
  assert.deepEqual(report.normalized, first.normalized);
  assert.ok(report.standards.includes(first.findings[0].standards[0]));

  // The quality dashboard renders this exact projection, so both focused
  // regressions retain their explanation/remediation in the JSON export.
  assert.deepEqual(dashboard.findings, report.findings);
  assert.deepEqual(dashboard.checks, report.checks);
  assert.deepEqual(dashboard.summary, report.summary);
  for (const id of ['CAL-BIAS-MISSING', 'TIME-TIMESTAMP-BOUNDARY-TAI-002']) {
    const finding = dashboard.findings.find((entry) => entry.id === id);
    const exported = JSON.parse(json).findings.find((entry) => entry.id === id);
    assert.ok(finding);
    assert.equal(finding.explanation, exported.explanation);
    assert.equal(finding.remediation, exported.remediation);
    assert.deepEqual(finding.evidence, exported.evidence);
    assert.deepEqual(finding.standards, exported.standards);
  }

  const markdown = formatValidationReport(first);
  for (const finding of report.findings) {
    assert.ok(markdown.includes(`\`${finding.id}\``));
    assert.ok(markdown.includes(finding.explanation));
    assert.ok(markdown.includes(finding.remediation));
  }
});
