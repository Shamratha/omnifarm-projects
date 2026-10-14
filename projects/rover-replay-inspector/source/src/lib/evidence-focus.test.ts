import { describe, expect, it } from "vitest";
import {
  analyzeRun, compareRuns, createReport, getDecisionEvidence,
  type DecisionEvidence, type PolicyRun, type ReplayFrame, type RunAnalysis, type SafetyEvent,
} from "./replay";

function frame(index: number, overrides: Partial<Omit<ReplayFrame, "index">> = {}): ReplayFrame {
  return {
    index, time: 1, x: 10, y: 55, heading: 0, speed: 1, steering: 0,
    observationTime: overrides.time ?? 1, clearance: 10, contact: false,
    reward: 1, goalReached: false, ...overrides,
  };
}

function run(id: string, frames: ReplayFrame[], completedGoals = 1): PolicyRun {
  return {
    id, name: `Policy ${id}`, version: "1.0", color: "#000000", frames,
    goals: [{ id: "a", x: 20, y: 30 }, { id: "b", x: 40, y: 30 }],
    completedGoals, totalGoals: 2,
  };
}

type FocusReport = {
  summaries: {
    id: string;
    summary: Omit<RunAnalysis, "events">;
    events: SafetyEvent[];
    evidence: {
      frameIndex: number;
      time: number;
      decision: DecisionEvidence;
      events: SafetyEvent[];
    }[];
  }[];
  ranking: (Pick<RunAnalysis,
    "totalReward" | "completion" | "success" | "completedGoals" | "totalGoals" |
    "completionStatus" | "safetyStatus"
  > & { id: string; rank: number })[];
};

function report(policyRuns: PolicyRun[]): FocusReport {
  return JSON.parse(createReport(policyRuns)) as FocusReport;
}

describe("focused replay evidence", () => {
  it("exports delay-only evidence above .5s, but not at .5s or for stationary stale readings", () => {
    const exact = frame(10, { observationTime: 0.5, clearance: 2 });
    const delayed = frame(11, { observationTime: 0.49, clearance: 2, steering: -0.25, reward: 4 });
    const stopped = frame(12, { observationTime: 0, speed: 0, clearance: 2 });
    const input = run("delay", [exact, delayed, stopped], 2);

    expect(getDecisionEvidence(exact)).toMatchObject({
      observationAgeSeconds: 0.5, observationAgeMs: 500, timing: "synchronized",
    });
    expect(getDecisionEvidence(delayed).observationAgeSeconds).toBeCloseTo(0.51);
    expect(getDecisionEvidence(stopped)).toMatchObject({
      actionLabel: "Hold position", observationAgeMs: 1000, timing: "stale-while-stationary",
    });
    for (const safeFrame of [exact, stopped]) {
      const safeRun = run("safe", [safeFrame], 2);
      expect(analyzeRun(safeRun)).toMatchObject({ events: [], firstUnsafe: null, success: true });
      expect(report([safeRun]).summaries[0].evidence).toEqual([]);
    }

    const analysis = analyzeRun(input);
    expect(analysis).toMatchObject({
      safetyStatus: "unsafe", success: false, completion: 1, contacts: 0,
      unsafeFrames: 1, criticalEvents: 0, warningEvents: 1,
      eventCounts: { contact: 0, staleObservation: 1, clearance: 0 },
      minClearance: 2, maxObservationAgeMs: 1000,
      firstUnsafe: { frameIndex: 11, type: "stale-observation", severity: "warning" },
    });
    expect(analysis.events.map(event => [event.frameIndex, event.type]))
      .toEqual([[11, "stale-observation"]]);
    const exported = report([input]).summaries[0];
    expect(exported.events).toEqual(analysis.events);
    expect(exported.evidence).toHaveLength(1);
    expect(exported.evidence[0]).toMatchObject({
      frameIndex: 11, time: 1,
      decision: {
        actionLabel: "Drive 1.00 m/s", steeringLabel: "Steer left · 0.25",
        decisionTime: 1, observationTime: 0.49, observationAgeMs: 510,
        timing: "delayed-while-moving", contact: false, clearance: 2, reward: 4,
      },
    });
    expect(exported.evidence[0].events).toEqual(analysis.events);
  });

  it("exports critical stopped contact and low clearance regardless of completed goals, without a moving-delay flag", () => {
    const stoppedContact = frame(20, {
      time: 2, observationTime: 0, speed: 0, contact: true, clearance: 0, reward: -3,
    });
    let baselineEvents: SafetyEvent[] | undefined;
    for (const completedGoals of [0, 1, 2]) {
      const input = run(`contact-${completedGoals}`, [stoppedContact], completedGoals);
      const analysis = analyzeRun(input);
      expect(analysis).toMatchObject({
        contacts: 1, unsafeFrames: 1, criticalEvents: 1, warningEvents: 1,
        eventCounts: { contact: 1, staleObservation: 0, clearance: 1 },
        completion: completedGoals / 2, completedGoals,
        completionStatus: ["not-started", "partial", "complete"][completedGoals],
        safetyStatus: "unsafe", success: false,
        firstUnsafe: { frameIndex: 20, type: "contact", severity: "critical" },
      });
      expect(analysis.events.map(event => [event.type, event.severity])).toEqual([
        ["contact", "critical"], ["clearance", "warning"],
      ]);
      if (baselineEvents) expect(analysis.events).toEqual(baselineEvents);
      baselineEvents = analysis.events;

      const exported = report([input]).summaries[0];
      expect(exported.summary).toMatchObject({
        completedGoals, completion: completedGoals / 2, safetyStatus: "unsafe", success: false,
        eventCounts: { contact: 1, staleObservation: 0, clearance: 1 },
      });
      expect(exported.events).toEqual(analysis.events);
      expect(exported.evidence).toHaveLength(1);
      expect(exported.evidence[0]).toMatchObject({
        frameIndex: 20, time: 2,
        decision: {
          actionLabel: "Hold position", decisionTime: 2, observationTime: 0,
          observationAgeMs: 2000, timing: "stale-while-stationary",
          contact: true, clearance: 0, reward: -3,
        },
      });
      expect(exported.evidence[0].events).toEqual(analysis.events);
    }
  });

  it("keeps completion and success independent of exact reward ties, with lexical display order and competition ranks", () => {
    const unsafeFull = run("A-unsafe", [frame(30, { reward: 12, contact: true, clearance: 0 })], 2);
    const safePartial = run("Z-partial", [frame(31, { reward: 12 })], 1);
    const safeFull = run("a-safe", [frame(32, { reward: 12 })], 2);
    const lower = run("0-lower", [frame(33, { reward: 1 })], 2);
    const expected = [
      { id: "A-unsafe", rank: 1, totalReward: 12, completion: 1, completedGoals: 2,
        completionStatus: "complete", safetyStatus: "unsafe", success: false },
      { id: "Z-partial", rank: 1, totalReward: 12, completion: 0.5, completedGoals: 1,
        completionStatus: "partial", safetyStatus: "safe", success: false },
      { id: "a-safe", rank: 1, totalReward: 12, completion: 1, completedGoals: 2,
        completionStatus: "complete", safetyStatus: "safe", success: true },
      { id: "0-lower", rank: 4, totalReward: 1, completion: 1, completedGoals: 2,
        completionStatus: "complete", safetyStatus: "safe", success: true },
    ];
    const permutations = [
      [safeFull, lower, safePartial, unsafeFull],
      [unsafeFull, safePartial, lower, safeFull],
      [lower, safeFull, unsafeFull, safePartial],
      [safePartial, unsafeFull, safeFull, lower],
    ];
    const baseline = createReport(permutations[0]);
    for (const policies of permutations) {
      const comparison = compareRuns(policies);
      expect(comparison.map(({ run: policy, rank, summary }) => ({ id: policy.id, rank, ...summary })))
        .toMatchObject(expected);
      for (const { run: policy, summary } of comparison) {
        expect(summary).toEqual(analyzeRun(policy));
      }
      expect(createReport(policies)).toBe(baseline);
      const exported = report(policies);
      expect(exported.ranking).toMatchObject(expected);
      for (const { id, rank: _rank, ...metrics } of expected) {
        expect(exported.summaries.find(entry => entry.id === id)?.summary).toMatchObject(metrics);
      }
    }
  });

  it("orders same-time events by frame index then contact/delay/clearance and preserves firstUnsafe and report bytes on reversal", () => {
    const input = run("ordered", [
      frame(7, { time: 2, observationTime: 1.49, contact: true, clearance: 0 }),
      frame(100, { time: 1 }),
      frame(4, { time: 2, observationTime: 1.49, contact: true, clearance: 0 }),
      frame(2, { time: 2, observationTime: 1.49, clearance: 1.9 }),
    ]);
    const reversed = { ...input, frames: [...input.frames].reverse() };
    const expectedOrder = [
      [2, "stale-observation"], [2, "clearance"],
      [4, "contact"], [4, "stale-observation"], [4, "clearance"],
      [7, "contact"], [7, "stale-observation"], [7, "clearance"],
    ];
    const analysis = analyzeRun(input);
    expect(analysis.events.map(event => [event.frameIndex, event.type])).toEqual(expectedOrder);
    expect(analysis.firstUnsafe).toMatchObject({
      frameIndex: 2, time: 2, type: "stale-observation", severity: "warning",
    });
    expect(analyzeRun(reversed).events).toEqual(analysis.events);
    expect(analyzeRun(reversed).firstUnsafe).toEqual(analysis.firstUnsafe);
    expect(createReport([reversed])).toBe(createReport([input]));

    const exported = report([input]).summaries[0];
    expect(exported.summary.firstUnsafe).toEqual(analysis.firstUnsafe);
    expect(exported.events.map(event => [event.frameIndex, event.type])).toEqual(expectedOrder);
    expect(exported.evidence.map(entry => entry.frameIndex)).toEqual([2, 4, 7]);
    expect(exported.evidence.flatMap(entry => entry.events.map(event => [entry.frameIndex, event.type])))
      .toEqual(expectedOrder);
  });

  it("rejects reused frame identities rather than silently merging safety evidence", () => {
    const input = run("duplicate-frame", [
      frame(3, { time: 1, observationTime: 0.49 }),
      frame(3, { time: 2, contact: true, clearance: 0 }),
    ]);
    const snapshot = JSON.stringify(input);
    for (const frames of [input.frames, [...input.frames].reverse()]) {
      const ambiguous = { ...input, frames };
      expect(() => analyzeRun(ambiguous)).toThrow(/Frame indices must be unique/);
      expect(() => compareRuns([ambiguous])).toThrow(/Frame indices must be unique/);
      expect(() => createReport([ambiguous])).toThrow(/Frame indices must be unique/);
    }
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("rejects ambiguous goal catalogs regardless of their array order", () => {
    const input = run("duplicate-goal", [frame(1)]);
    input.goals = [{ id: "a", x: 20, y: 30 }, { id: "a", x: 40, y: 30 }];
    const snapshot = JSON.stringify(input);
    expect(() => createReport([input])).toThrow(/Goal IDs must be unique/);
    expect(() => createReport([{ ...input, goals: [...input.goals].reverse() }]))
      .toThrow(/Goal IDs must be unique/);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("sorts policy and goal IDs without locale dependence and scopes local identities per policy", () => {
    const policies = ["ä", "a", "Z"].map(id => ({
      ...run(id, [frame(2), frame(1)]),
      goals: [{ id: "ä", x: 1, y: 1 }, { id: "z", x: 2, y: 2 }, { id: "A", x: 3, y: 3 }],
      totalGoals: 3,
    }));
    const original = createReport(policies);
    const exported = JSON.parse(original);
    expect(exported.summaries.map((entry: { id: string }) => entry.id)).toEqual(["Z", "a", "ä"]);
    expect(exported.ranking.map((entry: { id: string; rank: number }) => [entry.id, entry.rank]))
      .toEqual([["Z", 1], ["a", 1], ["ä", 1]]);
    for (const trace of exported.traces) {
      expect(trace.goals.map((goal: { id: string }) => goal.id)).toEqual(["A", "z", "ä"]);
      expect(trace.frames.map((sample: { index: number }) => sample.index)).toEqual([1, 2]);
    }
    expect(createReport([...policies].reverse().map(policy => ({
      ...policy, goals: [...policy.goals].reverse(), frames: [...policy.frames].reverse(),
    })))).toBe(original);
  });
});
