import { test, expect } from '@playwright/test';
import { scenario } from '../../src/data.js';
import { allocate } from '../../src/planner.js';
import { buildReport } from '../../src/report.js';

const sectionIds = ['shelters', 'unmet', 'bottlenecks', 'expired', 'equity'];
const number = (text) => Number(text.replace(/,/g, '').trim());

async function assertMatchesPlan(page, options = {}) {
  const plan = allocate(scenario, options);
  const expected = buildReport(scenario, plan, options);
  const allocations = await page.locator('#report-shelters tbody tr').evaluateAll((rows) =>
    rows.map((row) => [...row.querySelectorAll('td')].slice(-3).map((cell) => cell.textContent.trim())));
  expect(allocations).toEqual(expected.shelters.flatMap((shelter) => shelter.resources.map((resource) =>
    [resource.demand, resource.allocated, resource.unmet].map((value) =>
      new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value)))));
  const expired = await page.locator('#report-expired tbody tr').evaluateAll((rows) =>
    rows.map((row) => row.children[4].textContent));
  expect(expired.map(number)).toEqual(expected.expired.map((lot) => lot.excludedQuantity));
  const formatted = (value) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
  const rowNumbers = (selector) => page.locator(selector).evaluateAll((rows) =>
    rows.map((row) => [...row.querySelectorAll('td.report-number')].map((cell) => cell.textContent.trim())));
  const unmetRows = await rowNumbers('#report-unmet tbody tr:has(td.report-number)');
  expect(unmetRows).toEqual(expected.unmet.flatMap((shelter) => shelter.resources
    .filter((resource) => resource.unmet > 0)
    .map((resource) => [resource.demand, resource.allocated, resource.unmet].map(formatted))));
  const roads = await page.locator('#report-bottlenecks table').first().locator('tbody tr:has(td.report-number)').evaluateAll((rows) =>
    rows.map((row) => [...row.querySelectorAll('td.report-number')].slice(0, 3).map((cell) => cell.textContent.trim())));
  expect(roads).toEqual(
    expected.bottlenecks.map((road) => [road.used, road.remaining, road.capacity].map(formatted)));
  const equity = await rowNumbers('#report-equity tbody tr');
  expect(equity).toEqual(expected.equity.shelters.flatMap((shelter) => shelter.resources.map((resource) =>
    [`${formatted(shelter.vulnerability * 100)}%`, ...[resource.target, resource.allocated, resource.shortfall].map(formatted)])));
  await expect(page.locator('#report-equity .report-section-heading')).toContainText(
    options.equityFloor === 0 ? 'Disabled' : `${(options.equityFloor ?? 0.4) * 100}% floor`);
}

test.beforeEach(async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('requestfailed', (request) => errors.push(request.failure()?.errorText));
  page.on('response', (response) => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
  await page.goto('/');
  await expect(page.locator('#report-title')).toHaveText('Allocation report');
  // Keep diagnostics on the page so afterEach also checks control updates.
  page.reportErrors = errors;
});

test.afterEach(async ({ page }) => {
  expect(page.reportErrors).toEqual([]);
});

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test(`report sections align and numbers are readable at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await assertMatchesPlan(page);
    const boxes = [];
    for (const id of sectionIds) {
      const section = page.locator(`#report-${id}`);
      await expect(section).toBeVisible();
      boxes.push(await section.boundingBox());
      await expect(section.locator('caption').first()).toBeVisible();
      for (const selector of ['td.report-number', 'th.report-number']) {
        const alignment = await section.locator(selector).first().evaluate((cell) => getComputedStyle(cell).textAlign);
        expect(alignment).toBe('right');
      }
    }
    for (const box of boxes) {
      expect(Math.abs(box.x - boxes[0].x)).toBeLessThan(1);
      expect(Math.abs(box.width - boxes[0].width)).toBeLessThan(1);
    }
    const overflows = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflows).toBe(false);
    await page.getByRole('link', { name: 'Expired supplies', exact: true }).click();
    await expect(page).toHaveURL(/#report-expired$/);
    await expect(page.locator('#report-expired')).toContainText('UTC');
    await expect(page.locator('.notice')).toContainText('not an emergency dispatch system');
  });
}

test('what-if controls update every report and reset restores baseline', async ({ page }) => {
  const baseline = await page.locator('#plan').innerHTML();
  await page.locator('#inventoryScale').fill('0.5');
  await page.locator('#roadCapacityScale').fill('0.5');
  await assertMatchesPlan(page, { inventoryScale: 0.5, roadCapacityScale: 0.5 });
  await page.locator('#equityFloor').fill('0.8');
  await assertMatchesPlan(page, { inventoryScale: 0.5, roadCapacityScale: 0.5, equityFloor: 0.8 });
  await page.locator('#inventoryScale').fill('0');
  await page.locator('#roadCapacityScale').fill('0');
  await page.locator('#equityFloor').fill('0');
  await assertMatchesPlan(page, { inventoryScale: 0, roadCapacityScale: 0, equityFloor: 0 });
  await expect(page.locator('#report-bottlenecks')).toContainText('No capacity');
  await expect(page.locator('#report-unmet')).toContainText('Disconnected');
  await page.getByRole('button', { name: 'Reset to baseline' }).click();
  await expect(page.locator('#plan')).toHaveJSProperty('innerHTML', baseline);
  await assertMatchesPlan(page);
});

test('repeated keyboard adjustments retain control focus', async ({ page }) => {
  const slider = page.locator('#roadCapacityScale');
  await slider.focus();
  await page.keyboard.press('ArrowRight');
  await expect(slider).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(slider).toHaveValue('1.2');
  await expect(slider).toBeFocused();
  await assertMatchesPlan(page, { roadCapacityScale: 1.2 });
});
