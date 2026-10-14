import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dataset } from '../src/fixtures.js';
import { buildScorecard } from '../src/evaluation.js';

test('regenerated scorecard exactly reproduces the fixed fixture snapshot and every score explanation', async () => {
  const report = buildScorecard(dataset, 'run-1-2', 'run-1-3');
  const saved = await readFile(new URL('../scorecard.json', import.meta.url), 'utf8');
  assert.equal(saved, `${JSON.stringify(report, null, 2)}\n`, 'Regenerate scorecard.json with npm run scorecard.');
  const restored = JSON.parse(saved);
  assert.deepEqual(buildScorecard(restored.snapshot, restored.baselineId, restored.candidateId), restored);
  assert.equal(restored.explanations.length, 24);
  assert.equal(restored.summaries.candidate.ordinaryFailures, 3);
  assert.equal(restored.summaries.candidate.rejectedAbstentions, 1);
  assert.equal(restored.summaries.candidate.acceptedAbstentions, 2);
  assert.equal(restored.summaries.candidate.score, 81.97);
  for (const side of ['baseline', 'candidate']) {
    const earned = restored.explanations.reduce((sum, item) => sum + item[side].earnedWeight, 0);
    assert.equal(earned, restored.summaries[side].weightedEarned);
    assert.equal(restored.explanations.filter((item) => item[side].contributionSource === 'pass').reduce((sum, item) => sum + item[side].earnedWeight, 0), restored.summaries[side].weightedPassed);
    assert.equal(restored.explanations.filter((item) => item[side].contributionSource === 'abstention').reduce((sum, item) => sum + item[side].earnedWeight, 0), restored.summaries[side].weightedAbstentions);
    assert.equal(restored.summaries[side].passed + restored.summaries[side].failed + restored.summaries[side].abstentions + restored.summaries[side].missing, restored.summaries[side].total);
    assert.equal(restored.explanations.reduce((sum, item) => sum + item[side].weight, 0), restored.summaries[side].weightedTotal);
  }
  assert.equal(restored.schemaVersion, 2);
  assert.equal(restored.snapshot.schemaVersion, 1);
  assert.equal(restored.scoring.accountingVersion, '2.0.0');
  assert.equal(restored.comparisonSummary.deltas.weightedPassed, 10);
  assert.equal(restored.comparisonSummary.deltas.weightedAbstentions, -3);
  assert.equal(restored.comparisonSummary.deltas.weightedEarned, 7);
});
