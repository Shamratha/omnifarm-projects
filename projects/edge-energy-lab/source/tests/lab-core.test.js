const test = require('node:test');
const assert = require('node:assert/strict');
const Lab = require('../lab-core.js');

const EXPECTED_COST_ASSUMPTIONS = {
  batteryCapacityWh: 4.44,
  batteryWindowCount: 1000,
  energyPer1000WindowsFormula: 'energyMicroJPerWindow * 1000 / 3600 (microWh)',
  batteryPercentFormula: 'energyPer1000WindowsMicroWh / (batteryCapacityWh * 1000000) * 100',
  costIndependentOfThresholdAndAlerts: true,
  memoryBasis: 'Fixed modeled footprint; not measured peak RAM or flash usage',
  memoryUnitBytes: 1024,
  latencyFormula: '0.05 + operationsPerWindow * 0.003',
  p95Formula: 'latencyMsPerWindow * 1.20',
  p95Multiplier: 1.2,
  sensorEnergyMicroJ: 18,
  energyFormula: '18 + operationsPerWindow * 0.06 + memoryBytes * 0.002',
  falsePositiveDefinition: 'Normal-labeled evaluated window with score >= threshold',
  falsePositiveRateDenominator: 'falsePositives / (falsePositives + trueNegatives)',
  missingSamplePolicy: 'Skip windows with missing/non-finite channels or invalid labels; no imputation',
  alertEnergyIncluded: false,
  alertEnergyScope: 'Radio, alert transmission, actuation, idle, peripherals, and battery losses are excluded'
};

function expectedMetrics(total, missingSamples, tp, tn, fp, fn) {
  const evaluated = total - missingSamples;
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  return {
    total, evaluated, missingSamples,
    truePositives: tp, trueNegatives: tn, falsePositives: fp, falseNegatives: fn,
    accuracy: evaluated ? (tp + tn) / evaluated : 0,
    precision, recall,
    f1: precision + recall ? 2 * precision * recall / (precision + recall) : 0,
    falsePositiveRate: fp + tn ? fp / (fp + tn) : 0,
    falseNegativeRate: fn + tp ? fn / (fn + tp) : 0,
    detectionRate: recall
  };
}

function assertMetrics(actual, expected) {
  assert.deepEqual(actual, expected);
  for (const [field, value] of Object.entries(actual)) {
    assert.ok(Number.isFinite(value), `${field} must be finite`);
  }
}

function normalSample(overrides = {}) {
  return { id: 'normal', index: 0, timestampSec: 0,
    temperatureC: 24, vibrationG: 0.08, currentMa: 180, label: 0, ...overrides };
}

test('fixture metadata, seeded sensor values, window fields and class split are deterministic', () => {
  assert.deepEqual(Lab.FIXTURE, {
    id: 'edge-lab-fixture-v1', seed: 0xed6e2025, windows: 256,
    positiveWindows: 32, samplingPeriodSec: 1, normalizationVersion: 'fixed-v1'
  });
  const first = Lab.createFixture();
  const second = Lab.createFixture();
  assert.deepEqual(first, second);
  assert.notStrictEqual(first, second);
  assert.notStrictEqual(first[0], second[0]);
  assert.equal(first.length, 256);
  assert.equal(first.filter(row => row.label === 1).length, 32);
  assert.equal(first.filter(row => row.label === 0).length, 224);
  assert.deepEqual(first[0], {
    id: 'W0000', index: 0, timestampSec: 0,
    temperatureC: 23.924135, vibrationG: 0.085422, currentMa: 182.722796, label: 0
  });
  first.forEach((row, index) => {
    assert.equal(row.id, `W${String(index).padStart(4, '0')}`);
    assert.equal(row.index, index);
    assert.equal(row.timestampSec, index);
    assert.equal(row.label, index % 32 >= 24 && index % 32 <= 27 ? 1 : 0);
    for (const field of ['temperatureC', 'vibrationG', 'currentMa']) {
      assert.ok(Number.isFinite(row[field]), `${row.id}.${field}`);
    }
  });
});

test('model catalog exposes the complete deterministic model metadata', () => {
  assert.deepEqual(Lab.MODELS, [
    {
      id: 'micro-threshold-v1', version: '1.0', name: 'Micro Threshold', shortName: 'Threshold',
      kind: 'rules', defaultThreshold: 0.08, operationsPerWindow: 14, memoryBytes: 1152,
      parameters: { temperatureWeight: 0.25, vibrationWeight: 0.5, currentWeight: 0.25 }
    },
    {
      id: 'tiny-linear-v1', version: '1.0', name: 'Tiny Linear', shortName: 'Linear',
      kind: 'linear', defaultThreshold: 0.5, operationsPerWindow: 29, memoryBytes: 2048,
      parameters: { bias: -1.8, temperatureWeight: 0.9, vibrationWeight: 1.6, currentWeight: 0.7 }
    }
  ]);
});

test('normalization and both scorers expose finite scores and their contributions', () => {
  const sample = normalSample({ temperatureC: 28, vibrationG: 0.24, currentMa: 260 });
  assert.deepEqual(Lab.normalize(normalSample()), { temperature: 0, vibration: 0, current: 0 });
  const normalized = Lab.normalize(sample);
  for (const value of Object.values(normalized)) assert.ok(Math.abs(value - 2) < 1e-12);
  for (const model of Lab.MODELS) {
    const scored = Lab.scoreSample(sample, model);
    assert.deepEqual(Object.keys(scored).sort(), ['contributions', 'normalized', 'score']);
    assert.deepEqual(scored.normalized, normalized);
    const p = model.parameters;
    const expected = model.kind === 'rules'
      ? { temperature: p.temperatureWeight / 3,
        vibration: p.vibrationWeight * Math.max(0, normalized.vibration - 1.5) / 3,
        current: p.currentWeight * 0.8 / 3 }
      : { bias: p.bias, temperature: p.temperatureWeight * normalized.temperature,
        vibration: p.vibrationWeight * normalized.vibration, current: p.currentWeight * normalized.current };
    assert.deepEqual(Object.keys(scored.contributions).sort(), Object.keys(expected).sort());
    for (const [field, value] of Object.entries(expected)) {
      assert.ok(Math.abs(scored.contributions[field] - value) < 1e-12, field);
    }
    const sum = Object.values(expected).reduce((a, b) => a + b, 0);
    const expectedScore = model.kind === 'rules' ? sum : 1 / (1 + Math.exp(-sum));
    assert.ok(Math.abs(scored.score - expectedScore) < 1e-12);
    assert.ok(scored.score >= 0 && scored.score <= 1);
  }
});

test('null, absent and non-finite sample fields are excluded from rows and metric denominators', () => {
  const valid = [normalSample(), normalSample({ id: 'anomaly', label: 1 })];
  const invalid = [null, undefined];
  for (const field of ['temperatureC', 'vibrationG', 'currentMa', 'label']) {
    for (const value of [null, undefined, NaN, Infinity, -Infinity]) {
      invalid.push(normalSample({ [field]: value }));
    }
  }
  for (const model of Lab.MODELS) {
    const result = Lab.evaluate([...valid, ...invalid], model, 0);
    assertMetrics(result.metrics, expectedMetrics(24, 22, 1, 0, 1, 0));
    assert.deepEqual(result.rows.map(row => row.id), ['normal', 'anomaly']);
    result.rows.forEach((row, index) => {
      assert.deepEqual(row, { ...valid[index], ...Lab.scoreSample(valid[index], model),
        predicted: 1, isFalsePositive: index === 0, isFalseNegative: false });
    });
    assert.deepEqual(valid, [normalSample(), normalSample({ id: 'anomaly', label: 1 })]);
  }
});

test('empty and all-missing datasets have zero finite metrics and no evaluated rows', () => {
  for (const dataset of [[], [null, undefined, {}, normalSample({ currentMa: NaN })]]) {
    for (const model of Lab.MODELS) {
      const result = Lab.evaluate(dataset, model, 0.5);
      assert.deepEqual(result.rows, []);
      assertMetrics(result.metrics, expectedMetrics(dataset.length, dataset.length, 0, 0, 0, 0));
    }
  }
});

test('all-negative predictions conceal class imbalance behind 87.5% accuracy', () => {
  for (const model of Lab.MODELS) {
    const result = Lab.evaluate(Lab.createFixture(), model, 1);
    assertMetrics(result.metrics, expectedMetrics(256, 0, 0, 224, 0, 32));
    assert.equal(result.metrics.accuracy, 0.875);
    assert.equal(result.metrics.precision, 0, 'no predicted positives has safe zero precision');
    assert.equal(result.metrics.recall, 0);
    assert.equal(result.metrics.f1, 0);
    assert.ok(result.rows.every(row => row.predicted === 0 && !row.isFalsePositive));
    assert.equal(result.rows.filter(row => row.isFalseNegative).length, 32);
  }
});

test('single-class datasets keep undefined rates finite for positive and negative predictions', () => {
  for (const model of Lab.MODELS) {
    for (const label of [0, 1]) {
      const dataset = [normalSample({ label }), normalSample({ id: 'second', label })];
      for (const threshold of [0, 1]) {
        const result = Lab.evaluate(dataset, model, threshold);
        const positive = threshold === 0;
        assertMetrics(result.metrics, expectedMetrics(2, 0,
          positive && label === 1 ? 2 : 0, !positive && label === 0 ? 2 : 0,
          positive && label === 0 ? 2 : 0, !positive && label === 1 ? 2 : 0));
        assert.ok(result.rows.every(row => row.predicted === (positive ? 1 : 0)));
      }
    }
  }
});

test('scores equal to the threshold predict positive; scores just below predict negative', () => {
  const sample = normalSample({ label: 1 });
  for (const model of Lab.MODELS) {
    const { score } = Lab.scoreSample(sample, model);
    for (const threshold of [Math.max(0, score - Number.EPSILON), score]) {
      const result = Lab.evaluate([sample], model, threshold);
      assert.equal(result.rows[0].predicted, 1);
      assertMetrics(result.metrics, expectedMetrics(1, 0, 1, 0, 0, 0));
    }
    const result = Lab.evaluate([sample], model, score + Number.EPSILON);
    assert.equal(result.rows[0].predicted, 0);
    assert.equal(result.rows[0].isFalseNegative, true);
    assertMetrics(result.metrics, expectedMetrics(1, 0, 0, 0, 0, 1));
  }
});

test('threshold sweeps contain all metric fields and recommend the same optimum deterministically', () => {
  const dataset = Lab.createFixture();
  for (const model of Lab.MODELS) {
    const sweep = Lab.thresholdSweep(dataset, model);
    assert.equal(sweep.length, 101);
    assert.deepEqual(sweep, Lab.thresholdSweep(dataset, model));
    sweep.forEach((point, index) => {
      const threshold = index / 100;
      assert.deepEqual(point, { threshold, ...Lab.evaluate(dataset, model, threshold).metrics });
    });
    assertMetrics(Lab.evaluate(dataset, model, 0).metrics, expectedMetrics(256, 0, 32, 0, 224, 0));
    assertMetrics(Lab.evaluate(dataset, model, 1).metrics, expectedMetrics(256, 0, 0, 224, 0, 32));
    const snapshot = structuredClone(sweep);
    const recommended = Lab.recommendedThreshold(sweep);
    assert.deepEqual(sweep, snapshot, 'recommendation must not reorder the sweep');
    assert.deepEqual(recommended, Lab.recommendedThreshold([...sweep].reverse()));
    assert.ok(sweep.includes(recommended));
    assert.equal(recommended.f1, Math.max(...sweep.map(point => point.f1)));
    assert.equal(recommended.f1, 1);
    assertMetrics(Lab.evaluate(dataset, model, recommended.threshold).metrics,
      expectedMetrics(256, 0, 32, 224, 0, 0));
    if (model.kind === 'rules') assert.equal(recommended.threshold, 0.01);
  }
});

test('recommendation tie breakers prefer F1, fewer false positives, recall, then lower threshold', () => {
  const best = { threshold: 0.2, f1: 0.8, falsePositives: 1, recall: 0.9 };
  const cases = [
    { ...best, threshold: 0.1, f1: 0.7, falsePositives: 0, recall: 1 },
    { ...best, threshold: 0.1, falsePositives: 2, recall: 1 },
    { ...best, threshold: 0.1, recall: 0.8 },
    { ...best, threshold: 0.3 }
  ];
  for (const competitor of cases) {
    assert.deepEqual(Lab.recommendedThreshold([competitor, best]), best);
    assert.deepEqual(Lab.recommendedThreshold([best, competitor]), best);
  }
  assert.equal(Lab.recommendedThreshold([]), undefined);
});

test('empty and all-missing sweeps deterministically recommend the lowest threshold', () => {
  for (const model of Lab.MODELS) {
    for (const dataset of [[], [null, normalSample({ temperatureC: Infinity })]]) {
      const sweep = Lab.thresholdSweep(dataset, model);
      assert.equal(sweep.length, 101);
      for (const { threshold, ...metrics } of sweep) {
        assert.ok(threshold >= 0 && threshold <= 1);
        assertMetrics(metrics, expectedMetrics(dataset.length, dataset.length, 0, 0, 0, 0));
      }
      assert.deepEqual(Lab.recommendedThreshold(sweep), sweep[0]);
    }
  }
});

test('accuracy-latency Pareto frontier retains tradeoffs and equals while rejecting dominated points', () => {
  const points = [
    { accuracy: 0.8, latencyMs: 1 },
    { accuracy: 0.9, latencyMs: 2 },
    { accuracy: 1, latencyMs: 3 },
    { accuracy: 0.7, latencyMs: 2 },
    { accuracy: 0.8, latencyMs: 2 },
    { accuracy: 0.9, latencyMs: 3 },
    { accuracy: 0.9, latencyMs: 2 }
  ];
  const snapshot = structuredClone(points);
  const expected = [true, true, true, false, false, false, true];
  assert.deepEqual(Lab.isParetoFrontier(points), expected);
  assert.deepEqual(points, snapshot);
  assert.deepEqual(Lab.isParetoFrontier([...points].reverse()), [...expected].reverse());
  assert.deepEqual(Lab.isParetoFrontier([]), []);
  assert.deepEqual(Lab.isParetoFrontier([points[0]]), [true]);
  assert.deepEqual(Lab.isParetoFrontier([points[0], { ...points[0] }]), [true, true]);
});

test('cost estimates expose deterministic latency, memory, energy and battery fields', () => {
  const expected = {
    'micro-threshold-v1': {
      latencyMsPerWindow: 0.092, p95LatencyMs: 0.1104, memoryBytes: 1152, memoryKiB: 1.13,
      energyMicroJPerWindow: 21.144, energyPer1000WindowsMicroWh: 5.8733,
      batteryPercentPer1000Windows: 0.000132
    },
    'tiny-linear-v1': {
      latencyMsPerWindow: 0.137, p95LatencyMs: 0.1644, memoryBytes: 2048, memoryKiB: 2,
      energyMicroJPerWindow: 23.836, energyPer1000WindowsMicroWh: 6.6211,
      batteryPercentPer1000Windows: 0.000149
    }
  };
  assert.equal(Lab.MODELS.length, 2);
  for (const model of Lab.MODELS) {
    assert.deepEqual(Lab.estimateCost(model), expected[model.id]);
    for (const value of Object.values(Lab.estimateCost(model))) assert.ok(Number.isFinite(value));
  }
});

test('cost assumptions document modeled latency, memory, battery, false positives and coverage without alert energy', () => {
  assert.deepEqual(Lab.COST_ASSUMPTIONS, EXPECTED_COST_ASSUMPTIONS);
  const assumptions = Lab.COST_ASSUMPTIONS;
  for (const model of Lab.MODELS) {
    const cost = Lab.estimateCost(model);
    const latency = 0.05 + model.operationsPerWindow * 0.003;
    const energy = assumptions.sensorEnergyMicroJ + model.operationsPerWindow * 0.06 + model.memoryBytes * 0.002;
    const energyPer1000 = energy * assumptions.batteryWindowCount / 3600;
    assert.equal(cost.latencyMsPerWindow, Lab.round(latency, 4));
    assert.equal(cost.p95LatencyMs, Lab.round(latency * assumptions.p95Multiplier, 4));
    assert.equal(cost.memoryKiB, Lab.round(model.memoryBytes / assumptions.memoryUnitBytes, 2));
    assert.equal(cost.energyMicroJPerWindow, Lab.round(energy, 4));
    assert.equal(cost.energyPer1000WindowsMicroWh, Lab.round(energyPer1000, 4));
    assert.equal(cost.batteryPercentPer1000Windows,
      Lab.round(energyPer1000 / (assumptions.batteryCapacityWh * 1000000) * 100, 6));

    const result = Lab.evaluate(Lab.createFixture('dropouts'), model, model.defaultThreshold);
    assert.equal(result.metrics.evaluated, 247);
    assert.equal(result.metrics.missingSamples, 9);
    assert.equal(result.metrics.falsePositives,
      result.rows.filter(row => row.label === 0 && row.score >= model.defaultThreshold).length);
    assert.equal(result.metrics.falsePositiveRate,
      result.metrics.falsePositives / (result.metrics.falsePositives + result.metrics.trueNegatives));
  }
});

test('canonical serialization handles nested arrays, escaped strings and primitives deterministically', () => {
  const value = { title: 'edge "lab"\n', nested: [null, true, false, { score: 0.5 }], count: 2 };
  const expected = '{"title":"edge \\"lab\\"\\n","nested":[null,true,false,{"score":0.5}],"count":2}';
  assert.equal(Lab.canonicalize(value), expected);
  assert.equal(Lab.canonicalize(structuredClone(value)), expected);
  assert.deepEqual(JSON.parse(Lab.canonicalize(value)), value);
  assert.equal(Lab.canonicalize([]), '[]');
  assert.equal(Lab.canonicalize({}), '{}');
  assert.equal(Lab.canonicalize(null), 'null');
  assert.equal(Lab.fnv1a(''), '811c9dc5');
  assert.equal(Lab.fnv1a('a'), 'e40c292c');
  assert.equal(Lab.fnv1a('hello'), '4f9f2cab');
  assert.notEqual(Lab.fnv1a('SIMULATED — local'), Lab.fnv1a('SIMULATED — local'.replace('—', '')));
});

test('deployment cards contain canonical rounded fields and are checksum-stable', () => {
  const dataset = Lab.createFixture();
  const model = Lab.MODELS[0];
  const threshold = 0.012345;
  const result = Lab.evaluate(dataset, model, threshold);
  const cost = Lab.estimateCost(model);
  const card = Lab.deploymentCard(Lab.FIXTURE, model, threshold, result.metrics, cost);
  assert.deepEqual(card, {
    schemaVersion: '1.1',
    dataset: { id: 'edge-lab-fixture-v1', seed: 0xed6e2025, windows: 256, scenario: 'baseline' },
    model: {
      id: 'micro-threshold-v1', version: '1.0',
      parameters: { temperatureWeight: 0.25, vibrationWeight: 0.5, currentWeight: 0.25 }
    },
    threshold: 0.012345,
    metrics: {
      accuracy: 1, precision: 1, recall: 1, f1: 1, falsePositives: 0, falseNegatives: 0, evaluated: 256, missingSamples: 0
    },
    costEstimate: {
      latencyMs: 0.092, p95LatencyMs: 0.1104, memoryBytes: 1152,
      energyMicroJPerWindow: 21.144, energyPer1000WindowsMicroWh: 5.8733,
      batteryPercentPer1000Windows: 0.000132
    },
    assumptions: EXPECTED_COST_ASSUMPTIONS,
    fasterProfileComparison: null,
    simulation: {
      results: 'SIMULATED — not hardware measurements or a trained model benchmark',
      batteryWh: 4.44,
      energyScope: 'sensor acquisition + inference only; excludes radio, idle, peripherals and battery losses'
    },
    reproducibility: {
      normalizationVersion: 'fixed-v1', costModelVersion: 'synthetic-cost-v1',
      missingSamplePolicy: 'Skip windows with missing/non-finite channels or invalid labels; no imputation',
      classificationRule: 'score >= threshold', artifact: 'lab-core.js v1.0', fixtureChecksum: 'a898345b',
      costFormulas: {
        latencyMs: '0.05 + operationsPerWindow * 0.003',
        p95LatencyMs: 'latencyMsPerWindow * 1.20',
        energyMicroJ: '18 + operationsPerWindow * 0.06 + memoryBytes * 0.002'
      },
      operationsPerWindow: 14
    }
  });
  const canonical = Lab.canonicalize(card);
  const checksum = Lab.fnv1a(canonical);
  assert.equal(canonical, Lab.canonicalize(structuredClone(card)));
  assert.equal(checksum, Lab.fnv1a(Lab.canonicalize(structuredClone(card))));
  assert.match(checksum, /^[0-9a-f]{8}$/);
  assert.equal(checksum, 'de9f8d0b');
  const changedThresholdCard = Lab.deploymentCard(Lab.FIXTURE, model, 0.02, result.metrics, cost);
  assert.notEqual(Lab.fnv1a(Lab.canonicalize(changedThresholdCard)), checksum);
});

test('local noisy and dropout scenarios are deterministic and preserve class labels', () => {
  const baseline = Lab.createFixture();
  const noisy = Lab.createFixture('field-noise');
  const dropouts = Lab.createFixture('dropouts');
  for (const scenario of Lab.SCENARIOS) {
    const data = Lab.createFixture(scenario.id);
    assert.deepEqual(data, Lab.createFixture(scenario.id));
    assert.deepEqual(data.map(row => row.label), baseline.map(row => row.label));
  }
  assert.equal(noisy.filter((row, i) => row.vibrationG !== baseline[i].vibrationG).length, 7);
  assert.equal(dropouts.filter(row => row.vibrationG === null).length, 9);
  for (const model of Lab.MODELS) {
    const noisyResult = Lab.evaluate(noisy, model, model.defaultThreshold);
    const dropoutResult = Lab.evaluate(dropouts, model, model.defaultThreshold);
    assert.ok(noisyResult.metrics.falsePositives > 0, 'default noisy fixture must expose inspectable false alarms');
    assert.equal(dropoutResult.metrics.missingSamples, 9);
    assert.equal(dropoutResult.metrics.evaluated, 247);
    assert.ok(dropoutResult.rows.every(row => Number.isFinite(row.vibrationG)));
  }
  assert.throws(() => Lab.createFixture('remote'), /Unknown local fixture/);
});

test('field-noise comparison pins confusion counts and faster-minus-baseline costs independently of threshold tuning', () => {
  const dataset = Lab.createFixture('field-noise');
  const thresholds = { 'micro-threshold-v1': 0.08, 'tiny-linear-v1': 0.5 };
  const comparison = Lab.compareProfiles(dataset, Lab.MODELS, thresholds);
  assert.deepEqual(comparison, Lab.compareProfiles(Lab.createFixture('field-noise'), Lab.MODELS, thresholds));
  assert.deepEqual(comparison, Lab.compareProfiles(dataset, [...Lab.MODELS].reverse(), thresholds));
  assert.equal(comparison.version, '1');
  assert.equal(comparison.thresholdPolicy, 'explicit-per-profile');
  assert.equal(comparison.deltaConvention, 'faster-minus-baseline');
  assert.equal(comparison.faster.model.id, 'micro-threshold-v1');
  assert.equal(comparison.baseline.model.id, 'tiny-linear-v1');
  for (const [profile, counts] of [[comparison.faster, [12, 218, 6, 20]], [comparison.baseline, [32, 217, 7, 0]]]) {
    const model = Lab.MODELS.find(entry => entry.id === profile.model.id);
    assert.equal(profile.threshold, thresholds[model.id]);
    assert.deepEqual(profile.model, {
      id: model.id, version: model.version, name: model.name, kind: model.kind, parameters: model.parameters
    });
    assert.equal(profile.operationsPerWindow, model.operationsPerWindow);
    assert.equal(profile.memoryBytes, model.memoryBytes);
    assertMetrics(Lab.evaluate(dataset, model, profile.threshold).metrics, expectedMetrics(256, 0, ...counts));
    assert.deepEqual([
      profile.metrics.truePositives, profile.metrics.trueNegatives,
      profile.metrics.falsePositives, profile.metrics.falseNegatives
    ], counts);
    assert.equal(profile.metrics.evaluated, 256);
    assert.equal(profile.metrics.missingSamples, 0);
  }
  assert.deepEqual(comparison.deltas, {
    latencyMs: -0.045, p95LatencyMs: -0.054, memoryBytes: -896,
    energyMicroJPerWindow: -2.692, energyPer1000WindowsMicroWh: -0.7478,
    batteryPercentPer1000Windows: -0.000017,
    falsePositives: -1, falseNegatives: 20, accuracy: -0.074218, recall: -0.625, f1: -0.421408
  });

  const tuned = Lab.compareProfiles(dataset, Lab.MODELS, { ...thresholds, 'micro-threshold-v1': 0.01 });
  assert.equal(tuned.faster.threshold, 0.01);
  assertMetrics(Lab.evaluate(dataset, Lab.MODELS[0], 0.01).metrics, expectedMetrics(256, 0, 32, 217, 7, 0));
  assert.deepEqual(tuned.faster.metrics, comparison.baseline.metrics);
  assert.equal(tuned.faster.metrics.falsePositives, 7);
  assert.equal(tuned.faster.metrics.falseNegatives, 0);
  assert.deepEqual(tuned.faster.costEstimate, comparison.faster.costEstimate);
  assert.deepEqual(tuned.baseline, comparison.baseline);
  for (const field of ['latencyMs', 'p95LatencyMs', 'memoryBytes', 'energyMicroJPerWindow',
    'energyPer1000WindowsMicroWh', 'batteryPercentPer1000Windows']) {
    assert.equal(tuned.deltas[field], comparison.deltas[field], field);
  }
  assert.equal(tuned.deltas.falsePositives, 0);
  assert.equal(tuned.deltas.falseNegatives, 0);
});

test('comparison exports replay byte-identically from both model snapshots and exact thresholds; either threshold changes the checksum', () => {
  const metadata = { ...Lab.FIXTURE, scenario: 'field-noise' };
  const dataset = Lab.createFixture(metadata.scenario);
  const thresholds = { 'micro-threshold-v1': 0.01, 'tiny-linear-v1': 0.543456789 };
  const selectedModel = Lab.MODELS[0];
  const comparison = Lab.compareProfiles(dataset, Lab.MODELS, thresholds);
  const card = Lab.deploymentCard(metadata, selectedModel, thresholds[selectedModel.id],
    Lab.evaluate(dataset, selectedModel, thresholds[selectedModel.id]).metrics,
    Lab.estimateCost(selectedModel), comparison);
  assert.equal(card.schemaVersion, '1.1');
  assert.deepEqual(card.assumptions, EXPECTED_COST_ASSUMPTIONS);
  assert.deepEqual(card.fasterProfileComparison, comparison);
  const canonical = Lab.canonicalize(card);
  const checksum = Lab.fnv1a(canonical);
  const exported = JSON.parse(canonical);
  const profiles = [exported.fasterProfileComparison.baseline, exported.fasterProfileComparison.faster];
  // Reconstruct from the export alone, without borrowing catalog defaults or parameters.
  const replayModels = profiles.map(profile => ({
    ...profile.model, operationsPerWindow: profile.operationsPerWindow, memoryBytes: profile.memoryBytes
  }));
  const replayThresholds = Object.fromEntries(profiles.map(profile => [profile.model.id, profile.threshold]));
  assert.deepEqual(replayThresholds, thresholds);
  const replayDataset = Lab.createFixture(exported.dataset.scenario);
  const replayMetadata = { ...exported.dataset, normalizationVersion: exported.reproducibility.normalizationVersion };
  const replaySelectedModel = replayModels.find(model => model.id === exported.model.id);
  function replayCard(explicitThresholds) {
    const threshold = explicitThresholds[replaySelectedModel.id];
    return Lab.deploymentCard(replayMetadata, replaySelectedModel, threshold,
      Lab.evaluate(replayDataset, replaySelectedModel, threshold).metrics, Lab.estimateCost(replaySelectedModel),
      Lab.compareProfiles(replayDataset, replayModels, explicitThresholds));
  }
  const replay = replayCard(replayThresholds);
  const replayCanonical = Lab.canonicalize(replay);
  assert.equal(replayCanonical, canonical);
  assert.deepEqual(Buffer.from(replayCanonical, 'utf8'), Buffer.from(canonical, 'utf8'));
  assert.equal(Lab.fnv1a(replayCanonical), checksum);
  for (const profile of profiles) {
    // Tiny changes keep decisions and costs fixed, so the explicit threshold itself must be fingerprinted.
    const changed = replayCard({ ...replayThresholds, [profile.model.id]: profile.threshold + 0.000000001 });
    assert.deepEqual(changed.metrics, replay.metrics);
    assert.deepEqual(changed.costEstimate, replay.costEstimate);
    for (const role of ['baseline', 'faster']) {
      assert.deepEqual(changed.fasterProfileComparison[role].metrics, replay.fasterProfileComparison[role].metrics);
      assert.deepEqual(changed.fasterProfileComparison[role].costEstimate, replay.fasterProfileComparison[role].costEstimate);
    }
    assert.notEqual(Lab.fnv1a(Lab.canonicalize(changed)), checksum, profile.model.id);
    if (profile.model.id !== exported.model.id) {
      assert.equal(changed.threshold, replay.threshold, 'baseline threshold change is carried by the comparison');
    }
  }
});

test('sparse samples, invalid binary labels and invalid thresholds are handled explicitly', () => {
  const sparse = Array(3);
  sparse[1] = normalSample();
  for (const model of Lab.MODELS) {
    assertMetrics(Lab.evaluate(sparse, model, 1).metrics, expectedMetrics(3, 2, 0, 1, 0, 0));
    for (const label of [2, -1, '0', true]) {
      assert.equal(Lab.evaluate([normalSample({ label })], model, 0.5).metrics.missingSamples, 1);
    }
    for (const threshold of [-0.01, 1.01, NaN, Infinity, '0.5']) {
      assert.throws(() => Lab.evaluate([], model, threshold), RangeError);
    }
  }
});

test('Pareto frontier updates when tuning makes the faster profile equally accurate', () => {
  const data = Lab.createFixture();
  const points = Lab.MODELS.map(model => ({
    accuracy: Lab.evaluate(data, model, model.defaultThreshold).metrics.accuracy,
    latencyMs: Lab.estimateCost(model).latencyMsPerWindow
  }));
  assert.deepEqual(Lab.isParetoFrontier(points), [true, true]);
  points[0].accuracy = Lab.evaluate(data, Lab.MODELS[0], 0.01).metrics.accuracy;
  assert.deepEqual(Lab.isParetoFrontier(points), [true, false]);
});

test('deployment cards reproduce each scenario with exact thresholds and UTF-8 fingerprints', () => {
  // Independent byte-level reference catches accidental UTF-16 hashing.
  function byteHash(text) {
    let hash = 2166136261;
    for (const byte of Buffer.from(text, 'utf8')) hash = Math.imul(hash ^ byte, 16777619);
    return (hash >>> 0).toString(16).padStart(8, '0');
  }
  assert.equal(Lab.fnv1a('µJ — ⚡'), byteHash('µJ — ⚡'));
  for (const scenario of Lab.SCENARIOS) {
    const data = Lab.createFixture(scenario.id);
    for (const model of Lab.MODELS) {
      const threshold = 0.083456789;
      const metrics = Lab.evaluate(data, model, threshold).metrics;
      const card = Lab.deploymentCard({ ...Lab.FIXTURE, scenario: scenario.id }, model, threshold, metrics, Lab.estimateCost(model));
      assert.equal(card.threshold, threshold, 'export must not round away a decision boundary');
      assert.equal(card.dataset.scenario, scenario.id);
      assert.equal(card.reproducibility.fixtureChecksum, byteHash(Lab.canonicalize(data)));
      const reproducedModel = { ...model, parameters: card.model.parameters };
      const replay = Lab.evaluate(Lab.createFixture(card.dataset.scenario), reproducedModel, card.threshold);
      const replayCard = Lab.deploymentCard({ ...Lab.FIXTURE, scenario: card.dataset.scenario }, reproducedModel, card.threshold, replay.metrics, Lab.estimateCost(reproducedModel));
      assert.equal(Lab.canonicalize(card), Lab.canonicalize(replayCard));
      assert.equal(Lab.fnv1a(Lab.canonicalize(card)), byteHash(Lab.canonicalize(card)));
      assert.match(card.simulation.results, /SIMULATED/);
    }
  }
});
