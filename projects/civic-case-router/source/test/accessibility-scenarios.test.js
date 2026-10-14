import test from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_NOW, syntheticCases, teams } from '../src/data.js';
import { evaluateAll, evaluateCase, getWorkloads } from '../src/engine.js';

const benefits = () => structuredClone(syntheticCases.find((item) => item.id === 'CF-0143'));

test('bundled urgent incomplete intake remains assigned, accepted, escalated, and counted in workload', () => {
  const results = evaluateAll(syntheticCases, { now: DEMO_NOW });
  const urgent = results.find((item) => item.id === 'CF-0143');
  assert.equal(urgent.priority.level, 'urgent');
  assert.equal(urgent.hoursRemaining, 18);
  assert.deepEqual(urgent.missingDocuments.map((doc) => doc.type), ['income-evidence']);
  assert.equal(urgent.caseState.intake, 'accepted');
  assert.equal(urgent.caseState.documentStatus, 'incomplete');
  assert.equal(urgent.caseState.status, 'review-required');
  assert.equal(urgent.route.teamId, 'team-benefits');
  assert.ok(urgent.escalation.triggers.some((trigger) => trigger.includes('required document')));
  assert.match(urgent.escalation.action, /duty lead/);
  assert.equal(urgent.redacted.caseState.intake, 'accepted');
  assert.ok(urgent.flags.some((flag) => flag.type === 'documents' && flag.label.includes('intake accepted')));
  const workload = getWorkloads(results).find((team) => team.id === 'team-benefits');
  assert.equal(workload.assigned, 1);
  assert.equal(workload.urgent, 1);
  assert.equal(workload.awaitingDocuments, 1);
  assert.equal(workload.active, 7);
  assert.equal(workload.available, 3);
  assert.equal(workload.overCapacity, 0);
});

test('urgent missing-document cases retain workload and supervisor flags even above capacity', () => {
  const input = benefits();
  input.documents = []; // Two documents, but one accepted case in each workload count.
  const configuredTeams = structuredClone(teams);
  const team = configuredTeams.find((entry) => entry.id === 'team-benefits');
  team.baseline = team.capacity;
  const original = structuredClone(input);
  const first = evaluateAll([input], { now: DEMO_NOW, teams: configuredTeams });
  const second = evaluateAll([input], { now: DEMO_NOW, teams: configuredTeams });
  const workload = getWorkloads(first, configuredTeams).find((entry) => entry.id === team.id);
  assert.equal(first[0].priority.level, 'urgent');
  assert.equal(first[0].caseState.intake, 'accepted');
  assert.equal(first[0].missingDocuments.length, 2);
  assert.equal(first[0].route.teamId, team.id);
  assert.ok(first[0].route.flags.some((flag) => flag.includes('supervisor review')));
  assert.equal(workload.urgent, 1);
  assert.equal(workload.awaitingDocuments, 1, 'Counts cases, not missing files');
  assert.equal(workload.overCapacity, 1);
  assert.equal(workload.available, 0);
  assert.equal(workload.utilization, 110, 'Keep real overflow; only the UI meter is clamped');
  assert.deepEqual(first, second);
  assert.deepEqual(input, original);
});

test('document follow-up does not postpone overdue, due-now, or exact-24h priority', () => {
  for (const milliseconds of [-1, 0, 24 * 3600000]) {
    const input = benefits();
    input.deadline = new Date(Date.parse(DEMO_NOW) + milliseconds).toISOString();
    const result = evaluateCase(input, { now: DEMO_NOW });
    assert.equal(result.priority.level, 'urgent');
    assert.equal(result.caseState.intake, 'accepted');
    assert.equal(result.caseState.documentStatus, 'incomplete');
    assert.equal(result.route.teamId, 'team-benefits');
    assert.equal(result.deadlineBreakdown.remainingMilliseconds, milliseconds);
  }
});
