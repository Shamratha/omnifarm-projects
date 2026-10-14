import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { LEGEND, PRIORITY, PRIORITY_STYLE, STATUS } from '../../src/presentation.js';
import { scenario } from '../../src/data.js';
import { contrastRatio, parseColor, parseTokens } from '../helpers/contrast.js';

const tokens = parseTokens(readFileSync(new URL('../../src/tokens.css', import.meta.url), 'utf8'));
const viewports = [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
  { width: 320, height: 844 },
];

test.beforeEach(async ({ page }) => {
  page.priorityErrors = [];
  page.on('pageerror', (error) => page.priorityErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') page.priorityErrors.push(message.text()); });
  page.on('requestfailed', (request) => page.priorityErrors.push(`${request.url()}: ${request.failure()?.errorText}`));
  page.on('response', (response) => { if (response.status() >= 400) page.priorityErrors.push(`${response.status()} ${response.url()}`); });
});

test.afterEach(async ({ page }) => {
  expect(page.priorityErrors, 'browser runtime, console, network and HTTP errors').toEqual([]);
});

async function openDashboard(page, viewport) {
  await page.setViewportSize(viewport);
  await page.goto('/');
  await expect(page.locator('#report-title')).toHaveText('Allocation report');
  await page.evaluate(() => document.fonts.ready);
}

async function assertNoPageOverflow(page, context) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${context}: page must not overflow horizontally`).toBe(true);
}

async function assertPriorityLegend(page, viewport) {
  const legend = page.locator('section[data-legend="priority"]');
  await expect(legend).toHaveCount(1);
  await expect(legend).toBeVisible();
  await expect(legend).toHaveAttribute('aria-label', LEGEND.priority.title);
  await expect(legend.getByRole('heading')).toHaveText(LEGEND.priority.title);
  const entries = legend.locator('li[data-legend-status]');
  expect(await entries.evaluateAll((items) => items.map((item) => item.dataset.legendStatus))).toEqual(LEGEND.priority.keys);

  const boxes = [];
  for (const key of LEGEND.priority.keys) {
    const entry = legend.locator(`li[data-legend-status="${key}"]`);
    const badge = entry.locator(`.priority.${key}[data-priority="${key}"]`);
    const description = entry.locator('small');
    await expect(entry).toBeVisible();
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText(`${PRIORITY_STYLE[key].rank}${PRIORITY[key]}`);
    await expect(badge.locator('.priority-rank')).toHaveAttribute('aria-hidden', 'true');
    await expect(description).toHaveText(STATUS[key].description);
    const entryBox = await entry.boundingBox();
    const badgeBox = await badge.boundingBox();
    const descriptionBox = await description.boundingBox();
    boxes.push(entryBox);
    for (const [name, box] of [['entry', entryBox], ['badge', badgeBox], ['description', descriptionBox]]) {
      expect(box, `${key} ${name} must have a rendered box`).not.toBeNull();
      expect(box.x, `${key} ${name} left edge at ${viewport.width}px`).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, `${key} ${name} right edge at ${viewport.width}px`).toBeLessThanOrEqual(viewport.width);
    }
    const noHorizontalClip = await entry.evaluate((element) => element.scrollWidth <= element.clientWidth + 1);
    expect(noHorizontalClip, `${key} legend entry text must not be clipped`).toBe(true);
  }
  for (let index = 1; index < boxes.length; index += 1) {
    expect(boxes[index].y, `${LEGEND.priority.keys[index]} must not overlap the prior legend entry`).toBeGreaterThanOrEqual(boxes[index - 1].y + boxes[index - 1].height);
  }
}

async function assertPrioritySizingAndContrast(page, selector, context) {
  const samples = await page.locator(selector).evaluateAll((elements) => elements.map((element) => {
    const style = getComputedStyle(element);
    return {
      key: element.dataset.priority,
      color: style.color,
      background: style.backgroundColor,
      minHeight: style.minHeight,
      minWidth: style.minWidth,
      fontSize: style.fontSize,
      width: element.getBoundingClientRect().width,
      height: element.getBoundingClientRect().height,
    };
  }));
  expect(samples.length, `${context}: expected rendered priority badges`).toBeGreaterThan(0);
  for (const sample of samples) {
    const style = PRIORITY_STYLE[sample.key];
    expect(style, `${context}: unknown priority ${sample.key}`).toBeDefined();
    expect(sample.minHeight, `${sample.key} min-height`).toBe('28px');
    expect(sample.minWidth, `${sample.key} min-width`).toBe('100px');
    expect(sample.fontSize, `${sample.key} font size`).toBe('12px');
    expect(sample.width, `${sample.key} rendered width`).toBeGreaterThanOrEqual(100);
    expect(sample.height, `${sample.key} rendered height`).toBeGreaterThanOrEqual(28);
    expect(parseColor(sample.color), `${sample.key} foreground token`).toEqual(parseColor(tokens[style.foreground]));
    expect(parseColor(sample.background), `${sample.key} background token`).toEqual(parseColor(tokens[style.background]));
    expect(contrastRatio(sample.color, sample.background), `${sample.key} rendered contrast`).toBeGreaterThanOrEqual(4.5);
  }
}

async function assertReportPriorityRows(page) {
  const rows = page.locator('#report-shelters tbody tr');
  expect(await rows.count()).toBe(scenario.shelters.length * scenario.resources.length);
  for (const shelter of scenario.shelters) {
    const matchingRows = page.locator(`#report-shelters tbody tr:has-text("(${shelter.id})")`);
    expect(await matchingRows.count(), `${shelter.id} rows`).toBe(scenario.resources.length);
    await expect(matchingRows.locator(`.priority.${shelter.priority}[data-priority="${shelter.priority}"]`)).toHaveCount(scenario.resources.length);
  }
  await assertPrioritySizingAndContrast(page, '#report-shelters .priority[data-priority]', 'real report priority badges');
}

for (const viewport of viewports) {
  test(`priority legend and report badges remain complete at ${viewport.width}px`, async ({ page }) => {
    await openDashboard(page, viewport);
    await assertPriorityLegend(page, viewport);
    await expect(page.locator('#plan section[data-legend="priority"]')).toHaveCount(1);
    await expect(await page.locator('#plan section[data-legend="priority"]').evaluate((legend) => {
      const section = legend.closest('#plan');
      return [...section.children].indexOf(legend) < [...section.children].findIndex((child) => child.id === 'report-shelters');
    })).toBe(true);
    await assertReportPriorityRows(page);
    await assertNoPageOverflow(page, `${viewport.width}px baseline`);
  });
}

test('320px report uses local table scrolling so priority data remains reachable without page overflow', async ({ page }) => {
  await openDashboard(page, { width: 320, height: 844 });
  const scroll = page.locator('#report-shelters .report-table-scroll');
  const dimensions = await scroll.evaluate((element) => {
    const max = element.scrollWidth - element.clientWidth;
    element.scrollLeft = max;
    const reachedEnd = element.scrollLeft === max;
    const priority = element.querySelector('.priority[data-priority]');
    const priorityBox = priority.getBoundingClientRect();
    const scrollBox = element.getBoundingClientRect();
    element.scrollLeft = 0;
    return {
      max, reachedEnd,
      priorityReachableAtStart: priorityBox.left >= scrollBox.left && priorityBox.left < scrollBox.right,
      overflow: getComputedStyle(element).overflowX,
    };
  });
  expect(dimensions.max, 'report table must have local horizontal scroll at 320px').toBeGreaterThan(0);
  expect(dimensions.reachedEnd, 'local report scroll must reach its end').toBe(true);
  expect(['auto', 'scroll']).toContain(dimensions.overflow);
  expect(dimensions.priorityReachableAtStart, 'priority data must remain reachable in the local table viewport').toBe(true);
  await assertReportPriorityRows(page);
  await assertNoPageOverflow(page, '320px scrolled report');
});
