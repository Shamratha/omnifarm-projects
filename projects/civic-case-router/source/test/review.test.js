import test from 'node:test';
import assert from 'node:assert/strict';
import { syntheticCases } from '../src/data.js';
import { evaluateAll, evaluateCase } from '../src/engine.js';

const intake = (changes = {}) => ({
  ...structuredClone(syntheticCases[2]),
  categoryHint: null,
  summary: '',
  fields: [],
  documents: [],
  ...changes,
});

test('ambiguous service evidence reaches assisted intake without losing an urgent deadline', () => {
  const result = evaluateCase(intake({ subject: 'Housing and benefits', deadline: '2026-10-14T20:00:00Z' }));
  assert.equal(result.classification.source, 'manual-review');
  assert.equal(result.classification.category, 'general');
  assert.equal(result.route.teamId, 'team-general');
  assert.equal(result.priority.level, 'urgent');
  assert.equal(result.route.needsReview, true);
  assert.match(result.route.flags.join(' '), /classification review/);
});

test('unknown requests and conflicting category hints require explicit human confirmation', () => {
  for (const input of [
    intake({ subject: 'Unrecognized fictional request' }),
    intake({ subject: 'Food assistance benefits', categoryHint: 'housing' }),
    intake({ subject: 'Housing', categoryHint: 'unsupported-service' }),
  ]) {
    const result = evaluateCase(input);
    assert.equal(result.classification.source, 'manual-review');
    assert.equal(result.route.needsReview, true);
    assert.ok(result.audit.some((event) => event.action === 'Escalate / review'));
  }
});

test('invalid submitted deadlines are flagged, not silently replaced with a policy deadline', () => {
  const result = evaluateCase(intake({ subject: 'Pothole', deadline: 'invalid-date' }));
  assert.equal(result.hoursRemaining, null);
  assert.equal(result.dueLabel, 'Deadline needs review');
  assert.equal(result.route.needsReview, true);
  assert.ok(result.flags.some((flag) => flag.type === 'deadline'));
});

test('a missing team configuration leaves the accepted intake explicitly unassigned', () => {
  const result = evaluateCase(intake({ subject: 'Pothole' }), { teams: [] });
  assert.equal(result.route.teamId, null);
  assert.equal(result.route.teamName, 'Manual assignment');
  assert.equal(result.route.needsReview, true);
  assert.match(result.route.reason, /Intake is accepted/);
});

test('the complete fixture batch covers all six policies and explains each routing stage', () => {
  const expected = { 'CF-0142': 'housing', 'CF-0143': 'benefits', 'CF-0144': 'public-works', 'CF-0145': 'health', 'CF-0146': 'permits', 'CF-0147': 'general' };
  const results = evaluateAll(syntheticCases);
  assert.equal(results.length, 6);
  for (const result of results) {
    assert.equal(result.classification.category, expected[result.id]);
    assert.equal(result.route.teamId, result.policy.teamId);
    assert.deepEqual(result.audit.slice(0, 5).map((event) => event.action), ['Classification', 'Deadline & priority', 'Documents', 'Route', 'Redact']);
    assert.match(result.audit.find((event) => event.action === 'Redact').reason, /routing metadata is retained/);
    assert.ok(result.redacted.documents.every((document) => document.content === 'xxxxxxxx'));
  }
});
