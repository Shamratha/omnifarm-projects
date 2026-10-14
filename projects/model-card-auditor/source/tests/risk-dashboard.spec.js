import { test, expect } from '@playwright/test';
import { modelCards } from '../src/data/modelCards.js';
import { auditModelCard } from '../src/lib/audit.js';

const atlas = modelCards.find((card) => card.id === 'atlas-assist');
const harbor = modelCards.find((card) => card.id === 'harbor-screen');
const lumen = modelCards.find((card) => card.id === 'lumen-caption');
const atlasAudit = auditModelCard(atlas);
const categoryOptions = [
  { label: 'All findings', value: 'all' },
  { label: 'Privacy', value: 'privacy' },
  { label: 'Fairness', value: 'fairness' },
  { label: 'Threats', value: 'security' },
  { label: 'Accessibility', value: 'accessibility' },
  { label: 'Claims', value: 'claims' },
];
const severityOptions = [
  { label: 'All severities', value: 'all' },
  { label: 'High', value: 'high' },
  { label: 'Medium', value: 'medium' },
  { label: 'Low', value: 'low' },
];

function dashboard(page) {
  return page.getByRole('region', { name: 'Risk trade-off dashboard', exact: true });
}

function findingStatus(view) {
  return view.getByRole('status').filter({ hasText: /^Showing \d+ of \d+ findings\.$/ });
}

async function expectRoute(page, path, model) {
  await expect(page).toHaveURL((url) => url.pathname === path && url.searchParams.get('model') === model);
}

async function openDashboard(page, card = atlas) {
  await page.goto(`/risk-tradeoffs?model=${card.id}`);
  await expect(dashboard(page).getByRole('heading', {
    name: 'Risk trade-off dashboard', level: 2, exact: true,
  })).toBeVisible();
  await expect(page.getByLabel('Model card', { exact: true })).toHaveValue(card.id);
  return dashboard(page);
}

async function expectFindings(view, expected, total = expected.length) {
  await expect(view.getByRole('article')).toHaveCount(expected.length);
  await expect(findingStatus(view)).toHaveText(`Showing ${expected.length} of ${total} findings.`);
  for (const finding of expected) {
    await expect(view.getByRole('article', { name: finding.title, exact: true })).toBeVisible();
  }
}

test('the sidebar opens Atlas with every finding and its source evidence visible', async ({ page }) => {
  await page.goto('/');
  const navigation = page.getByRole('button', { name: 'Risk trade-offs', exact: true });
  await navigation.focus();
  await page.keyboard.press('Enter');
  await expectRoute(page, '/risk-tradeoffs', atlas.id);
  const view = dashboard(page);
  await expect(view.getByRole('heading', { name: 'Risk trade-off dashboard', level: 2, exact: true })).toBeVisible();
  await expect(page.getByLabel('Model card', { exact: true })).toHaveJSProperty('tagName', 'SELECT');
  await expectFindings(view, atlasAudit.findings);

  for (const finding of atlasAudit.findings) {
    const article = view.getByRole('article', { name: finding.title, exact: true });
    await expect(article).toContainText(finding.description);
    await expect(article).toContainText(finding.recommendation);
    await expect(article).toContainText(finding.evidence);
    for (const entry of finding.sources) {
      await expect(article).toContainText(entry.path);
      await expect(article).toContainText(entry.label);
      await expect(article).toContainText(entry.detail);
    }
  }
  const missing = view.getByRole('article', { name: 'Subgroup evaluation data is missing or invalid', exact: true });
  await expect(missing).toContainText('Age 65+');
  const consent = view.getByRole('article', { name: 'Consent contradiction: requirements are contradictory', exact: true });
  for (const id of ['atlas-du1', 'atlas-du2']) {
    await expect(consent).toContainText(id);
    await expect(consent).toContainText(atlas.dataUse.statements.find((statement) => statement.id === id).text);
  }
  const threats = view.getByRole('article', { name: 'Threat mitigations need review', exact: true });
  const threat = atlas.threats.find((item) => item.id === 'atlas-t2');
  await expect(threats).toContainText(threat.id);
  await expect(threats).toContainText(threat.name);
  await expect(threats).toContainText(threat.mitigation);
  for (const [id, title] of [
    ['atlas-a2', 'Accessibility checks failed'],
    ['atlas-a3', 'Accessibility coverage is incomplete'],
  ]) {
    const article = view.getByRole('article', { name: title, exact: true });
    const check = atlas.accessibility.find((item) => item.id === id);
    await expect(article).toContainText(check.id);
    await expect(article).toContainText(check.name);
    await expect(article).toContainText(check.detail);
  }

  const summary = view.getByRole('region', { name: 'Category summary', exact: true });
  for (const category of categoryOptions.slice(1)) {
    const heading = category.value === 'security' ? 'Threats / security' : category.label;
    const item = summary.getByRole('listitem').filter({
      has: page.getByRole('heading', { name: heading, level: 4, exact: true }),
    });
    const count = atlasAudit.findings.filter((finding) => finding.category === category.value).length;
    const coverage = category.value === 'claims'
      ? Math.round(100 * atlasAudit.supportedClaims / atlasAudit.totalClaims)
      : atlasAudit.dimensions.find((dimension) => dimension.id === category.value).score;
    await expect(item).toContainText(`${count} ${count === 1 ? 'finding' : 'findings'}`);
    await expect(item).toContainText(`${coverage}%`);
  }
});

test('category and severity filters show exactly their intersection without changing the audit', async ({ page }) => {
  const view = await openDashboard(page);
  const categorySelect = view.getByLabel('Finding category', { exact: true });
  const severitySelect = view.getByLabel('Finding severity', { exact: true });
  await expect(categorySelect).toHaveJSProperty('tagName', 'SELECT');
  await expect(severitySelect).toHaveJSProperty('tagName', 'SELECT');
  await expect(categorySelect.locator('option')).toHaveText(categoryOptions.map((item) => item.label));
  await expect(severitySelect.locator('option')).toHaveText(severityOptions.map((item) => item.label));
  const auditSummary = view.getByRole('region', { name: 'Audit summary', exact: true });
  const categorySummary = view.getByRole('region', { name: 'Category summary', exact: true });
  const originalAuditSummary = await auditSummary.textContent();
  const originalCategorySummary = await categorySummary.textContent();

  for (const category of categoryOptions) {
    await categorySelect.selectOption({ label: category.label });
    for (const severity of severityOptions) {
      await severitySelect.selectOption({ label: severity.label });
      const expected = atlasAudit.findings.filter((finding) => (
        (category.value === 'all' || finding.category === category.value)
        && (severity.value === 'all' || finding.severity === severity.value)
      ));
      await expectFindings(view, expected, atlasAudit.findings.length);
      if (!expected.length) await expect(view.getByText(/No findings match these filters\./)).toBeVisible();
    }
  }
  await expect(auditSummary).toHaveText(originalAuditSummary);
  await expect(categorySummary).toHaveText(originalCategorySummary);
  await view.getByRole('button', { name: 'Clear finding filters', exact: true }).click();
  await expect(categorySelect).toHaveValue('all');
  await expect(severitySelect).toHaveValue('all');
  await expectFindings(view, atlasAudit.findings);
  await expect(view.getByText(/No findings match these filters\./)).toHaveCount(0);
});

test('Harbor exposes the rural small-sample evidence and suggested review action', async ({ page }) => {
  const view = await openDashboard(page, harbor);
  const audit = auditModelCard(harbor);
  await expectFindings(view, audit.findings);
  const smallSample = audit.findings.find((finding) => finding.id === 'fairness-small-samples');
  const article = view.getByRole('article', { name: smallSample.title, exact: true });
  await expect(article).toContainText('Rural applicants: n=18');
  await expect(article).toContainText('Subgroup samples below 30');
  await expect(article).toContainText(smallSample.recommendation);
  await view.getByLabel('Finding category', { exact: true }).selectOption({ label: 'Fairness' });
  await view.getByLabel('Finding severity', { exact: true }).selectOption({ label: 'Medium' });
  await expectFindings(view, [smallSample], audit.findings.length);
});

test('Lumen has a clear no-findings state without presenting it as assurance', async ({ page }) => {
  const view = await openDashboard(page, lumen);
  await expectFindings(view, []);
  await expect(view.getByText(/No findings were generated for this card\./)).toBeVisible();
  await expect(view.getByText(/This is not assurance of safety, fairness, privacy, or accessibility/)).toBeVisible();
  await expect(view.getByRole('region', { name: 'Audit summary', exact: true })).toContainText('100%');
  await view.getByLabel('Finding category', { exact: true }).selectOption({ label: 'Privacy' });
  await view.getByLabel('Finding severity', { exact: true }).selectOption({ label: 'High' });
  await expectFindings(view, []);
  await expect(view.getByText(/No findings were generated for this card\./)).toBeVisible();
  await expect(view.getByText(/No findings match these filters\./)).toHaveCount(0);
});

for (const scenario of [
  { card: atlas, privacyDelta: '-30 points · less privacy risk than current', fairnessDelta: '-50 points · less fairness visibility than current' },
  { card: harbor, privacyDelta: '-60 points · less privacy risk than current', fairnessDelta: '+10 points · more fairness visibility than current' },
  { card: lumen, privacyDelta: '+45 points · more privacy risk than current', fairnessDelta: '+10 points · more fairness visibility than current' },
]) {
  test(`${scenario.card.name} comparisons show signed estimates while findings and coverage stay unchanged`, async ({ page }) => {
    const { card } = scenario;
    const view = await openDashboard(page, card);
    const audit = auditModelCard(card);
    await expectFindings(view, audit.findings);
    const articles = view.getByRole('article');
    const originalFindings = await articles.allTextContents();
    const auditSummary = view.getByRole('region', { name: 'Audit summary', exact: true });
    const originalSummary = await auditSummary.textContent();
    const comparison = view.getByRole('region', { name: 'Illustrative strategy comparison', exact: true });
    const selected = comparison.getByRole('region', { name: 'Selected strategy estimates', exact: true });
    const current = card.tradeoffs.find((strategy) => strategy.current);
    const alternative = card.tradeoffs.find((strategy) => !strategy.current);

    await expect(comparison.getByText(/Comparison only: these 0–100 estimates are fictional/)).toBeVisible();
    await expect(comparison.getByText(/Selecting a strategy does not apply it, resolve any flags, or recalculate audit evidence or coverage/)).toBeVisible();
    await expect(comparison.getByRole('group', { name: 'Illustrative comparison strategy', exact: true })).toBeVisible();
    await expect(comparison.getByRole('radio', { name: current.name, exact: true })).toBeChecked();
    await expect(selected.getByText(`${current.privacyRisk} / 100`, { exact: true })).toBeVisible();
    await expect(selected.getByText(`${current.fairnessVisibility} / 100`, { exact: true })).toBeVisible();
    await expect(selected.getByText('+0 points · no change from current', { exact: true })).toHaveCount(2);

    const table = comparison.getByRole('table', { name: 'Illustrative strategy comparison', exact: true });
    await expect(table.getByRole('row')).toHaveCount(card.tradeoffs.length + 1);
    for (const strategy of card.tradeoffs) {
      const row = table.getByRole('row').filter({ hasText: strategy.name });
      await expect(row.getByRole('rowheader')).toContainText(strategy.name);
      await expect(row.getByRole('cell').nth(0)).toContainText(String(strategy.privacyRisk));
      await expect(row.getByRole('cell').nth(1)).toContainText(String(strategy.fairnessVisibility));
      await expect(row.getByRole('cell').nth(2)).toHaveText(strategy.description);
    }

    // Native radio keys select the comparison; no separate application action exists.
    const currentRadio = comparison.getByRole('radio', { name: current.name, exact: true });
    await currentRadio.focus();
    await page.keyboard.press(card.tradeoffs.indexOf(current) === 0 ? 'ArrowRight' : 'ArrowLeft');
    const alternativeRadio = comparison.getByRole('radio', { name: alternative.name, exact: true });
    await expect(alternativeRadio).toBeFocused();
    await expect(alternativeRadio).toBeChecked();
    await expect(currentRadio).not.toBeChecked();
    await expect(selected.getByText(`${alternative.privacyRisk} / 100`, { exact: true })).toBeVisible();
    await expect(selected.getByText(`${alternative.fairnessVisibility} / 100`, { exact: true })).toBeVisible();
    await expect(selected).toContainText(scenario.privacyDelta);
    await expect(selected).toContainText(scenario.fairnessDelta);
    await expect(selected).toContainText(alternative.description);
    await expect(articles).toHaveText(originalFindings);
    await expectFindings(view, audit.findings);
    await expect(auditSummary).toHaveText(originalSummary);
    await expect(auditSummary).toContainText(`${audit.coverage}%`);

    await page.keyboard.press('Space');
    await expect(alternativeRadio).toBeChecked();
    await currentRadio.focus();
    await page.keyboard.press('Space');
    await expect(currentRadio).toBeChecked();
    await expect(selected.getByText('+0 points · no change from current', { exact: true })).toHaveCount(2);
    await expect(articles).toHaveText(originalFindings);
    await expect(auditSummary).toHaveText(originalSummary);
  });
}

test('deep links, model changes, and preview navigation retain the selected model on reload', async ({ page }) => {
  let view = await openDashboard(page);
  await view.getByLabel('Finding category', { exact: true }).selectOption({ label: 'Privacy' });
  await view.getByLabel('Finding severity', { exact: true }).selectOption({ label: 'High' });
  await view.getByRole('radio', { name: 'Minimal retention baseline', exact: true }).check();

  const modelSelect = page.getByLabel('Model card', { exact: true });
  await modelSelect.selectOption(harbor.id);
  await expectRoute(page, '/risk-tradeoffs', harbor.id);
  await expect(view.getByLabel('Finding category', { exact: true })).toHaveValue('all');
  await expect(view.getByLabel('Finding severity', { exact: true })).toHaveValue('all');
  await expect(view.getByRole('radio', { name: 'Raw feature retention', exact: true })).toBeChecked();
  await expectFindings(view, auditModelCard(harbor).findings);

  await page.reload();
  view = dashboard(page);
  await expectRoute(page, '/risk-tradeoffs', harbor.id);
  await expect(modelSelect).toHaveValue(harbor.id);
  await expectFindings(view, auditModelCard(harbor).findings);
  await modelSelect.selectOption(lumen.id);
  await expectRoute(page, '/risk-tradeoffs', lumen.id);
  await page.reload();
  await expect(modelSelect).toHaveValue(lumen.id);
  await expectFindings(view, []);

  await view.getByRole('button', { name: 'Preview review packet', exact: true }).click();
  await expectRoute(page, '/packet-preview', lumen.id);
  await page.reload();
  await expectRoute(page, '/packet-preview', lumen.id);
  await expect(modelSelect).toHaveJSProperty('tagName', 'SELECT');
  await expect(modelSelect).toHaveValue(lumen.id);
  await page.goBack();
  await expectRoute(page, '/risk-tradeoffs', lumen.id);
  await expectFindings(dashboard(page), []);
});

test('dashboard controls and comparison table fit a narrower content area', async ({ page }) => {
  await page.setViewportSize({ width: 740, height: 900 });
  const view = await openDashboard(page);
  await expect.poll(() => view.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), {
    message: 'The dashboard must keep overflow inside its own table scroller',
  }).toBe(true);
  await expect(view.getByRole('region', { name: 'Strategy comparison table', exact: true })).toHaveAttribute('tabindex', '0');
  await view.getByLabel('Finding category', { exact: true }).selectOption({ label: 'Threats' });
  await expectFindings(view, atlasAudit.findings.filter((finding) => finding.category === 'security'), atlasAudit.findings.length);
  await view.getByRole('radio', { name: 'Minimal retention baseline', exact: true }).check();
  await expect(view.getByRole('region', { name: 'Selected strategy estimates', exact: true })).toContainText('25 / 100');
});
