import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { modelCards } from '../src/data/modelCards.js';
import { auditModelCard, exportReviewPacket } from '../src/lib/audit.js';

const atlas = modelCards.find((card) => card.id === 'atlas-assist');
const harbor = modelCards.find((card) => card.id === 'harbor-screen');
const lumen = modelCards.find((card) => card.id === 'lumen-caption');
const atlasAudit = auditModelCard(atlas);

const dashboard = (page) => page.getByRole('region', { name: 'Risk trade-off dashboard', exact: true });
const inspector = (view) => view.getByRole('region', { name: 'Claim evidence inspector', exact: true });
const comparison = (view) => view.getByRole('region', { name: 'Illustrative strategy comparison', exact: true });
const findings = (view) => view.getByRole('region', { name: 'Review findings', exact: true });

function claimDetails(view, id) {
  return inspector(view).locator('details').filter({ hasText: new RegExp(`^${id}\\s`) });
}

async function openDashboard(page, card = atlas) {
  await page.goto(`/risk-tradeoffs?model=${card.id}`);
  const view = dashboard(page);
  await expect(view.getByRole('heading', { name: 'Risk trade-off dashboard', exact: true })).toBeVisible();
  return view;
}

async function expectClaimCount(view, card, filter) {
  const audit = auditModelCard(card);
  const unsupported = audit.totalClaims - audit.supportedClaims;
  const count = filter === 'all' ? audit.totalClaims : filter === 'complete' ? audit.supportedClaims : unsupported;
  await expect(inspector(view).locator('details')).toHaveCount(count);
  await expect(inspector(view).getByRole('status')).toHaveText(
    `Showing ${count} of ${audit.totalClaims} claims. ${unsupported} unsupported; ${audit.supportedClaims} with complete references.`,
  );
}

async function expectEstimates(view, card, selected, privacy, fairness) {
  const section = comparison(view);
  const estimates = section.getByRole('region', { name: 'Selected strategy estimates', exact: true });
  const table = section.getByRole('table', { name: 'Illustrative strategy comparison', exact: true });
  await expect(table.getByRole('columnheader')).toHaveText([
    'Strategy', ...(privacy ? ['Privacy risk (0–100)'] : []),
    ...(fairness ? ['Fairness visibility (0–100)'] : []), 'Description',
  ]);
  await expect(table.getByRole('columnheader')).toHaveCount(2 + Number(privacy) + Number(fairness));
  await expect(estimates.getByText(`${selected.privacyRisk} / 100`, { exact: true })).toHaveCount(Number(privacy));
  await expect(estimates.getByText(`${selected.fairnessVisibility} / 100`, { exact: true })).toHaveCount(Number(fairness));
  await expect(estimates.locator('dt')).toHaveText([
    ...(privacy ? ['Privacy risk estimate'] : []), ...(fairness ? ['Fairness visibility estimate'] : []),
  ]);
  await expect(estimates).toContainText(selected.description);
  for (const strategy of card.tradeoffs) {
    const row = table.getByRole('row').filter({ hasText: strategy.name });
    await expect(row.getByRole('cell')).toHaveCount(1 + Number(privacy) + Number(fairness));
    await expect(row.locator('td > strong')).toHaveText([
      ...(privacy ? [String(strategy.privacyRisk)] : []),
      ...(fairness ? [String(strategy.fairnessVisibility)] : []),
    ]);
    await expect(row.getByRole('cell').last()).toHaveText(strategy.description);
  }
}

test('Atlas c11 exposes its resolved Spanish slice and missing second reference with native keyboard details', async ({ page }) => {
  const view = await openDashboard(page);
  await expect(inspector(view)).toHaveCount(1);
  const claim = atlas.claims.find((item) => item.id === 'atlas-c11');
  const spanish = atlas.evidence.find((item) => item.id === 'atlas-e3');
  const details = claimDetails(view, claim.id);
  const summary = details.locator('summary');
  await expect(summary).toHaveText('atlas-c11 Unsupported');
  await expect(details).toHaveJSProperty('open', false);
  await summary.focus();
  await page.keyboard.press('Space');
  await expect(details).toHaveJSProperty('open', true);
  await expect(details.getByText(claim.text, { exact: true })).toBeVisible();
  await expect(details.getByText('claims[10]', { exact: true })).toBeVisible();
  const resolved = details.getByRole('listitem').filter({ hasText: 'atlas-e3' });
  await expect(resolved).toContainText('Resolved reference');
  await expect(resolved).toContainText(spanish.title);
  await expect(resolved).toContainText(spanish.description);
  await expect(resolved.getByText('evidence[2]', { exact: true })).toBeVisible();
  const missing = details.getByRole('listitem').filter({ hasText: 'Missing evidence' });
  await expect(missing).toContainText('atlas-missing-evidence');
  await expect(missing).toContainText('No local evidence path.');
  await expect(details.getByRole('heading', { name: 'Reference completeness reasons', exact: true })).toBeVisible();
  await expect(details.locator('.claim-evidence__reasons')).toContainText('atlas-missing-evidence');
  await expect(inspector(view).getByText(/reference completeness only, not verified truth/)).toBeVisible();
  await expect(inspector(view).getByText(/not semantically checked for relevance or mismatches/)).toBeVisible();
  await expect(inspector(view).locator('a, img, iframe, object, embed')).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect(details).toHaveJSProperty('open', false);

  const empty = claimDetails(view, 'atlas-c10');
  await empty.locator('summary').click();
  await expect(empty.getByText('No evidence references are recorded for this claim.', { exact: true })).toBeVisible();
  await expect(empty.getByText(atlas.claims.find((item) => item.id === 'atlas-c10').text, { exact: true })).toBeVisible();
  await expect(empty.getByText('claims[9]', { exact: true })).toBeVisible();
  await expect(empty.locator('.claim-evidence__reasons')).toContainText(/no evidence references/i);
});

test('claim filters show exact counts and complete references without treating completeness as truth', async ({ page }) => {
  const view = await openDashboard(page);
  const filter = inspector(view).getByLabel('Claim evidence filter', { exact: true });
  await expect(filter).toHaveJSProperty('tagName', 'SELECT');
  await expect(filter.locator('option')).toHaveText(['Unsupported claims', 'All claims', 'Complete references']);
  await expect(filter).toHaveValue('unsupported');
  await expectClaimCount(view, atlas, 'unsupported');
  await expect(inspector(view).locator('summary')).toHaveText([
    'atlas-c9 Unsupported', 'atlas-c10 Unsupported', 'atlas-c11 Unsupported', 'atlas-c12 Unsupported',
  ]);
  await filter.selectOption({ label: 'All claims' });
  await expectClaimCount(view, atlas, 'all');
  for (const claim of atlas.claims) await expect(claimDetails(view, claim.id).locator('summary')).toBeVisible();
  await filter.selectOption({ label: 'Complete references' });
  await expectClaimCount(view, atlas, 'complete');
  await expect(inspector(view).locator('summary')).toHaveText(
    atlas.claims.slice(0, atlasAudit.supportedClaims).map((claim) => `${claim.id} Complete references`),
  );
  const complete = claimDetails(view, 'atlas-c1');
  await complete.locator('summary').click();
  await expect(complete.getByText('No reference gaps found. This does not verify the claim.', { exact: true })).toBeVisible();
  for (const id of atlas.claims[0].evidenceIds) {
    const evidence = atlas.evidence.find((item) => item.id === id);
    const reference = complete.getByRole('listitem').filter({ hasText: id });
    await expect(reference).toContainText(evidence.title);
    await expect(reference).toContainText(evidence.description);
  }
  await page.getByLabel('Model card', { exact: true }).selectOption(lumen.id);
  await expectClaimCount(view, lumen, 'unsupported');
  await expect(inspector(view).getByText(/No unsupported claims: every claim has complete references/)).toBeVisible();
  await inspector(view).getByLabel('Claim evidence filter', { exact: true }).selectOption({ label: 'All claims' });
  await expectClaimCount(view, lumen, 'all');
});

test('inspection quick actions set finding filters or focus unsupported claims while retaining audit flags', async ({ page }) => {
  const view = await openDashboard(page);
  const auditSummary = view.getByRole('region', { name: 'Audit summary', exact: true });
  const categorySummary = view.getByRole('region', { name: 'Category summary', exact: true });
  const originalAudit = await auditSummary.textContent();
  const originalCategories = await categorySummary.textContent();
  const originalFindings = await findings(view).getByRole('article').allTextContents();
  const privacy = view.getByRole('button', { name: 'Inspect privacy findings', exact: true });
  const fairness = view.getByRole('button', { name: 'Inspect fairness findings', exact: true });
  await expect(privacy).toHaveAttribute('aria-pressed', 'false');
  await expect(fairness).toHaveAttribute('aria-pressed', 'false');

  for (const [category, action, other] of [['privacy', privacy, fairness], ['fairness', fairness, privacy]]) {
    await view.getByLabel('Finding severity', { exact: true }).selectOption('low');
    await action.click();
    await expect(action).toHaveAttribute('aria-pressed', 'true');
    await expect(other).toHaveAttribute('aria-pressed', 'false');
    await expect(view.getByLabel('Finding category', { exact: true })).toHaveValue(category);
    await expect(view.getByLabel('Finding severity', { exact: true })).toHaveValue('all');
    const expected = atlasAudit.findings.filter((finding) => finding.category === category);
    await expect(findings(view).getByRole('article')).toHaveCount(expected.length);
    await expect(findings(view).getByRole('status')).toHaveText(`Showing ${expected.length} of ${atlasAudit.findings.length} findings.`);
    for (const finding of expected) {
      await expect(findings(view).getByRole('article', { name: finding.title, exact: true })).toBeVisible();
    }
  }

  await inspector(view).getByLabel('Claim evidence filter', { exact: true }).selectOption('complete');
  const quickInspect = view.getByRole('button', { name: 'Inspect unsupported claims', exact: true });
  await quickInspect.focus();
  await page.keyboard.press('Space');
  const heading = inspector(view).getByRole('heading', { name: 'Claim evidence inspector', exact: true });
  await expect(heading).toBeFocused();
  await expect(heading).toBeInViewport();
  await expect(inspector(view).getByLabel('Claim evidence filter', { exact: true })).toHaveValue('unsupported');
  await expectClaimCount(view, atlas, 'unsupported');
  await expect(view.getByLabel('Finding category', { exact: true })).toHaveValue('fairness');
  await expect(auditSummary).toHaveText(originalAudit);
  await expect(categorySummary).toHaveText(originalCategories);
  await view.getByRole('button', { name: 'Clear finding filters', exact: true }).click();
  await expect(findings(view).getByRole('article')).toHaveText(originalFindings);
  await expect(privacy).toHaveAttribute('aria-pressed', 'false');
  await expect(fairness).toHaveAttribute('aria-pressed', 'false');
});

test('native Space toggles hide only matching numeric estimates and columns and Reset restores both', async ({ page }) => {
  const view = await openDashboard(page);
  const section = comparison(view);
  const privacy = section.getByRole('checkbox', { name: 'Show privacy risk estimates', exact: true });
  const fairness = section.getByRole('checkbox', { name: 'Show fairness visibility estimates', exact: true });
  const current = atlas.tradeoffs.find((strategy) => strategy.current);
  const alternative = atlas.tradeoffs.find((strategy) => !strategy.current);
  const originalFindings = await findings(view).getByRole('article').allTextContents();
  const auditSummary = view.getByRole('region', { name: 'Audit summary', exact: true });
  const originalSummary = await auditSummary.textContent();
  await expect(privacy).toHaveAttribute('type', 'checkbox');
  await expect(fairness).toHaveAttribute('type', 'checkbox');
  await expect(privacy).toBeChecked();
  await expect(fairness).toBeChecked();
  await expect(section.getByText(/Display-only controls/)).toBeVisible();
  await expect(section.getByText(/All estimates remain in the exported review packet/)).toBeVisible();
  await expectEstimates(view, atlas, current, true, true);

  await privacy.focus();
  await page.keyboard.press('Space');
  await expect(privacy).toBeFocused();
  await expect(privacy).not.toBeChecked();
  await expect(fairness).toBeChecked();
  await expectEstimates(view, atlas, current, false, true);
  await fairness.focus();
  await page.keyboard.press('Space');
  await expect(fairness).not.toBeChecked();
  await expectEstimates(view, atlas, current, false, false);
  await expect(section.getByRole('status')).toContainText('Both estimates are hidden.');
  await expect(section.getByRole('radio', { name: current.name, exact: true })).toBeChecked();

  const pendingDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export review packet', exact: true }).click();
  await page.getByRole('dialog', { name: 'Export review packet', exact: true })
    .getByRole('button', { name: 'Download Markdown', exact: true }).click();
  const download = await pendingDownload;
  const packetPath = await download.path();
  expect(packetPath).not.toBeNull();
  const packet = await readFile(packetPath, 'utf8');
  const expectedPacket = exportReviewPacket(atlas, atlasAudit);
  expect(packet).toBe(expectedPacket);
  expect(packet).toContain('Privacy risk (0–100)');
  expect(packet).toContain('Fairness visibility (0–100)');
  for (const strategy of atlas.tradeoffs) {
    expect(packet).toContain(strategy.name);
    expect(packet).toContain(String(strategy.privacyRisk));
    expect(packet).toContain(String(strategy.fairnessVisibility));
  }

  const reset = section.getByRole('button', { name: 'Reset estimates', exact: true });
  await reset.focus();
  await page.keyboard.press('Enter');
  await expect(privacy).toBeChecked();
  await expect(fairness).toBeChecked();
  await expectEstimates(view, atlas, current, true, true);
  await fairness.focus();
  await page.keyboard.press('Space');
  await expectEstimates(view, atlas, current, true, false);
  await section.getByRole('radio', { name: alternative.name, exact: true }).check();
  await expectEstimates(view, atlas, alternative, true, false);
  await fairness.focus();
  await page.keyboard.press('Space');
  await expectEstimates(view, atlas, alternative, true, true);
  await expect(section.getByRole('region', { name: 'Selected strategy estimates', exact: true })).toContainText(
    '-30 points · less privacy risk than current',
  );
  await expect(section.getByRole('region', { name: 'Selected strategy estimates', exact: true })).toContainText(
    '-50 points · less fairness visibility than current',
  );
  await expect(findings(view).getByRole('article')).toHaveText(originalFindings);
  await expect(auditSummary).toHaveText(originalSummary);
});

test('switching cards resets claim filters and disclosures, estimate visibility, and the current strategy', async ({ page }) => {
  const view = await openDashboard(page);
  await inspector(view).getByLabel('Claim evidence filter', { exact: true }).selectOption('all');
  await claimDetails(view, 'atlas-c11').locator('summary').click();
  await expect(claimDetails(view, 'atlas-c11')).toHaveJSProperty('open', true);
  await view.getByRole('button', { name: 'Inspect privacy findings', exact: true }).click();
  await view.getByLabel('Finding severity', { exact: true }).selectOption('high');
  await comparison(view).getByRole('checkbox', { name: 'Show privacy risk estimates', exact: true }).uncheck();
  await comparison(view).getByRole('checkbox', { name: 'Show fairness visibility estimates', exact: true }).uncheck();
  await comparison(view).getByRole('radio', { name: 'Minimal retention baseline', exact: true }).check();

  await page.getByLabel('Model card', { exact: true }).selectOption(harbor.id);
  await expect(page).toHaveURL((url) => url.searchParams.get('model') === harbor.id);
  await expect(inspector(view).getByLabel('Claim evidence filter', { exact: true })).toHaveValue('unsupported');
  await expectClaimCount(view, harbor, 'unsupported');
  await expect(inspector(view).locator('details[open]')).toHaveCount(0);
  await expect(view.getByLabel('Finding category', { exact: true })).toHaveValue('all');
  await expect(view.getByLabel('Finding severity', { exact: true })).toHaveValue('all');
  await expect(comparison(view).getByRole('checkbox', { name: 'Show privacy risk estimates', exact: true })).toBeChecked();
  await expect(comparison(view).getByRole('checkbox', { name: 'Show fairness visibility estimates', exact: true })).toBeChecked();
  const harborCurrent = harbor.tradeoffs.find((strategy) => strategy.current);
  await expect(comparison(view).getByRole('radio', { name: harborCurrent.name, exact: true })).toBeChecked();
  await expectEstimates(view, harbor, harborCurrent, true, true);

  await claimDetails(view, 'harbor-c2').locator('summary').click();
  await expect(claimDetails(view, 'harbor-c2')).toHaveJSProperty('open', true);
  await inspector(view).getByLabel('Claim evidence filter', { exact: true }).selectOption('all');
  await comparison(view).getByRole('checkbox', { name: 'Show privacy risk estimates', exact: true }).uncheck();
  await page.getByLabel('Model card', { exact: true }).selectOption(atlas.id);
  await expect(inspector(view).getByLabel('Claim evidence filter', { exact: true })).toHaveValue('unsupported');
  await expectClaimCount(view, atlas, 'unsupported');
  await expect(inspector(view).locator('details[open]')).toHaveCount(0);
  await expect(claimDetails(view, 'atlas-c11')).toHaveJSProperty('open', false);
  await expect(comparison(view).getByRole('checkbox', { name: 'Show privacy risk estimates', exact: true })).toBeChecked();
  await expect(comparison(view).getByRole('checkbox', { name: 'Show fairness visibility estimates', exact: true })).toBeChecked();
  const atlasCurrent = atlas.tradeoffs.find((strategy) => strategy.current);
  await expect(comparison(view).getByRole('radio', { name: atlasCurrent.name, exact: true })).toBeChecked();
  await expectEstimates(view, atlas, atlasCurrent, true, true);
});
