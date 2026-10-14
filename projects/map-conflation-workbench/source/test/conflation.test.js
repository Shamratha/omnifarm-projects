import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExportPackage, confidenceBand, freshness, geometryDistance, makeCandidate, normalizeName, recordDecision, restoreCandidates, scoreCandidate, syntheticCandidates, tagConflicts } from '../src/conflation.js';
import { features } from '../src/data.js';

const byId = (id) => features.find((feature) => feature.id === id);

test('duplicate roads remain separate deterministic candidates', () => {
  const candidates = syntheticCandidates(features);
  const duplicates = candidates.filter((candidate) => candidate.primaryId === 'city-way-1842' || candidate.primaryId === 'city-way-1843');
  assert.deepEqual(duplicates.map((candidate) => candidate.id), ['cand-001', 'cand-002']);
  assert.notEqual(duplicates[0].primaryId, duplicates[1].primaryId);
  assert.ok(duplicates[0].confidence >= 80);
});

test('split way produces two candidate links to the same source way', () => {
  const candidates = syntheticCandidates(features).filter((candidate) => candidate.kind === 'split');
  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates.map((candidate) => candidate.secondaryId), ['open-way-1208a', 'open-way-1208b']);
  assert.ok(candidates.every((candidate) => candidate.primaryId === 'city-way-2515'));
  assert.ok(candidates.every((candidate) => candidate.distance < 10));
});

test('renamed features normalize common street suffixes but preserve raw names', () => {
  assert.equal(normalizeName('Market Street'), normalizeName('Market St'));
  const score = scoreCandidate(byId('city-way-1901'), byId('open-way-801'));
  assert.equal(score.nameMatch, true);
  assert.equal(byId('city-way-1901').name, 'Market Street');
  assert.equal(byId('open-way-801').name, 'Market St');
});

test('renamed candidate keeps its evidence in the review package', () => {
  const renamed = syntheticCandidates(features).find((candidate) => candidate.id === 'cand-003');
  assert.equal(renamed.kind, 'renamed');
  assert.equal(renamed.nameMatch, true);
  const output = buildExportPackage([renamed], features, 'renamed-regression');
  assert.equal(output.decisions[0].primaryId, 'city-way-1901');
  assert.equal(output.decisions[0].secondaryId, 'open-way-801');
  assert.equal(output.decisions[0].freshness.label, 'Within a year');
});

test('conflicting coordinates and tags are exposed as review evidence', () => {
  const primary = byId('city-way-2110');
  const secondary = byId('open-way-929');
  const score = scoreCandidate(primary, secondary);
  assert.equal(score.distance, 23);
  assert.deepEqual(tagConflicts(primary, secondary), [{ key: 'maxspeed', primary: '35', secondary: '25' }]);
  assert.equal(score.freshness.label, 'Within a year');
  assert.equal(score.confidenceEvidence.band, confidenceBand(score.confidence));
  assert.equal(score.confidenceEvidence.distanceUnit, 'schematic units');
});

test('confidence band thresholds include exact ties', () => {
  assert.equal(confidenceBand(59), 'low');
  assert.equal(confidenceBand(60), 'medium');
  assert.equal(confidenceBand(79), 'medium');
  assert.equal(confidenceBand(80), 'high');
});

test('confidence evidence stays explicit at the high-band threshold', () => {
  const primary = {
    id: 'threshold-primary', source: 'primary', type: 'way', name: 'Threshold Road',
    tags: { name: 'Threshold Road', highway: 'residential' },
    geometry: [[0, 0], [100, 0]], updated: '2024-01-01'
  };
  // Parallel ways offset by 19 / 1.8 yield a schematic distance of 19.
  const secondary = {
    ...primary, id: 'threshold-secondary', source: 'secondary',
    geometry: [[0, 19 / 1.8], [100, 19 / 1.8]], updated: '2024-12-31'
  };
  const candidate = makeCandidate('threshold-candidate', primary, secondary);
  assert.equal(candidate.distance, 19);
  assert.equal(candidate.nameMatch, true);
  assert.deepEqual(candidate.conflicts, []);
  assert.equal(candidate.confidenceEvidence.typeMatch, true);
  assert.equal(candidate.confidenceEvidence.conflictCount, 0);
  assert.equal(candidate.confidenceEvidence.conflictPenalty, 0);
  assert.ok(Math.abs(candidate.confidenceEvidence.rawScore * 100 - 79.73333333333333) < 1e-10);
  assert.equal(candidate.confidence, 80);

  recordDecision(candidate, 'accepted', '2025-01-01T10:00:00.000Z');
  const output = JSON.parse(JSON.stringify(buildExportPackage([candidate], [primary, secondary], 'threshold-regression')));
  const decision = output.decisions[0];
  assert.equal(decision.confidence, 80);
  assert.deepEqual(decision.confidenceEvidence, candidate.confidenceEvidence);
  assert.deepEqual(decision.freshness, candidate.freshness);
  assert.deepEqual(decision.audit, candidate.audit);
  for (const computation of [candidate.audit[0].computation, decision, decision.audit[0].computation]) {
    assert.equal(computation.confidence, 80);
    assert.equal(computation.confidenceEvidence.roundedPercent, 80);
    assert.equal(computation.confidenceEvidence.band, 'high');
    assert.ok(computation.confidenceEvidence.rawScore * 100 < 80);
    assert.equal(computation.freshness.metadataValid, true);
    assert.equal(computation.freshness.primaryUpdated, '2024-01-01');
    assert.equal(computation.freshness.secondaryUpdated, '2024-12-31');
    assert.equal(computation.freshness.days, 365);
    assert.equal(computation.freshness.thresholds.staleInclusive, 365);
    assert.equal(computation.freshness.label, 'Stale source');
  }
  assert.deepEqual(candidate.audit[0].sourceEvidence, {
    primaryId: primary.id, secondaryId: secondary.id, kind: 'match',
    geometryDistance: 19, geometryDistanceUnit: 'schematic units', tagConflicts: []
  });
});

test('freshness threshold ties and stale source metadata are explicit', () => {
  const source = (updated) => ({ updated });
  const date = new Date('2024-01-01T00:00:00.000Z');
  const atDays = (days) => new Date(date.getTime() + days * 86_400_000).toISOString().slice(0, 10);
  assert.equal(freshness(source(atDays(179)), source('2024-01-01')).label, 'Recent');
  assert.equal(freshness(source(atDays(180)), source('2024-01-01')).label, 'Within a year');
  assert.equal(freshness(source(atDays(364)), source('2024-01-01')).label, 'Within a year');
  assert.equal(freshness(source(atDays(365)), source('2024-01-01')).label, 'Stale source');

  const stale = syntheticCandidates(features).find((candidate) => candidate.id === 'cand-005');
  assert.equal(stale.freshness.label, 'Stale source');
  assert.equal(stale.freshness.primaryUpdated, '2024-01-14');
  assert.equal(stale.freshness.secondaryUpdated, '2025-01-27');
  const output = buildExportPackage([stale], features, 'stale-regression');
  assert.deepEqual(output.decisions[0].freshness, stale.freshness);
});

test('review package exports decisions and append-only audit events', () => {
  const candidates = syntheticCandidates(features);
  recordDecision(candidates[0], 'accepted', '2025-01-01T10:00:00.000Z');
  recordDecision(candidates[0], 'rejected', '2025-01-01T10:01:00.000Z');
  recordDecision(candidates[1], 'deferred', '2025-01-01T10:02:00.000Z');
  const output = buildExportPackage(candidates, features, 'deterministic-test');
  assert.equal(output.format, 'conflation-review-package');
  assert.equal(output.exportedAt, 'deterministic-test');
  assert.equal(output.decisions[0].status, 'rejected');
  assert.equal(output.decisions[0].confidenceEvidence.band, confidenceBand(output.decisions[0].confidence));
  assert.equal(output.decisions[0].freshness.primaryUpdated, '2024-06-18');
  assert.deepEqual(output.decisions[0].audit, [
    {
      action: 'accepted', at: '2025-01-01T10:00:00.000Z',
      sourceEvidence: {
        primaryId: 'city-way-1842', secondaryId: 'open-way-771', kind: 'match',
        geometryDistance: candidates[0].distance, geometryDistanceUnit: 'schematic units', tagConflicts: candidates[0].conflicts
      },
      computation: { confidence: candidates[0].confidence, confidenceEvidence: candidates[0].confidenceEvidence, freshness: candidates[0].freshness }
    },
    {
      action: 'rejected', at: '2025-01-01T10:01:00.000Z',
      sourceEvidence: {
        primaryId: 'city-way-1842', secondaryId: 'open-way-771', kind: 'match',
        geometryDistance: candidates[0].distance, geometryDistanceUnit: 'schematic units', tagConflicts: candidates[0].conflicts
      },
      computation: { confidence: candidates[0].confidence, confidenceEvidence: candidates[0].confidenceEvidence, freshness: candidates[0].freshness }
    }
  ]);
  assert.equal(output.decisions[1].status, 'deferred');
});

test('accept, reject, and defer all survive candidate restoration', () => {
  const candidates = syntheticCandidates(features);
  recordDecision(candidates[0], 'accepted', '2025-01-01T10:00:00.000Z');
  recordDecision(candidates[1], 'rejected', '2025-01-01T10:01:00.000Z');
  recordDecision(candidates[2], 'deferred', '2025-01-01T10:02:00.000Z');
  const restored = restoreCandidates(syntheticCandidates(features), JSON.parse(JSON.stringify(candidates)));
  assert.deepEqual(restored.slice(0, 3).map((candidate) => candidate.status), ['accepted', 'rejected', 'deferred']);
  assert.deepEqual(restored.slice(0, 3).map((candidate) => candidate.audit.length), [1, 1, 1]);
});

test('accept, reject, and defer snapshots stay append-only through mutations, JSON restoration, and export', () => {
  const seed = structuredClone(syntheticCandidates(features).find((candidate) => candidate.id === 'cand-004'));
  const candidate = structuredClone(seed);
  const expectedAudit = [];
  const actions = ['accepted', 'rejected', 'deferred'];
  const timestamps = ['2025-01-01T10:00:00.000Z', '2025-01-01T10:01:00.000Z', '2025-01-01T10:02:00.000Z'];
  const mutateEvidence = (target, step) => {
    target.conflicts[0].secondary = `mutated-${step}`;
    target.conflicts.push({ key: `extra-${step}`, primary: 'yes', secondary: 'no' });
    target.freshness.days += 10;
    target.freshness.label = `Mutated freshness ${step}`;
    target.freshness.thresholds.staleInclusive += 1;
    target.confidence -= 1;
    target.confidenceEvidence.roundedPercent = target.confidence;
    target.confidenceEvidence.band = `mutated-${step}`;
    target.confidenceEvidence.contributions.geometry += 0.01;
    target.confidenceEvidence.rules.geometryWeight += 0.01;
  };

  for (const [index, action] of actions.entries()) {
    const previousAudit = candidate.audit;
    const previousEvents = structuredClone(expectedAudit);
    expectedAudit.push(structuredClone({
      action, at: timestamps[index],
      sourceEvidence: {
        primaryId: candidate.primaryId, secondaryId: candidate.secondaryId, kind: candidate.kind,
        geometryDistance: candidate.distance, geometryDistanceUnit: 'schematic units', tagConflicts: candidate.conflicts
      },
      computation: {
        confidence: candidate.confidence, confidenceEvidence: candidate.confidenceEvidence, freshness: candidate.freshness
      }
    }));
    recordDecision(candidate, action, timestamps[index]);
    assert.equal(candidate.status, action);
    assert.deepEqual(previousAudit, previousEvents);
    assert.deepEqual(candidate.audit, expectedAudit);
    mutateEvidence(candidate, index);
    assert.deepEqual(candidate.audit, expectedAudit);
    assert.deepEqual(previousAudit, previousEvents);
  }
  assert.deepEqual(candidate.audit.map(({ action, at }) => ({ action, at })), actions.map((action, index) => ({ action, at: timestamps[index] })));

  const saved = JSON.parse(JSON.stringify([candidate]));
  const [restored] = restoreCandidates([seed], saved);
  assert.equal(restored.status, 'deferred');
  assert.deepEqual(restored.audit, expectedAudit);
  mutateEvidence(restored, 'restored');
  assert.deepEqual(restored.audit, expectedAudit);
  assert.deepEqual(candidate.audit, expectedAudit);

  const output = buildExportPackage([restored], features, 'snapshot-regression');
  const jsonOutput = JSON.parse(JSON.stringify(output));
  assert.equal(jsonOutput.decisions[0].status, 'deferred');
  assert.deepEqual(jsonOutput.decisions[0].audit, expectedAudit);
  // Mutate the live export before serialization can hide shallow references.
  for (const event of output.decisions[0].audit) {
    event.action = 'accepted';
    event.sourceEvidence.tagConflicts[0].primary = 'export mutation';
    event.sourceEvidence.tagConflicts.push({ key: 'export', primary: 'yes', secondary: 'no' });
    event.computation.confidence = 0;
    event.computation.freshness.label = 'Export mutation';
    event.computation.freshness.thresholds.staleInclusive = 0;
    event.computation.confidenceEvidence.band = 'low';
    event.computation.confidenceEvidence.contributions.geometry = 0;
    event.computation.confidenceEvidence.rules.geometryWeight = 0;
  }
  output.decisions[0].freshness.thresholds.staleInclusive = 0;
  output.decisions[0].confidenceEvidence.contributions.geometry = 0;
  assert.deepEqual(restored.audit, expectedAudit);
  assert.deepEqual(candidate.audit, expectedAudit);
  assert.deepEqual(buildExportPackage([restored], features, 'snapshot-regression').decisions[0].audit, expectedAudit);
});

test('geometry distance is zero for identical coordinates', () => {
  assert.equal(geometryDistance([[0, 0], [10, 0]], [[0, 0], [10, 0]]), 0);
});
