import { describe, expect, it } from "vitest";
import {
  analyzeRun, chronologicalFrames, compareRuns, createReport, cumulativeRewards, getDecisionEvidence, runs,
  type PolicyRun, type ReplayFrame,
} from "./replay";

function frame(overrides: Partial<ReplayFrame> = {}): ReplayFrame {
  return {
    index: 0, time: 0, x: 10, y: 55, heading: 0, speed: 1, steering: 0,
    observationTime: overrides.time ?? 0, clearance: 10, contact: false,
    reward: 1, goalReached: false, ...overrides,
  };
}

function run(frames: ReplayFrame[], overrides: Partial<PolicyRun> = {}): PolicyRun {
  return {
    id: "test", name: "Test policy", version: "1.0", color: "#000000", frames,
    goals: [{ id: "b", x: 2, y: 3 }, { id: "a", x: 1, y: 2 }],
    completedGoals: 1, totalGoals: 2, ...overrides,
  };
}

function unsafeRun(): PolicyRun {
  return run([
    frame({ index: 8, time: 2, speed: 0, contact: true }),
    frame({ index: 3, time: 1, observationTime: 0.49, contact: true,
      clearance: 0, steering: -0.25, reward: -4 }),
    frame({ index: 1, time: 0 }),
  ]);
}

function reverseKeys<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).reverse()) as T;
}

describe("inspection metrics", () => {
  it("counts stopped contacts and cooccurring rules separately from unsafe frames", () => {
    const summary = analyzeRun(unsafeRun());
    expect(summary).toMatchObject({
      frameCount: 3, contacts: 2, unsafeFrames: 2, criticalEvents: 2, warningEvents: 2,
      eventCounts: { contact: 2, staleObservation: 1, clearance: 1 },
      completedGoals: 1, totalGoals: 2, remainingGoals: 1, completion: 0.5,
      completionStatus: "partial", safetyStatus: "unsafe", success: false,
      minClearance: 0, maxObservationAgeMs: 510, duration: 2, totalReward: -2,
    });
    expect(summary.events).toHaveLength(4);
    expect(summary.firstUnsafe).toMatchObject({ frameIndex: 3, time: 1 });
    expect(summary.events.filter((event) => event.frameIndex === 8))
      .toMatchObject([{ type: "contact", severity: "critical" }]);
  });

  it("distinguishes safe partial delivery from unsafe partial delivery", () => {
    const safe = analyzeRun(run([frame({ clearance: 2 })]));
    expect(safe).toMatchObject({
      completionStatus: "partial", safetyStatus: "safe", success: false,
      completedGoals: 1, totalGoals: 2, remainingGoals: 1, unsafeFrames: 0,
      eventCounts: { contact: 0, staleObservation: 0, clearance: 0 },
    });
    expect(analyzeRun(unsafeRun()).safetyStatus).toBe("unsafe");
    expect(analyzeRun(run([frame()], { completedGoals: 2 })))
      .toMatchObject({ completionStatus: "complete", remainingGoals: 0, success: true });
    expect(analyzeRun(run([frame()], { completedGoals: 0 })))
      .toMatchObject({ completionStatus: "not-started", remainingGoals: 2, success: false });
  });

  it("applies the strict moving age boundary while retaining stationary maximum age", () => {
    const exact = frame({ time: 1, observationTime: 0.5 });
    const delayed = frame({ index: 1, time: 1, observationTime: 0.49 });
    const stopped = frame({ index: 2, time: 2, observationTime: 0, speed: 0 });
    expect(analyzeRun(run([exact]))).toMatchObject({ unsafeFrames: 0, maxObservationAgeMs: 500 });
    expect(analyzeRun(run([delayed]))).toMatchObject({
      unsafeFrames: 1, maxObservationAgeMs: 510, eventCounts: { staleObservation: 1 },
    });
    expect(analyzeRun(run([stopped]))).toMatchObject({
      safetyStatus: "safe", maxObservationAgeMs: 2000, eventCounts: { staleObservation: 0 },
    });
    expect(analyzeRun(run([stopped, delayed, exact])).events)
      .toMatchObject([{ frameIndex: 1, type: "stale-observation" }]);
  });

  it("reports empty data without success or fabricated extrema", () => {
    expect(analyzeRun(run([], { goals: [], completedGoals: 0, totalGoals: 0 }))).toMatchObject({
      frameCount: 0, completedGoals: 0, totalGoals: 0, remainingGoals: 0,
      completionStatus: "no-goals", safetyStatus: "no-data", success: false,
      events: [], firstUnsafe: null, totalReward: 0, completion: 0, duration: 0,
      contacts: 0, unsafeFrames: 0, criticalEvents: 0, warningEvents: 0,
      eventCounts: { contact: 0, staleObservation: 0, clearance: 0 },
      minClearance: null, maxObservationAgeMs: null,
    });
    expect(analyzeRun(run([], { completedGoals: 2 })).success).toBe(false);
  });

  it("sorts a copy by time then index and compensates chronological reward summation", () => {
    const input = run([
      frame({ index: 2, time: 1, reward: 1 }), frame({ index: 0, time: 0, reward: 1e16 }),
      frame({ index: 3, time: 2, reward: -1e16 }), frame({ index: 1, time: 1, reward: 1 }),
    ]);
    const snapshot = JSON.stringify(input);
    const ordered = chronologicalFrames(input.frames);
    expect(ordered).not.toBe(input.frames);
    expect(ordered.map((sample) => sample.index)).toEqual([0, 1, 2, 3]);
    expect(analyzeRun(input).totalReward).toBe(2);
    expect(cumulativeRewards(input.frames).at(-1)?.totalReward).toBe(2);
    expect(analyzeRun({ ...input, frames: [...input.frames].reverse() }).totalReward).toBe(2);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe("inspection comparison and report", () => {
  it("uses exact competition ties, lexical ids, and distinct ranks for UI-rounded totals", () => {
    const policies = [["zeta", 10.004], ["lower", 10.003], ["alpha", 10.004]] as const;
    const input = policies.map(([id, reward]) => run([frame({ reward })], { id }));
    expect((10.004).toFixed(2)).toBe((10.003).toFixed(2));
    expect(compareRuns(input).map(({ run: policy, rank }) => [policy.id, rank]))
      .toEqual([["alpha", 1], ["zeta", 1], ["lower", 3]]);
    expect(() => compareRuns([input[0], { ...input[1], id: input[0].id }])).toThrow();
    const originalReport = createReport(input);
    expect(createReport([...input].reverse())).toBe(originalReport);
    expect(JSON.parse(originalReport).ranking.map((entry: { id: string; rank: number }) => [entry.id, entry.rank]))
      .toEqual([["alpha", 1], ["zeta", 1], ["lower", 3]]);
  });

  it("exports full summaries, expanded ranking, and one evidence entry per unsafe frame", () => {
    const input = unsafeRun();
    input.frames.push(frame({ index: 10, time: 3, clearance: 1 }));
    const { events, ...metrics } = analyzeRun(input);
    const report = JSON.parse(createReport([input]));
    expect(report.schemaVersion).toBe(1);
    expect(report.summaries[0]).toEqual({
      id: input.id, name: input.name, version: input.version, summary: metrics, events,
      evidence: chronologicalFrames(input.frames).filter((sample) => sample.contact || sample.clearance < 2).map((sample) => ({
        frameIndex: sample.index, time: sample.time, decision: getDecisionEvidence(sample),
        events: events.filter((event) => event.frameIndex === sample.index),
      })),
    });
    expect(report.summaries[0].evidence[0].decision).toMatchObject({
      decisionTime: 1, observationTime: 0.49, observationAgeMs: 510,
      timing: "delayed-while-moving", contact: true, clearance: 0, reward: -4,
    });
    expect(report.summaries[0].evidence[0].events.map((event: { type: string }) => event.type).sort())
      .toEqual(["clearance", "contact", "stale-observation"]);
    expect(report.ranking[0]).toEqual({
      rank: 1, id: input.id, name: input.name, totalReward: -1, completion: 0.5, success: false,
      completedGoals: 1, totalGoals: 2, remainingGoals: 1, completionStatus: "partial",
      safetyStatus: "unsafe", contacts: 2, unsafeFrames: 3,
      eventCounts: { contact: 2, staleObservation: 1, clearance: 2 },
    });
    const descriptions = JSON.stringify(report.rules);
    expect(descriptions).toMatch(/time.*index/i);
    expect(descriptions).toMatch(/goal.*id|id.*goal/i);
    expect(descriptions).toMatch(/contact.*frames|frames.*contact/i);
    expect(descriptions).toMatch(/unsafe.*frames|frames.*unsafe/i);
    expect(descriptions).toMatch(/event/i);
    expect(report).not.toHaveProperty("exportedAt");
    expect(report).not.toHaveProperty("generatedAt");
  });

  it("is byte-identical under input ordering and key permutations, projects traces, and never mutates", () => {
    const input = [unsafeRun(), run([frame({ index: 2 }), frame({ index: 1 })], { id: "alpha" })];
    const permuted = [...input].reverse().map((policy) => reverseKeys({
      ...policy,
      frames: [...policy.frames].reverse().map((sample) => reverseKeys({ ...sample, ignored: "frame" })),
      goals: [...policy.goals].reverse().map((goal) => reverseKeys({ ...goal, ignored: "goal" })),
    }));
    const snapshots = [JSON.stringify(input), JSON.stringify(permuted)];
    const baseline = createReport(input);
    expect(createReport(permuted)).toBe(baseline);
    const report = JSON.parse(baseline);
    expect(report.summaries.map((entry: { id: string }) => entry.id)).toEqual(["alpha", "test"]);
    expect(report.traces.map((entry: { id: string }) => entry.id)).toEqual(["alpha", "test"]);
    expect(report.traces[0].frames).toEqual([input[1].frames[1], input[1].frames[0]]);
    expect(report.traces[1].frames).toEqual([input[0].frames[2], input[0].frames[1], input[0].frames[0]]);
    expect(report.traces[1].goals).toEqual([{ id: "a", x: 1, y: 2 }, { id: "b", x: 2, y: 3 }]);
    expect(report.summaries[0].evidence).toEqual([]);
    compareRuns(permuted);
    expect([JSON.stringify(input), JSON.stringify(permuted)]).toEqual(snapshots);
  });

  it("keeps curve endpoints, displayed metrics, and exported totals aligned for bundled policies", () => {
    const report = JSON.parse(createReport(runs));
    for (const policy of runs) {
      const summary = analyzeRun(policy);
      const exported = report.summaries.find((entry: { id: string }) => entry.id === policy.id).summary;
      const ranked = report.ranking.find((entry: { id: string }) => entry.id === policy.id);
      expect(cumulativeRewards(policy.frames).at(-1)?.totalReward).toBe(summary.totalReward);
      expect(exported.totalReward).toBe(summary.totalReward);
      expect(ranked.totalReward).toBe(summary.totalReward);
      expect(exported.contacts).toBe(summary.contacts);
      expect(exported.completionStatus).toBe(summary.completionStatus);
    }
  });
});
