(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.EdgeLab = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const FIXTURE = {
    id: "edge-lab-fixture-v1",
    seed: 0xed6e2025,
    windows: 256,
    positiveWindows: 32,
    samplingPeriodSec: 1,
    normalizationVersion: "fixed-v1"
  };

  const MODELS = [
    {
      id: "micro-threshold-v1",
      version: "1.0",
      name: "Micro Threshold",
      shortName: "Threshold",
      kind: "rules",
      defaultThreshold: 0.08,
      operationsPerWindow: 14,
      memoryBytes: 1152,
      parameters: { temperatureWeight: 0.25, vibrationWeight: 0.5, currentWeight: 0.25 }
    },
    {
      id: "tiny-linear-v1",
      version: "1.0",
      name: "Tiny Linear",
      shortName: "Linear",
      kind: "linear",
      defaultThreshold: 0.5,
      operationsPerWindow: 29,
      memoryBytes: 2048,
      parameters: { bias: -1.8, temperatureWeight: 0.9, vibrationWeight: 1.6, currentWeight: 0.7 }
    }
  ];

  const SCENARIOS = [
    { id: "baseline", name: "Clean baseline", description: "Clean synthetic signals · 32 anomaly windows" },
    { id: "field-noise", name: "Field noise", description: "Benign motor-start bursts · 32 anomaly windows" },
    { id: "dropouts", name: "Missing samples", description: "Field noise + 9 missing-channel windows" }
  ];

  const COST_ASSUMPTIONS = {
    batteryCapacityWh: 4.44,
    batteryWindowCount: 1000,
    energyPer1000WindowsFormula: "energyMicroJPerWindow * 1000 / 3600 (microWh)",
    batteryPercentFormula: "energyPer1000WindowsMicroWh / (batteryCapacityWh * 1000000) * 100",
    costIndependentOfThresholdAndAlerts: true,
    memoryBasis: "Fixed modeled footprint; not measured peak RAM or flash usage",
    memoryUnitBytes: 1024,
    latencyFormula: "0.05 + operationsPerWindow * 0.003",
    p95Formula: "latencyMsPerWindow * 1.20",
    p95Multiplier: 1.2,
    sensorEnergyMicroJ: 18,
    energyFormula: "18 + operationsPerWindow * 0.06 + memoryBytes * 0.002",
    falsePositiveDefinition: "Normal-labeled evaluated window with score >= threshold",
    falsePositiveRateDenominator: "falsePositives / (falsePositives + trueNegatives)",
    missingSamplePolicy: "Skip windows with missing/non-finite channels or invalid labels; no imputation",
    alertEnergyIncluded: false,
    alertEnergyScope: "Radio, alert transmission, actuation, idle, peripherals, and battery losses are excluded"
  };

  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
  function round(value, digits) {
    const factor = Math.pow(10, digits == null ? 6 : digits);
    return Math.round((value + Number.EPSILON) * factor) / factor;
  }

  function seededNoise(state) {
    state.value = (Math.imul(1664525, state.value) + 1013904223) >>> 0;
    return (state.value / 4294967296) * 2 - 1;
  }

  function createFixture(scenarioId) {
    const scenario = scenarioId || "baseline";
    if (!SCENARIOS.some(function (entry) { return entry.id === scenario; })) throw new Error("Unknown local fixture scenario");
    const state = { value: FIXTURE.seed >>> 0 };
    const windows = [];
    for (let i = 0; i < FIXTURE.windows; i += 1) {
      const temperatureNoise = seededNoise(state);
      const vibrationNoise = seededNoise(state);
      const currentNoise = seededNoise(state);
      const isAnomaly = i % 32 >= 24 && i % 32 <= 27;
      let temperatureC = 24 + 0.7 * Math.sin((2 * Math.PI * i) / 64) + 0.2 * temperatureNoise;
      let vibrationG = 0.08 + 0.01 * Math.sin((2 * Math.PI * i) / 16) + 0.006 * vibrationNoise;
      let currentMa = 180 + 12 * Math.sin((2 * Math.PI * i) / 48) + 5 * currentNoise;
      if (isAnomaly) {
        temperatureC += 3.5;
        vibrationG += 0.12;
        currentMa += 50;
      }
      // A known, benign motor start creates an overlapping sensor signature.
      if (scenario !== "baseline" && !isAnomaly && i % 37 === 8) {
        temperatureC += 1.8;
        vibrationG += 0.16;
        currentMa += 48;
      }
      windows.push({
        id: `W${String(i).padStart(4, "0")}`,
        index: i,
        timestampSec: i * FIXTURE.samplingPeriodSec,
        temperatureC: round(temperatureC, 6),
        vibrationG: round(vibrationG, 6),
        currentMa: round(currentMa, 6),
        label: isAnomaly ? 1 : 0
      });
      if (scenario === "dropouts" && i % 29 === 7) windows[windows.length - 1].vibrationG = null;
    }
    return windows;
  }

  function normalize(sample) {
    return {
      temperature: (sample.temperatureC - 24) / 2,
      vibration: (sample.vibrationG - 0.08) / 0.08,
      current: (sample.currentMa - 180) / 40
    };
  }

  function scoreSample(sample, model) {
    const z = normalize(sample);
    let score;
    let contributions;
    if (model.kind === "rules") {
      const temperature = Math.max(0, z.temperature - 1) / 3;
      const vibration = Math.max(0, z.vibration - 1.5) / 3;
      const current = Math.max(0, z.current - 1.2) / 3;
      contributions = {
        temperature: model.parameters.temperatureWeight * temperature,
        vibration: model.parameters.vibrationWeight * vibration,
        current: model.parameters.currentWeight * current
      };
      score = clamp(contributions.temperature + contributions.vibration + contributions.current, 0, 1);
    } else {
      contributions = {
        bias: model.parameters.bias,
        temperature: model.parameters.temperatureWeight * z.temperature,
        vibration: model.parameters.vibrationWeight * z.vibration,
        current: model.parameters.currentWeight * z.current
      };
      const logit = contributions.bias + contributions.temperature + contributions.vibration + contributions.current;
      score = 1 / (1 + Math.exp(-logit));
    }
    return { score, normalized: z, contributions };
  }

  function evaluate(dataset, model, threshold) {
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new RangeError("Threshold must be between 0 and 1");
    const rows = [];
    let missingSamples = 0;
    let tp = 0; let tn = 0; let fp = 0; let fn = 0;
    for (const sample of dataset) {
      if (!sample || ![sample.temperatureC, sample.vibrationG, sample.currentMa].every(Number.isFinite) || ![0, 1].includes(sample.label)) {
        missingSamples += 1;
        continue;
      }
      const scored = scoreSample(sample, model);
      const predicted = scored.score >= threshold ? 1 : 0;
      if (predicted && sample.label) tp += 1;
      else if (!predicted && !sample.label) tn += 1;
      else if (predicted && !sample.label) fp += 1;
      else fn += 1;
      rows.push(Object.assign({}, sample, scored, { predicted, isFalsePositive: predicted === 1 && sample.label === 0, isFalseNegative: predicted === 0 && sample.label === 1 }));
    }
    const total = dataset.length;
    const evaluated = rows.length;
    const precision = tp + fp ? tp / (tp + fp) : 0;
    const recall = tp + fn ? tp / (tp + fn) : 0;
    return {
      rows,
      metrics: {
        total, evaluated, missingSamples,
        truePositives: tp, trueNegatives: tn, falsePositives: fp, falseNegatives: fn,
        accuracy: evaluated ? (tp + tn) / evaluated : 0,
        precision,
        recall,
        f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0,
        falsePositiveRate: fp + tn ? fp / (fp + tn) : 0,
        falseNegativeRate: fn + tp ? fn / (fn + tp) : 0,
        detectionRate: recall
      }
    };
  }

  function inspectWindows(dataset, models, thresholds) {
    const profiles = (models || []).map(function (model) {
      const threshold = thresholds == null ? undefined : thresholds[model.id];
      if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new RangeError("Threshold must be between 0 and 1");
      return { model, threshold };
    });
    // Array.from visits sparse slots as well as explicit missing samples.
    return Array.from(dataset || [], function (sample, index) {
      const missingFields = ["temperatureC", "vibrationG", "currentMa"].filter(function (field) {
        return !sample || !Number.isFinite(sample[field]);
      });
      if (!sample || ![0, 1].includes(sample.label)) missingFields.push("label");
      const missing = missingFields.length > 0;
      const decisions = profiles.map(function (profile) {
        const model = profile.model;
        const threshold = profile.threshold;
        const decision = { modelId: model.id, name: model.name, threshold };
        if (missing) return Object.assign(decision, {
          score: null, predicted: null, margin: null, status: "skipped", normalized: null, contributions: null
        });
        const scored = scoreSample(sample, model);
        const predicted = scored.score >= threshold ? 1 : 0;
        const status = predicted === 1
          ? (sample.label === 1 ? "correct-alert" : "false-alarm")
          : (sample.label === 1 ? "missed-event" : "correct-reject");
        return Object.assign(decision, {
          score: scored.score, predicted, margin: scored.score - threshold, status,
          normalized: scored.normalized, contributions: scored.contributions
        });
      });
      return Object.assign({}, sample || {
        id: `W-${index}`, index, timestampSec: null,
        temperatureC: undefined, vibrationG: undefined, currentMa: undefined, label: undefined
      }, { missingFields, missing, decisions });
    });
  }

  function estimateCost(model) {
    const latencyMsPerWindow = 0.05 + model.operationsPerWindow * 0.003;
    const p95LatencyMs = latencyMsPerWindow * 1.2;
    const energyMicroJPerWindow = 18 + 0.06 * model.operationsPerWindow + 0.002 * model.memoryBytes;
    const energyPer1000WindowsMicroWh = (energyMicroJPerWindow * 1000) / 3600;
    const batteryPercentPer1000Windows = energyPer1000WindowsMicroWh / (COST_ASSUMPTIONS.batteryCapacityWh * 1000000) * 100;
    return {
      latencyMsPerWindow: round(latencyMsPerWindow, 4),
      p95LatencyMs: round(p95LatencyMs, 4),
      memoryBytes: model.memoryBytes,
      memoryKiB: round(model.memoryBytes / 1024, 2),
      energyMicroJPerWindow: round(energyMicroJPerWindow, 4),
      energyPer1000WindowsMicroWh: round(energyPer1000WindowsMicroWh, 4),
      batteryPercentPer1000Windows: round(batteryPercentPer1000Windows, 6)
    };
  }

  function thresholdSweep(dataset, model) {
    const sweep = [];
    for (let i = 0; i <= 100; i += 1) {
      const threshold = i / 100;
      const result = evaluate(dataset, model, threshold);
      sweep.push(Object.assign({ threshold }, result.metrics));
    }
    return sweep;
  }

  function recommendedThreshold(sweep) {
    return sweep.slice().sort(function (a, b) {
      return b.f1 - a.f1 || a.falsePositives - b.falsePositives || b.recall - a.recall || a.threshold - b.threshold;
    })[0];
  }

  function isParetoFrontier(points) {
    return points.map(function (point, index) {
      return !points.some(function (other, otherIndex) {
        if (index === otherIndex) return false;
        const atLeastAsAccurate = other.accuracy >= point.accuracy;
        const atLeastAsFast = other.latencyMs <= point.latencyMs;
        const strictlyBetter = other.accuracy > point.accuracy || other.latencyMs < point.latencyMs;
        return atLeastAsAccurate && atLeastAsFast && strictlyBetter;
      });
    });
  }

  function metricsSnapshot(metrics) {
    return {
      accuracy: round(metrics.accuracy, 6), precision: round(metrics.precision, 6), recall: round(metrics.recall, 6), f1: round(metrics.f1, 6),
      truePositives: metrics.truePositives, trueNegatives: metrics.trueNegatives, falsePositives: metrics.falsePositives, falseNegatives: metrics.falseNegatives,
      falsePositiveRate: round(metrics.falsePositiveRate, 6), falseNegativeRate: round(metrics.falseNegativeRate, 6), evaluated: metrics.evaluated, missingSamples: metrics.missingSamples
    };
  }

  function costSnapshot(cost) {
    return {
      latencyMs: round(cost.latencyMsPerWindow, 4), p95LatencyMs: round(cost.p95LatencyMs, 4), memoryBytes: cost.memoryBytes, memoryKiB: cost.memoryKiB,
      energyMicroJPerWindow: round(cost.energyMicroJPerWindow, 4), energyPer1000WindowsMicroWh: round(cost.energyPer1000WindowsMicroWh, 4), batteryPercentPer1000Windows: round(cost.batteryPercentPer1000Windows, 6)
    };
  }

  function profileSnapshot(dataset, model, threshold) {
    const result = evaluate(dataset, model, threshold);
    const cost = estimateCost(model);
    return {
      model: { id: model.id, version: model.version, name: model.name, kind: model.kind, parameters: model.parameters },
      threshold,
      operationsPerWindow: model.operationsPerWindow,
      memoryBytes: model.memoryBytes,
      metrics: metricsSnapshot(result.metrics),
      costEstimate: costSnapshot(cost)
    };
  }

  function compareProfiles(dataset, models, thresholds) {
    const snapshots = models.map(function (model) { return profileSnapshot(dataset, model, thresholds[model.id]); });
    const ordered = snapshots.slice().sort(function (a, b) { return a.costEstimate.latencyMs - b.costEstimate.latencyMs || a.model.id.localeCompare(b.model.id); });
    const faster = ordered[0];
    const baseline = ordered[ordered.length - 1];
    const delta = function (fasterValue, baselineValue, digits) { return round(fasterValue - baselineValue, digits); };
    return {
      version: "1",
      thresholdPolicy: "explicit-per-profile",
      baseline,
      faster,
      deltaConvention: "faster-minus-baseline",
      deltas: {
        latencyMs: delta(faster.costEstimate.latencyMs, baseline.costEstimate.latencyMs, 4),
        p95LatencyMs: delta(faster.costEstimate.p95LatencyMs, baseline.costEstimate.p95LatencyMs, 4),
        memoryBytes: faster.costEstimate.memoryBytes - baseline.costEstimate.memoryBytes,
        energyMicroJPerWindow: delta(faster.costEstimate.energyMicroJPerWindow, baseline.costEstimate.energyMicroJPerWindow, 4),
        energyPer1000WindowsMicroWh: delta(faster.costEstimate.energyPer1000WindowsMicroWh, baseline.costEstimate.energyPer1000WindowsMicroWh, 4),
        batteryPercentPer1000Windows: delta(faster.costEstimate.batteryPercentPer1000Windows, baseline.costEstimate.batteryPercentPer1000Windows, 6),
        falsePositives: faster.metrics.falsePositives - baseline.metrics.falsePositives,
        falseNegatives: faster.metrics.falseNegatives - baseline.metrics.falseNegatives,
        accuracy: delta(faster.metrics.accuracy, baseline.metrics.accuracy, 6),
        recall: delta(faster.metrics.recall, baseline.metrics.recall, 6),
        f1: delta(faster.metrics.f1, baseline.metrics.f1, 6)
      }
    };
  }

  function canonicalize(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.keys(value).map(function (key) { return JSON.stringify(key) + ":" + canonicalize(value[key]); }).join(",")}}`;
    return JSON.stringify(value);
  }

  function fnv1a(text) {
    let hash = 2166136261;
    const bytes = new TextEncoder().encode(text);
    for (let i = 0; i < bytes.length; i += 1) {
      hash ^= bytes[i];
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function deploymentCard(datasetMeta, model, threshold, metrics, cost, comparison) {
    return {
      schemaVersion: "1.1",
      dataset: { id: datasetMeta.id, seed: datasetMeta.seed, windows: datasetMeta.windows, scenario: datasetMeta.scenario || "baseline" },
      model: { id: model.id, version: model.version, parameters: model.parameters },
      threshold,
      metrics: {
        accuracy: round(metrics.accuracy, 6), precision: round(metrics.precision, 6), recall: round(metrics.recall, 6), f1: round(metrics.f1, 6),
        falsePositives: metrics.falsePositives, falseNegatives: metrics.falseNegatives,
        evaluated: metrics.evaluated, missingSamples: metrics.missingSamples
      },
      costEstimate: {
        latencyMs: round(cost.latencyMsPerWindow, 4), p95LatencyMs: round(cost.p95LatencyMs, 4), memoryBytes: cost.memoryBytes,
        energyMicroJPerWindow: round(cost.energyMicroJPerWindow, 4), energyPer1000WindowsMicroWh: round(cost.energyPer1000WindowsMicroWh, 4), batteryPercentPer1000Windows: round(cost.batteryPercentPer1000Windows, 6)
      },
      assumptions: COST_ASSUMPTIONS,
      fasterProfileComparison: comparison || null,
      simulation: { results: "SIMULATED — not hardware measurements or a trained model benchmark", batteryWh: COST_ASSUMPTIONS.batteryCapacityWh, energyScope: "sensor acquisition + inference only; excludes radio, idle, peripherals and battery losses" },
      reproducibility: {
        normalizationVersion: datasetMeta.normalizationVersion, costModelVersion: "synthetic-cost-v1",
        missingSamplePolicy: COST_ASSUMPTIONS.missingSamplePolicy,
        classificationRule: "score >= threshold", artifact: "lab-core.js v1.0",
        fixtureChecksum: fnv1a(canonicalize(createFixture(datasetMeta.scenario || "baseline"))),
        costFormulas: { latencyMs: COST_ASSUMPTIONS.latencyFormula, p95LatencyMs: COST_ASSUMPTIONS.p95Formula, energyMicroJ: COST_ASSUMPTIONS.energyFormula },
        operationsPerWindow: model.operationsPerWindow
      }
    };
  }

  return { FIXTURE, MODELS, SCENARIOS, COST_ASSUMPTIONS, createFixture, normalize, scoreSample, evaluate, inspectWindows, estimateCost, thresholdSweep, recommendedThreshold, isParetoFrontier, compareProfiles, canonicalize, fnv1a, deploymentCard, round };
});
