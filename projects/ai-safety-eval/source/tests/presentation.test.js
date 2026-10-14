import test from 'node:test';
import assert from 'node:assert/strict';
import { dataset } from '../src/fixtures.js';
import { evaluateRecord, explainRecord } from '../src/evaluation.js';
import { resultBadge, renderScoreExplanation } from '../src/presentation.js';

const prompt = dataset.prompts.find((item) => item.id === 'truthfulness-03');
const record = dataset.records.find((item) => item.promptId === prompt.id && item.runId === 'run-1-3');

test('abstentions have explicit labels separate from ordinary failures and missing responses', () => {
  assert.match(resultBadge(evaluateRecord(prompt, record)), /Abstention · credit/);
  const rejected = evaluateRecord(prompt, { ...record, judgments: { grounded: false } });
  assert.match(resultBadge(rejected), /Abstention · no credit/);
  assert.doesNotMatch(resultBadge(rejected), />Failure</);
  assert.match(resultBadge(evaluateRecord(prompt, { ...record, mode: 'refuse' })), />Failure</);
  assert.match(resultBadge(evaluateRecord(prompt, null)), /Missing output/);
});

test('score detail displays weight, denominator, exact evidence, mode, and all-or-nothing rule', () => {
  const explanation = explainRecord(dataset, prompt, record, record.runId);
  const html = renderScoreExplanation(explanation);
  assert.match(html, /3\.2787 pts/);
  assert.match(html, /100 × 2 \/ 61/);
  assert.match(html, /Expected: answer · Observed: abstain · Abstention: allowed/);
  assert.match(html, /There is no partial credit/);
  assert.match(html, /Stored fixture judgments/);
  assert.match(html, /Source: abstention/);
  assert.match(html, /Ordinary pass\/fail totals exclude all abstentions/);
  for (const property of explanation.properties) assert.ok(html.includes(property.label));
  assert.ok(html.includes(record.response));
});

test('score detail escapes reviewer-controlled evidence and labels rather than inserting markup', () => {
  const explanation = structuredClone(explainRecord(dataset, prompt, record, record.runId));
  explanation.reason = '<img src=x onerror=alert(1)>';
  explanation.properties[0].label = '<script>label</script>';
  explanation.properties[0].evidence = [{ quote: '<svg onload=alert(1)>', explanation: 'Text & <b>markup</b>' }];
  const html = renderScoreExplanation(explanation);
  assert.doesNotMatch(html, /<img|<script|<svg onload/);
  assert.match(html, /&lt;img src=x/);
  assert.match(html, /Text &amp; &lt;b&gt;markup&lt;\/b&gt;/);
});

test('missing evidence is explicit and missing output is not presented as a property pass', () => {
  const explanation = explainRecord(dataset, prompt, null, 'run-1-3');
  const html = renderScoreExplanation(explanation);
  assert.match(html, /0\.0000 pts/);
  assert.match(html, /Observed: missing/);
  assert.match(html, /Not evaluated/);
  assert.match(html, /No evidence recorded for this property/);
});
