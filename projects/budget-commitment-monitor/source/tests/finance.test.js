import test from 'node:test';
import assert from 'node:assert/strict';
import { requests, vendors, policies, SNAPSHOT_DATE } from '../src/data.js';
import {
  analyzeRequests,
  formatMoney,
  isFullyApproved,
  summarize,
  toCents,
} from '../src/finance.js';

test('the synthetic snapshot is deterministic and deduplicates commitments', () => {
  const summary = summarize(requests);

  assert.deepEqual(summary, {
    budgetCents: 250000000,
    spentCents: 108420000,
    committedCents: 80800000,
    projectedCents: 189220000,
    remainingCents: 60780000,
    untrackedCents: 10800000,
    untrackedCount: 3,
    overdueCount: 1,
    policyCount: 3,
    activeCount: 14,
    duplicateCount: 5,
  });

  assert.equal(SNAPSHOT_DATE, '2026-09-18');
  assert.deepEqual(summarize(requests), summary);
  assert.equal(analyzeRequests(requests).length, 15);
});

test('a commitment ID is counted once while requests without one remain individually untracked', () => {
  const analyzed = analyzeRequests(requests);
  const elmRequests = analyzed.filter((request) => request.commitmentId === 'COM-ELM-001');

  assert.equal(elmRequests.filter((request) => request.includedInProjection).length, 1);
  assert.equal(elmRequests.filter((request) => request.isDuplicate).length, 1);
  assert.equal(analyzed.filter((request) => request.commitmentId == null && request.status !== 'cancelled').length, 3);
});

test('split approval requires every approval stage and creates a policy flag', () => {
  const splitRequest = requests.find((request) => request.id === 'REQ-2026-002');
  const analyzed = analyzeRequests([splitRequest])[0];

  assert.equal(isFullyApproved(splitRequest), false);
  assert.equal(analyzed.flags.some((flag) => flag.type === 'policy'), true);
  assert.equal(analyzed.flags.find((flag) => flag.type === 'policy').label, 'Split approval incomplete');
  assert.equal(isFullyApproved({ approvals: [{ status: 'approved' }, { status: 'approved' }] }), true);
  assert.equal(isFullyApproved({ approvals: [{ status: 'approved' }, { status: 'pending' }] }), false);
  assert.equal(isFullyApproved({ approvals: [] }), false);
  assert.equal(isFullyApproved({}), false);

  const noExplicitException = { ...splitRequest, policyExceptions: [] };
  assert.equal(analyzeRequests([noExplicitException])[0].flags.some((flag) => flag.type === 'policy'), true);
  const completed = {
    ...noExplicitException,
    approvals: splitRequest.approvals.map((approval) => ({ ...approval, status: 'approved' })),
  };
  assert.equal(isFullyApproved(completed), true);
  assert.deepEqual(analyzeRequests([completed])[0].flags, []);
});

test('toCents performs exact decimal half-up rounding', () => {
  assert.equal(toCents('1.005'), 101);
  assert.equal(toCents(1.005), 101);
  assert.equal(toCents('2.675'), 268);
  assert.equal(toCents(2.675), 268);
  assert.equal(toCents('10.004'), 1000);
  assert.equal(toCents('-1.005'), -101);
  assert.equal(toCents('0.005'), 1);
  assert.equal(toCents('  +.005  '), 1);
  assert.equal(toCents('1.234567890123456789'), 123);
  assert.equal(toCents('123456789012.345'), 12345678901235);
  assert.equal(toCents(1e-7), 0);
  assert.equal(toCents('1.005e2'), 10050);
  assert.equal(toCents('1e-1000000'), 0);
  assert.equal(toCents('90071992547409.91'), Number.MAX_SAFE_INTEGER);
  assert.throws(() => toCents('90071992547409.92'), RangeError);
  assert.throws(() => toCents('1e1000000'), RangeError);
  for (const invalid of ['', '12 dollars', '1,000', NaN, Infinity, null, true]) {
    assert.throws(() => toCents(invalid), TypeError);
  }
});

test('cancelled requests have no flags and no financial projection', () => {
  const cancelled = analyzeRequests(requests).find((request) => request.status === 'cancelled');

  assert.deepEqual(cancelled.flags, []);
  assert.deepEqual(cancelled.overdueApprovals, []);
  assert.equal(cancelled.includedInProjection, false);
  assert.equal(summarize(requests).committedCents, 80800000);

  // Cancellation must also suppress untracked totals and must not reserve a key.
  const cancelledUntracked = { ...cancelled, commitmentId: null };
  const summary = summarize([cancelledUntracked]);
  assert.equal(summary.untrackedCents, 0);
  assert.equal(summary.untrackedCount, 0);
  assert.equal(summary.activeCount, 0);
  assert.equal(summary.overdueCount, 0);
  assert.equal(summary.policyCount, 0);
  assert.equal(summary.committedCents, 0);
  const activeCopy = { ...cancelled, status: 'pending' };
  assert.equal(analyzeRequests([cancelled, activeCopy])[1].includedInProjection, true);
});

test('money formatting is stable for regular and compact values', () => {
  assert.equal(formatMoney(250000000), '$2,500,000.00');
  assert.equal(formatMoney(250000000, { compact: true }), '$2.5M');
  assert.equal(formatMoney(123456), '$1,234.56');
  assert.equal(formatMoney(-101), '-$1.01');
  assert.equal(formatMoney(70000000, { compact: true }), '$700K');
  assert.equal(formatMoney(0), '$0.00');
});

test('overdue approvals use a strict snapshot boundary and count requests, not stages', () => {
  const request = {
    ...requests[0],
    status: 'pending',
    approvals: [
      { role: 'finance', name: 'Luis Romero', status: 'pending', dueDate: '2026-09-18' },
      { role: 'purchasing', name: 'Tessa Green', status: 'pending', dueDate: '2026-09-18' },
      { role: 'department', name: 'Maya Chen', status: 'approved', dueDate: '2026-09-01' },
    ],
  };
  assert.equal(analyzeRequests([request])[0].overdueApprovals.length, 0);
  assert.equal(analyzeRequests([request], '2026-09-19')[0].overdueApprovals.length, 2);
  assert.equal(summarize([request], '2026-09-19').overdueCount, 1);
  assert.deepEqual(analyzeRequests(requests), analyzeRequests(requests, '2026-09-18'));
});

test('missing commitments deduplicate by request ID without colliding with commitment IDs', () => {
  const first = { ...requests[0], id: 'shared-key', commitmentId: null, amountCents: 10000 };
  const repeat = { ...first, title: 'Repeated import' };
  const second = { ...first, id: 'different-request', amountCents: 20000 };
  const tracked = { ...first, id: 'tracked-request', commitmentId: 'shared-key', amountCents: 30000 };
  const summary = summarize([first, repeat, second, tracked]);
  assert.equal(summary.committedCents, 60000);
  assert.equal(summary.untrackedCents, 30000);
  assert.equal(summary.untrackedCount, 2);
  assert.equal(summary.duplicateCount, 1);
});

test('analysis enriches vendor data, handles empty input, and leaves inputs unchanged', () => {
  const before = structuredClone(requests);
  const analyzed = analyzeRequests(requests);
  summarize(requests);
  assert.deepEqual(requests, before);
  assert.equal(analyzed[0].vendor.name, 'Harbor Civic Works');
  assert.equal(analyzeRequests([{ ...requests[0], vendorId: 'unknown' }])[0].vendor, null);
  assert.deepEqual(analyzeRequests([]), []);
  assert.equal(summarize([]).projectedCents, 108420000);
  assert.equal(summarize([]).remainingCents, 141580000);
});

test('civic dataset has unique identities and valid vendor and policy references', () => {
  assert.equal(new Set(requests.map((request) => request.id)).size, requests.length);
  assert.equal(new Set(requests.map((request) => request.title)).size, requests.length);
  assert.equal(new Set(vendors.map((vendor) => vendor.id)).size, vendors.length);
  assert.equal(new Set(policies.map((policy) => policy.id)).size, policies.length);
  for (const request of requests) {
    assert.ok(vendors.some((vendor) => vendor.id === request.vendorId));
    assert.ok(Number.isSafeInteger(request.amountCents) && request.amountCents > 0);
    assert.ok(request.approvals.length > 0);
    assert.ok(request.milestones.length > 0);
    assert.ok(request.description.length > 0);
  }
  const tracked = analyzeRequests(requests).filter((request) => request.includedInProjection && request.commitmentId);
  assert.equal(tracked.reduce((total, request) => total + request.amountCents, 0), 70000000);
});

test('policy metadata defines deterministic threshold or scope and provenance values', () => {
  assert.equal(policies.length, 6);
  for (const policy of policies) {
    assert.ok(policy.code);
    assert.ok(policy.thresholdLabel);
    assert.ok(policy.rule);
    assert.ok(policy.provenanceLabel);
    assert.match(policy.provenanceLabel, /^Synthetic FY26 policy/);
    assert.ok(policy.thresholdCents == null || Number.isSafeInteger(policy.thresholdCents));
  }
  assert.equal(policies.find((policy) => policy.id === 'competitive-bids').thresholdCents, 1000000);
  assert.equal(policies.find((policy) => policy.id === 'approval-chain').thresholdCents, 1000000);
  assert.match(policies.find((policy) => policy.id === 'approval-chain').rule, /Every recorded approval stage must be complete/);
  assert.equal(policies.find((policy) => policy.id === 'vendor-verification').thresholdLabel, 'All purchase orders before release');
  assert.equal(policies.find((policy) => policy.id === 'community-benefit').thresholdLabel, 'Capital work at or above $50,000');
  assert.equal(policies.find((policy) => policy.id === 'emergency-procurement').thresholdLabel, 'Any emergency purchase');
  assert.equal(policies.find((policy) => policy.id === 'accessibility').thresholdLabel, 'All public improvements');
});

test('current policy exceptions are structured and resolve to policy provenance', () => {
  const analyzed = analyzeRequests(requests);
  const currentExceptions = analyzed.flatMap((request) => request.policyExceptions);

  for (const request of requests) {
    for (const exception of request.policyExceptions) {
      assert.equal(typeof exception, 'object');
      assert.ok(exception.reason);
      assert.ok(policies.some((policy) => policy.id === exception.policyId));
    }
  }

  assert.ok(currentExceptions.length > 0);
  for (const exception of currentExceptions) {
    assert.equal(typeof exception.policyId, 'string');
    assert.equal(typeof exception.reason, 'string');
    assert.ok(policies.some((policy) => policy.id === exception.policyId));
  }

  const explicitCases = [
    ['REQ-2026-002', 'competitive-bids', 'PROC-CB-01'],
    ['REQ-2026-010', 'emergency-procurement', 'PROC-EP-04'],
  ];
  for (const [requestId, policyId, policyCode] of explicitCases) {
    const policyFlag = analyzed.find((request) => request.id === requestId).flags.find((flag) => flag.type === 'policy');
    assert.equal(policyFlag.policyId, policyId);
    assert.equal(policyFlag.policyCode, policyCode);
    assert.match(policyFlag.provenanceLabel, /§/);
    assert.ok(policyFlag.policyRule);
    assert.ok(policyFlag.evidence);
  }

  const generated = analyzed.find((request) => request.id === 'REQ-2026-008');
  assert.equal(generated.policyExceptions.length, 1);
  assert.equal(generated.policyExceptions[0].policyId, 'approval-chain');
  assert.equal(generated.flags.find((flag) => flag.type === 'policy').policyCode, 'PROC-AP-00');

  for (const request of analyzed) {
    for (const flag of request.flags.filter((flag) => flag.type === 'policy')) {
      const policy = policies.find((item) => item.id === flag.policyId);
      assert.equal(flag.policyName, policy.name);
      assert.equal(flag.policyRule, policy.rule);
      assert.equal(flag.policyThreshold, policy.thresholdLabel);
      assert.equal(flag.provenanceLabel, policy.provenanceLabel);
      assert.equal(flag.explanation, flag.reason);
    }
  }
});

test('legacy and unknown policy exceptions use safe fallback provenance', () => {
  const source = requests[0];
  const analyzed = analyzeRequests([{
    ...source,
    id: 'legacy-policy',
    policyExceptions: ['Legacy exception text.'],
  }])[0];
  const legacyFlag = analyzed.flags.find((flag) => flag.type === 'policy');

  assert.deepEqual(analyzed.policyExceptions, [{ policyId: 'unknown-policy', reason: 'Legacy exception text.' }]);
  assert.equal(legacyFlag.policyCode, 'POLICY-UNKNOWN');
  assert.equal(legacyFlag.policyName, 'Unknown policy');
  assert.equal(legacyFlag.provenanceLabel, 'Unresolved policy metadata');

  const unknown = analyzeRequests([{
    ...source,
    id: 'unknown-policy-id',
    policyExceptions: [{ policyId: 'does-not-exist', reason: 'Needs review.' }],
  }])[0].flags.find((flag) => flag.type === 'policy');
  assert.equal(unknown.policyId, 'does-not-exist');
  assert.equal(unknown.policyCode, 'POLICY-UNKNOWN');
  assert.equal(unknown.policyThreshold, 'Scope unavailable');
});

test('generated split approvals cite approval rules at and above the finance threshold without duplicating explicit exceptions', () => {
  const source = requests.find((request) => request.id === 'REQ-2026-008');
  const atThreshold = analyzeRequests([{ ...source, amountCents: 1000000 }])[0];
  const aboveThreshold = analyzeRequests([{ ...source, amountCents: 1000001 }])[0];
  assert.equal(atThreshold.policyExceptions[0].policyId, 'approval-chain');
  assert.equal(aboveThreshold.policyExceptions[0].policyId, 'approval-chain');
  assert.doesNotMatch(atThreshold.policyExceptions[0].evidence, /exceeds/);
  assert.match(aboveThreshold.policyExceptions[0].evidence, /exceeds/);

  const explicit = analyzeRequests(requests).find((request) => request.id === 'REQ-2026-002');
  assert.equal(explicit.policyExceptions.length, 1);
  assert.equal(explicit.flags.filter((flag) => flag.type === 'policy').length, 1);

  const cancelled = analyzeRequests([{ ...source, status: 'cancelled', policyExceptions: ['Historical waiver.'] }])[0];
  assert.deepEqual(cancelled.policyExceptions, []);
  assert.deepEqual(cancelled.flags, []);
});
