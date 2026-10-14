/**
 * The replay model deliberately contains no rendering or clock dependencies.
 * A frame is a sample from the simulator, rather than a command to a rover.
 */
export type ReplayFrame = {
  index: number;
  time: number;
  x: number;
  y: number;
  heading: number;
  speed: number;
  steering: number;
  observationTime: number;
  clearance: number;
  contact: boolean;
  reward: number;
  goalReached: boolean;
};

export type PolicyRun = {
  id: string;
  name: string;
  version: string;
  color: string;
  frames: ReplayFrame[];
  goals: { id: string; x: number; y: number }[];
  completedGoals: number;
  totalGoals: number;
};

export type SafetyEvent = {
  frameIndex: number;
  time: number;
  type: "contact" | "stale-observation" | "clearance";
  title: string;
  description: string;
  severity: "critical" | "warning";
};

// Part of the inspection/report contract, not the order rules happen to be evaluated.
const EVENT_PRIORITY: Record<SafetyEvent["type"], number> = {
  contact: 0,
  "stale-observation": 1,
  clearance: 2,
};

function compareIds(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export type DecisionEvidence = {
  actionLabel: string;
  steeringLabel: string;
  decisionTime: number;
  observationTime: number;
  observationAgeSeconds: number;
  observationAgeMs: number;
  timing: "synchronized" | "delayed-while-moving" | "stale-while-stationary";
  clearance: number;
  contact: boolean;
  reward: number;
};

export const SCENARIO = {
  name: "Warehouse west-to-east delivery",
  seed: 18427,
  width: 100,
  height: 70,
  start: { x: 10, y: 55 },
  obstacles: [
    { x: 48, y: 29, w: 8, h: 8 },
    { x: 70, y: 38, w: 12, h: 5 },
  ],
} as const;

const GOALS = [
  { id: "dock-a", x: 35, y: 42 },
  { id: "dock-b", x: 65, y: 20 },
  { id: "dock-c", x: 88, y: 12 },
];

// A two-unit buffer is the warehouse's warning boundary. Contact is always
// reported separately, including when the rover is no longer moving.
const CLEARANCE_WARNING = 2;
const STEP = 0.5;
const LAST_TIME = 60;

export function getDecisionEvidence(frame: ReplayFrame): DecisionEvidence {
  const observationAgeSeconds = Math.max(0, frame.time - frame.observationTime);
  const steeringLabel = Math.abs(frame.steering) < 0.05
    ? "Steering neutral"
    : frame.steering > 0
      ? `Steer right · ${frame.steering.toFixed(2)}`
      : `Steer left · ${Math.abs(frame.steering).toFixed(2)}`;
  const timing = observationAgeSeconds > 0.5
    ? frame.speed > 0 ? "delayed-while-moving" : "stale-while-stationary"
    : "synchronized";

  return {
    actionLabel: frame.speed > 0 ? `Drive ${frame.speed.toFixed(2)} m/s` : "Hold position",
    steeringLabel,
    decisionTime: frame.time,
    observationTime: frame.observationTime,
    observationAgeSeconds,
    observationAgeMs: Math.round(observationAgeSeconds * 1000),
    timing,
    clearance: frame.clearance,
    contact: frame.contact,
    reward: frame.reward,
  };
}

type Waypoint = { time: number; x: number; y: number };

const PPO_PATH: Waypoint[] = [
  { time: 0, x: 10, y: 55 },
  { time: 14, x: 35, y: 42 },
  { time: 23.5, x: 46, y: 33 },
  { time: 24, x: 48, y: 33 },
  { time: 24.5, x: 48, y: 33 },
  { time: 25, x: 46, y: 33 },
  { time: 29, x: 44, y: 24 },
  { time: 37, x: 65, y: 20 },
  { time: 50, x: 88, y: 12 },
  { time: 60, x: 88, y: 12 },
];

const SAC_PATH: Waypoint[] = [
  { time: 0, x: 10, y: 55 },
  { time: 14, x: 35, y: 42 },
  { time: 19, x: 42, y: 24 },
  { time: 30, x: 65, y: 20 },
  { time: 45, x: 88, y: 12 },
  { time: 60, x: 88, y: 12 },
];

const BASELINE_PATH: Waypoint[] = [
  { time: 0, x: 10, y: 55 },
  { time: 15, x: 35, y: 42 },
  { time: 23.5, x: 46, y: 33 },
  { time: 24, x: 48, y: 33 },
  { time: 24.5, x: 48, y: 33 },
  { time: 25, x: 46, y: 33 },
  { time: 31, x: 44, y: 24 },
  { time: 40, x: 65, y: 20 },
  { time: 60, x: 65, y: 20 },
];

type PolicyFixture = {
  id: string;
  name: string;
  version: string;
  color: string;
  path: Waypoint[];
  completedGoals: number;
  rewardScale: number;
  staleAt?: number;
};

const FIXTURES: PolicyFixture[] = [
  {
    id: "ppo",
    name: "PPO · v2.4",
    version: "2.4",
    color: "#f97316",
    path: PPO_PATH,
    completedGoals: 3,
    rewardScale: 1,
    staleAt: 24,
  },
  {
    id: "sac",
    name: "SAC · v1.8",
    version: "1.8",
    color: "#14b8a6",
    path: SAC_PATH,
    completedGoals: 3,
    rewardScale: 1.12,
  },
  {
    id: "baseline",
    name: "Rule-based",
    version: "1.0",
    color: "#64748b",
    path: BASELINE_PATH,
    completedGoals: 2,
    rewardScale: 0.78,
  },
];

function interpolate(path: Waypoint[], time: number): { x: number; y: number } {
  for (let i = 0; i < path.length - 1; i += 1) {
    const from = path[i];
    const to = path[i + 1];
    if (time <= to.time) {
      if (time === to.time || from.time === to.time) return { x: to.x, y: to.y };
      const ratio = (time - from.time) / (to.time - from.time);
      return {
        x: from.x + (to.x - from.x) * ratio,
        y: from.y + (to.y - from.y) * ratio,
      };
    }
  }
  const last = path[path.length - 1];
  return { x: last.x, y: last.y };
}

function rectangleClearance(x: number, y: number, obstacle: (typeof SCENARIO.obstacles)[number]): number {
  const dx = Math.max(obstacle.x - x, 0, x - (obstacle.x + obstacle.w));
  const dy = Math.max(obstacle.y - y, 0, y - (obstacle.y + obstacle.h));
  return Math.sqrt(dx * dx + dy * dy);
}

function clearanceAt(x: number, y: number): number {
  return Math.min(...SCENARIO.obstacles.map((obstacle) => rectangleClearance(x, y, obstacle)));
}

function isInsideObstacle(x: number, y: number): boolean {
  return SCENARIO.obstacles.some(
    (obstacle) =>
      x >= obstacle.x &&
      x <= obstacle.x + obstacle.w &&
      y >= obstacle.y &&
      y <= obstacle.y + obstacle.h,
  );
}

function reachedGoal(x: number, y: number, goal: { x: number; y: number }): boolean {
  return Math.hypot(x - goal.x, y - goal.y) < 0.001;
}

function makeFrames(fixture: PolicyFixture): ReplayFrame[] {
  const frames: ReplayFrame[] = [];
  const deliveredGoals = new Set<string>();

  for (let index = 0; index <= LAST_TIME / STEP; index += 1) {
    const time = index * STEP;
    const position = interpolate(fixture.path, time);
    const previous = index === 0 ? position : interpolate(fixture.path, time - STEP);
    const dx = position.x - previous.x;
    const dy = position.y - previous.y;
    const distance = Math.hypot(dx, dy);
    const speed = distance / STEP;
    const heading = distance === 0 && frames.length > 0 ? frames[frames.length - 1].heading : Math.atan2(dy, dx);
    const previousHeading = frames.length > 0 ? frames[frames.length - 1].heading : heading;
    const steering = Math.max(-1, Math.min(1, (heading - previousHeading) / (Math.PI / 3)));
    const contact = isInsideObstacle(position.x, position.y);
    const goal = GOALS.find(
      (candidate) => !deliveredGoals.has(candidate.id) && reachedGoal(position.x, position.y, candidate),
    );
    const goalReached = goal !== undefined;
    if (goal) deliveredGoals.add(goal.id);
    const observationTime = fixture.staleAt === time ? time - 0.9 : time;

    // Progress, delivery bonuses, and safety costs make the fixture rewards
    // useful for ranking while remaining entirely deterministic.
    const progressReward = distance * 0.11 * fixture.rewardScale;
    const goalReward = goalReached ? 5 * fixture.rewardScale : 0;
    const contactCost = contact ? 5.5 : 0;
    const reward = progressReward + goalReward - contactCost;

    frames.push({
      index,
      time,
      x: position.x,
      y: position.y,
      heading,
      speed,
      steering,
      observationTime,
      clearance: clearanceAt(position.x, position.y),
      contact,
      reward,
      goalReached,
    });
  }

  return frames;
}

function makeRun(fixture: PolicyFixture): PolicyRun {
  return {
    id: fixture.id,
    name: fixture.name,
    version: fixture.version,
    color: fixture.color,
    frames: makeFrames(fixture),
    goals: GOALS.map((goal) => ({ ...goal })),
    completedGoals: fixture.completedGoals,
    totalGoals: GOALS.length,
  };
}

/** Three fixed policy runs over the same 100 by 70 warehouse scenario. */
export const runs: PolicyRun[] = FIXTURES.map(makeRun);

function eventForFrame(frame: ReplayFrame): SafetyEvent[] {
  const events: SafetyEvent[] = [];
  const evidence = getDecisionEvidence(frame);

  if (frame.contact) {
    events.push({
      frameIndex: frame.index,
      time: frame.time,
      type: "contact",
      title: "Obstacle contact",
      description: `At (${frame.x.toFixed(1)}, ${frame.y.toFixed(1)})m, the recorded action was ${evidence.actionLabel.toLowerCase()} with ${evidence.steeringLabel.toLowerCase()}. The rover occupied an obstacle cell. Observation age: ${evidence.observationAgeMs}ms.`,
      severity: "critical",
    });
  }
  if (evidence.timing === "delayed-while-moving") {
    events.push({
      frameIndex: frame.index,
      time: frame.time,
      type: "stale-observation",
      title: "Stale observation",
      description: `The rover acted on an observation ${evidence.observationAgeMs}ms old while moving (observation ${frame.observationTime.toFixed(3)}s → decision ${frame.time.toFixed(3)}s). The age exceeded the 500ms limit.`,
      severity: "warning",
    });
  }
  if (frame.clearance < CLEARANCE_WARNING) {
    events.push({
      frameIndex: frame.index,
      time: frame.time,
      type: "clearance",
      title: "Low obstacle clearance",
      description: `Obstacle clearance was ${frame.clearance.toFixed(3)}m, below the ${CLEARANCE_WARNING}m warning boundary.`,
      severity: "warning",
    });
  }
  return events;
}

export type RunAnalysis = {
  events: SafetyEvent[];
  firstUnsafe: SafetyEvent | null;
  totalReward: number;
  completion: number;
  contacts: number;
  /** All goals completed without any safety violations. */
  success: boolean;
  duration: number;
  frameCount: number;
  completedGoals: number;
  totalGoals: number;
  remainingGoals: number;
  completionStatus: "complete" | "partial" | "not-started" | "no-goals";
  safetyStatus: "safe" | "unsafe" | "no-data";
  unsafeFrames: number;
  eventCounts: { contact: number; staleObservation: number; clearance: number };
  criticalEvents: number;
  warningEvents: number;
  minClearance: number | null;
  maxObservationAgeMs: number | null;
};

/** A copied, canonical sample order; callers' recording arrays stay untouched. */
export function chronologicalFrames(frames: ReplayFrame[]): ReplayFrame[] {
  if (new Set(frames.map(frame => frame.index)).size !== frames.length) {
    throw new Error("Frame indices must be unique within a policy for unambiguous evidence ordering.");
  }
  return [...frames].sort((a, b) => a.time - b.time || a.index - b.index);
}

// Neumaier compensated summation avoids losing small rewards to large costs.
// Canonical frame order also keeps aggregation independent of input array order.
export function cumulativeRewards(frames: ReplayFrame[]): { time: number; totalReward: number }[] {
  let sum = 0;
  let correction = 0;
  return chronologicalFrames(frames).map(frame => {
    const next = sum + frame.reward;
    correction += Math.abs(sum) >= Math.abs(frame.reward)
      ? (sum - next) + frame.reward
      : (frame.reward - next) + sum;
    sum = next;
    return { time: frame.time, totalReward: sum + correction };
  });
}

export function analyzeRun(run: PolicyRun): RunAnalysis {
  const frames = chronologicalFrames(run.frames);
  const events = frames.flatMap(eventForFrame).sort((a, b) =>
    a.time - b.time || a.frameIndex - b.frameIndex || EVENT_PRIORITY[a.type] - EVENT_PRIORITY[b.type]);
  const rewards = cumulativeRewards(frames);
  const totalReward = rewards.at(-1)?.totalReward ?? 0;
  const completion = run.totalGoals > 0 ? run.completedGoals / run.totalGoals : 0;
  const contacts = frames.filter((frame) => frame.contact).length;
  const duration = frames.length > 0 ? frames[frames.length - 1].time - frames[0].time : 0;
  const completionStatus = run.totalGoals === 0 ? "no-goals"
    : run.completedGoals >= run.totalGoals ? "complete"
      : run.completedGoals > 0 ? "partial" : "not-started";
  const safetyStatus = !frames.length ? "no-data" : events.length ? "unsafe" : "safe";
  const eventCounts = {
    contact: contacts,
    staleObservation: events.filter(event => event.type === "stale-observation").length,
    clearance: events.filter(event => event.type === "clearance").length,
  };

  return {
    events,
    firstUnsafe: events[0] ?? null,
    totalReward,
    completion,
    contacts,
    success: completionStatus === "complete" && safetyStatus === "safe",
    duration,
    frameCount: frames.length,
    completedGoals: run.completedGoals,
    totalGoals: run.totalGoals,
    remainingGoals: Math.max(0, run.totalGoals - run.completedGoals),
    completionStatus,
    safetyStatus,
    unsafeFrames: new Set(events.map(event => event.frameIndex)).size,
    eventCounts,
    criticalEvents: events.filter(event => event.severity === "critical").length,
    warningEvents: events.filter(event => event.severity === "warning").length,
    minClearance: frames.length ? frames.reduce((min, frame) => Math.min(min, frame.clearance), Infinity) : null,
    maxObservationAgeMs: frames.length ? frames.reduce((max, frame) => Math.max(max, getDecisionEvidence(frame).observationAgeMs), 0) : null,
  };
}

export type RunComparison = {
  run: PolicyRun;
  summary: RunAnalysis;
  rank: number;
};

export function compareRuns(policyRuns: PolicyRun[]): RunComparison[] {
  if (new Set(policyRuns.map(run => run.id)).size !== policyRuns.length) {
    throw new Error("Policy IDs must be unique for deterministic comparison and reporting.");
  }
  const compared = policyRuns.map((run) => ({ run, summary: analyzeRun(run) }));
  compared.sort((a, b) => {
    if (b.summary.totalReward !== a.summary.totalReward) {
      return b.summary.totalReward - a.summary.totalReward;
    }
    return compareIds(a.run, b.run);
  });

  let rank = 0;
  return compared.map((entry, index) => {
    if (index === 0 || entry.summary.totalReward !== compared[index - 1].summary.totalReward) {
      rank = index + 1;
    }
    return { ...entry, rank };
  });
}

export function formatTime(seconds: number): string {
  const tenths = Number.isFinite(seconds) ? Math.round(Math.max(0, seconds) * 10) : 0;
  const minutes = Math.floor(tenths / 600);
  const remainder = tenths % 600;
  return `${String(minutes).padStart(2, "0")}:${(remainder / 10).toFixed(1).padStart(4, "0")}`;
}

export function createReport(policyRuns: PolicyRun[]): string {
  const canonicalRuns = [...policyRuns].sort(compareIds);
  for (const run of canonicalRuns) {
    if (new Set(run.goals.map(goal => goal.id)).size !== run.goals.length) {
      throw new Error(`Goal IDs must be unique within policy "${run.id}" for deterministic report ordering.`);
    }
  }
  const comparisons = compareRuns(canonicalRuns);
  const summaries = canonicalRuns.map((run) => {
    const { events, ...summary } = analyzeRun(run);
    return {
      id: run.id,
      name: run.name,
      version: run.version,
      summary,
      events,
      evidence: chronologicalFrames(run.frames)
        .filter(frame => events.some(event => event.frameIndex === frame.index))
        .map(frame => ({
          frameIndex: frame.index,
          time: frame.time,
          decision: getDecisionEvidence(frame),
          events: events.filter(event => event.frameIndex === frame.index),
        })),
    };
  });
  const ranking = comparisons.map(({ run, summary, rank }) => ({
    rank,
    id: run.id,
    name: run.name,
    totalReward: summary.totalReward,
    completion: summary.completion,
    success: summary.success,
    completedGoals: summary.completedGoals,
    totalGoals: summary.totalGoals,
    remainingGoals: summary.remainingGoals,
    completionStatus: summary.completionStatus,
    safetyStatus: summary.safetyStatus,
    contacts: summary.contacts,
    unsafeFrames: summary.unsafeFrames,
    eventCounts: summary.eventCounts,
  }));

  return `${JSON.stringify({
    schemaVersion: 1,
    viewerOnly: true,
    scenario: SCENARIO,
    rules: {
      movingObservationAgeLimitSeconds: 0.5,
      minimumClearanceMeters: CLEARANCE_WARNING,
      contactAlwaysUnsafe: true,
      ranking: "Descending undiscounted reward; exact ties share competition rank; id breaks display ties.",
      contactCount: "Number of contact frames, not collision episodes.",
      unsafeFrameCount: "Distinct frame indices with at least one safety violation; overlapping rules count separately in eventCounts.",
      completion: "Recorded completedGoals / totalGoals; success requires all goals, recorded frames, and no safety events.",
      rewardAggregation: "Chronological Neumaier compensated sum, full precision; display rounding does not define ties.",
      ordering: {
        policies: "ID ascending (locale-independent); unique IDs required.",
        frames: "Simulation time ascending, then frame index ascending; duplicate frame indices are rejected within each policy.",
        goals: "Goal ID ascending (locale-independent); duplicate goal IDs are rejected within each policy.",
        events: "Frame time, frame index, then contact, stale-observation, clearance.",
      },
      evidence: "Observation timestamp is linked to the decision; clearance and contact are action-frame readings, not historical sensor payloads. Co-occurrence does not prove causation.",
    },
    summaries,
    ranking,
    traces: canonicalRuns.map(({ id, version, completedGoals, totalGoals, goals, frames }) => ({
      id, version, completedGoals, totalGoals,
      goals: [...goals].sort(compareIds)
        .map(({ id, x, y }) => ({ id, x, y })),
      frames: chronologicalFrames(frames).map(frame => ({
        index: frame.index,
        time: frame.time,
        x: frame.x,
        y: frame.y,
        heading: frame.heading,
        speed: frame.speed,
        steering: frame.steering,
        observationTime: frame.observationTime,
        clearance: frame.clearance,
        contact: frame.contact,
        reward: frame.reward,
        goalReached: frame.goalReached,
      })),
    })),
  }, null, 2)}\n`;
}
