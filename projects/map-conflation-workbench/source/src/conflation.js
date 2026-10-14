export const CONFIDENCE_RULES = Object.freeze({
  version: 'weighted-v1',
  geometryWeight: 0.48, nameWeight: 0.32, typeWeight: 0.20,
  distanceCutoff: 45, nameMismatchScore: 0.62, typeMismatchScore: 0.35,
  conflictPenaltyEach: 0.06, conflictPenaltyCap: 0.24,
  highInclusive: 80, mediumInclusive: 60,
  formula: 'round(100 × clamp(0.48 × geometry + 0.32 × name + 0.20 × type − penalty, 0, 1))',
  rounding: 'Nearest integer percent; half ties round up. Bands use the rounded percent.'
});

export function confidenceBand(confidence) {
  return confidence >= CONFIDENCE_RULES.highInclusive ? 'high' : confidence >= CONFIDENCE_RULES.mediumInclusive ? 'medium' : 'low';
}

export function normalizeName(name = '') {
  return name.toLowerCase().replace(/\b(street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln)\b/g, '').replace(/[^a-z0-9]/g, '');
}

export function pointDistance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function pointToSegmentDistance(point, start, end) {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return pointDistance(point, start);
  const projection = Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / lengthSquared));
  return pointDistance(point, [start[0] + projection * dx, start[1] + projection * dy]);
}

export function geometryDistance(a, b) {
  // Use the shorter way for the comparison so a split segment can still
  // match the parent way instead of being penalized for its missing half.
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  let total = 0;
  for (const point of shorter) {
    let nearest = Infinity;
    for (let index = 1; index < longer.length; index += 1) {
      nearest = Math.min(nearest, pointToSegmentDistance(point, longer[index - 1], longer[index]));
    }
    total += nearest;
  }
  return Math.round((total / shorter.length) * 1.8);
}

export function tagConflicts(primary, secondary) {
  const keys = [...new Set([...Object.keys(primary.tags), ...Object.keys(secondary.tags)])];
  return keys.filter((key) => primary.tags[key] !== undefined && secondary.tags[key] !== undefined && primary.tags[key] !== secondary.tags[key])
    .map((key) => ({ key, primary: primary.tags[key], secondary: secondary.tags[key] }));
}

export function freshness(primary, secondary) {
  const parseDate = (value) => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
    const timestamp = Date.parse(`${value}T00:00:00.000Z`);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value ? timestamp : NaN;
  };
  const primaryDate = parseDate(primary.updated);
  const secondaryDate = parseDate(secondary.updated);
  const valid = Number.isFinite(primaryDate) && Number.isFinite(secondaryDate);
  const days = valid ? Math.round(Math.abs(secondaryDate - primaryDate) / 86_400_000) : null;
  return {
    version: 'source-gap-v1',
    basis: 'Gap between feature update dates, not age relative to today; no confidence penalty.',
    formula: 'round(abs(secondaryUpdated − primaryUpdated) / 86400000) using UTC dates',
    thresholds: { recentExclusive: 180, staleInclusive: 365 },
    primaryUpdated: primary.updated ?? null, secondaryUpdated: secondary.updated ?? null,
    metadataValid: valid,
    newerSource: !valid || primaryDate === secondaryDate ? null : primaryDate > secondaryDate ? 'primary' : 'secondary',
    days,
    label: !valid ? 'Unknown freshness' : days < 180 ? 'Recent' : days < 365 ? 'Within a year' : 'Stale source'
  };
}

export function scoreCandidate(primary, secondary) {
  const distance = geometryDistance(primary.geometry, secondary.geometry);
  const nameMatch = normalizeName(primary.name) === normalizeName(secondary.name);
  const conflicts = tagConflicts(primary, secondary);
  const rules = CONFIDENCE_RULES;
  const distanceScore = Math.max(0, 1 - distance / rules.distanceCutoff);
  const nameScore = nameMatch ? 1 : rules.nameMismatchScore;
  const typeMatch = primary.tags.highway === secondary.tags.highway;
  const typeScore = typeMatch ? 1 : rules.typeMismatchScore;
  const conflictPenalty = Math.min(conflicts.length * rules.conflictPenaltyEach, rules.conflictPenaltyCap);
  const contributions = {
    geometry: distanceScore * rules.geometryWeight,
    name: nameScore * rules.nameWeight,
    type: typeScore * rules.typeWeight
  };
  const rawScore = contributions.geometry + contributions.name + contributions.type - conflictPenalty;
  const clampedScore = Math.max(0, Math.min(1, rawScore));
  const confidence = Math.round(clampedScore * 100);
  const confidenceEvidence = {
    rules, distance, distanceUnit: 'schematic units',
    geometryMethod: 'Mean nearest-segment distance from the way with fewer vertices × 1.8, rounded; vertex-count ties use primary.',
    distanceScore, normalizedPrimaryName: normalizeName(primary.name), normalizedSecondaryName: normalizeName(secondary.name),
    nameMatch, nameScore, primaryHighway: primary.tags.highway ?? null, secondaryHighway: secondary.tags.highway ?? null,
    typeMatch, typeScore, conflictCount: conflicts.length, conflictPenalty,
    contributions, rawScore, clampedScore, roundedPercent: confidence, band: confidenceBand(confidence)
  };
  return { distance, nameMatch, conflicts, confidence, confidenceEvidence, freshness: freshness(primary, secondary) };
}

export function makeCandidate(id, primary, secondary, kind = 'match') {
  const score = scoreCandidate(primary, secondary);
  return { id, primaryId: primary.id, secondaryId: secondary.id, kind, status: 'pending', ...score, audit: [] };
}

export function recordDecision(candidate, action, at = new Date().toISOString()) {
  if (!['accepted', 'rejected', 'deferred'].includes(action)) throw new Error(`Unsupported decision: ${action}`);
  candidate.status = action;
  candidate.audit = [...candidate.audit, {
    action,
    at,
    sourceEvidence: structuredClone({
      primaryId: candidate.primaryId,
      secondaryId: candidate.secondaryId,
      kind: candidate.kind,
      geometryDistance: candidate.distance,
      geometryDistanceUnit: 'schematic units',
      tagConflicts: candidate.conflicts
    }),
    computation: structuredClone({
      confidence: candidate.confidence,
      confidenceEvidence: candidate.confidenceEvidence,
      freshness: candidate.freshness
    })
  }];
  return candidate;
}

export function restoreCandidates(seed, saved) {
  if (!Array.isArray(saved)) return seed;
  const savedById = new Map(saved.map((candidate) => [candidate.id, candidate]));
  return seed.map((candidate) => {
    const stored = savedById.get(candidate.id);
    if (!stored) return candidate;
    const status = ['pending', 'accepted', 'rejected', 'deferred'].includes(stored.status) ? stored.status : candidate.status;
    const audit = Array.isArray(stored.audit)
      ? stored.audit.filter((event) => ['accepted', 'rejected', 'deferred'].includes(event?.action) && typeof event?.at === 'string')
      : candidate.audit;
    return { ...candidate, status, audit };
  });
}

export function syntheticCandidates(allFeatures) {
  const primary = allFeatures.filter((feature) => feature.source === 'primary');
  const secondary = allFeatures.filter((feature) => feature.source === 'secondary');
  const pairs = [
    ['cand-001', 'city-way-1842', 'open-way-771', 'match'],
    ['cand-002', 'city-way-1843', 'open-way-772', 'conflict'],
    ['cand-003', 'city-way-1901', 'open-way-801', 'renamed'],
    ['cand-004', 'city-way-2110', 'open-way-929', 'coordinate'],
    ['cand-005', 'city-way-2204', 'open-way-977', 'conflict'],
    ['cand-006', 'city-way-2320', 'open-way-1001', 'coordinate'],
    ['cand-007', 'city-way-2410', 'open-way-1092', 'conflict'],
    ['cand-008', 'city-way-2515', 'open-way-1208a', 'split'],
    ['cand-009', 'city-way-2515', 'open-way-1208b', 'split']
  ];
  return pairs.map(([id, primaryId, secondaryId, kind]) => makeCandidate(id, primary.find((f) => f.id === primaryId), secondary.find((f) => f.id === secondaryId), kind));
}

export function statusLabel(status) {
  return { pending: 'Needs review', accepted: 'Accepted', rejected: 'Rejected', deferred: 'Deferred' }[status] ?? status;
}

export function buildExportPackage(candidates, features, exportedAt = 'offline-session') {
  const byId = new Map(features.map((feature) => [feature.id, feature]));
  return {
    format: 'conflation-review-package', version: 2, exportedAt,
    sourceExtracts: { primary: 'City streets · 2024', secondary: 'Open map · 2025' },
    decisions: candidates.map(({ id, primaryId, secondaryId, status, kind, confidence, confidenceEvidence, distance, freshness, audit }) => ({
      candidateId: id, primaryId, secondaryId, kind, status, confidence, confidenceEvidence, freshness,
      geometryDistance: distance, geometryDistanceUnit: 'schematic units',
      primary: byId.get(primaryId)?.name, secondary: byId.get(secondaryId)?.name,
      audit: audit.map((event) => ({ ...structuredClone(event), computation: event.computation ? structuredClone(event.computation) : null }))
    }))
  };
}

export const kindMeta = {
  match: { label: 'Strong match', tone: 'teal' },
  conflict: { label: 'Tag conflict', tone: 'orange' },
  renamed: { label: 'Renamed', tone: 'purple' },
  coordinate: { label: 'Coordinate drift', tone: 'blue' },
  split: { label: 'Split way', tone: 'yellow' }
};
