const STAGE_SCALE = {
  placement: { setup: 1.85, hold: 1.0, overflow: 0.7 },
  cts: { setup: 1.35, hold: 0.9, overflow: 0.84 },
  signoff: { setup: 1, hold: 1, overflow: 1 }
};

const EVIDENCE_DOMAINS = {
  timing: new Set(['timing', 'paths', 'parasitics']),
  constraints: new Set(['constraints']),
  clock: new Set(['clock']),
  physical: new Set(['congestion', 'placement', 'netlist'])
};

const REPORTED_CONTEXT = { stage: 'signoff', corner: 'slow', mode: 'functional' };
const REQUIRED_KINDS = {
  timing: ['timing', 'paths', 'parasitics'],
  constraints: ['constraints'],
  clock: ['clock'],
  physical: ['congestion', 'placement', 'netlist']
};

function timestamp(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function reportReason(report, manifest, generatedAt) {
  const reasons = [];
  if (report.status === 'stale') reasons.push('explicit_status');
  if (report.snapshotId && report.snapshotId !== manifest.snapshotId) reasons.push('snapshot_mismatch');
  const reportTime = timestamp(report.generatedAt);
  if (generatedAt && reportTime && reportTime > generatedAt) reasons.push('generated_after_snapshot');
  if (!generatedAt) reasons.push('invalid_snapshot_timestamp');
  if (report.generatedAt && !reportTime) reasons.push('invalid_timestamp');
  if (!report.generatedAt) reasons.push('missing_timestamp');
  return reasons;
}

function domainForReport(report) {
  return Object.entries(EVIDENCE_DOMAINS).find(([, kinds]) => kinds.has(report.kind))?.[0] ?? 'other';
}

export function detectStaleReports(manifest, currentTime = new Date()) {
  const generatedAt = timestamp(manifest.generatedAt);
  const declaredStale = new Set((manifest.staleReports ?? []).map((entry) => typeof entry === 'string' ? entry : entry.name));
  const reports = (manifest.sourceReports ?? []).map((report) => {
    const reasons = reportReason(report, manifest, generatedAt);
    if (declaredStale.has(report.name)) reasons.push('manifest_stale_list');
    const dependencies = ['timing', 'paths'].includes(report.kind)
      ? ['parasitics', 'constraints', 'clock', 'placement', 'netlist']
      : report.kind === 'congestion' ? ['placement', 'netlist'] : [];
    for (const input of manifest.sourceReports ?? []) {
      if (dependencies.includes(input.kind) && timestamp(input.generatedAt) > timestamp(report.generatedAt) && timestamp(report.generatedAt)) {
        reasons.push(`newer_dependency:${input.name}`);
      }
    }
    const unknown = reasons.some((reason) => ['missing_timestamp', 'invalid_timestamp', 'invalid_snapshot_timestamp'].includes(reason));
    const stale = reasons.some((reason) => !['missing_timestamp', 'invalid_timestamp', 'invalid_snapshot_timestamp'].includes(reason));
    return { ...report, domain: domainForReport(report), stale, unknown, freshness: stale ? 'stale' : unknown ? 'unknown' : 'fresh', reasons: [...new Set(reasons)] };
  });
  const stale = reports.filter((report) => report.stale);
  const unknown = reports.filter((report) => report.unknown);
  return {
    stale,
    unknown,
    reports,
    hasStale: stale.length > 0,
    hasUnknown: unknown.length > 0,
    checkedAt: currentTime.toISOString()
  };
}

export function assessEvidence(manifest) {
  const checked = detectStaleReports(manifest);
  const domains = Object.fromEntries(Object.keys(EVIDENCE_DOMAINS).map((domain) => {
    const reports = checked.reports.filter((report) => report.domain === domain);
    const stale = reports.filter((report) => report.stale);
    const unknown = reports.filter((report) => report.unknown);
    const missingKinds = REQUIRED_KINDS[domain].filter((kind) => !reports.some((report) => report.kind === kind));
    const status = stale.length ? 'stale' : missingKinds.length || unknown.length ? 'unknown' : 'fresh';
    return [domain, {
      status,
      reports,
      stale,
      unknown,
      reasons: [...new Set([...stale, ...unknown].flatMap((report) => report.reasons).concat(missingKinds.map((kind) => `missing_report:${kind}`)))]
    }];
  }));
  const statuses = Object.values(domains).map((domain) => domain.status);
  return {
    ...domains,
    overall: statuses.includes('stale') ? 'stale' : statuses.includes('unknown') ? 'unknown' : 'fresh',
    reports: checked.reports,
    stale: checked.stale,
    unknown: checked.unknown,
    checkedAt: checked.checkedAt
  };
}

export function exceptionKind(exception) {
  if (!exception) return null;
  if (typeof exception === 'object') return exception.kind ?? null;
  if (exception === 'set_false_path') return 'false_path';
  if (String(exception).toLowerCase().includes('false_path')) return 'false_path';
  return 'unknown';
}

export function classifyPathException(path, evidence = null) {
  const exception = path.exception;
  if (!exception) return { disposition: 'timed', excluded: false, review: false, label: 'TIMED' };
  const kind = exceptionKind(exception);
  const status = typeof exception === 'object' ? exception.status ?? 'unknown' : exception === 'set_false_path' ? 'applied' : String(exception).includes('candidate') ? 'candidate' : 'unknown';
  const constraintsFresh = !evidence || evidence.constraints.status === 'fresh';
  const source = typeof exception === 'object' ? exception.sourceReport ?? 'constraints.sdc' : 'constraints.sdc';
  const clocks = [path.launchClock ?? path.clock, path.captureClock ?? path.clock];
  const scopedClocks = exception.clockGroups;
  const scoped = !scopedClocks || clocks.every((clock) => scopedClocks.includes(clock));
  if (!scoped) return { disposition: 'exception_unverified', excluded: false, review: true, label: 'EXCEPTION · SCOPE MISMATCH', kind, status, source };
  if (status === 'applied' && constraintsFresh && kind === 'false_path') {
    return { disposition: 'false_path_excluded', excluded: true, review: false, label: 'FALSE PATH · EXCLUDED', kind, status, source };
  }
  if (status === 'applied' && constraintsFresh && kind === 'clock_group') {
    return { disposition: 'clock_group_excluded', excluded: true, review: false, label: 'CLOCK GROUP · EXCLUDED', kind, status, source };
  }
  if (status === 'applied' && constraintsFresh && kind === 'multicycle' && Number.isInteger(exception.cycles) && exception.cycles >= 1) {
    // Reported required/slack already incorporate the SDC requirement. Do not
    // add another period here or silently turn a multicycle check into an exclusion.
    return { disposition: 'multicycle_timed', excluded: false, review: false, label: `MULTICYCLE ×${exception.cycles} · TIMED`, kind, status, source };
  }
  if (status === 'candidate') {
    return { disposition: 'exception_review', excluded: false, review: true, label: 'EXCEPTION · REVIEW', kind, status, source };
  }
  return { disposition: 'exception_unverified', excluded: false, review: true, label: 'EXCEPTION · UNVERIFIED', kind, status, source };
}

function normalizePath(path) {
  const launchClock = path.launchClock ?? path.clock ?? 'unknown';
  const captureClock = path.captureClock ?? path.clock ?? launchClock;
  return {
    ...path,
    launchClock,
    captureClock,
    clock: path.clock ?? captureClock,
    clockRelation: path.clockRelation ?? (launchClock === captureClock ? 'same' : 'related')
  };
}

function comparePathSlack(a, b) {
  const slackOrRank = a.slack - b.slack || (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER);
  if (slackOrRank) return slackOrRank;
  const left = String(a.id ?? '');
  const right = String(b.id ?? '');
  return left < right ? -1 : left > right ? 1 : 0;
}

export function pathsFor(snapshot, analysis = 'setup', stage = 'signoff', corner = 'slow', mode = 'functional') {
  const scale = STAGE_SCALE[stage] ?? STAGE_SCALE.signoff;
  const cornerScale = corner === 'fast' ? (analysis === 'hold' ? 0.62 : 0.76) : 1;
  const modeScale = mode === 'scan' ? 1.12 : 1;
  return snapshot.paths
    .filter((path) => path.analysis === analysis)
    .map((rawPath) => {
      const path = normalizePath(rawPath);
      const slack = path.slack * scale[analysis] * cornerScale * modeScale;
      return {
        ...path,
        slack: Number(slack.toFixed(3)),
        arrival: Number((path.required + (analysis === 'setup' ? -slack : slack)).toFixed(3)),
        origin: stage === REPORTED_CONTEXT.stage && corner === REPORTED_CONTEXT.corner && mode === REPORTED_CONTEXT.mode ? 'reported' : 'derived'
      };
    })
    .sort(comparePathSlack);
}

export function summarize(paths, snapshot, analysis = 'setup', stage = 'signoff', evidence = assessEvidence(snapshot.manifest)) {
  const classifications = paths.map((path) => ({ path, classification: classifyPathException(path, evidence) }));
  const eligible = classifications.filter(({ classification }) => !classification.excluded);
  const violating = eligible.filter(({ path }) => path.slack < 0);
  const timed = eligible;
  const excluded = classifications.filter(({ classification }) => classification.excluded);
  const wns = timed.length ? Math.min(...timed.map(({ path }) => path.slack)) : 0;
  const tns = violating.reduce((sum, { path }) => sum + path.slack, 0);
  const stageRecord = snapshot.stages.find((stageItem) => stageItem.id === stage);
  const timingUnverified = evidence && (evidence.timing.status !== 'fresh' || evidence.constraints.status !== 'fresh');
  return {
    wns: Number(wns.toFixed(3)),
    tns: Number(tns.toFixed(3)),
    violations: violating.length,
    endpoints: timed.length,
    totalPaths: paths.length,
    timedPaths: timed.length,
    excludedPaths: excluded.length,
    excludedFalsePaths: excluded.filter(({ classification }) => classification.disposition === 'false_path_excluded').length,
    excludedClockGroups: excluded.filter(({ classification }) => classification.disposition === 'clock_group_excluded').length,
    exceptionCandidates: classifications.filter(({ classification }) => classification.disposition === 'exception_review').length,
    unverifiedExceptions: classifications.filter(({ classification }) => classification.disposition === 'exception_unverified').length,
    multicyclePaths: classifications.filter(({ classification }) => classification.disposition === 'multicycle_timed').length,
    overflow: stageRecord?.overflow ?? 0,
    status: timingUnverified ? 'UNVERIFIED' : violating.length === 0 ? 'PASS' : 'FAIL',
    analysis,
    origin: paths.some((path) => path.origin === 'derived') ? 'derived' : 'reported'
  };
}

export function sortPaths(paths, order = 'slack') {
  return [...paths].sort((a, b) => order === 'slack' ? comparePathSlack(a, b) : b[order] - a[order] || comparePathSlack(a, b));
}

export function buildSlackHistogram(paths, binEdges = [-Infinity, -0.2, -0.1, 0, 0.1, 0.2, Infinity]) {
  const labels = ['< -0.20', '-0.20 → -0.10', '-0.10 → 0', '0 → 0.10', '0.10 → 0.20', '> 0.20'];
  return labels.map((label, index) => ({
    label,
    min: binEdges[index],
    max: binEdges[index + 1],
    count: paths.filter((path) => path.slack >= binEdges[index] && path.slack < binEdges[index + 1]).length
  }));
}

export function rankedHotspots(snapshot, layer = 'all') {
  return snapshot.congestion
    .filter((tile) => layer === 'all' || tile.layer === layer)
    .slice()
    .sort((a, b) => b.overflow - a.overflow);
}

export function findPath(snapshot, pathId) {
  return snapshot.paths.find((path) => path.id === pathId) ?? null;
}

export function findCandidate(snapshot, candidateId) {
  return snapshot.candidates.find((candidate) => candidate.id === candidateId) ?? null;
}

export function applyWhatIf(snapshot, candidateId, analysis = 'setup', stage = 'signoff', corner = 'slow', mode = 'functional') {
  const candidate = findCandidate(snapshot, candidateId);
  if (!candidate) throw new Error(`Unknown candidate: ${candidateId}`);
  const basePaths = pathsFor(snapshot, analysis, stage, corner, mode);
  const affected = new Set(candidate.affectedPathIds ?? (candidate.id === 'resize-buf' ? ['p-001', 'p-002'] : candidate.id === 'spread-net' ? ['p-001', 'p-002', 'p-006'] : candidate.id === 'clock-skew' ? ['p-001', 'p-002'] : []));
  const modeledPaths = basePaths
    .map((path) => {
      if (candidate.id === 'false-path' && affected.has(path.id)) {
        return { ...path, exception: { kind: 'false_path', status: 'applied', scope: 'path', sourceReport: 'constraints.sdc' }, modeled: true };
      }
      if (!affected.has(path.id)) return path;
      const delta = analysis === 'hold' ? candidate.model.holdWns : candidate.model.setupWns;
      return { ...path, slack: Number((path.slack + delta).toFixed(3)), arrival: Number((path.arrival + (analysis === 'setup' ? -delta : delta)).toFixed(3)), modeled: true };
    });
  const evidence = assessEvidence(snapshot.manifest);
  const summary = summarize(modeledPaths, snapshot, analysis, stage, evidence);
  return {
    candidate,
    paths: modeledPaths,
    summary: {
      ...summary,
      overflow: Number((summary.overflow + candidate.model.overflow).toFixed(1)),
      area: Number((snapshot.totals.area * (1 + candidate.model.area / 100)).toFixed(0)),
      power: Number((snapshot.totals.power * (1 + candidate.model.power / 100)).toFixed(1)),
      modeled: true,
      origin: 'modeled'
    },
    baseline: summarize(basePaths, snapshot, analysis, stage, evidence)
  };
}

export function compareMetrics(baseline, modeled) {
  return [
    { key: 'WNS', baseline: baseline.wns, candidate: modeled.wns, unit: 'ns', better: modeled.wns >= baseline.wns },
    { key: 'TNS', baseline: baseline.tns, candidate: modeled.tns, unit: 'ns', better: modeled.tns >= baseline.tns },
    { key: 'Violating endpoints', baseline: baseline.violations, candidate: modeled.violations, unit: '', better: modeled.violations <= baseline.violations },
    { key: 'Route overflow', baseline: baseline.overflow, candidate: modeled.overflow, unit: '%', better: modeled.overflow <= baseline.overflow },
    { key: 'Area', baseline: baseline.area ?? 82410, candidate: modeled.area ?? 82410, unit: 'µm²', better: (modeled.area ?? 82410) <= (baseline.area ?? 82410) },
    { key: 'Power', baseline: baseline.power ?? 118.4, candidate: modeled.power ?? 118.4, unit: 'mW', better: (modeled.power ?? 118.4) <= (baseline.power ?? 118.4) }
  ].map((metric) => ({ ...metric, delta: Number((metric.candidate - metric.baseline).toFixed(3)) }));
}

export function getPathRelatedHotspots(snapshot, path) {
  return snapshot.congestion.filter((tile) => path?.hotspotIds?.includes(tile.id));
}

export function stageRecord(snapshot, stage) {
  return snapshot.stages.find((item) => item.id === stage) ?? snapshot.stages.at(-1);
}

export function buildSignoffReport(snapshot, context = {}) {
  const selected = { ...REPORTED_CONTEXT, analysis: 'setup', ...context };
  const evidence = assessEvidence(snapshot.manifest);
  const setupPaths = pathsFor(snapshot, 'setup', selected.stage, selected.corner, selected.mode);
  const holdPaths = pathsFor(snapshot, 'hold', selected.stage, selected.corner, selected.mode);
  const setup = summarize(setupPaths, snapshot, 'setup', selected.stage, evidence);
  const hold = summarize(holdPaths, snapshot, 'hold', selected.stage, evidence);
  const selectedPaths = selected.analysis === 'hold' ? holdPaths : setupPaths;
  const exceptions = [...setupPaths, ...holdPaths]
    .map((path) => ({ path, classification: classifyPathException(path, evidence) }))
    .filter(({ path }) => path.exception)
    .map(({ path, classification }) => ({ id: path.id, analysis: path.analysis, launchClock: path.launchClock, captureClock: path.captureClock, clockRelation: path.clockRelation, exception: path.exception, ...classification }));
  const clockPairs = [...new Set([...setupPaths, ...holdPaths].map((path) => `${path.launchClock} → ${path.captureClock} (${path.clockRelation})`))];
  const evidenceEligible = evidence.overall === 'fresh' && exceptions.every((exception) => !exception.review);
  const signoffEligible = evidenceEligible && setup.status === 'PASS' && hold.status === 'PASS' && setup.endpoints > 0 && hold.endpoints > 0 && setup.origin === 'reported';
  const annotate = (path) => ({ ...path, classification: classifyPathException(path, evidence), timingFreshness: evidence.timing.status, constraintFreshness: evidence.constraints.status });
  return {
    exportedAt: new Date().toISOString(),
    manifest: snapshot.manifest,
    context: selected,
    evidence,
    evidenceEligible,
    signoffEligible,
    closureStatus: setup.status === 'UNVERIFIED' || hold.status === 'UNVERIFIED' ? 'UNVERIFIED' : setup.violations || hold.violations ? 'OPEN' : 'PASS',
    baseline: {
      setup,
      hold,
      selectedAnalysis: selected.analysis,
      worstPaths: selectedPaths.map(annotate),
      hotspots: rankedHotspots(snapshot),
      clocks: snapshot.clocks,
      clockPairs
    },
    exceptions
  };
}
