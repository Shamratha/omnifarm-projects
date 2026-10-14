const test = require('node:test');
const assert = require('node:assert/strict');
const Lab = require('../lab-core.js');

const defaults = Object.fromEntries(Lab.MODELS.map(model => [model.id, model.defaultThreshold]));
const fields = ['temperatureC', 'vibrationG', 'currentMa', 'label'];
const gapIds = ['W0007', 'W0036', 'W0065', 'W0094', 'W0123', 'W0152', 'W0181', 'W0210', 'W0239'];

function statusCounts(windows, modelId) {
  const counts = { 'false-alarm': 0, 'missed-event': 0, 'correct-alert': 0, 'correct-reject': 0, skipped: 0 };
  for (const window of windows) {
    counts[window.decisions.find(decision => decision.modelId === modelId).status] += 1;
  }
  return counts;
}

test('inspection retains every fixture identity and raw field across scenarios and decision filters', () => {
  const identities = Lab.createFixture().map(({ id, index, timestampSec }) => ({ id, index, timestampSec }));
  assert.equal(identities[0].id, 'W0000');
  assert.equal(identities[255].id, 'W0255');
  for (const scenario of Lab.SCENARIOS) {
    const dataset = Lab.createFixture(scenario.id);
    const snapshot = structuredClone(dataset);
    dataset.forEach(Object.freeze);
    Object.freeze(dataset);
    const windows = Lab.inspectWindows(dataset, Lab.MODELS, defaults);
    assert.equal(windows.length, 256);
    assert.deepEqual(windows.map(({ id, index, timestampSec }) => ({ id, index, timestampSec })), identities);
    for (const [index, window] of windows.entries()) {
      assert.notStrictEqual(window, dataset[index]);
      for (const [field, value] of Object.entries(dataset[index])) assert.equal(window[field], value);
      assert.deepEqual(window.decisions.map(decision => decision.modelId), Lab.MODELS.map(model => model.id));
    }
    for (const model of Lab.MODELS) {
      const evaluated = Lab.evaluate(dataset, model, defaults[model.id]).rows;
      for (const [status, predicate] of [
        ['false-alarm', row => row.isFalsePositive],
        ['missed-event', row => row.isFalseNegative],
        ['correct-alert', row => row.predicted === 1 && row.label === 1],
        ['correct-reject', row => row.predicted === 0 && row.label === 0]
      ]) {
        const filtered = windows.filter(window => window.decisions.find(decision => decision.modelId === model.id).status === status);
        assert.deepEqual(filtered.map(window => window.id), evaluated.filter(predicate).map(row => row.id));
        for (const window of filtered) assert.deepEqual(
          { id: window.id, index: window.index, timestampSec: window.timestampSec }, identities[window.index]);
      }
    }
    // Inspecting a subset or reordering it must retain source identities, not assign new ones.
    const subset = [dataset[255], dataset[7], dataset[123]];
    assert.deepEqual(Lab.inspectWindows(subset, Lab.MODELS, defaults).map(({ id, index, timestampSec }) =>
      ({ id, index, timestampSec })), [identities[255], identities[7], identities[123]]);
    assert.deepEqual(dataset, snapshot);
  }
});

test('all nine dropout gaps retain IDs and raw nulls with explicitly skipped decisions', () => {
  const dataset = Lab.createFixture('dropouts');
  const windows = Lab.inspectWindows(dataset, Lab.MODELS, defaults);
  const gaps = windows.filter(window => window.missing);
  assert.deepEqual(gaps.map(window => window.id), gapIds);
  assert.equal(windows.length, 256);
  for (const gap of gaps) {
    assert.deepEqual(gap.missingFields, ['vibrationG']);
    assert.equal(gap.vibrationG, null);
    for (const [index, decision] of gap.decisions.entries()) {
      const model = Lab.MODELS[index];
      assert.deepEqual(decision, {
        modelId: model.id, name: model.name, threshold: defaults[model.id],
        score: null, predicted: null, margin: null, status: 'skipped', normalized: null, contributions: null
      });
    }
  }
  assert.equal(windows.filter(window => !window.missing).length, 247);
});

test('each profile decision exactly matches evaluation and scoring at independent explicit thresholds', () => {
  const thresholds = { 'micro-threshold-v1': 0.0123456789, 'tiny-linear-v1': 0.543456789 };
  for (const scenario of Lab.SCENARIOS) {
    const dataset = Lab.createFixture(scenario.id);
    const windows = Lab.inspectWindows(dataset, Lab.MODELS, thresholds);
    for (const model of Lab.MODELS) {
      const evaluated = Lab.evaluate(dataset, model, thresholds[model.id]).rows;
      const valid = windows.filter(window => !window.missing);
      assert.deepEqual(valid.map(window => window.id), evaluated.map(row => row.id));
      for (const [index, window] of valid.entries()) {
        const row = evaluated[index];
        const scored = Lab.scoreSample(row, model);
        const decision = window.decisions.find(entry => entry.modelId === model.id);
        assert.deepEqual(window.missingFields, []);
        assert.deepEqual(decision, {
          modelId: model.id, name: model.name, threshold: thresholds[model.id],
          score: scored.score, predicted: row.predicted, margin: scored.score - thresholds[model.id],
          status: row.isFalsePositive ? 'false-alarm' : row.isFalseNegative ? 'missed-event'
            : row.predicted === 1 ? 'correct-alert' : 'correct-reject',
          normalized: scored.normalized, contributions: scored.contributions
        });
      }
    }
    const reversed = Lab.inspectWindows(dataset, [...Lab.MODELS].reverse(), thresholds);
    assert.deepEqual(reversed, windows.map(window => ({ ...window, decisions: [...window.decisions].reverse() })));
  }
});

test('exact score boundaries use >= with zero margin, including zero and one endpoints', () => {
  const normal = { id: 'boundary', index: 42, timestampSec: 84, temperatureC: 24, vibrationG: 0.08, currentMa: 180 };
  for (const model of Lab.MODELS) {
    const score = Lab.scoreSample(normal, model).score;
    for (const label of [0, 1]) {
      for (const threshold of [Math.max(0, score - Number.EPSILON), score, score + Number.EPSILON]) {
        const sample = { ...normal, label };
        const decision = Lab.inspectWindows([sample], [model], { [model.id]: threshold })[0].decisions[0];
        const predicted = threshold <= score ? 1 : 0;
        assert.equal(decision.predicted, predicted);
        assert.equal(decision.predicted, Lab.evaluate([sample], model, threshold).rows[0].predicted);
        assert.equal(decision.margin, score - threshold);
        assert.equal(decision.status, predicted ? (label ? 'correct-alert' : 'false-alarm')
          : (label ? 'missed-event' : 'correct-reject'));
        if (threshold === score) assert.equal(decision.margin, 0);
      }
    }
  }
  const saturated = { ...normal, temperatureC: 100, vibrationG: 100, currentMa: 10000, label: 1 };
  for (const model of Lab.MODELS) {
    const decision = Lab.inspectWindows([saturated], [model], { [model.id]: 1 })[0].decisions[0];
    assert.equal(decision.score, 1);
    assert.equal(decision.predicted, 1);
    assert.equal(decision.margin, 0);
    assert.equal(decision.status, 'correct-alert');
  }
});

test('invalid channels and labels are identified without imputation or source mutation', () => {
  const base = { id: 'raw', index: 81, timestampSec: 162, temperatureC: 24, vibrationG: 0.08, currentMa: 180, label: 0, note: 'retain me' };
  for (const field of fields) {
    const invalid = field === 'label'
      ? [undefined, null, NaN, Infinity, -Infinity, -1, 2, '0', '1', true, false]
      : [undefined, null, NaN, Infinity, -Infinity, '24', true];
    for (const value of invalid) {
      const sample = Object.freeze({ ...base, [field]: value });
      const [window] = Lab.inspectWindows([sample], Lab.MODELS, defaults);
      assert.deepEqual(window.missingFields, [field]);
      assert.equal(window.missing, true);
      assert.equal(window[field], value);
      assert.equal(window.note, 'retain me');
      assert.equal(sample[field], value);
      for (const decision of window.decisions) {
        assert.equal(decision.status, 'skipped');
        for (const key of ['score', 'predicted', 'margin', 'normalized', 'contributions']) assert.equal(decision[key], null);
      }
    }
    const sample = { ...base };
    delete sample[field];
    assert.deepEqual(Lab.inspectWindows([sample], Lab.MODELS, defaults)[0].missingFields, [field]);
    assert.equal(Object.hasOwn(sample, field), false);
  }
  assert.deepEqual(Lab.inspectWindows([{}], Lab.MODELS, defaults)[0].missingFields, fields);
  const partial = { ...base, temperatureC: NaN, currentMa: null, label: 2 };
  assert.deepEqual(Lab.inspectWindows([partial], Lab.MODELS, defaults)[0].missingFields, ['temperatureC', 'currentMa', 'label']);
});

test('sparse, null and empty inputs are safe and retain every source slot', () => {
  const sparse = Array(5);
  sparse[1] = Lab.createFixture()[81];
  sparse[2] = null;
  sparse[3] = undefined;
  const snapshot = structuredClone(sparse);
  const windows = Lab.inspectWindows(sparse, Lab.MODELS, defaults);
  assert.equal(windows.length, 5);
  assert.deepEqual(windows.map(window => window.id), ['W-0', 'W0081', 'W-2', 'W-3', 'W-4']);
  for (const index of [0, 2, 3, 4]) {
    assert.equal(windows[index].index, index);
    assert.equal(windows[index].timestampSec, null);
    assert.deepEqual(windows[index].missingFields, fields);
    assert.equal(windows[index].missing, true);
    for (const field of fields) assert.equal(windows[index][field], undefined);
    assert.ok(windows[index].decisions.every(decision => decision.status === 'skipped' && decision.score === null));
  }
  assert.deepEqual(sparse, snapshot);
  assert.equal(0 in sparse, false);
  assert.equal(4 in sparse, false);
  for (const dataset of [[], null, undefined]) assert.deepEqual(Lab.inspectWindows(dataset, Lab.MODELS, defaults), []);
  for (const models of [[], null, undefined]) {
    assert.deepEqual(Lab.inspectWindows([null], models, null)[0].decisions, []);
  }
});

test('thresholds are mandatory finite numbers in [0, 1], even without any valid windows', () => {
  const datasets = [Lab.createFixture(), [], null, [null, undefined, {}], Array(3), Lab.createFixture('dropouts')];
  for (const model of Lab.MODELS) {
    for (const threshold of [undefined, null, NaN, Infinity, -Infinity, -0.01, 1.01, '0.5', true]) {
      for (const dataset of datasets) {
        assert.throws(() => Lab.inspectWindows(dataset, Lab.MODELS, { ...defaults, [model.id]: threshold }),
          { name: 'RangeError', message: 'Threshold must be between 0 and 1' });
      }
    }
    for (const dataset of datasets) {
      for (const thresholds of [undefined, null, {}, { [Lab.MODELS.find(entry => entry.id !== model.id).id]: 0.5 }]) {
        assert.throws(() => Lab.inspectWindows(dataset, Lab.MODELS, thresholds), RangeError);
      }
    }
  }
  for (const threshold of [0, 1]) {
    const thresholds = Object.fromEntries(Lab.MODELS.map(model => [model.id, threshold]));
    const windows = Lab.inspectWindows([null], Lab.MODELS, thresholds);
    assert.ok(windows[0].decisions.every(decision => decision.threshold === threshold && decision.status === 'skipped'));
  }
});

test('clean threshold-one inspection exposes 224 correct rejects and 32 misses despite 87.5% accuracy', () => {
  const dataset = Lab.createFixture();
  const thresholds = Object.fromEntries(Lab.MODELS.map(model => [model.id, 1]));
  const windows = Lab.inspectWindows(dataset, Lab.MODELS, thresholds);
  for (const model of Lab.MODELS) {
    assert.deepEqual(statusCounts(windows, model.id), {
      'false-alarm': 0, 'missed-event': 32, 'correct-alert': 0, 'correct-reject': 224, skipped: 0
    });
    const metrics = Lab.evaluate(dataset, model, 1).metrics;
    assert.equal(metrics.accuracy, 0.875);
    assert.equal(metrics.accuracy * 100, 87.5);
    assert.equal(metrics.recall, 0);
    assert.equal(metrics.f1, 0);
    const tuned = Lab.recommendedThreshold(Lab.thresholdSweep(dataset, model));
    const tunedWindows = Lab.inspectWindows(dataset, [model], { [model.id]: tuned.threshold });
    assert.deepEqual(statusCounts(tunedWindows, model.id), {
      'false-alarm': 0, 'missed-event': 0, 'correct-alert': 32, 'correct-reject': 224, skipped: 0
    });
    assert.equal(tuned.accuracy, 1);
    assert.equal(tuned.recall, 1);
    assert.equal(tuned.f1, 1);
    assert.deepEqual(tunedWindows.map(window => window.id), windows.map(window => window.id));
  }
});

test('dropout inspection preserves coverage while evaluation denominators exclude seven normal and two anomaly gaps', () => {
  const dataset = Lab.createFixture('dropouts');
  for (const thresholds of [defaults, { ...defaults, 'micro-threshold-v1': 0.01 }]) {
    const windows = Lab.inspectWindows(dataset, Lab.MODELS, thresholds);
    assert.equal(windows.filter(window => window.missing && window.label === 0).length, 7);
    assert.equal(windows.filter(window => window.missing && window.label === 1).length, 2);
    for (const model of Lab.MODELS) {
      const counts = statusCounts(windows, model.id);
      const metrics = Lab.evaluate(dataset, model, thresholds[model.id]).metrics;
      const tp = counts['correct-alert']; const tn = counts['correct-reject'];
      const fp = counts['false-alarm']; const fn = counts['missed-event'];
      assert.equal(counts.skipped, 9);
      assert.equal(metrics.total, 256);
      assert.equal(metrics.evaluated, 247);
      assert.equal(metrics.missingSamples, 9);
      assert.deepEqual([metrics.truePositives, metrics.trueNegatives, metrics.falsePositives, metrics.falseNegatives], [tp, tn, fp, fn]);
      assert.equal(tn + fp, 217);
      assert.equal(tp + fn, 30);
      assert.equal(metrics.accuracy, (tp + tn) / 247);
      assert.equal(metrics.falsePositiveRate, fp / 217);
      assert.equal(metrics.recall, tp / 30);
      assert.equal(metrics.falseNegativeRate, fn / 30);
      assert.equal(metrics.precision, tp / (tp + fp));
      assert.equal(metrics.f1, 2 * metrics.precision * metrics.recall / (metrics.precision + metrics.recall));
    }
  }
});

test('real profile Pareto frontier retains default tradeoffs and tuning creates equal-accuracy dominance', () => {
  const dataset = Lab.createFixture('field-noise');
  function pointsFor(thresholds) {
    const windows = Lab.inspectWindows(dataset, Lab.MODELS, thresholds);
    return Lab.MODELS.map(model => {
      const counts = statusCounts(windows, model.id);
      return {
        modelId: model.id,
        accuracy: (counts['correct-alert'] + counts['correct-reject']) / (windows.length - counts.skipped),
        latencyMs: Lab.estimateCost(model).latencyMsPerWindow
      };
    });
  }
  const points = pointsFor(defaults);
  assert.deepEqual(points, [
    { modelId: 'micro-threshold-v1', accuracy: 230 / 256, latencyMs: 0.092 },
    { modelId: 'tiny-linear-v1', accuracy: 249 / 256, latencyMs: 0.137 }
  ]);
  assert.deepEqual(Lab.isParetoFrontier(points), [true, true]);
  const tuned = pointsFor({ ...defaults, 'micro-threshold-v1': 0.01 });
  assert.equal(tuned[0].accuracy, 249 / 256);
  assert.equal(tuned[0].accuracy, tuned[1].accuracy);
  assert.equal(tuned[0].latencyMs, points[0].latencyMs);
  assert.deepEqual(tuned[1], points[1]);
  assert.deepEqual(Lab.isParetoFrontier(tuned), [true, false]);
});

test('real profile Pareto equality and frontier membership are invariant to input order', () => {
  const dataset = Lab.createFixture('field-noise');
  for (const thresholds of [defaults, { ...defaults, 'micro-threshold-v1': 0.01 }]) {
    const points = Lab.MODELS.map(model => ({
      modelId: model.id,
      accuracy: Lab.evaluate(dataset, model, thresholds[model.id]).metrics.accuracy,
      latencyMs: Lab.estimateCost(model).latencyMsPerWindow
    }));
    const duplicates = [...points, ...points.map(point => ({ ...point }))];
    const snapshot = structuredClone(duplicates);
    const expected = thresholds['micro-threshold-v1'] === 0.01 ? [true, false, true, false] : [true, true, true, true];
    assert.deepEqual(Lab.isParetoFrontier(duplicates), expected);
    assert.deepEqual(duplicates, snapshot);
    for (const order of [[3, 2, 1, 0], [1, 3, 0, 2], [2, 0, 3, 1]]) {
      assert.deepEqual(Lab.isParetoFrontier(order.map(index => duplicates[index])), order.map(index => expected[index]));
    }
    assert.deepEqual(Lab.isParetoFrontier([points[0], { ...points[0] }]), [true, true]);
  }
});
