import test from 'node:test';
import assert from 'node:assert/strict';
import { requests, SNAPSHOT_DATE } from '../src/data.js';
import { analyzeRequests, summarize } from '../src/finance.js';
import { createView, toggleFilter } from '../src/view.js';

const analyzed = analyzeRequests(requests, SNAPSHOT_DATE);
const ids = (view) => view.rows.map((request) => request.id).sort();

test('untracked and policy combine with AND semantics and scope every count and total', () => {
  const view = createView(analyzed, { filters: ['untracked', 'policy'] });

  assert.deepEqual(ids(view), ['REQ-2026-008', 'REQ-2026-010']);
  assert.deepEqual(view.counts, { all: 2, attention: 2, untracked: 2, overdue: 1, policy: 2 });
  assert.deepEqual(view.summary, {
    budgetCents: 250000000,
    spentCents: 108420000,
    committedCents: 7300000,
    projectedCents: 115720000,
    remainingCents: 134280000,
    untrackedCents: 7300000,
    untrackedCount: 2,
    overdueCount: 1,
    policyCount: 2,
    activeCount: 2,
    duplicateCount: 0,
  });
});

test('untracked and overdue show only the tree canopy request', () => {
  const view = createView(analyzed, { filters: ['untracked', 'overdue'] });

  assert.deepEqual(ids(view), ['REQ-2026-008']);
  assert.deepEqual(view.counts, { all: 1, attention: 1, untracked: 1, overdue: 1, policy: 1 });
  assert.equal(view.summary.committedCents, 4500000);
  assert.equal(view.summary.projectedCents, 112920000);
  assert.equal(view.summary.remainingCents, 137080000);
  assert.equal(view.summary.untrackedCents, 4500000);
  assert.equal(view.summary.untrackedCount, 1);
  assert.equal(view.summary.activeCount, 1);
});

test('all four flag toggles can combine and attention can be toggled independently', () => {
  let filters = [];
  for (const filter of ['untracked', 'overdue', 'policy', 'attention']) {
    filters = toggleFilter(filters, filter);
  }
  assert.deepEqual(ids(createView(analyzed, { filters })), ['REQ-2026-008']);
  filters = toggleFilter(filters, 'attention');
  assert.deepEqual(filters, ['untracked', 'overdue', 'policy']);
  assert.deepEqual(ids(createView(analyzed, { filters })), ['REQ-2026-008']);
  assert.deepEqual(ids(createView(analyzed, { filters: ['attention'] })), [
    'REQ-2026-002', 'REQ-2026-008', 'REQ-2026-009', 'REQ-2026-010',
  ]);
});

test('search and policy scope the same rows, facets, and summary across searchable fields', () => {
  for (const query of ['  RIVERSTONE  ', 'Water Utility', 'drinking-water', 'REQ-2026-010']) {
    const view = createView(analyzed, { filters: ['policy'], query });
    assert.deepEqual(ids(view), ['REQ-2026-010']);
    assert.deepEqual(view.counts, { all: 1, attention: 1, untracked: 1, overdue: 0, policy: 1 });
    assert.equal(view.summary.committedCents, 2800000);
    assert.equal(view.summary.projectedCents, 111220000);
    assert.equal(view.summary.remainingCents, 138780000);
    assert.equal(view.summary.untrackedCents, 2800000);
    assert.equal(view.summary.untrackedCount, 1);
    assert.equal(view.summary.overdueCount, 0);
    assert.equal(view.summary.policyCount, 1);
    assert.equal(view.summary.activeCount, 1);
  }
});

test('All clears every flag toggle, preserves search, and restores the snapshot when search is cleared', () => {
  const selected = ['untracked', 'overdue', 'policy', 'attention'];
  const filters = toggleFilter(selected, 'all');
  assert.deepEqual(filters, []);
  assert.deepEqual(selected, ['untracked', 'overdue', 'policy', 'attention']);

  const searched = createView(analyzed, { filters, query: 'Riverstone' });
  assert.deepEqual(ids(searched), ['REQ-2026-006', 'REQ-2026-010', 'REQ-2026-015']);
  assert.deepEqual(searched.counts, { all: 3, attention: 1, untracked: 1, overdue: 0, policy: 1 });
  assert.equal(searched.summary.committedCents, 12300000);

  const all = createView(analyzed, { filters, query: '' });
  assert.equal(all.rows.length, 15);
  assert.deepEqual(all.counts, { all: 15, attention: 4, untracked: 3, overdue: 1, policy: 3 });
  assert.deepEqual(all.summary, summarize(requests, SNAPSHOT_DATE));
});

test('policy filtering keeps global duplicate ownership even when the original is hidden', () => {
  const policy = createView(analyzed, { filters: ['policy'] });
  assert.deepEqual(ids(policy), ['REQ-2026-002', 'REQ-2026-008', 'REQ-2026-010']);
  assert.equal(policy.summary.committedCents, 7300000);
  assert.equal(policy.summary.duplicateCount, 1);
  assert.equal(policy.summary.policyCount, 3);

  const duplicate = createView(analyzed, { filters: ['policy'], query: 'lighting change order' });
  assert.deepEqual(ids(duplicate), ['REQ-2026-002']);
  assert.equal(duplicate.rows[0].isDuplicate, true);
  assert.equal(duplicate.rows[0].includedInProjection, false);
  assert.equal(duplicate.summary.committedCents, 0);
  assert.equal(duplicate.summary.projectedCents, 108420000);
  assert.equal(duplicate.summary.remainingCents, 141580000);
  assert.equal(duplicate.summary.policyCount, 1);
  assert.equal(duplicate.summary.activeCount, 1);
});

test('empty views zero scoped metrics while keeping historical spent and budget fixed', () => {
  const view = createView(analyzed, { filters: ['policy', 'overdue'], query: 'no matching record' });

  assert.deepEqual(view.rows, []);
  assert.deepEqual(view.counts, { all: 0, attention: 0, untracked: 0, overdue: 0, policy: 0 });
  assert.deepEqual(view.summary, {
    budgetCents: 250000000,
    spentCents: 108420000,
    committedCents: 0,
    projectedCents: 108420000,
    remainingCents: 141580000,
    untrackedCents: 0,
    untrackedCount: 0,
    overdueCount: 0,
    policyCount: 0,
    activeCount: 0,
    duplicateCount: 0,
  });
});

test('a cancelled search result is visible but contributes no active status or spend', () => {
  const view = createView(analyzed, { query: 'REQ-2026-011' });
  assert.deepEqual(ids(view), ['REQ-2026-011']);
  assert.deepEqual(view.counts, { all: 1, attention: 0, untracked: 0, overdue: 0, policy: 0 });
  assert.equal(view.summary.activeCount, 0);
  assert.equal(view.summary.committedCents, 0);
  assert.equal(view.summary.projectedCents, 108420000);
});

test('view creation and toggle removal leave inputs unchanged; sorting preserves totals', () => {
  const before = structuredClone(analyzed);
  const options = { filters: ['untracked', 'policy'], query: '' };
  assert.deepEqual(toggleFilter(options.filters, 'policy'), ['untracked']);
  const ascending = createView(analyzed, options);
  const descending = createView(analyzed, { ...options, sortAscending: false });

  assert.deepEqual(descending.rows, [...ascending.rows].reverse());
  assert.deepEqual(descending.summary, ascending.summary);
  assert.deepEqual(descending.counts, ascending.counts);
  assert.deepEqual(analyzed, before);
  assert.deepEqual(options, { filters: ['untracked', 'policy'], query: '' });
});
