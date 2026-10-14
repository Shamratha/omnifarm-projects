import { describe, expect, it } from "vitest";
import {
  SCENARIO,
  analyzeRun,
  compareRuns,
  createReport,
  formatTime,
  getDecisionEvidence,
  runs,
  type PolicyRun,
  type ReplayFrame,
} from "./replay";

function frame(overrides: Partial<ReplayFrame> = {}): ReplayFrame {
  return {
    index: 0,
    time: 0,
    x: 10,
    y: 55,
    heading: 0,
    speed: 1,
    steering: 0,
    observationTime: 0,
    clearance: 10,
    contact: false,
    reward: 1,
    goalReached: false,
    ...overrides,
  };
}

function run(frames: ReplayFrame[], overrides: Partial<PolicyRun> = {}): PolicyRun {
  return {
    id: "test",
    name: "Test policy",
    version: "1.0",
    color: "#000000",
    frames,
    goals: [{ id: "goal", x: 1, y: 1 }],
    completedGoals: 0,
    totalGoals: 1,
    ...overrides,
  };
}

describe("bundled replay fixtures", () => {
  it("contains three deterministic 60-second trajectories", () => {
    expect(runs.map((policyRun) => policyRun.id)).toEqual(["ppo", "sac", "baseline"]);
    for (const policyRun of runs) {
      expect(policyRun.frames).toHaveLength(121);
      expect(policyRun.frames[0].time).toBe(0);
      expect(policyRun.frames[policyRun.frames.length - 1].time).toBe(60);
      expect(policyRun.frames[0]).toMatchObject({ x: 10, y: 55 });
      expect(policyRun.goals).toEqual([
        { id: "dock-a", x: 35, y: 42 },
        { id: "dock-b", x: 65, y: 20 },
        { id: "dock-c", x: 88, y: 12 },
      ]);
      for (const sample of policyRun.frames) {
        expect(sample.x).toBeGreaterThanOrEqual(0);
        expect(sample.x).toBeLessThanOrEqual(100);
        expect(sample.y).toBeGreaterThanOrEqual(0);
        expect(sample.y).toBeLessThanOrEqual(70);
        expect(Object.values(sample).every((value) => typeof value !== "number" || Number.isFinite(value))).toBe(true);
        const insideObstacle = SCENARIO.obstacles.some(
          ({ x, y, w, h }) => sample.x >= x && sample.x <= x + w && sample.y >= y && sample.y <= y + h,
        );
        expect(sample.contact).toBe(insideObstacle);
      }
      expect(policyRun.frames.filter((sample) => sample.goalReached)).toHaveLength(policyRun.completedGoals);
    }
    expect(SCENARIO.obstacles).toContainEqual({ x: 48, y: 29, w: 8, h: 8 });
    const ppo = analyzeRun(runs[0]);
    const sac = analyzeRun(runs[1]);
    const baseline = analyzeRun(runs[2]);
    expect(ppo.firstUnsafe?.time).toBe(24);
    expect(ppo.events.some((event) => event.type === "stale-observation")).toBe(true);
    expect(runs[0].frames.find((sample) => sample.contact)).toMatchObject({ x: 48, y: 33 });
    expect(sac.success).toBe(true);
    expect(sac.events).toEqual([]);
    expect(sac.completion).toBe(1);
    expect(baseline.completion).toBeCloseTo(2 / 3);
    expect(baseline.contacts).toBeGreaterThan(0);
    expect(compareRuns(runs).map(({ run: item }) => item.id)).toEqual(["sac", "ppo", "baseline"]);
  });
});

describe("decision evidence", () => {
  it("links PPO frame 48 to its recorded observation and decision-associated readings", () => {
    const action = runs.find((policyRun) => policyRun.id === "ppo")!.frames[48];
    const evidence = getDecisionEvidence(action);

    expect(action).toMatchObject({ index: 48, time: 24, observationTime: 23.1 });
    expect(evidence).toMatchObject({
      decisionTime: 24,
      observationTime: 23.1,
      observationAgeMs: 900,
      timing: "delayed-while-moving",
      actionLabel: "Drive 4.00 m/s",
      steeringLabel: "Steer right · 0.65",
      contact: true,
      clearance: 0,
      reward: action.reward,
    });
    expect(evidence.observationAgeSeconds).toBeCloseTo(0.9);
    expect(evidence.reward).toBeCloseTo(-5.28);
    expect({ contact: evidence.contact, clearance: evidence.clearance, reward: evidence.reward }).toEqual({
      contact: action.contact,
      clearance: action.clearance,
      reward: action.reward,
    });
  });

  it.each([
    { decisionTime: 24, age: 0.5, ageMs: 500, timing: "synchronized", events: [] },
    { decisionTime: 24.01, age: 0.51, ageMs: 510, timing: "delayed-while-moving", events: ["stale-observation"] },
  ])("preserves timestamp precision at observation age $age", ({ decisionTime, age, ageMs, timing, events }) => {
    const action = frame({ time: decisionTime, observationTime: 23.5 });
    const evidence = getDecisionEvidence(action);

    expect(formatTime(decisionTime)).toBe("00:24.0");
    expect(evidence.decisionTime).toBe(decisionTime);
    expect(evidence.observationTime).toBe(23.5);
    expect(evidence.observationAgeSeconds).toBeCloseTo(age);
    expect(evidence.observationAgeMs).toBe(ageMs);
    expect(evidence.timing).toBe(timing);
    expect(analyzeRun(run([action])).events.map((event) => event.type)).toEqual(events);
  });

  it("keeps stationary stale age available for display without a stale violation", () => {
    const action = frame({ time: 24, observationTime: 23.1, speed: 0 });
    const evidence = getDecisionEvidence(action);

    expect(evidence).toMatchObject({
      actionLabel: "Hold position",
      decisionTime: 24,
      observationTime: 23.1,
      observationAgeMs: 900,
      timing: "stale-while-stationary",
    });
    expect(evidence.observationAgeSeconds).toBeCloseTo(0.9);
    expect(analyzeRun(run([action])).events).toEqual([]);
  });

  it.each([
    { speed: 1.236, steering: 0, actionLabel: "Drive 1.24 m/s", steeringLabel: "Steering neutral" },
    { speed: 0, steering: 0.257, actionLabel: "Hold position", steeringLabel: "Steer right · 0.26" },
    { speed: 1, steering: -0.257, actionLabel: "Drive 1.00 m/s", steeringLabel: "Steer left · 0.26" },
    { speed: 1, steering: 0.049, actionLabel: "Drive 1.00 m/s", steeringLabel: "Steering neutral" },
    { speed: 1, steering: -0.049, actionLabel: "Drive 1.00 m/s", steeringLabel: "Steering neutral" },
    { speed: 1, steering: 0.05, actionLabel: "Drive 1.00 m/s", steeringLabel: "Steer right · 0.05" },
    { speed: 1, steering: -0.05, actionLabel: "Drive 1.00 m/s", steeringLabel: "Steer left · 0.05" },
  ])("labels speed $speed and steering $steering", ({ speed, steering, actionLabel, steeringLabel }) => {
    expect(getDecisionEvidence(frame({ speed, steering }))).toMatchObject({ actionLabel, steeringLabel });
  });

  it("does not mutate the recorded action or share mutable evidence between calls", () => {
    const action = Object.freeze(frame({
      index: 48, time: 24, observationTime: 23.1, speed: 4,
      steering: -0.25, contact: true, clearance: 0, reward: -5.28,
    }));
    const snapshot = { ...action };
    const evidence = getDecisionEvidence(action);
    const repeated = getDecisionEvidence(action);

    expect(action).toEqual(snapshot);
    expect(repeated).toEqual(evidence);
    expect(repeated).not.toBe(evidence);
    evidence.decisionTime = 0;
    evidence.observationTime = 0;
    evidence.contact = false;
    evidence.clearance = 100;
    evidence.reward = 100;
    expect(action).toEqual(snapshot);
    expect(getDecisionEvidence(action)).toEqual(repeated);
  });
});

describe("safety analysis boundaries", () => {
  it("flags observation age over .5 while moving, but not exactly .5", () => {
    const exactFrame = frame({ time: 1, observationTime: 0.5 });
    const delayedFrame = frame({ time: 1, observationTime: 0.49 });
    const stoppedFrame = frame({ time: 1, observationTime: 0, speed: 0 });
    const exact = analyzeRun(run([exactFrame]));
    const delayed = analyzeRun(run([delayedFrame]));
    const stopped = analyzeRun(run([stoppedFrame]));

    expect(exact.events).toHaveLength(0);
    expect(delayed.events.map((event) => event.type)).toEqual(["stale-observation"]);
    expect(stopped.events).toHaveLength(0);
    expect(getDecisionEvidence(exactFrame)).toMatchObject({
      actionLabel: "Drive 1.00 m/s",
      observationAgeMs: 500,
      timing: "synchronized",
    });
    expect(getDecisionEvidence(delayedFrame).timing).toBe("delayed-while-moving");
    expect(getDecisionEvidence(stoppedFrame).timing).toBe("stale-while-stationary");
  });

  it("reports contact even when the rover is stopped", () => {
    const summary = analyzeRun(run([frame({ speed: 0, contact: true })]));
    expect(summary.contacts).toBe(1);
    expect(summary.firstUnsafe?.type).toBe("contact");
    expect(summary.firstUnsafe?.severity).toBe("critical");
    expect(analyzeRun(run([frame({ contact: true })], { completedGoals: 1 })).success).toBe(false);
  });

  it("reports low clearance and partial completion", () => {
    const summary = analyzeRun(
      run([frame({ clearance: 1.9 })], { completedGoals: 2, totalGoals: 3 }),
    );
    expect(summary.events.map((event) => event.type)).toEqual(["clearance"]);
    expect(summary.completion).toBeCloseTo(2 / 3);
    expect(summary.success).toBe(false);
    expect(analyzeRun(run([frame({ clearance: 2 })])).firstUnsafe).toBeNull();
  });

  it("sums per-frame rewards and preserves source frames while finding the earliest violation", () => {
    const input = run([
      frame({ index: 2, time: 8, observationTime: 8, contact: true, reward: -3 }),
      frame({ index: 1, time: 5, observationTime: 4, reward: 7 }),
    ]);
    const snapshot = JSON.stringify(input);
    const summary = analyzeRun(input);
    expect(summary.totalReward).toBe(4);
    expect(summary.duration).toBe(3);
    expect(summary.firstUnsafe).toMatchObject({ frameIndex: 1, time: 5, type: "stale-observation" });
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("handles empty replay data without dividing by zero", () => {
    expect(analyzeRun(run([], { totalGoals: 0 }))).toMatchObject({
      events: [], firstUnsafe: null, totalReward: 0, completion: 0,
      contacts: 0, success: false, duration: 0,
    });
    expect(compareRuns([])).toEqual([]);
    expect(JSON.parse(createReport([]))).toMatchObject({ summaries: [], ranking: [] });
  });
});

describe("comparison and reporting", () => {
  it("uses competition ranks for tied rewards and sorts tied ids stably", () => {
    const first = run([frame({ reward: 10 })], { id: "zeta" });
    const second = run([frame({ reward: 10 })], { id: "alpha" });
    const third = run([frame({ reward: 1 })], { id: "omega" });
    const fourth = run([frame({ reward: 10 })], { id: "beta" });
    const input = [first, third, second, fourth];
    const snapshot = JSON.stringify(input);
    expect(compareRuns(input).map(({ run: item, rank }) => [item.id, rank])).toEqual([
      ["alpha", 1],
      ["beta", 1],
      ["zeta", 1],
      ["omega", 4],
    ]);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("creates byte-identical reports for identical input", () => {
    const first = createReport(runs);
    const second = createReport(runs);
    expect(first).toBe(second);
    expect(JSON.parse(first)).toMatchObject({ schemaVersion: 1, scenario: SCENARIO });
    expect(JSON.parse(first).summaries[0]).toHaveProperty("events");
    expect(JSON.parse(first)).toHaveProperty("ranking");
    expect(first).toContain('\n  "schemaVersion": 1,');
    expect(first).toBe(createReport(JSON.parse(JSON.stringify(runs))));
    expect(first).toBe(createReport([...runs].reverse()));
    const report = JSON.parse(first);
    expect(report.traces).toHaveLength(3);
    expect(report.traces[0].frames).toHaveLength(121);
    expect(report.rules.contactAlwaysUnsafe).toBe(true);
    expect(report).not.toHaveProperty('exportedAt');
  });

  it("formats minutes and tenths consistently", () => {
    expect(formatTime(24)).toBe("00:24.0");
    expect(formatTime(60)).toBe("01:00.0");
    expect(formatTime(3.25)).toBe("00:03.3");
    expect(formatTime(59.96)).toBe("01:00.0");
    expect(formatTime(125.1)).toBe("02:05.1");
    expect(formatTime(-1)).toBe("00:00.0");
  });
});
