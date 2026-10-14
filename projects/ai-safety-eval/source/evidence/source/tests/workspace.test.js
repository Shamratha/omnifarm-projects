import test from 'node:test';
import assert from 'node:assert/strict';
import { dataset } from '../src/fixtures.js';
import { compareRuns, buildScorecard, summarize } from '../src/evaluation.js';
import { loadWorkspace, saveReview, filterRows, scorecardCsv } from '../src/workspace.js';

const storage = () => {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
};

test('annotations survive a workspace reload without mutating bundled fixtures or scores', () => {
  const store = storage();
  const { data } = loadWorkspace(dataset, store);
  const record = data.records.find((item) => item.runId === 'run-1-3' && item.annotation === null);
  const score = summarize(data, 'run-1-3').score;
  assert.deepEqual(saveReview(data, record.id, { reviewer: 'Ada', note: 'Checked evidence.' }, store, '2026-10-14T12:00:00.000Z'), { persisted: true });
  const restored = loadWorkspace(dataset, store).data;
  assert.equal(restored.records.find((item) => item.id === record.id).annotation.note, 'Checked evidence.');
  assert.equal(summarize(restored, 'run-1-3').reviewed, 23);
  assert.equal(summarize(restored, 'run-1-3').score, score);
  assert.equal(dataset.records.find((item) => item.id === record.id).annotation, null);
});

test('blocked or corrupted storage degrades to a working session', () => {
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); } };
  const { data, error } = loadWorkspace(dataset, broken);
  assert.ok(error);
  const record = data.records[0];
  assert.equal(saveReview(data, record.id, { note: 'Session note' }, broken, '2026-10-14T12:00:00.000Z').persisted, false);
  assert.equal(record.annotation.note, 'Session note');
  assert.ok(loadWorkspace(dataset, { getItem: () => '{broken' }).error);
});

test('combined search and failure / regression / review filters use selected candidate', () => {
  const rows = compareRuns(dataset, 'run-1-2', 'run-1-3');
  assert.equal(filterRows(rows, { outcome: 'failures' }).length, 3);
  assert.equal(filterRows(rows, { outcome: 'nonpassing' }).length, 4);
  assert.equal(filterRows(rows, { outcome: 'regressions' }).length, 2);
  assert.equal(filterRows(rows, { outcome: 'review' }).length, 2);
  const filtered = filterRows(rows, { query: 'UNKNOWN', category: 'truthfulness', severity: 'high', outcome: 'regressions' });
  assert.deepEqual(filtered.map((row) => row.prompt.id), ['truthfulness-01']);
  assert.equal(filterRows(rows, { query: 'no such case' }).length, 0);
});

test('severity filtering is exact, composable, and independent of the score denominator', () => {
  const rows = compareRuns(dataset, 'run-1-2', 'run-1-3');
  for (const severity of ['critical', 'high', 'medium', 'low']) {
    const expected = dataset.prompts.filter((prompt) => prompt.severity === severity).map((prompt) => prompt.id);
    assert.deepEqual(filterRows(rows, { severity }).map((row) => row.prompt.id), expected);
  }
  assert.equal(filterRows(rows, { category: 'fairness', severity: 'high', outcome: 'failures' }).length, 0);
  assert.equal(filterRows(rows, { category: 'fairness', severity: 'high', outcome: 'rejected-abstentions' }).length, 1);
  assert.equal(filterRows(rows, { severity: 'critical', outcome: 'regressions' }).length, 0);
  assert.equal(filterRows(rows, { severity: 'all' }).length, 24);
  assert.equal(summarize(dataset, 'run-1-3').weightedTotal, 61);
});

test('ordinary results and abstention filters are disjoint and cover every present response', () => {
  const rows = compareRuns(dataset, 'run-1-2', 'run-1-3');
  const ids = (outcome) => filterRows(rows, { outcome }).map((row) => row.prompt.id);
  assert.deepEqual(ids('failures'), ['harmful-01', 'truthfulness-01', 'autonomy-01']);
  assert.deepEqual(ids('accepted-abstentions'), ['privacy-03', 'truthfulness-03']);
  assert.deepEqual(ids('rejected-abstentions'), ['fairness-02']);
  assert.equal(ids('abstentions').length, 3);
  assert.equal(ids('passes').length, 18);
  assert.equal(ids('credited').length, 20);
  assert.equal(new Set([...ids('failures'), ...ids('passes'), ...ids('abstentions')]).size, 24);
  const copy = structuredClone(dataset);
  copy.records = copy.records.filter((record) => !(record.runId === 'run-1-3' && record.promptId === 'fairness-02'));
  const incomplete = compareRuns(copy, 'run-1-2', 'run-1-3');
  assert.equal(filterRows(incomplete, { outcome: 'abstentions' }).length, 2);
  assert.equal(filterRows(incomplete, { outcome: 'missing' }).length, 1);
  assert.equal(filterRows(incomplete, { outcome: 'nonpassing' }).length, 3);
  assert.equal(filterRows(incomplete, { outcome: 'missing' })[0].change, 'incomparable');
});

test('CSV contains every case, quotes multiline content, and neutralizes formulas', () => {
  const copy = structuredClone(dataset);
  copy.records.find((item) => item.runId === 'run-1-3').annotation.note = '=HYPERLINK("example")\nsecond line';
  const csv = scorecardCsv(buildScorecard(copy, 'run-1-2', 'run-1-3'));
  assert.ok(csv.startsWith('"prompt_id","title"'));
  assert.ok(csv.includes('"\'=HYPERLINK(""example"")\nsecond line"'));
  assert.ok(csv.includes('"autonomy-04"'));
  assert.ok(csv.includes('"baseline_result_type","candidate_result_type","candidate_credited","candidate_contribution_source","candidate_abstention_status"'));
  assert.ok(csv.includes('"pass","abstention","false","","rejected","abstain","false","0","61","0"'));
  assert.ok(csv.includes('"abstention","abstention","true","abstention","accepted","abstain","true","2","61","3.2787"'));
  assert.ok(csv.includes('"transition","accounting_changed","earned_weight_delta","pass_earned_weight_delta","abstention_earned_weight_delta"'));
  assert.ok(csv.includes('"abstention-accepted → failure","true","\'-3","0","\'-3"'));
  assert.ok(csv.includes('""label"":""Protect personal data""'));
  assert.equal(csv, scorecardCsv(buildScorecard(copy, 'run-1-2', 'run-1-3')));
});

test('credited filters use earned credit rather than abstention outcome pass/fail', () => {
  const rows = compareRuns(dataset, 'run-1-2', 'run-1-3');
  assert.equal(filterRows(rows, { outcome: 'credited' }).filter((row) => row.candidate.outcome === 'abstention').length, 2);
  assert.equal(filterRows(rows, { outcome: 'nonpassing' }).filter((row) => row.candidate.outcome === 'abstention').length, 1);
  for (const row of filterRows(rows, { outcome: 'abstentions' })) assert.equal(row.candidate.outcome, 'abstention');
});
