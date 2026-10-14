import { test, expect } from '@playwright/test';
import { STATUS, PRIORITY_STYLE, COPY } from '../../src/presentation.js';

for (const width of [1440, 390, 320]) {
  test(`final wording and spacing remain readable at ${width}px`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('requestfailed', (request) => errors.push(request.url()));
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/');
    await page.evaluate(() => document.fonts.ready);
    await expect(page).toHaveTitle('Climate Resource Allocator');
    await expect(page.locator('.panel-intro')).toHaveText(COPY.controlsIntro);

    const metrics = await page.locator('.metric-note').evaluateAll((notes) => notes.map((note) => {
      const noteBox = note.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(note);
      return {
        text: note.textContent,
        clipped: note.scrollWidth > note.clientWidth + 1 || note.scrollHeight > note.clientHeight + 1,
        outside: [...range.getClientRects()].some((rect) => rect.left < noteBox.left - 1 || rect.right > noteBox.right + 1 || rect.top < noteBox.top - 1 || rect.bottom > noteBox.bottom + 1),
      };
    }));
    expect(metrics).toHaveLength(4);
    for (const metric of metrics) {
      expect(metric.clipped, metric.text).toBe(false);
      expect(metric.outside, metric.text).toBe(false);
    }
    const phaseStyles = await page.locator('.phase').evaluateAll((chips) => chips.map((chip) => {
      const style = getComputedStyle(chip);
      return { classes: [...chip.classList], font: style.fontSize, padding: style.padding, minWidth: style.minWidth, minHeight: style.minHeight };
    }));
    expect(phaseStyles.some((style) => style.classes.includes('phase-equity'))).toBe(true);
    expect(phaseStyles.some((style) => style.classes.includes('phase-priority'))).toBe(true);
    for (const style of phaseStyles) {
      expect(style.classes).not.toContain('priority');
      expect(style.minWidth).toBe('0px');
      expect(style.minHeight).toBe('0px');
      expect(style.font).toBe(phaseStyles[0].font);
      expect(style.padding).toBe(phaseStyles[0].padding);
    }
    for (const key of Object.keys(PRIORITY_STYLE)) {
      const badges = page.locator(`.priority[data-priority="${key}"]`);
      for (const badge of await badges.all()) await expect(badge).toHaveAttribute('title', STATUS[key].description);
    }
    const legendBoxes = await page.locator('#plan > .status-legend').evaluateAll((legends) => legends.map((legend) => {
      const style = getComputedStyle(legend);
      const rect = legend.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, margin: style.marginTop, padding: style.paddingTop };
    }));
    expect(legendBoxes).toHaveLength(2);
    for (const box of legendBoxes) {
      expect(box.margin).toBe('0px');
      expect(box.padding).toBe('0px');
    }
    expect(legendBoxes[1].top - legendBoxes[0].bottom).toBe(18);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}
