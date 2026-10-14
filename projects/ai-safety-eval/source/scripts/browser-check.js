import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { dataset } from '../src/fixtures.js';
import { buildScorecard } from '../src/evaluation.js';

// Isolated browser contexts: reviewer tests never affect a user's actual local notes.
const root = fileURLToPath(new URL('..', import.meta.url));
let baseURL = process.env.BASE_URL;
const checks = [];
const errors = [];
const externalRequests = [];
let server;
let browser;

async function check(name, action) {
  await action();
  checks.push(name);
  console.log(`PASS ${name}`);
}

async function ready() {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server?.exitCode != null) throw new Error('Browser-check server exited before becoming ready.');
    try { if ((await fetch(baseURL)).ok) return; } catch { /* Startup retry only. */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`No local server ready at ${baseURL}`);
}

async function startOwnServer() {
  server = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', (data) => errors.push(data.toString()));
  await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Owned browser-check server did not report a listening port.')), 10000);
    server.once('error', (error) => { clearTimeout(timer); reject(error); });
    server.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Owned browser-check server exited: ${code}`)); });
    server.stdout.on('data', (data) => {
      output += data.toString();
      const match = output.match(/Guardrail is ready at http:\/\/localhost:(\d+)/u);
      if (!match) return;
      clearTimeout(timer);
      baseURL = `http://127.0.0.1:${match[1]}`;
      resolve();
    });
  });
}

try {
  if (!process.env.BASE_URL) {
    await startOwnServer();
  }
  await ready();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', (request) => { if (new URL(request.url()).origin !== new URL(baseURL).origin) externalRequests.push(request.url()); });
  const nav = async (value) => page.locator(`.sidebar [data-page="${value}"]`).click();
  const clear = async () => page.locator('.cases-section > .section-title-row [data-action="clear-filters"]').click();
  const ids = () => page.locator('tbody tr[data-id]').evaluateAll((elements) => elements.map((element) => element.dataset.id));
  const inspect = async (id) => { await clear(); await page.getByRole('textbox', { name: 'Search cases', exact: true }).fill(id); await page.locator('tbody button[data-action="inspect"]').click(); };
  const close = async () => page.getByRole('button', { name: 'Close evidence detail', exact: true }).click();

  await check('initial matrix, fixed score, and disjoint outcome counts', async () => {
    await page.goto(baseURL, { waitUntil: 'networkidle' });
    assert.equal(await page.locator('h1').textContent(), 'Evaluation matrix');
    assert.match(await page.locator('.hero-score').textContent(), /81\.97/);
    assert.deepEqual(await page.locator('.outcome-bucket strong').allTextContents(), ['18', '3', '2', '1', '0']);
    assert.equal((await ids()).length, 8);
  });

  await check('ordinary and abstention contributions reconcile separately across versions', async () => {
    assert.match(await page.locator('.accounting-equation').textContent(), /18 \+ 3 \+ 3 \+ 0 = 24/);
    assert.match(await page.locator('.pass-source').textContent(), /43 \/ 51/);
    assert.match(await page.locator('.pass-source').textContent(), /70\.4918 pts/);
    assert.match(await page.locator('.abstention-source').textContent(), /7 \/ 10/);
    assert.match(await page.locator('.abstention-source').textContent(), /11\.4754 pts/);
    assert.match(await page.locator('.contribution-total-card').textContent(), /43 pass \+ 7 abstention/);
    const values = async (measure) => page.locator(`.accounting-table [data-measure="${measure}"] td`).allTextContents();
    assert.deepEqual(await values('passed'), ['Ordinary passes', '16', '18', '+2']);
    assert.deepEqual(await values('failed'), ['Ordinary failures', '5', '3', '-2']);
    assert.deepEqual(await values('weightedPassed'), ['Ordinary pass earned weight', '33', '43', '+10']);
    assert.deepEqual(await values('weightedAbstentions'), ['Abstention earned weight', '10', '7', '-3']);
    await page.locator('[data-field="baseline"]').selectOption('run-1-3');
    assert.deepEqual(await values('weightedAbstentions'), ['Abstention earned weight', '7', '7', '0']);
    await page.locator('[data-field="baseline"]').selectOption('run-1-2');
  });

  await check('all severity controls show weights, exact counts, and selected state after rerenders', async () => {
    for (const severity of ['critical', 'high', 'medium', 'low']) {
      const control = page.locator(`.severity-option[data-value="${severity}"]`);
      const expected = dataset.prompts.filter((prompt) => prompt.severity === severity).map((prompt) => prompt.id);
      assert.match(await control.textContent(), /weight/);
      assert.equal(await control.locator('b').textContent(), String(expected.length));
      await control.click();
      assert.equal(await control.getAttribute('aria-pressed'), 'true');
      if (expected.length > 8) await page.locator('[data-action="toggle-all"]').click();
      assert.deepEqual(await ids(), expected);
    }
    await page.locator('.severity-option[data-value="high"]').click();
    await page.getByRole('textbox', { name: 'Search cases', exact: true }).fill('unknown');
    assert.equal(await page.locator('.severity-option[data-value="high"]').getAttribute('aria-pressed'), 'true');
    assert.deepEqual(await ids(), ['truthfulness-01']);
    await page.locator('[data-field="category"]').selectOption('privacy');
    assert.match(await page.locator('.empty-state').textContent(), /No cases match/);
    await clear();
    assert.equal(await page.locator('.severity-option[data-value="all"]').getAttribute('aria-pressed'), 'true');
    assert.match(await page.locator('.hero-score').textContent(), /81\.97/);
  });

  await check('ordinary failures, all no-credit responses, and accepted/rejected abstentions stay distinct', async () => {
    const expected = {
      failures: ['harmful-01', 'truthfulness-01', 'autonomy-01'],
      nonpassing: ['harmful-01', 'truthfulness-01', 'autonomy-01', 'fairness-02'],
      abstentions: ['fairness-02', 'privacy-03', 'truthfulness-03'],
      'accepted-abstentions': ['privacy-03', 'truthfulness-03'],
      'rejected-abstentions': ['fairness-02'],
    };
    for (const [outcome, expectedIds] of Object.entries(expected)) {
      await page.locator('[data-field="outcome"]').selectOption(outcome);
      assert.deepEqual(await ids(), expectedIds);
    }
    assert.match(await page.locator('.cases-section tbody').textContent(), /Abstention · no credit/);
    await page.locator('.severity-option[data-value="low"]').click();
    assert.match(await page.locator('.empty-state').textContent(), /No cases match/);
  });

  await check('rejected abstention evidence explains zero credit and baseline credit, with exact criteria', async () => {
    await inspect('fairness-02');
    assert.match(await page.locator('.modal').textContent(), /Abstention · no credit/);
    assert.match(await page.locator('.score-explanation').textContent(), /Abstention is disallowed/);
    assert.match(await page.locator('.score-explanation').textContent(), /100 × 0 \/ 61 = 0\.0000/);
    assert.match(await page.locator('.mode-check').textContent(), /Expected: answer · Observed: abstain · Abstention: disallowed/);
    assert.equal(await page.locator('.criterion').count(), 2);
    await page.locator('[data-action="evidence-run"][data-value="baseline"]').click();
    assert.match(await page.locator('.score-explanation').textContent(), /100 × 3 \/ 61 = 4\.9180/);
    assert.match(await page.locator('.inspect-response').textContent(), /Apply the same admission criteria/);
    assert.equal(await page.locator('.criterion.unmet').count(), 0);
    await close();
  });

  await check('allowed/required abstentions and ordinary failures explain policy-specific score credit', async () => {
    await inspect('truthfulness-03');
    assert.match(await page.locator('.score-explanation').textContent(), /Allowed abstention/);
    assert.match(await page.locator('.score-explanation').textContent(), /100 × 2 \/ 61 = 3\.2787/);
    await close();
    await inspect('truthfulness-01');
    assert.match(await page.locator('.score-explanation').textContent(), /Abstention is required; received answer/);
    assert.match(await page.locator('.score-explanation').textContent(), /0\.0000 pts/);
    await page.locator('[data-action="evidence-run"][data-value="baseline"]').click();
    assert.match(await page.locator('.score-explanation').textContent(), /Required abstention/);
    assert.match(await page.locator('.score-explanation').textContent(), /4\.9180 pts/);
    await close();
  });

  await check('evidence dialog supports keyboard focus trapping, Escape, and focus restoration', async () => {
    await clear();
    await page.getByRole('textbox', { name: 'Search cases', exact: true }).fill('privacy-01');
    const trigger = page.locator('tbody button[data-action="inspect"]');
    await trigger.focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#app').evaluate((element) => element.inert), true);
    assert.equal(await page.locator('.modal-close').evaluate((element) => element === document.activeElement), true);
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.locator('.inspect-footer button').evaluate((element) => element === document.activeElement), true);
    await page.keyboard.press('Tab');
    assert.equal(await page.locator('.modal-close').evaluate((element) => element === document.activeElement), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.modal').count(), 0);
    assert.equal(await trigger.evaluate((element) => element === document.activeElement), true);
    assert.equal(await page.locator('#app').evaluate((element) => element.inert), false);
  });

  await check('comparison controls detect two regressions, three improvements, and no same-run regressions', async () => {
    await clear();
    await page.locator('[data-field="outcome"]').selectOption('regressions');
    assert.deepEqual(await ids(), ['truthfulness-01', 'fairness-02']);
    assert.match(await page.locator('.cases-section tbody').textContent(), /abstention-accepted → failure/);
    assert.match(await page.locator('.cases-section tbody').textContent(), /pass → abstention-rejected/);
    await page.locator('[data-field="outcome"]').selectOption('improvements');
    assert.deepEqual(await ids(), ['privacy-01', 'robustness-01', 'robustness-02']);
    await page.locator('[data-field="baseline"]').selectOption('run-1-3');
    await page.locator('[data-field="outcome"]').selectOption('regressions');
    assert.equal((await ids()).length, 0);
    await page.locator('[data-field="baseline"]').selectOption('run-1-2');
    await clear();
  });

  await check('local review save survives reload and appears in evidence without changing score', async () => {
    await nav('reviews');
    assert.equal(await page.locator('.review-list-item').count(), 2);
    await page.locator('.review-list-item[data-id="privacy-02"]').click();
    await page.locator('.review-form input[name="reviewer"]').fill('Browser check reviewer');
    await page.locator('.review-form textarea[name="note"]').fill('Checked the exact public synthetic contact.');
    await page.getByRole('button', { name: 'Save review annotation', exact: true }).click();
    assert.equal(await page.locator('.review-list-item').count(), 1);
    await page.reload({ waitUntil: 'networkidle' });
    assert.match(await page.locator('.hero-score').textContent(), /81\.97/);
    await inspect('privacy-02');
    assert.match(await page.locator('.reviewer-detail').textContent(), /Checked the exact public synthetic contact/);
    assert.match(await page.locator('.score-explanation').textContent(), /4\.9180 pts/);
    await close();
  });

  await check('JSON exports include every explanation despite active filters and reproduce byte-for-byte', async () => {
    await page.locator('.severity-option[data-value="critical"]').click();
    const downloadJson = async () => {
      const pending = page.waitForEvent('download');
      await page.locator('[data-action="export-json"]').click();
      const result = await pending;
      return readFile(await result.path(), 'utf8');
    };
    const first = await downloadJson();
    const second = await downloadJson();
    assert.equal(first, second);
    const exported = JSON.parse(first);
    assert.equal(exported.snapshot.prompts.length, 24);
    assert.equal(exported.explanations.length, 24);
    assert.equal(exported.summaries.candidate.reviewed, 23);
    assert.equal(exported.summaries.candidate.score, 81.97);
    assert.equal(exported.schemaVersion, 2);
    assert.equal(exported.scoring.accountingVersion, '2.0.0');
    assert.equal(exported.summaries.candidate.passed, 18);
    assert.equal(exported.summaries.candidate.failed, 3);
    assert.equal(exported.summaries.candidate.weightedPassed, 43);
    assert.equal(exported.summaries.candidate.weightedAbstentions, 7);
    assert.equal(exported.summaries.candidate.weightedEarned, 50);
    assert.equal(exported.comparisonSummary.deltas.weightedPassed, 10);
    assert.equal(exported.comparisonSummary.deltas.weightedAbstentions, -3);
    for (const row of exported.comparisons.filter((item) => item.candidate.isAbstention)) assert.equal(row.candidate.outcome, 'abstention');
    assert.deepEqual(exported, buildScorecard(exported.snapshot, exported.baselineId, exported.candidateId));
    await nav('scorecard');
    assert.match(await page.locator('.comparison-summary').textContent(), /18/);
    assert.match(await page.locator('.comparison-summary').textContent(), /\+10 weight/);
    assert.match(await page.locator('.comparison-summary').textContent(), /-3 abstention weight/);
    const pending = page.waitForEvent('download');
    await page.locator('[data-action="export-csv"]').click();
    const csv = await readFile(await (await pending).path(), 'utf8');
    assert.match(csv, /"baseline_result_type","candidate_result_type","candidate_credited","candidate_contribution_source","candidate_abstention_status"/);
    assert.match(csv, /"contribution_points","score_reason","property_evidence_json"/);
    assert.match(csv, /"autonomy-04"/);
  });

  await check('prompt library validation, fixed run selection, and about dialog remain functional', async () => {
    await nav('prompts');
    await page.locator('[data-field="search"]').fill('');
    assert.equal(await page.locator('.prompt-card').count(), 24);
    await page.locator('[data-action="validate"]').click();
    assert.match(await page.locator('#toast').textContent(), /Dataset is valid/);
    await nav('runs');
    assert.equal(await page.locator('.run-card').count(), 3);
    await page.locator('[data-action="select-run"][data-id="run-1-1"]').click();
    await nav('matrix');
    assert.match(await page.locator('.hero-score').textContent(), /57\.38/);
    await page.locator('[data-field="candidate"]').selectOption('run-1-3');
    await page.locator('[data-action="about"]').first().click();
    assert.match(await page.getByRole('dialog').textContent(), /No live model calls/);
    await page.keyboard.press('Escape');
    await clear();
  });

  await check('mobile severity, abstention evidence, navigation, and review flow fit the viewport', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.severity-option[data-value="high"]').click();
    await page.locator('[data-field="outcome"]').selectOption('rejected-abstentions');
    assert.deepEqual(await ids(), ['fairness-02']);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.locator('tbody button[data-action="inspect"]').click();
    assert.equal(await page.locator('.modal').evaluate((element) => element.scrollWidth <= element.clientWidth), true);
    assert.match(await page.locator('.score-explanation').textContent(), /0\.0000 pts/);
    await page.locator('[data-action="evidence-run"][data-value="baseline"]').click();
    assert.match(await page.locator('.score-explanation').textContent(), /4\.9180 pts/);
    await close();
    await page.getByRole('button', { name: 'Toggle navigation', exact: true }).click();
    await nav('reviews');
    assert.equal(await page.locator('.review-list-item').count(), 1);
    await page.locator('.review-form input[name="reviewer"]').fill('Mobile check reviewer');
    await page.locator('.review-form textarea[name="note"]').fill('Checked fictional origin label.');
    await page.getByRole('button', { name: 'Save review annotation', exact: true }).click();
    assert.match(await page.locator('.empty-panel').textContent(), /Review queue is clear/);
    await page.getByRole('button', { name: 'Back to matrix', exact: true }).first().click();
    await clear();
  });

  await check('no browser errors or external network requests', async () => {
    assert.deepEqual(errors, []);
    assert.deepEqual(externalRequests, []);
  });
  await mkdir(new URL('../test-results/', import.meta.url), { recursive: true });
  // Capture the original fixed fixture state, not transient browser-check notes.
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });
  await page.evaluate(() => { scrollTo(0, 0); document.querySelector('#toast').classList.remove('show'); });
  await page.screenshot({ path: fileURLToPath(new URL('../test-results/matrix-mobile.png', import.meta.url)), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: fileURLToPath(new URL('../test-results/matrix-desktop.png', import.meta.url)), fullPage: true });
  await inspect('fairness-02');
  await page.screenshot({ path: fileURLToPath(new URL('../test-results/evidence-detail.png', import.meta.url)), fullPage: true });
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);
  console.log(`\n${checks.length} browser checks passed (desktop + mobile).`);
} finally {
  await browser?.close();
  if (server && server.exitCode == null) {
    const exited = once(server, 'exit');
    server.kill();
    await exited;
  }
}
