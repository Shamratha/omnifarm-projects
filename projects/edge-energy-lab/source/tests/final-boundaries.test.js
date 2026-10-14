const test = require('node:test');
const assert = require('node:assert/strict');
const Lab = require('../lab-core.js');

const thresholdsAt = (value) => Object.fromEntries(
  Lab.MODELS.map(model => [model.id, value])
);

function expectedMetrics(total, missingSamples, truePositives, trueNegatives, falsePositives, falseNegatives) {
  const evaluated = total - missingSamples;
  const precision = truePositives + falsePositives
    ? truePositives / (truePositives + falsePositives) : 0;
  const recall = truePositives + falseNegatives
    ? truePositives / (truePositives + falseNegatives) : 0;
  return {
    total, evaluated, missingSamples, truePositives, trueNegatives, falsePositives, falseNegatives,
    accuracy: evaluated ? (truePositives + trueNegatives) / evaluated : 0,
    precision, recall,
    f1: precision + recall ? 2 * precision * recall / (precision + recall) : 0,
    falsePositiveRate: falsePositives + trueNegatives
      ? falsePositives / (falsePositives + trueNegatives) : 0,
    falseNegativeRate: falseNegatives + truePositives
      ? falseNegatives / (falseNegatives + truePositives) : 0,
    detectionRate: recall
  };
}

function statusCounts(windows, modelId) {
  const counts = { 'false-alarm': 0, 'missed-event': 0, 'correct-alert': 0, 'correct-reject': 0, skipped: 0 };
  for (const window of windows) counts[window.decisions.find(decision => decision.modelId === modelId).status] += 1;
  return counts;
}

function byteHash(text) {
  let hash = 2166136261;
  for (const byte of Buffer.from(text, 'utf8')) hash = Math.imul(hash ^ byte, 16777619);
  return (hash >>> 0).toString(16).padStart(8, '0');
}

const rounded = (value, digits = 6) => Number(value.toFixed(digits));

function metricSnapshot(metrics) {
  return {
    accuracy: rounded(metrics.accuracy), precision: rounded(metrics.precision),
    recall: rounded(metrics.recall), f1: rounded(metrics.f1),
    truePositives: metrics.truePositives, trueNegatives: metrics.trueNegatives,
    falsePositives: metrics.falsePositives, falseNegatives: metrics.falseNegatives,
    falsePositiveRate: rounded(metrics.falsePositiveRate),
    falseNegativeRate: rounded(metrics.falseNegativeRate),
    evaluated: metrics.evaluated, missingSamples: metrics.missingSamples
  };
}

function expectedEndpointComparison(scenario, thresholds) {
  const missing = scenario === 'dropouts' ? 9 : 0;
  const positives = scenario === 'dropouts' ? 30 : 32;
  const negatives = scenario === 'dropouts' ? 217 : 224;
  const profiles = Lab.MODELS.map(model => {
    const threshold = thresholds[model.id];
    const metrics = threshold === 0
      ? expectedMetrics(256, missing, positives, 0, negatives, 0)
      : expectedMetrics(256, missing, 0, negatives, 0, positives);
    const latency = 0.05 + model.operationsPerWindow * 0.003;
    const energy = 18 + model.operationsPerWindow * 0.06 + model.memoryBytes * 0.002;
    return {
      model: { id: model.id, version: model.version, name: model.name, kind: model.kind, parameters: model.parameters },
      threshold, operationsPerWindow: model.operationsPerWindow, memoryBytes: model.memoryBytes,
      metrics: metricSnapshot(metrics),
      costEstimate: {
        latencyMs: rounded(latency, 4), p95LatencyMs: rounded(latency * 1.2, 4),
        memoryBytes: model.memoryBytes, memoryKiB: rounded(model.memoryBytes / 1024, 2),
        energyMicroJPerWindow: rounded(energy, 4),
        energyPer1000WindowsMicroWh: rounded(energy * 1000 / 3600, 4),
        batteryPercentPer1000Windows: rounded(energy * 1000 / 3600 / 4440000 * 100)
      }
    };
  });
  const [faster, baseline] = profiles;
  return {
    version: '1', thresholdPolicy: 'explicit-per-profile', baseline, faster,
    deltaConvention: 'faster-minus-baseline',
    deltas: {
      latencyMs: rounded(faster.costEstimate.latencyMs - baseline.costEstimate.latencyMs, 4),
      p95LatencyMs: rounded(faster.costEstimate.p95LatencyMs - baseline.costEstimate.p95LatencyMs, 4),
      memoryBytes: faster.memoryBytes - baseline.memoryBytes,
      energyMicroJPerWindow: rounded(faster.costEstimate.energyMicroJPerWindow - baseline.costEstimate.energyMicroJPerWindow, 4),
      energyPer1000WindowsMicroWh: rounded(faster.costEstimate.energyPer1000WindowsMicroWh - baseline.costEstimate.energyPer1000WindowsMicroWh, 4),
      batteryPercentPer1000Windows: rounded(faster.costEstimate.batteryPercentPer1000Windows - baseline.costEstimate.batteryPercentPer1000Windows),
      falsePositives: faster.metrics.falsePositives - baseline.metrics.falsePositives,
      falseNegatives: faster.metrics.falseNegatives - baseline.metrics.falseNegatives,
      accuracy: rounded(faster.metrics.accuracy - baseline.metrics.accuracy),
      recall: rounded(faster.metrics.recall - baseline.metrics.recall),
      f1: rounded(faster.metrics.f1 - baseline.metrics.f1)
    }
  };
}

test('simultaneously invalid channels and labels produce skipped decisions and finite empty metrics', () => {
  const dataset = [
    null,
    undefined,
    {},
    { id: 'all-invalid', temperatureC: NaN, vibrationG: null, currentMa: Infinity, label: 2 },
    { id: 'missing-label', temperatureC: 24, vibrationG: 0.08, currentMa: 180 }
  ];
  const thresholds = thresholdsAt(0.5);

  for (const model of Lab.MODELS) {
    const result = Lab.evaluate(dataset, model, thresholds[model.id]);
    assert.deepEqual(result.rows, []);
    assert.deepEqual(result.metrics, expectedMetrics(5, 5, 0, 0, 0, 0));
    for (const value of Object.values(result.metrics)) assert.ok(Number.isFinite(value));
  }

  const inspected = Lab.inspectWindows(dataset, Lab.MODELS, thresholds);
  assert.equal(inspected.length, dataset.length);
  assert.deepEqual(inspected.map(window => window.missingFields), [
    ['temperatureC', 'vibrationG', 'currentMa', 'label'],
    ['temperatureC', 'vibrationG', 'currentMa', 'label'],
    ['temperatureC', 'vibrationG', 'currentMa', 'label'],
    ['temperatureC', 'vibrationG', 'currentMa', 'label'],
    ['label']
  ]);
  for (const window of inspected) {
    assert.equal(window.missing, true);
    for (const decision of window.decisions) {
      assert.equal(decision.status, 'skipped');
      assert.equal(decision.normalized, null);
      assert.equal(decision.contributions, null);
      assert.deepEqual(
        { score: decision.score, predicted: decision.predicted, margin: decision.margin },
        { score: null, predicted: null, margin: null }
      );
    }
  }
});

test('dropout threshold-one predictions expose 217 normal and 30 anomaly evaluated coverage', () => {
  const dataset = Lab.createFixture('dropouts');
  const thresholds = thresholdsAt(1);
  const windows = Lab.inspectWindows(dataset, Lab.MODELS, thresholds);

  assert.equal(windows.filter(window => window.missing).length, 9);
  assert.equal(windows.filter(window => window.missing && window.label === 1).length, 2);
  for (const model of Lab.MODELS) {
    assert.deepEqual(statusCounts(windows, model.id), {
      'false-alarm': 0, 'missed-event': 30, 'correct-alert': 0, 'correct-reject': 217, skipped: 9
    });
    const result = Lab.evaluate(dataset, model, thresholds[model.id]);
    assert.deepEqual(result.metrics, expectedMetrics(256, 9, 0, 217, 0, 30));
    assert.equal(result.metrics.accuracy, 217 / 247);
    assert.equal(result.metrics.recall, 0);
    assert.equal(result.metrics.f1, 0);
  }
});

test('a small minority-positive fixture shows one hidden miss and endpoint all-negative misses', () => {
  const normal = index => ({ id: `N${index}`, index, temperatureC: 24, vibrationG: 0.08, currentMa: 180, label: 0 });
  const dataset = [
    ...Array.from({ length: 10 }, (_, index) => normal(index)),
    { id: 'P-strong', index: 10, temperatureC: 28, vibrationG: 0.24, currentMa: 260, label: 1 },
    { id: 'P-subtle', index: 11, temperatureC: 24.8, vibrationG: 0.1, currentMa: 185, label: 1 }
  ];
  const tunedThresholds = { 'micro-threshold-v1': 0.1, 'tiny-linear-v1': 0.5 };

  for (const model of Lab.MODELS) {
    const tuned = Lab.evaluate(dataset, model, tunedThresholds[model.id]);
    assert.deepEqual(tuned.metrics, expectedMetrics(12, 0, 1, 10, 0, 1));
    assert.equal(tuned.metrics.accuracy, 11 / 12);
    assert.equal(tuned.metrics.recall, 0.5);
    assert.equal(tuned.metrics.f1, 2 / 3);
    assert.deepEqual(tuned.rows.filter(row => row.isFalseNegative).map(row => row.id), ['P-subtle']);

    const endpoint = Lab.evaluate(dataset, model, 1);
    assert.deepEqual(endpoint.metrics, expectedMetrics(12, 0, 0, 10, 0, 2));
    assert.equal(endpoint.metrics.accuracy, 10 / 12);
    assert.equal(endpoint.metrics.recall, 0);
    assert.equal(endpoint.metrics.f1, 0);
    assert.deepEqual(endpoint.rows.filter(row => row.isFalseNegative).map(row => row.id), ['P-strong', 'P-subtle']);
  }
});

test('Pareto dominance uses strict improvement while preserving ties and input-order correspondence', () => {
  const points = [
    { id: 'same-latency-lower-accuracy', accuracy: 0.8, latencyMs: 2 },
    { id: 'efficient-frontier', accuracy: 0.9, latencyMs: 2 },
    { id: 'same-accuracy-slower', accuracy: 0.9, latencyMs: 3 },
    { id: 'identical-tie', accuracy: 0.9, latencyMs: 2 },
    { id: 'worse-both', accuracy: 0.7, latencyMs: 4 }
  ];
  const expected = [false, true, false, true, false];
  assert.deepEqual(Lab.isParetoFrontier(points), expected);
  assert.deepEqual(Lab.isParetoFrontier([...points].reverse()), [...expected].reverse());
  assert.deepEqual(Lab.isParetoFrontier([points[1], points[3]]), [true, true]);
  const order = [3, 0, 4, 2, 1];
  assert.deepEqual(Lab.isParetoFrontier(order.map(index => points[index])), order.map(index => expected[index]));
});

test('dropout profile comparison and inspector agree before and after faster-profile tuning', () => {
  const dataset = Lab.createFixture('dropouts');
  const before = thresholdsAt(0.08);
  before['tiny-linear-v1'] = 0.5;
  const after = { ...before, 'micro-threshold-v1': 0.01 };

  for (const thresholds of [before, after]) {
    const comparison = Lab.compareProfiles(dataset, Lab.MODELS, thresholds);
    const inspected = Lab.inspectWindows(dataset, Lab.MODELS, thresholds);
    const points = Lab.MODELS.map(model => {
      const profile = [comparison.faster, comparison.baseline].find(entry => entry.model.id === model.id);
      const counts = statusCounts(inspected, model.id);
      assert.deepEqual([
        profile.metrics.truePositives, profile.metrics.trueNegatives,
        profile.metrics.falsePositives, profile.metrics.falseNegatives
      ], [counts['correct-alert'], counts['correct-reject'], counts['false-alarm'], counts['missed-event']]);
      assert.equal(profile.metrics.evaluated, 247);
      assert.equal(profile.metrics.missingSamples, 9);
      const inspectorMetrics = expectedMetrics(inspected.length, counts.skipped,
        counts['correct-alert'], counts['correct-reject'], counts['false-alarm'], counts['missed-event']);
      assert.deepEqual(Lab.evaluate(dataset, model, thresholds[model.id]).metrics, inspectorMetrics);
      assert.deepEqual(profile.metrics, metricSnapshot(inspectorMetrics));
      return { modelId: model.id, accuracy: profile.metrics.accuracy, latencyMs: profile.costEstimate.latencyMs };
    });
    assert.deepEqual(points, thresholds['micro-threshold-v1'] === 0.01 ? [
      { modelId: 'micro-threshold-v1', accuracy: rounded(240 / 247), latencyMs: 0.092 },
      { modelId: 'tiny-linear-v1', accuracy: rounded(240 / 247), latencyMs: 0.137 }
    ] : [
      { modelId: 'micro-threshold-v1', accuracy: rounded(222 / 247), latencyMs: 0.092 },
      { modelId: 'tiny-linear-v1', accuracy: rounded(240 / 247), latencyMs: 0.137 }
    ]);
    assert.deepEqual(Lab.isParetoFrontier(points), thresholds['micro-threshold-v1'] === 0.01
      ? [true, false] : [true, true]);
  }
});

test('every scenario, selected profile, and independent endpoint pair exports a replay-stable comparison', () => {
  const endpointPairs = [0, 1].flatMap(first => [0, 1].map(second => ({
    'micro-threshold-v1': first,
    'tiny-linear-v1': second
  })));

  for (const scenario of Lab.SCENARIOS) {
    const dataset = Lab.createFixture(scenario.id);
    const metadata = { ...Lab.FIXTURE, scenario: scenario.id };
    for (const thresholds of endpointPairs) {
      const comparison = Lab.compareProfiles(dataset, Lab.MODELS, thresholds);
      const expectedComparison = expectedEndpointComparison(scenario.id, thresholds);
      assert.deepEqual(comparison, expectedComparison);
      for (const selectedModel of Lab.MODELS) {
        const selectedResult = Lab.evaluate(dataset, selectedModel, thresholds[selectedModel.id]);
        const card = Lab.deploymentCard(metadata, selectedModel, thresholds[selectedModel.id],
          selectedResult.metrics, Lab.estimateCost(selectedModel), comparison);
        const bodyJson = JSON.stringify(card);
        assert.equal(Lab.canonicalize(card), bodyJson, 'canonical body is compact JSON in stable field order');
        const exportedJson = JSON.stringify({ ...card, checksum: {
          algorithm: 'FNV-1a-32',
          scope: 'UTF-8 compact JSON body excluding checksum',
          value: Lab.fnv1a(Lab.canonicalize(card))
        } }, null, 2);
        const exported = JSON.parse(exportedJson);
        const { checksum, ...exportedBody } = exported;

        assert.equal(checksum.value, byteHash(JSON.stringify(exportedBody)));
        assert.equal(exported.dataset.scenario, scenario.id);
        assert.equal(exported.threshold, thresholds[selectedModel.id]);
        assert.deepEqual(exported.fasterProfileComparison, expectedComparison);
        const expectedSelected = [expectedComparison.faster, expectedComparison.baseline]
          .find(profile => profile.model.id === selectedModel.id).metrics;
        assert.deepEqual(exported.metrics, {
          accuracy: expectedSelected.accuracy, precision: expectedSelected.precision,
          recall: expectedSelected.recall, f1: expectedSelected.f1,
          falsePositives: expectedSelected.falsePositives, falseNegatives: expectedSelected.falseNegatives,
          evaluated: expectedSelected.evaluated, missingSamples: expectedSelected.missingSamples
        });
        assert.equal(exported.simulation.results, 'SIMULATED — not hardware measurements or a trained model benchmark');
        assert.equal(exported.reproducibility.fixtureChecksum, byteHash(JSON.stringify(dataset)));
        assert.equal(exported.metrics.evaluated + exported.metrics.missingSamples, exported.dataset.windows);
        for (const role of ['faster', 'baseline']) {
          const profile = exported.fasterProfileComparison[role];
          assert.equal(profile.threshold, thresholds[profile.model.id]);
          assert.equal(profile.metrics.evaluated + profile.metrics.missingSamples, exported.dataset.windows);
        }

        // Reconstruct from parsed export snapshots, including the unselected profile.
        const snapshots = [exported.fasterProfileComparison.baseline, exported.fasterProfileComparison.faster];
        const replayProfiles = snapshots.map(profile => ({
          ...profile.model,
          operationsPerWindow: profile.operationsPerWindow,
          memoryBytes: profile.memoryBytes
        }));
        const replayThresholds = Object.fromEntries(snapshots.map(profile => [profile.model.id, profile.threshold]));
        const replayDataset = Lab.createFixture(exported.dataset.scenario);
        const replayMetadata = {
          ...exported.dataset,
          normalizationVersion: exported.reproducibility.normalizationVersion
        };
        const replaySelectedModel = replayProfiles.find(model => model.id === exported.model.id);
        const replay = Lab.deploymentCard(replayMetadata, replaySelectedModel,
          replayThresholds[replaySelectedModel.id],
          Lab.evaluate(replayDataset, replaySelectedModel, replayThresholds[replaySelectedModel.id]).metrics,
          Lab.estimateCost(replaySelectedModel),
          Lab.compareProfiles(replayDataset, replayProfiles, replayThresholds));
        const replayJson = JSON.stringify(replay);
        assert.equal(replayJson, bodyJson);
        assert.equal(byteHash(replayJson), exported.checksum.value);
        assert.deepEqual(Buffer.from(replayJson, 'utf8'), Buffer.from(bodyJson, 'utf8'));
        assert.equal(JSON.stringify({ ...replay, checksum }, null, 2), exportedJson);
      }
    }
  }
});
