import test from 'node:test';
import assert from 'node:assert/strict';
import { requests, SNAPSHOT_DATE } from '../src/data.js';
import { analyzeRequests, formatMoney } from '../src/finance.js';
import { createDrawerModel } from '../src/drawer.js';

// Analyze the entire snapshot so the drawer receives global commitment ownership.
const analyzed = analyzeRequests(requests, SNAPSHOT_DATE);
const record = (suffix) => analyzed.find((request) => request.id === `REQ-2026-${suffix}`);

test('REQ008 shows honest pending verification, partial approval, and six snapshot days overdue', () => {
  const request = record('008');
  const model = createDrawerModel(request);

  assert.equal(model.asOf, '2026-09-18');
  assert.equal(model.vendor.name, 'Oak & Iron Tree Care');
  assert.equal(model.vendor.state, 'pending');
  assert.match(model.vendor.explanation, /not verified/);
  assert.match(model.vendor.explanation, /review status are not recorded/);
  assert.equal(model.vendor.source, 'Synthetic snapshot · 2026-09-18');
  assert.equal(Object.hasOwn(model.vendor, 'verifiedAt'), false);
  assert.equal(Object.hasOwn(model.vendor, 'verificationDate'), false);
  assert.equal(model.approvals.total, 2);
  assert.equal(model.approvals.completed, 1);
  assert.equal(model.approvals.percent, 50);
  assert.equal(model.approvals.allApproved, false);
  assert.equal(model.approvals.stages[0].state, 'complete');
  assert.equal(model.approvals.stages[0].overdue, false);
  assert.equal(model.approvals.stages[0].daysOverdue, 0);
  assert.equal(model.approvals.stages[1].role, 'purchasing');
  assert.equal(model.approvals.stages[1].dueDate, '2026-09-12');
  assert.equal(model.approvals.stages[1].state, 'overdue');
  assert.equal(model.approvals.stages[1].overdue, true);
  assert.equal(model.approvals.stages[1].daysOverdue, 6);
  assert.equal(model.commitment.contributionCents, 4500000);
  assert.match(model.commitment.explanation, /included in the projection/);
});

test('REQ008 preserves milestone history, next delivery, and the existing PROC-AP-00 policy explanation', () => {
  const request = record('008');
  const model = createDrawerModel(request);
  assert.equal(model.milestones.total, 2);
  assert.equal(model.milestones.completed, 1);
  assert.equal(model.milestones.percent, 50);
  assert.deepEqual(model.milestones.rows.map((row) => row.state), ['complete', 'upcoming']);
  assert.equal(model.milestones.nextPending.label, 'Fall planting');
  assert.equal(model.milestones.nextPending.date, '2026-10-12');

  const flag = request.flags.find((item) => item.type === 'policy');
  assert.deepEqual(model.policyExceptions, [{
    code: 'PROC-AP-00',
    name: flag.policyName,
    provenance: flag.provenanceLabel,
    threshold: flag.policyThreshold,
    rule: flag.policyRule,
    reason: flag.reason,
    evidence: flag.evidence,
  }]);
  assert.match(model.policyExceptions[0].rule, /Every recorded approval stage must be complete/);
  assert.match(model.policyExceptions[0].provenance, /Synthetic FY26 policy §2\.1/);
});

test('REQ001 has verified snapshot vendor, fully completed approval chain, and its owning contribution', () => {
  const request = record('001');
  const model = createDrawerModel(request);
  assert.equal(model.vendor.state, 'verified');
  assert.match(model.vendor.explanation, /snapshot marks this vendor as verified/);
  assert.match(model.vendor.explanation, /No verification date/);
  assert.equal(model.vendor.source, `Synthetic snapshot · ${SNAPSHOT_DATE}`);
  assert.equal(model.approvals.completed, 2);
  assert.equal(model.approvals.percent, 100);
  assert.equal(model.approvals.allApproved, true);
  assert.ok(model.approvals.stages.every((stage) => !stage.overdue && stage.daysOverdue === 0));
  assert.equal(model.commitment.contributionCents, request.amountCents);
  assert.equal(formatMoney(model.commitment.contributionCents), '$180,000.00');
  assert.deepEqual(model.policyExceptions, []);
});

test('REQ002 remains a zero-contribution duplicate when opened by itself', () => {
  const duplicate = record('002');
  assert.equal(duplicate.includedInProjection, false);
  assert.equal(duplicate.isDuplicate, true);
  const model = createDrawerModel(duplicate);
  assert.equal(model.commitment.contributionCents, 0);
  assert.match(model.commitment.explanation, /shared commitment balance is counted once/);
  assert.match(model.commitment.explanation, /adds no additional commitment/);
  assert.equal(model.policyExceptions[0].code, 'PROC-CB-01');
  assert.equal(model.policyExceptions[0].reason, duplicate.flags.find((flag) => flag.type === 'policy').reason);
});

test('REQ011 suppresses active delays and exceptions while preserving completed historical items', () => {
  const request = record('011');
  const model = createDrawerModel(request);
  assert.deepEqual(model.approvals.stages.map((stage) => stage.state), ['complete', 'cancelled']);
  assert.equal(model.approvals.stages[0].status, 'approved');
  assert.equal(model.approvals.stages[0].dueDate, '2026-07-25');
  assert.equal(model.approvals.completed, 1);
  assert.equal(model.approvals.percent, 50);
  assert.equal(model.approvals.allApproved, false);
  assert.ok(model.approvals.stages.every((stage) => !stage.overdue && stage.daysOverdue === 0));
  assert.deepEqual(model.milestones.rows.map((row) => row.state), ['complete', 'cancelled']);
  assert.equal(model.milestones.rows[0].label, 'Material sample');
  assert.equal(model.milestones.rows[0].date, '2026-08-15');
  assert.equal(model.milestones.completed, 1);
  assert.equal(model.milestones.percent, 50);
  assert.equal(model.milestones.nextPending, null);
  assert.deepEqual(model.flags, []);
  assert.deepEqual(model.policyExceptions, []);
  assert.equal(model.commitment.contributionCents, 0);
  assert.match(model.commitment.explanation, /Cancelled request/);

  // Suppression remains true after the pending milestone date and with stale flags.
  const later = createDrawerModel({ ...request, flags: record('008').flags }, '2026-09-25');
  assert.equal(later.milestones.rows[1].state, 'cancelled');
  assert.equal(later.milestones.rows[1].daysOverdue, 0);
  assert.deepEqual(later.policyExceptions, []);
  assert.deepEqual(later.flags, []);
});

test('due today is not overdue; next pending is the earliest dated item without sorting input rows', () => {
  const request = {
    ...record('009'),
    approvals: [
      { role: 'finance', status: 'pending', dueDate: SNAPSHOT_DATE },
      { role: 'department', status: 'pending', dueDate: '2026-09-17' },
    ],
    milestones: [
      { label: 'Future', status: 'pending', date: '2026-10-01' },
      { label: 'Today', status: 'pending', date: SNAPSHOT_DATE },
      { label: 'History', status: 'complete', date: '2026-08-01' },
      { label: 'Late', status: 'pending', date: '2026-09-17' },
      { label: 'Undated', status: 'pending' },
      { label: 'Cancelled item', status: 'cancelled', date: '2026-08-02' },
    ],
  };
  const before = structuredClone(request);
  const model = createDrawerModel(request);
  assert.deepEqual(model.approvals.stages.map((stage) => stage.state), ['due_today', 'overdue']);
  assert.deepEqual(model.approvals.stages.map((stage) => stage.daysOverdue), [0, 1]);
  assert.deepEqual(model.approvals.stages.map((stage) => stage.overdue), [false, true]);
  assert.deepEqual(model.milestones.rows.map((row) => row.state), ['upcoming', 'due_today', 'complete', 'overdue', 'upcoming', 'cancelled']);
  assert.equal(model.milestones.rows[3].daysOverdue, 1);
  assert.equal(model.milestones.nextPending.label, 'Late');
  assert.deepEqual(request, before);

  const tomorrow = createDrawerModel(request, '2026-09-19');
  assert.equal(tomorrow.approvals.stages[0].daysOverdue, 1);
  assert.equal(tomorrow.milestones.rows[1].state, 'overdue');
  assert.equal(tomorrow.milestones.rows[1].daysOverdue, 1);
});

test('missing vendor and arrays remain usable without claiming approval or verification', () => {
  for (const request of [
    {},
    { vendor: null, approvals: null, milestones: null, flags: null },
    { vendor: { name: 'Vendor without verification metadata' }, approvals: {}, milestones: {}, flags: {} },
    { vendor: { verified: 'true' }, approvals: [], milestones: [], flags: [] },
  ]) {
    const model = createDrawerModel(request);
    assert.equal(model.vendor.state, 'unknown');
    assert.match(model.vendor.explanation, /information is unavailable/);
    assert.deepEqual(model.approvals, { total: 0, completed: 0, percent: 0, allApproved: false, stages: [] });
    assert.deepEqual(model.milestones, { total: 0, completed: 0, percent: 0, rows: [], nextPending: null });
    assert.deepEqual(model.policyExceptions, []);
    assert.deepEqual(model.flags, []);
    assert.equal(model.commitment.contributionCents, 0);
  }
  assert.equal(createDrawerModel({}).vendor.name, 'Unknown vendor');
});

test('invalid or absent dates cannot become overdue or displace the next dated milestone', () => {
  const model = createDrawerModel({
    approvals: [{ status: 'pending', dueDate: '2026-02-30' }, { status: 'pending' }],
    milestones: [
      { label: 'Invalid', status: 'pending', date: 'not-a-date' },
      { label: 'Valid', status: 'pending', date: '2026-09-20' },
      { label: 'Invalid calendar day', status: 'pending', date: '2026-02-30' },
    ],
  });
  assert.ok(model.approvals.stages.every((stage) => !stage.overdue && stage.daysOverdue === 0));
  assert.ok(model.milestones.rows.every((row) => !row.overdue));
  assert.equal(model.milestones.nextPending.label, 'Valid');

  const leapDay = createDrawerModel({ approvals: [{ status: 'pending', dueDate: '2024-02-28' }] }, '2024-03-01');
  assert.equal(leapDay.approvals.stages[0].daysOverdue, 2);
});

test('exceptions come only from analyzed flags, without inferring vendor rules or compliance', () => {
  const request = { ...record('001'), vendor: { verified: false }, policyExceptions: [{ reason: 'Raw exception' }], flags: [] };
  assert.deepEqual(createDrawerModel(request).policyExceptions, []);
  const flagged = createDrawerModel({ ...request, flags: [{ type: 'policy', policyCode: 'CUSTOM', policyName: 'Recorded rule', provenanceLabel: 'Recorded source', policyThreshold: 'Recorded scope', policyRule: 'Recorded rule text', explanation: 'Recorded explanation' }] });
  assert.deepEqual(flagged.policyExceptions, [{ code: 'CUSTOM', name: 'Recorded rule', provenance: 'Recorded source', threshold: 'Recorded scope', rule: 'Recorded rule text', reason: 'Recorded explanation', evidence: null }]);
});

test('drawer creation never mutates analyzed requests, their arrays, flags, or vendor metadata', () => {
  const input = structuredClone(analyzed);
  const before = structuredClone(input);
  function freeze(value) {
    if (!value || typeof value !== 'object') return;
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  freeze(input);
  for (const request of input) {
    const model = createDrawerModel(request);
    assert.deepEqual(createDrawerModel(request), model);
    assert.notEqual(model.vendor, request.vendor);
    assert.notEqual(model.approvals.stages, request.approvals);
    assert.notEqual(model.milestones.rows, request.milestones);
    assert.notEqual(model.flags, request.flags);
    if (model.approvals.stages.length) assert.notEqual(model.approvals.stages[0], request.approvals[0]);
    if (model.milestones.rows.length) assert.notEqual(model.milestones.rows[0], request.milestones[0]);
  }
  assert.deepEqual(input, before);
});
