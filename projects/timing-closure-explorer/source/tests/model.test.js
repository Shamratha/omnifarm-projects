import test from 'node:test';
import assert from 'node:assert/strict';
import { demoSnapshot } from '../src/data.js';
import {
  applyWhatIf,
  assessEvidence,
  buildSignoffReport,
  buildSlackHistogram,
  classifyPathException,
  detectStaleReports,
  pathsFor,
  rankedHotspots,
  sortPaths,
  summarize
} from '../src/model.js';

function freshSnapshot() {
  const snapshot = structuredClone(demoSnapshot);
  // Freshness tests control timestamp relationships independently of demo report ordering.
  snapshot.manifest.generatedAt = '2026-10-14T12:00:00Z';
  for (const report of snapshot.manifest.sourceReports) {
    report.generatedAt = snapshot.manifest.generatedAt;
  }
  return snapshot;
}

function snapshotTimeOffset(snapshot, seconds) {
  return new Date(Date.parse(snapshot.manifest.generatedAt) + seconds * 1000).toISOString();
}

function sourceReport(snapshot, kind) {
  return snapshot.manifest.sourceReports.find((report) => report.kind === kind);
}

function snapshotPath(snapshot, id) {
  return snapshot.paths.find((path) => path.id === id);
}

function pathById(paths, id) {
  return paths.find((path) => path.id === id);
}

test('multi-clock setup paths remain associated with their source clocks', () => {
  const paths = pathsFor(demoSnapshot, 'setup', 'signoff');
  const clocks = new Set(paths.map((path) => path.clock));

  assert.deepEqual([...clocks].sort(), ['clk_bus', 'clk_core', 'clk_dbg']);
  assert.equal(paths.find((path) => path.id === 'p-004').clock, 'clk_bus');
  assert.equal(paths.find((path) => path.id === 'p-008').clock, 'clk_bus');
});

test('false-path annotations remain visible instead of being silently treated as timing failures', () => {
  const paths = pathsFor(demoSnapshot, 'setup', 'signoff');
  const falsePath = paths.find((path) => path.id === 'p-007');

  assert.deepEqual(falsePath.exception, {
    kind: 'false_path',
    status: 'applied',
    scope: 'clock_pair',
    clockGroups: ['clk_core', 'clk_dbg'],
    sourceReport: 'constraints.sdc'
  });
  assert.ok(falsePath.slack > 0);
  const summary = summarize(paths, demoSnapshot, 'setup', 'signoff');
  assert.equal(summary.violations, 6);
  assert.equal(summary.excludedFalsePaths, 1);
});

test('negative slack ties sort deterministically by source rank', () => {
  const reversed = structuredClone(demoSnapshot);
  reversed.paths.reverse();
  const before = structuredClone(reversed);
  for (const [analysis, slack, ids] of [
    ['setup', -0.183, ['p-001', 'p-002']],
    ['hold', -0.006, ['p-010', 'p-011']]
  ]) {
    const paths = pathsFor(reversed, analysis, 'signoff');
    assert.deepEqual(paths.filter((path) => path.slack === slack).map((path) => path.id), ids);
    assert.deepEqual(paths.slice(0, 2).map((path) => path.id), ids);
    assert.deepEqual(paths, pathsFor(demoSnapshot, analysis, 'signoff'));
  }
  assert.deepEqual(reversed, before);
});

test('long hierarchical labels survive tied negative slack and duplicate source ranks', () => {
  const snapshot = freshSnapshot();
  const hierarchy = 'orion_top/u_vector_pipeline/u_accumulator_lane_012/'.repeat(4);
  snapshot.paths = ['b', 'a'].map((suffix) => ({
    ...snapshotPath(snapshot, 'p-001'),
    id: `tie-${suffix}`,
    rank: 1,
    startpoint: `${hierarchy}launch_register_${suffix}/Q`,
    endpoint: `${hierarchy}capture_register_${suffix}/D`
  }));
  const before = structuredClone(snapshot);
  const expectedIds = ['tie-a', 'tie-b'];
  for (const input of [snapshot.paths, [...snapshot.paths].reverse()]) {
    const paths = pathsFor({ ...snapshot, paths: input });
    assert.deepEqual(paths.map((path) => path.id), expectedIds);
    assert.deepEqual(sortPaths(input).map((path) => path.id), expectedIds);
    assert.equal(paths[0].endpoint, `${hierarchy}capture_register_a/D`);
    assert.equal(paths[1].startpoint, `${hierarchy}launch_register_b/Q`);
    const summary = summarize(paths, snapshot);
    assert.equal(summary.violations, 2);
    assert.equal(summary.wns, -0.183);
    assert.equal(summary.tns, -0.366);
    assert.deepEqual(buildSignoffReport({ ...snapshot, paths: input }).baseline.worstPaths.map((path) => path.endpoint), paths.map((path) => path.endpoint));
  }
  assert.deepEqual(snapshot, before);
});

test('slack histogram bins account for every path, including ties at zero', () => {
  const paths = pathsFor(demoSnapshot, 'hold', 'signoff');
  const bins = buildSlackHistogram(paths);

  assert.equal(bins.reduce((sum, bin) => sum + bin.count, 0), paths.length);
  assert.equal(bins.find((bin) => bin.label === '-0.10 → 0').count, 2);
  assert.equal(bins.find((bin) => bin.label === '0 → 0.10').count, 3);
});

test('hotspots rank by overflow and can be filtered by layer', () => {
  assert.equal(rankedHotspots(demoSnapshot)[0].id, 'hot-1');
  assert.ok(rankedHotspots(demoSnapshot, 'M5').every((tile) => tile.layer === 'M5'));
  assert.equal(rankedHotspots(demoSnapshot, 'M5')[0].id, 'hot-2');
});

test('what-if repairs are deterministic and do not mutate the baseline', () => {
  const first = applyWhatIf(demoSnapshot, 'resize-buf', 'setup', 'signoff');
  const second = applyWhatIf(demoSnapshot, 'resize-buf', 'setup', 'signoff');

  assert.deepEqual(first, second);
  assert.equal(first.candidate.id, 'resize-buf');
  assert.ok(first.summary.wns > first.baseline.wns);
  assert.equal(demoSnapshot.paths.find((path) => path.id === 'p-001').slack, -0.183);
});

test('stale timing evidence stays separate from fresh physical evidence', () => {
  const snapshot = freshSnapshot();
  const paths = pathsFor(snapshot);
  const baseline = summarize(paths, snapshot);
  sourceReport(snapshot, 'timing').status = 'stale';

  const evidence = assessEvidence(snapshot.manifest);
  assert.equal(evidence.timing.status, 'stale');
  assert.equal(evidence.physical.status, 'fresh');
  assert.equal(evidence.constraints.status, 'fresh');
  assert.equal(evidence.clock.status, 'fresh');
  assert.equal(evidence.overall, 'stale');
  assert.deepEqual(evidence.timing.reasons, ['explicit_status']);
  assert.deepEqual(evidence.physical.reasons, []);
  assert.equal(baseline.status, 'FAIL');
  assert.deepEqual(summarize(paths, snapshot), { ...baseline, status: 'UNVERIFIED' });
});

test('stale physical evidence does not make fresh timing summaries unverified', () => {
  const snapshot = freshSnapshot();
  const paths = pathsFor(snapshot);
  const baseline = summarize(paths, snapshot);
  sourceReport(snapshot, 'congestion').status = 'stale';

  const evidence = assessEvidence(snapshot.manifest);
  assert.equal(evidence.physical.status, 'stale');
  assert.equal(evidence.timing.status, 'fresh');
  assert.equal(evidence.constraints.status, 'fresh');
  assert.equal(evidence.clock.status, 'fresh');
  assert.equal(evidence.overall, 'stale');
  assert.deepEqual(summarize(paths, snapshot), baseline);
});

test('explicit stale status and snapshot mismatch independently override declared freshness', () => {
  const snapshot = freshSnapshot();
  const timing = sourceReport(snapshot, 'timing');
  const congestion = sourceReport(snapshot, 'congestion');
  timing.status = 'stale';
  congestion.snapshotId = `${snapshot.manifest.snapshotId}-old`;
  const before = structuredClone(snapshot.manifest);
  const checked = detectStaleReports(snapshot.manifest);

  assert.equal(checked.hasStale, true);
  assert.equal(checked.hasUnknown, false);
  assert.deepEqual(new Set(checked.stale.map((report) => report.name)), new Set([timing.name, congestion.name]));
  assert.deepEqual(checked.stale.find((report) => report.name === timing.name).reasons, ['explicit_status']);
  const mismatched = checked.stale.find((report) => report.name === congestion.name);
  assert.equal(mismatched.status, 'fresh');
  assert.equal(mismatched.freshness, 'stale');
  assert.deepEqual(mismatched.reasons, ['snapshot_mismatch']);
  assert.deepEqual(snapshot.manifest, before);
});

test('manifest stale declarations accept both report names and objects', () => {
  for (const objectEntry of [false, true]) {
    const snapshot = freshSnapshot();
    const report = sourceReport(snapshot, 'paths');
    snapshot.manifest.staleReports = [objectEntry ? { name: report.name } : report.name];
    const checked = detectStaleReports(snapshot.manifest);
    assert.equal(checked.hasStale, true);
    assert.equal(checked.stale.length, 1);
    assert.equal(checked.stale[0].name, report.name);
    assert.deepEqual(checked.stale[0].reasons, ['manifest_stale_list']);
  }
});

for (const kind of ['parasitics', 'constraints', 'clock', 'placement', 'netlist']) {
  test(`newer ${kind} dependency makes timing and path reports stale`, () => {
    const snapshot = freshSnapshot();
    for (const report of snapshot.manifest.sourceReports) {
      report.generatedAt = snapshotTimeOffset(snapshot, -2);
    }
    for (const output of ['timing', 'paths']) {
      sourceReport(snapshot, output).generatedAt = snapshotTimeOffset(snapshot, -1);
    }
    const input = sourceReport(snapshot, kind);
    input.generatedAt = snapshot.manifest.generatedAt;
    const checked = detectStaleReports(snapshot.manifest);
    for (const output of ['timing', 'paths']) {
      const report = checked.reports.find((report) => report.kind === output);
      assert.equal(report.freshness, 'stale');
      assert.deepEqual(report.reasons, [`newer_dependency:${input.name}`]);
    }
    assert.equal(checked.reports.find((report) => report.kind === kind).freshness, 'fresh');
    assert.equal(assessEvidence(snapshot.manifest).timing.status, 'stale');
  });
}

test('congestion evidence is stale when placement or netlist is newer', () => {
  for (const kind of ['placement', 'netlist']) {
    const snapshot = freshSnapshot();
    sourceReport(snapshot, 'congestion').generatedAt = snapshotTimeOffset(snapshot, -1);
    sourceReport(snapshot, kind === 'placement' ? 'netlist' : 'placement').generatedAt = snapshotTimeOffset(snapshot, -2);
    const input = sourceReport(snapshot, kind);
    const checked = detectStaleReports(snapshot.manifest);
    assert.equal(checked.stale.length, 1);
    assert.equal(checked.stale[0].kind, 'congestion');
    assert.deepEqual(checked.stale[0].reasons, [`newer_dependency:${input.name}`]);
    const evidence = assessEvidence(snapshot.manifest);
    assert.equal(evidence.physical.status, 'stale');
    assert.equal(evidence.timing.status, 'fresh');
  }
});

test('equal or older dependencies are fresh regardless of the time evidence is checked', () => {
  for (const offset of [0, -60]) {
    const snapshot = freshSnapshot();
    for (const kind of ['parasitics', 'constraints', 'clock', 'placement', 'netlist']) {
      sourceReport(snapshot, kind).generatedAt = snapshotTimeOffset(snapshot, offset);
    }
    for (const currentTime of [new Date('2026-10-14T11:00:00Z'), new Date('2027-01-01T00:00:00Z')]) {
      const checked = detectStaleReports(snapshot.manifest, currentTime);
      assert.equal(checked.hasStale, false);
      assert.equal(checked.hasUnknown, false);
      assert.ok(checked.reports.every((report) => report.freshness === 'fresh' && report.reasons.length === 0));
    }
    assert.equal(assessEvidence(snapshot.manifest).overall, 'fresh');
  }
});

test('generated-after-snapshot is stale while equal and older reports are accepted', () => {
  for (const [offset, freshness] of [[1, 'stale'], [0, 'fresh'], [-1, 'fresh']]) {
    const snapshot = freshSnapshot();
    const congestion = sourceReport(snapshot, 'congestion');
    congestion.generatedAt = snapshotTimeOffset(snapshot, offset);
    sourceReport(snapshot, 'placement').generatedAt = snapshotTimeOffset(snapshot, -2);
    sourceReport(snapshot, 'netlist').generatedAt = snapshotTimeOffset(snapshot, -2);
    const checked = detectStaleReports(snapshot.manifest);
    const result = checked.reports.find((report) => report.kind === 'congestion');
    assert.equal(result.freshness, freshness);
    assert.equal(result.unknown, false);
    assert.equal(checked.hasStale, offset > 0);
    assert.deepEqual(result.reasons, offset > 0 ? ['generated_after_snapshot'] : []);
  }
});

test('missing and invalid report timestamps are unknown without concealing timing violations', () => {
  for (const [value, reason] of [[undefined, 'missing_timestamp'], [null, 'missing_timestamp'], ['', 'missing_timestamp'], ['not a date', 'invalid_timestamp']]) {
    const snapshot = freshSnapshot();
    sourceReport(snapshot, 'timing').generatedAt = value;
    const checked = detectStaleReports(snapshot.manifest);
    assert.equal(checked.hasStale, false);
    assert.equal(checked.hasUnknown, true);
    assert.equal(checked.unknown.length, 1);
    const result = checked.unknown[0];
    assert.equal(result.kind, 'timing');
    assert.equal(result.freshness, 'unknown');
    assert.equal(result.stale, false);
    assert.deepEqual(result.reasons, [reason]);
    const evidence = assessEvidence(snapshot.manifest);
    assert.equal(evidence.timing.status, 'unknown');
    assert.equal(evidence.physical.status, 'fresh');
    assert.equal(evidence.overall, 'unknown');
    const summary = summarize(pathsFor(snapshot), snapshot);
    assert.equal(summary.status, 'UNVERIFIED');
    assert.equal(summary.violations, 6);
    assert.equal(summary.wns, -0.183);
    assert.equal(summary.tns, -0.777);
  }
});

test('missing or invalid snapshot timestamps leave all evidence unverified', () => {
  for (const generatedAt of [undefined, null, 'not a date']) {
    const snapshot = freshSnapshot();
    snapshot.manifest.generatedAt = generatedAt;
    const checked = detectStaleReports(snapshot.manifest);
    assert.equal(checked.hasStale, false);
    assert.equal(checked.unknown.length, snapshot.manifest.sourceReports.length);
    assert.ok(checked.reports.every((report) => report.freshness === 'unknown'));
    assert.ok(checked.reports.every((report) => report.reasons.includes('invalid_snapshot_timestamp')));
    const evidence = assessEvidence(snapshot.manifest);
    for (const domain of ['timing', 'constraints', 'clock', 'physical']) {
      assert.equal(evidence[domain].status, 'unknown');
    }
    assert.equal(evidence.overall, 'unknown');
    assert.equal(summarize(pathsFor(snapshot), snapshot).status, 'UNVERIFIED');
  }
});

test('missing required reports make only their evidence domain unknown', () => {
  for (const [kind, domain] of [
    ['timing', 'timing'], ['paths', 'timing'], ['parasitics', 'timing'],
    ['constraints', 'constraints'], ['clock', 'clock'],
    ['congestion', 'physical'], ['placement', 'physical'], ['netlist', 'physical']
  ]) {
    const snapshot = freshSnapshot();
    snapshot.manifest.sourceReports = snapshot.manifest.sourceReports.filter((report) => report.kind !== kind);
    const checked = detectStaleReports(snapshot.manifest);
    assert.equal(checked.hasStale, false);
    assert.equal(checked.hasUnknown, false);
    const evidence = assessEvidence(snapshot.manifest);
    assert.equal(evidence[domain].status, 'unknown');
    assert.deepEqual(evidence[domain].reasons, [`missing_report:${kind}`]);
    assert.equal(evidence.overall, 'unknown');
    for (const other of ['timing', 'constraints', 'clock', 'physical'].filter((other) => other !== domain)) {
      assert.equal(evidence[other].status, 'fresh');
    }
    assert.equal(summarize(pathsFor(snapshot), snapshot).status, ['timing', 'constraints'].includes(domain) ? 'UNVERIFIED' : 'FAIL');
  }
});

test('negative applied false paths are excluded while negative candidates remain timed', () => {
  const snapshot = freshSnapshot();
  snapshotPath(snapshot, 'p-007').slack = -0.75;
  const evidence = assessEvidence(snapshot.manifest);
  const paths = pathsFor(snapshot);
  const appliedPath = pathById(paths, 'p-007');
  const candidatePath = pathById(paths, 'p-006');
  const applied = classifyPathException(appliedPath, evidence);
  const candidate = classifyPathException(candidatePath, evidence);

  assert.equal(appliedPath.slack, -0.75);
  assert.deepEqual(applied, {
    disposition: 'false_path_excluded',
    excluded: true,
    review: false,
    label: 'FALSE PATH · EXCLUDED',
    kind: 'false_path',
    status: 'applied',
    source: 'constraints.sdc'
  });
  assert.equal(candidate.disposition, 'exception_review');
  assert.equal(candidate.excluded, false);
  assert.equal(candidate.review, true);
  assert.equal(candidatePath.slack, -0.044);
  const summary = summarize(paths, snapshot);
  assert.equal(summary.status, 'FAIL');
  assert.equal(summary.wns, -0.183);
  assert.equal(summary.tns, -0.777);
  assert.equal(summary.violations, 6);
  assert.equal(summary.endpoints, 7);
  assert.equal(summary.timedPaths, 7);
  assert.equal(summary.totalPaths, 8);
  assert.equal(summary.excludedFalsePaths, 1);
  assert.equal(summary.exceptionCandidates, 1);

  const pair = summarize([candidatePath, appliedPath], snapshot);
  assert.equal(pair.wns, candidatePath.slack);
  assert.equal(pair.tns, candidatePath.slack);
  assert.equal(pair.violations, 1);
  assert.equal(pair.timedPaths, 1);
});

test('stale, unknown, or missing constraints keep negative applied false paths timed and unverified', () => {
  for (const problem of ['stale', 'missing_timestamp', 'invalid_timestamp', 'missing_report']) {
    const snapshot = freshSnapshot();
    snapshotPath(snapshot, 'p-007').slack = -0.75;
    const constraints = sourceReport(snapshot, 'constraints');
    if (problem === 'stale') constraints.status = 'stale';
    if (problem === 'missing_timestamp') delete constraints.generatedAt;
    if (problem === 'invalid_timestamp') constraints.generatedAt = 'not a date';
    if (problem === 'missing_report') {
      snapshot.manifest.sourceReports = snapshot.manifest.sourceReports.filter((report) => report !== constraints);
    }
    const evidence = assessEvidence(snapshot.manifest);
    assert.equal(evidence.constraints.status, problem === 'stale' ? 'stale' : 'unknown', problem);
    assert.equal(evidence.timing.status, 'fresh', problem);
    const paths = pathsFor(snapshot);
    const classification = classifyPathException(pathById(paths, 'p-007'), evidence);
    assert.equal(classification.disposition, 'exception_unverified', problem);
    assert.equal(classification.excluded, false, problem);
    assert.equal(classification.review, true, problem);
    assert.equal(classifyPathException(pathById(paths, 'p-006'), evidence).disposition, 'exception_review', problem);
    const summary = summarize(paths, snapshot);
    assert.equal(summary.status, 'UNVERIFIED', problem);
    assert.equal(summary.excludedPaths, 0, problem);
    assert.equal(summary.unverifiedExceptions, 1, problem);
    assert.equal(summary.exceptionCandidates, 1, problem);
    assert.equal(summary.timedPaths, paths.length, problem);
    assert.equal(summary.violations, 7, problem);
    assert.equal(summary.wns, -0.75, problem);
    assert.equal(summary.tns, -1.527, problem);
  }
});

test('clock-group scope excludes asynchronous paths but leaves unrelated negative paths timed', () => {
  const snapshot = freshSnapshot();
  for (const [id, slack] of [['p-007', -0.75], ['p-013', -0.02]]) {
    const path = snapshotPath(snapshot, id);
    path.exception = { ...path.exception, kind: 'clock_group' };
    path.slack = slack;
  }
  const paths = pathsFor(snapshot, 'setup', 'signoff');
  const evidence = assessEvidence(snapshot.manifest);
  const asynchronous = pathById(paths, 'p-007');
  const unrelated = pathById(paths, 'p-004');
  const summary = summarize(paths, snapshot, 'setup', 'signoff', evidence);

  assert.equal(asynchronous.launchClock, 'clk_core');
  assert.equal(asynchronous.captureClock, 'clk_dbg');
  assert.equal(asynchronous.clockRelation, 'asynchronous');
  assert.equal(classifyPathException(asynchronous, evidence).disposition, 'clock_group_excluded');
  assert.equal(classifyPathException(asynchronous, evidence).excluded, true);
  assert.equal(classifyPathException(unrelated, evidence).disposition, 'timed');
  assert.equal(unrelated.slack, -0.124);
  assert.equal(summary.excludedPaths, 1);
  assert.equal(summary.excludedClockGroups, 1);
  assert.equal(summary.excludedFalsePaths, 0);
  assert.equal(summary.violations, 6);
  assert.equal(summary.wns, -0.183);
  assert.equal(summary.tns, -0.777);
  assert.equal(summary.timedPaths, 7);

  const holdPaths = pathsFor(snapshot, 'hold');
  assert.equal(classifyPathException(pathById(holdPaths, 'p-013'), evidence).disposition, 'clock_group_excluded');
  const hold = summarize(holdPaths, snapshot, 'hold');
  assert.equal(hold.excludedClockGroups, 1);
  assert.equal(hold.violations, 2);
  assert.equal(hold.wns, -0.006);
  assert.equal(hold.tns, -0.012);

  // Both launch and capture must be inside the declared clock scope.
  for (const clocks of [
    { launchClock: 'clk_bus', captureClock: 'clk_dbg' },
    { launchClock: 'clk_core', captureClock: 'clk_bus' }
  ]) {
    const mismatchedPath = { ...asynchronous, ...clocks };
    const mismatch = classifyPathException(mismatchedPath, evidence);
    assert.equal(mismatch.disposition, 'exception_unverified');
    assert.equal(mismatch.excluded, false);
    assert.equal(mismatch.review, true);
    const mismatched = summarize([mismatchedPath, unrelated], snapshot);
    assert.equal(mismatched.excludedPaths, 0);
    assert.equal(mismatched.violations, 2);
    assert.equal(mismatched.wns, -0.75);
    assert.equal(mismatched.tns, -0.874);
  }
});

test('multicycle exceptions remain timed without changing required time or slack', () => {
  const snapshot = freshSnapshot();
  const baselinePaths = pathsFor(snapshot);
  const baseline = summarize(baselinePaths, snapshot);
  snapshotPath(snapshot, 'p-001').exception = { kind: 'multicycle', status: 'applied', cycles: 2 };
  const regular = pathById(baselinePaths, 'p-001');
  const paths = pathsFor(snapshot, 'setup', 'signoff');
  const multicycle = pathById(paths, 'p-001');
  const classification = classifyPathException(multicycle, assessEvidence(snapshot.manifest));
  const summary = summarize(paths, snapshot, 'setup', 'signoff');

  assert.equal(multicycle.required, regular.required);
  assert.equal(multicycle.slack, regular.slack);
  assert.equal(multicycle.arrival, regular.arrival);
  assert.deepEqual(classification, {
    disposition: 'multicycle_timed',
    excluded: false,
    review: false,
    label: 'MULTICYCLE ×2 · TIMED',
    kind: 'multicycle',
    status: 'applied',
    source: 'constraints.sdc'
  });
  assert.equal(summary.multicyclePaths, 1);
  assert.equal(summary.timedPaths, paths.length - 1);
  assert.equal(summary.violations, 6);
  assert.deepEqual(summary, { ...baseline, multicyclePaths: 1 });
});

test('false-path what-if adds only p-006 exclusion and respects stage, corner, and mode', () => {
  const snapshot = freshSnapshot();
  const before = structuredClone(snapshot);
  const evidence = assessEvidence(snapshot.manifest);
  for (const [stage, corner, mode, expectedWns] of [
    ['signoff', 'slow', 'functional', -0.183],
    ['signoff', 'fast', 'functional', -0.139],
    ['signoff', 'slow', 'scan', -0.205],
    ['placement', 'fast', 'scan', -0.288]
  ]) {
    const modeled = applyWhatIf(snapshot, 'false-path', 'setup', stage, corner, mode);
    const baselinePaths = pathsFor(snapshot, 'setup', stage, corner, mode);
    const baseline = summarize(baselinePaths, snapshot, 'setup', stage);
    const baselineExcluded = baselinePaths.filter((path) => classifyPathException(path, evidence).excluded).map((path) => path.id);
    const modeledExcluded = modeled.paths.filter((path) => classifyPathException(path, evidence).excluded).map((path) => path.id);

    assert.deepEqual(baselineExcluded, ['p-007']);
    assert.deepEqual(modeledExcluded, ['p-006', 'p-007']);
    assert.deepEqual(modeled.paths.filter((path) => path.modeled).map((path) => path.id), ['p-006']);
    assert.equal(modeled.paths.length, baselinePaths.length);
    assert.equal(pathById(modeled.paths, 'p-001').slack, expectedWns);
    for (const path of baselinePaths.filter((path) => path.id !== 'p-006')) {
      assert.deepEqual(pathById(modeled.paths, path.id), path);
    }
    const target = pathById(modeled.paths, 'p-006');
    assert.deepEqual(target, {
      ...pathById(baselinePaths, 'p-006'),
      exception: {
        kind: 'false_path',
        status: 'applied',
        scope: 'path',
        sourceReport: 'constraints.sdc'
      },
      modeled: true
    });
    assert.ok(target.slack < 0);
    assert.deepEqual(modeled.baseline, baseline);
    assert.equal(modeled.summary.wns, baseline.wns);
    assert.equal(modeled.summary.tns, Number((baseline.tns - target.slack).toFixed(3)));
    assert.equal(modeled.summary.violations, baseline.violations - 1);
    assert.equal(modeled.summary.timedPaths, baseline.timedPaths - 1);
    assert.equal(modeled.summary.endpoints, baseline.endpoints - 1);
    assert.equal(modeled.summary.totalPaths, baseline.totalPaths);
    assert.equal(modeled.summary.excludedFalsePaths, baseline.excludedFalsePaths + 1);
    assert.equal(modeled.summary.exceptionCandidates, 0);
    assert.equal(modeled.summary.status, 'FAIL');
    assert.equal(modeled.summary.overflow, baseline.overflow);
    assert.equal(modeled.summary.area, snapshot.totals.area);
    assert.equal(modeled.summary.power, snapshot.totals.power);
    assert.equal(modeled.summary.modeled, true);
    assert.equal(modeled.summary.origin, 'modeled');
    assert.deepEqual(snapshot, before);
    assert.deepEqual(pathsFor(snapshot, 'setup', stage, corner, mode), baselinePaths);
  }
  assert.equal(snapshotPath(snapshot, 'p-006').exception.status, 'candidate');
});

test('false-path what-if leaves hold paths and timing metrics unchanged', () => {
  const snapshot = freshSnapshot();
  const before = structuredClone(snapshot);
  const paths = pathsFor(snapshot, 'hold', 'cts', 'fast', 'scan');
  const baseline = summarize(paths, snapshot, 'hold', 'cts');
  const modeled = applyWhatIf(snapshot, 'false-path', 'hold', 'cts', 'fast', 'scan');

  assert.deepEqual(modeled.paths, paths);
  assert.deepEqual(modeled.baseline, baseline);
  for (const [metric, value] of Object.entries(baseline).filter(([metric]) => metric !== 'origin')) {
    assert.equal(modeled.summary[metric], value, metric);
  }
  assert.equal(pathById(modeled.paths, 'p-010').slack, -0.004);
  assert.deepEqual(snapshot, before);
});

test('false-path what-if cannot exclude its target when constraints are unverified', () => {
  const snapshot = freshSnapshot();
  sourceReport(snapshot, 'constraints').status = 'stale';
  const before = structuredClone(snapshot);
  const modeled = applyWhatIf(snapshot, 'false-path');
  const target = pathById(modeled.paths, 'p-006');
  const classification = classifyPathException(target, assessEvidence(snapshot.manifest));

  assert.equal(target.exception.status, 'applied');
  assert.equal(target.slack, snapshotPath(snapshot, 'p-006').slack);
  assert.equal(classification.disposition, 'exception_unverified');
  assert.equal(classification.excluded, false);
  assert.equal(modeled.summary.status, 'UNVERIFIED');
  assert.equal(modeled.summary.excludedPaths, 0);
  assert.equal(modeled.summary.violations, modeled.baseline.violations);
  assert.equal(modeled.summary.wns, modeled.baseline.wns);
  assert.equal(modeled.summary.tns, modeled.baseline.tns);
  assert.deepEqual(snapshot, before);
});

test('signoff report selects hold paths, inventories classified exceptions, and rejects violations', () => {
  const snapshot = freshSnapshot();
  const before = structuredClone(snapshot);
  const report = buildSignoffReport(snapshot, { analysis: 'hold' });
  const byId = (id, analysis) => report.exceptions.find((exception) => exception.id === id && exception.analysis === analysis);

  assert.deepEqual(report.context, { analysis: 'hold', stage: 'signoff', corner: 'slow', mode: 'functional' });
  assert.equal(report.baseline.selectedAnalysis, 'hold');
  assert.deepEqual(report.baseline.worstPaths.map((path) => path.id), ['p-010', 'p-011', 'p-009', 'p-012', 'p-013']);
  assert.ok(report.baseline.worstPaths.every((path) => path.analysis === 'hold'));
  for (const path of report.baseline.worstPaths) {
    assert.equal(path.timingFreshness, 'fresh');
    assert.equal(path.constraintFreshness, 'fresh');
    assert.equal(path.classification.disposition, path.id === 'p-013' ? 'clock_group_excluded' : 'timed');
  }
  assert.equal(report.evidence.overall, 'fresh');
  assert.equal(report.evidenceEligible, false);
  assert.equal(report.closureStatus, 'OPEN');
  assert.equal(report.baseline.setup.violations, 6);
  assert.equal(report.baseline.hold.violations, 2);
  assert.equal(report.baseline.hold.wns, -0.006);
  assert.equal(report.baseline.hold.tns, -0.012);
  assert.equal(report.baseline.hold.timedPaths, 4);
  assert.equal(report.baseline.hold.excludedClockGroups, 1);
  assert.equal(report.signoffEligible, false);
  assert.equal(byId('p-006', 'setup').disposition, 'exception_review');
  assert.equal(byId('p-006', 'setup').kind, 'false_path');
  assert.equal(byId('p-007', 'setup').disposition, 'false_path_excluded');
  assert.equal(byId('p-013', 'hold').disposition, 'clock_group_excluded');
  assert.equal(report.exceptions.length, 3);
  for (const exception of report.exceptions) {
    const raw = snapshotPath(snapshot, exception.id);
    assert.deepEqual(exception.exception, raw.exception);
    assert.equal(exception.source, 'constraints.sdc');
    assert.equal(exception.status, raw.exception.status);
    assert.equal(exception.excluded, exception.id !== 'p-006');
    assert.equal(exception.review, exception.id === 'p-006');
  }
  assert.equal(byId('p-013', 'hold').launchClock, 'clk_core');
  assert.equal(byId('p-013', 'hold').captureClock, 'clk_dbg');
  assert.equal(byId('p-013', 'hold').clockRelation, 'asynchronous');
  assert.ok(report.baseline.clockPairs.includes('clk_core → clk_dbg (asynchronous)'));
  assert.deepEqual(snapshot, before);
});

test('fresh evidence and reviewed exceptions cannot make setup or hold violations signoff eligible', () => {
  for (const failingAnalysis of ['setup', 'hold']) {
    const snapshot = freshSnapshot();
    snapshotPath(snapshot, 'p-006').exception = null;
    for (const path of snapshot.paths) {
      path.slack = path.analysis === failingAnalysis ? path.slack : Math.abs(path.slack);
    }
    // Select the passing analysis to prove eligibility still checks both analyses.
    const passingAnalysis = failingAnalysis === 'setup' ? 'hold' : 'setup';
    const report = buildSignoffReport(snapshot, { analysis: passingAnalysis });
    assert.equal(report.evidence.overall, 'fresh');
    assert.equal(report.evidenceEligible, true);
    assert.equal(report.baseline[passingAnalysis].status, 'PASS');
    assert.equal(report.baseline[failingAnalysis].status, 'FAIL');
    assert.ok(report.baseline[failingAnalysis].violations > 0);
    assert.equal(report.closureStatus, 'OPEN');
    assert.equal(report.signoffEligible, false);
  }
});

test('derived contexts remain signoff ineligible even with fresh evidence and passing timing', () => {
  const snapshot = freshSnapshot();
  snapshotPath(snapshot, 'p-006').exception = null;
  for (const path of snapshot.paths) path.slack = Math.abs(path.slack);
  const reported = buildSignoffReport(snapshot, { analysis: 'hold' });
  assert.equal(reported.evidenceEligible, true);
  assert.equal(reported.signoffEligible, true);
  assert.equal(reported.baseline.setup.origin, 'reported');
  assert.equal(reported.baseline.hold.origin, 'reported');

  for (const context of [
    { stage: 'placement', analysis: 'hold' },
    { corner: 'fast', analysis: 'hold' },
    { mode: 'scan', analysis: 'hold' },
    { stage: 'cts', corner: 'fast', mode: 'scan', analysis: 'hold' }
  ]) {
    const report = buildSignoffReport(snapshot, context);
    assert.deepEqual(report.context, { stage: 'signoff', corner: 'slow', mode: 'functional', analysis: 'hold', ...context });
    assert.equal(report.evidence.overall, 'fresh');
    assert.equal(report.evidenceEligible, true);
    assert.equal(report.baseline.setup.status, 'PASS');
    assert.equal(report.baseline.hold.status, 'PASS');
    assert.equal(report.baseline.setup.origin, 'derived');
    assert.equal(report.baseline.hold.origin, 'derived');
    assert.ok(report.baseline.worstPaths.every((path) => path.origin === 'derived' && path.analysis === 'hold'));
    assert.equal(report.signoffEligible, false);
    assert.equal(report.closureStatus, 'PASS');
  }
});

test('invalid timestamps cannot conceal explicitly stale timing evidence', () => {
  const snapshot = freshSnapshot();
  const timing = sourceReport(snapshot, 'timing');
  timing.status = 'stale';
  timing.generatedAt = 'invalid';

  const report = buildSignoffReport(snapshot);
  const source = report.evidence.reports.find((item) => item.name === timing.name);
  assert.equal(source.stale, true);
  assert.equal(source.unknown, true);
  assert.equal(source.freshness, 'stale');
  assert.deepEqual(source.reasons, ['explicit_status', 'invalid_timestamp']);
  assert.equal(report.evidence.timing.status, 'stale');
  assert.equal(report.baseline.setup.status, 'UNVERIFIED');
  assert.equal(report.signoffEligible, false);
});
