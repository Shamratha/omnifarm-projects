import { test, expect } from '@playwright/test';
import { modelCards } from '../src/data/modelCards.js';
import { getThreatFixtures } from '../src/data/threatFixtures.js';
import { scoringRules } from '../src/data/scoringRules.js';
import { auditModelCard } from '../src/lib/audit.js';

const atlas = modelCards.find((card) => card.id === 'atlas-assist');
const fixtureFields = [
  'id', 'modelId', 'threatId', 'title', 'synthetic', 'kind',
  'setup', 'input', 'expectedBehavior', 'explanation', 'reviewCheck',
];

function panel(page, name) {
  return page.getByRole('region', { name, exact: true });
}

async function openWithKeyboard(page, summary) {
  await expect(summary).toBeVisible();
  for (let step = 0; step < 100; step += 1) {
    if (await summary.evaluate((element) => element === document.activeElement)) break;
    await page.keyboard.press('Tab');
  }
  await expect(summary, 'Native summary must be reachable through the keyboard tab order').toBeFocused();
  await page.keyboard.press('Enter');
  await expect(summary.locator('..')).toHaveAttribute('open', '');
}

test('Atlas risk dashboard exposes both explanation panels and keyboard-expandable native details', async ({ page }) => {
  await page.goto('/risk-tradeoffs?model=atlas-assist');

  const fixturesPanel = panel(page, 'Synthetic threat fixtures');
  const rulesPanel = panel(page, 'Scoring-rule explanations');
  await expect(fixturesPanel.getByRole('heading', { name: 'Synthetic threat fixtures', level: 3, exact: true })).toBeVisible();
  await expect(rulesPanel.getByRole('heading', { name: 'Scoring-rule explanations', level: 3, exact: true })).toBeVisible();
  await expect(fixturesPanel.getByText(/Not executed: these fixture descriptions are narrative-only/)).toBeVisible();

  const fixtures = getThreatFixtures(atlas);
  await expect(fixturesPanel.locator('details')).toHaveCount(fixtures.length);
  await expect(fixturesPanel.locator('details[open]')).toHaveCount(0);
  for (const fixture of fixtures) {
    const summary = fixturesPanel.locator('summary').filter({ hasText: fixture.id });
    await expect(summary).toContainText(fixture.title);
  }

  const firstFixture = fixtures[0];
  const firstFixtureSummary = fixturesPanel.locator('summary').filter({ hasText: firstFixture.id });
  await openWithKeyboard(page, firstFixtureSummary);
  const firstDetails = firstFixtureSummary.locator('..');
  await expect(firstDetails).toContainText(firstFixture.setup);
  await expect(firstDetails.locator('pre')).toHaveText(firstFixture.input);
  await expect(firstDetails).toContainText(firstFixture.expectedBehavior);
  await expect(firstDetails).toContainText(firstFixture.explanation);
  await expect(firstDetails).toContainText(firstFixture.reviewCheck);
  const threat = atlas.threats.find((item) => item.id === firstFixture.threatId);
  await expect(firstDetails).toContainText(threat.severity);
  await expect(firstDetails).toContainText(threat.status);
  await expect(firstDetails).toContainText(threat.mitigation);
  await page.keyboard.press('Space');
  await expect(firstDetails).not.toHaveAttribute('open', '');
  await expect(firstDetails.locator('pre')).not.toBeVisible();

  await expect(rulesPanel.locator('details')).toHaveCount(scoringRules.length);
  await expect(rulesPanel.locator('details[open]')).toHaveCount(0);
  await expect(rulesPanel.getByText(/equal-weight mean of the five unrounded dimension ratios/)).toBeVisible();
  const coverage = rulesPanel.getByRole('region', { name: 'Coverage dimensions', exact: true });
  for (const dimension of auditModelCard(atlas).dimensions) {
    const item = coverage.getByRole('listitem').filter({ hasText: dimension.label });
    await expect(item).toContainText(`${dimension.covered} / ${dimension.total}`);
  }
  const firstRuleSummary = rulesPanel.locator('summary').filter({ hasText: scoringRules[0].id });
  await openWithKeyboard(page, firstRuleSummary);
  const firstRuleDetails = firstRuleSummary.locator('..');
  await expect(firstRuleDetails).toContainText(scoringRules[0].title);
  await expect(firstRuleDetails).toContainText(scoringRules[0].trigger);
  await expect(firstRuleDetails).toContainText(scoringRules[0].effect);
  await expect(firstRuleDetails).toContainText(scoringRules[0].limit);
  await page.keyboard.press('Space');
  await expect(firstRuleDetails).not.toHaveAttribute('open', '');
});

for (const card of modelCards) {
  test(`${card.name} packet preview includes every fixture field and rule explanation`, async ({ page }) => {
    await page.goto(`/packet-preview?model=${card.id}`);
    const content = page.getByRole('region', { name: 'Review packet content', exact: true });
    // Assert the new sections by name, without fixing the engine's heading count.
    await expect(content.getByRole('heading', { name: 'Synthetic threat fixtures', level: 2, exact: true })).toBeVisible();
    await expect(content.getByRole('heading', { name: 'Scoring-rule explanations', level: 2, exact: true })).toBeVisible();

    for (const fixture of getThreatFixtures(card)) {
      for (const field of fixtureFields) await expect(content).toContainText(String(fixture[field]));
      const threat = card.threats.find((item) => item.id === fixture.threatId);
      for (const value of [threat.name, threat.severity, threat.status, threat.mitigation]) {
        await expect(content).toContainText(value);
      }
    }
    for (const other of modelCards.filter((item) => item.id !== card.id)) {
      for (const fixture of getThreatFixtures(other)) await expect(content).not.toContainText(fixture.id);
    }

    for (const rule of scoringRules) {
      for (const field of ['id', 'title', 'category', 'trigger', 'effect', 'limit']) {
        await expect(content).toContainText(rule[field]);
      }
    }
  });
}

test('opening narrative fixtures displays inert text and preserves coverage without external requests', async ({ page, baseURL }) => {
  const externalRequests = [];
  const origin = new URL(baseURL).origin;
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (/^https?:$/.test(url.protocol) && url.origin !== origin) {
      externalRequests.push(url.href);
      await route.abort();
    } else {
      await route.continue();
    }
  });

  await page.goto('/risk-tradeoffs?model=atlas-assist');
  const fixturesPanel = panel(page, 'Synthetic threat fixtures');
  await expect(fixturesPanel).toBeVisible();
  const coverage = panel(page, 'Scoring-rule explanations').getByRole('region', { name: 'Coverage dimensions', exact: true });
  const originalCoverage = await coverage.innerText();
  for (const fixture of getThreatFixtures(atlas)) {
    const summary = fixturesPanel.locator('summary').filter({ hasText: fixture.id });
    await openWithKeyboard(page, summary);
    await expect(summary.locator('..').locator('pre')).toHaveText(fixture.input);
  }
  await expect(fixturesPanel.locator('a, img, script, iframe, object, embed, form, button')).toHaveCount(0);
  expect((await coverage.innerText()).replace(/\s+/g, ' ')).toBe(originalCoverage.replace(/\s+/g, ' '));
  expect(externalRequests).toEqual([]);
});
