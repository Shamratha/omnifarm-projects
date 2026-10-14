import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { STATUS, LEGEND, COPY, EQUITY, PHASE, roadStatus, coverageStatus } from '../../src/presentation.js';
import { scenario } from '../../src/data.js';
import { allocate } from '../../src/planner.js';
import { contrastRatio, parseColor, parseTokens, renderedColors } from '../helpers/contrast.js';

const tokens = () => parseTokens(readFileSync(new URL('../../src/tokens.css', import.meta.url), 'utf8'));
const routes = ['allocated', 'open', 'saturated', 'noCapacity', 'closed'];
const shelterShapes = { full: 'circle', partial: 'polygon', none: 'rect' };

test.beforeEach(async ({ page }) => {
  page.presentationErrors = [];
  page.on('pageerror', (error) => page.presentationErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') page.presentationErrors.push(message.text()); });
  page.on('requestfailed', (request) => page.presentationErrors.push(`${request.url()}: ${request.failure()?.errorText}`));
  page.on('response', (response) => { if (response.status() >= 400) page.presentationErrors.push(`${response.status()} ${response.url()}`); });
});

test.afterEach(async ({ page }) => {
  expect(page.presentationErrors, 'browser runtime, console, network and HTTP errors').toEqual([]);
});

async function openDashboard(page, viewport) {
  await page.setViewportSize(viewport);
  await page.goto('/');
  await expect(page.locator('#report-title')).toHaveText('Allocation report');
  await page.evaluate(() => document.fonts.ready);
}

async function assertLegends(page) {
  for (const [kind, definition] of Object.entries(LEGEND)) {
    const legend = page.locator(`section[data-legend="${kind}"]`);
    await expect(legend, `${kind} legend must be rendered at this width`).toHaveCount(1);
    await expect(legend).toBeVisible();
    await expect(legend).toHaveAttribute('aria-label', definition.title);
    await expect(legend.getByRole('heading')).toHaveText(definition.title);
    const entries = legend.locator('li[data-legend-status]');
    expect(await entries.evaluateAll((items) => items.map((item) => item.dataset.legendStatus))).toEqual(definition.keys);
    for (const key of definition.keys) {
      const entry = legend.locator(`li[data-legend-status="${key}"]`);
      await expect(entry).toBeVisible();
      await expect(entry.locator('strong')).toHaveText(STATUS[key].label);
      await expect(entry.locator('small')).toHaveText(STATUS[key].description);
      const entryBox = await entry.boundingBox();
      expect(entryBox.x, `${key} legend entry stays within the page`).toBeGreaterThanOrEqual(0);
      expect(entryBox.x + entryBox.width, `${key} legend entry must not be clipped horizontally`).toBeLessThanOrEqual(page.viewportSize().width);
      const swatch = entry.locator('.legend-swatch');
      await expect(swatch).toBeVisible();
      const box = await swatch.boundingBox();
      expect(box.width, `${key} legend swatch width`).toBeGreaterThan(0);
      expect(box.height, `${key} legend swatch height`).toBeGreaterThan(0);
    }
  }
}

// Inspect the actual elements and their ancestor backgrounds. Returning raw paint
// information keeps the WCAG calculation independent of browser/application code.
async function assertTextContrast(page, selector, context) {
  const samples = await page.locator(selector).evaluateAll((elements) => elements.flatMap((element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const ownText = [...element.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join(' ').trim();
    if (!ownText || rect.width === 0 || rect.height === 0 || style.visibility !== 'visible' || style.display === 'none') return [];
    const layers = [];
    for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
      const paint = getComputedStyle(ancestor);
      layers.push({ background: paint.backgroundColor, opacity: Number(paint.opacity), image: paint.backgroundImage });
    }
    return [{
      element: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}.${[...element.classList].join('.')}: ${ownText.slice(0, 100)}`,
      color: element instanceof SVGElement ? style.fill : style.color,
      layers,
    }];
  }));
  expect(samples.length, `${context}: no rendered text sampled (${selector})`).toBeGreaterThan(0);
  const defects = [];
  for (const sample of samples) {
    if (sample.layers.some((layer) => layer.image !== 'none')) {
      defects.push(`${sample.element}: background image requires a measured paint sample`);
      continue;
    }
    const { foreground, background } = renderedColors(sample);
    const ratio = contrastRatio(foreground, background);
    if (ratio < 4.5) defects.push(`${sample.element}: ${ratio.toFixed(3)}:1 < 4.5:1 (color ${sample.color}; backgrounds ${sample.layers.map((layer) => layer.background).join(' over ')})`);
  }
  expect(defects, `${context}: rendered text contrast defects`).toEqual([]);
}

async function assertDashboardVocabulary(page) {
  await expect(page.getByRole('heading', { name: COPY.dashboardTitle, exact: true })).toBeVisible();
  for (const title of [COPY.networkTitle, COPY.controlsTitle, COPY.ledgerTitle, COPY.inventoryTitle, COPY.weather, COPY.auditTitle]) {
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  }
  await expect(page.locator('.notice strong')).toHaveText(COPY.prototype);
  await expect(page.locator('.notice p')).toHaveText(COPY.disclaimer);
  for (const [id, label] of [['inventoryScale', COPY.inventoryControl], ['roadCapacityScale', COPY.roadControl], ['equityFloor', EQUITY.floor]]) {
    await expect(page.getByRole('slider', { name: new RegExp(label) })).toHaveAttribute('id', id);
  }
  await expect(page.locator('label:has(#equityFloor) .slider-hint')).toHaveText(EQUITY.hint);
  await expect(page.getByRole('button', { name: COPY.reset, exact: true })).toBeVisible();
  const phases = await page.locator('.phase').allTextContents();
  expect(phases.length).toBeGreaterThan(0);
  for (const label of phases) expect(Object.values(PHASE)).toContain(label.trim());
}

async function assertReportBadges(page, seen) {
  const palette = tokens();
  const samples = await page.locator('#plan .report-status[data-status]').evaluateAll((elements) => elements.map((element) => {
    const style = getComputedStyle(element);
    return {
      key: element.dataset.status, label: element.textContent.trim(), description: element.title, classes: [...element.classList],
      color: style.color, background: style.backgroundColor,
    };
  }));
  expect(samples.length, 'real report badges, excluding legend labels').toBeGreaterThan(0);
  for (const sample of samples) {
    expect(STATUS[sample.key], `unknown status ${sample.key}`).toBeDefined();
    expect(sample.label).toBe(STATUS[sample.key].label);
    expect(sample.description).toBe(STATUS[sample.key].description);
    expect(sample.classes).toContain(`report-status-${STATUS[sample.key].tone}`);
    const tone = STATUS[sample.key].tone;
    expect(parseColor(sample.color), `${sample.key} actual foreground must use the status token`).toEqual(parseColor(palette[`--status-${tone}-fg`]));
    expect(parseColor(sample.background), `${sample.key} actual background must use the status token`).toEqual(parseColor(palette[`--status-${tone}-bg`]));
    seen.add(sample.key);
  }
  await assertTextContrast(page, '#plan .report-status', 'report status badges');
}

async function setControls(page, values) {
  for (const [id, value] of Object.entries(values)) {
    await page.locator(`#${id}`).fill(String(value));
    await expect(page.locator(`#${id}`)).toHaveValue(String(value));
  }
}

async function assertMap(page, options, seenRoads, seenShelters, patterns) {
  const plan = allocate(scenario, options);
  const nodes = new Map(scenario.nodes.map((node) => [node.id, node]));
  const paints = await page.locator('.map .road, .map-wrap .road').evaluateAll((elements) => elements.map((element) => {
    const style = getComputedStyle(element);
    return {
      from: [Number(element.getAttribute('x1')), Number(element.getAttribute('y1'))],
      to: [Number(element.getAttribute('x2')), Number(element.getAttribute('y2'))],
      classes: [...element.classList], stroke: style.stroke, dash: style.strokeDasharray,
      opacity: Number(style.opacity), strokeOpacity: Number(style.strokeOpacity), width: parseFloat(style.strokeWidth),
    };
  }));
  expect(paints, 'every scenario road must be visibly rendered on the map').toHaveLength(scenario.roads.length);
  const palette = tokens();
  const map = page.locator('.map-wrap').first();
  const mapPaint = await map.evaluate((element) => {
    const layers = [];
    for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      layers.push({ background: style.backgroundColor, opacity: Number(style.opacity), image: style.backgroundImage });
    }
    return { color: getComputedStyle(element).color, layers };
  });
  expect(mapPaint.layers.every((layer) => layer.image === 'none'), 'map uses a single measurable --map-bg').toBe(true);
  const background = renderedColors(mapPaint).background;
  expect(background, 'effective map background must resolve to --map-bg').toEqual(parseColor(palette['--map-bg']));
  for (const road of scenario.roads) {
    const from = nodes.get(road.from);
    const to = nodes.get(road.to);
    const paint = paints.find((item) => item.from[0] === from.x && item.from[1] === from.y && item.to[0] === to.x && item.to[1] === to.y);
    expect(paint, `missing actual road ${road.id}`).toBeDefined();
    const key = roadStatus(plan.roads.find((item) => item.id === road.id));
    expect(paint.classes.filter((className) => routes.includes(className)), `${road.id} must have exactly its effective road state`).toEqual([key]);
    expect(LEGEND.routes.keys, `${road.id} state must be explained by route legend`).toContain(key);
    expect(paint.width, `${road.id} visible stroke`).toBeGreaterThan(0);
    expect(paint.opacity).toBe(1);
    expect(paint.strokeOpacity).toBe(1);
    expect(parseColor(paint.stroke), `${road.id} must consume its state color token`).toEqual(parseColor(palette[`--road-${key}`]));
    expect(contrastRatio(paint.stroke, background), `${road.id} (${key}) actual stroke contrast`).toBeGreaterThanOrEqual(3);
    if (patterns.has(key)) expect(paint.dash, `${key} pattern stays stable across control updates`).toBe(patterns.get(key));
    patterns.set(key, paint.dash);
    seenRoads.add(key);
  }

  const shelters = await page.locator('.map .map-node.shelter, .map-wrap .map-node.shelter').evaluateAll((elements) => elements.map((element) => ({
    transform: element.getAttribute('transform'), classes: [...element.classList],
    shapes: [...element.children].filter((child) => ['circle', 'polygon', 'rect'].includes(child.localName)).map((child) => {
      const rect = child.getBoundingClientRect();
      const style = getComputedStyle(child);
      return { tag: child.localName, width: rect.width, height: rect.height, fill: style.fill, display: style.display, visibility: style.visibility };
    }),
  })));
  expect(shelters).toHaveLength(scenario.shelters.length);
  for (const shelter of scenario.shelters) {
    const node = nodes.get(shelter.nodeId);
    const glyph = shelters.find((item) => {
      const coords = item.transform?.match(/translate\(\s*([\d.-]+)[,\s]+([\d.-]+)/);
      return coords && Number(coords[1]) === node.x && Number(coords[2]) === node.y;
    });
    expect(glyph, `missing shelter ${shelter.id}`).toBeDefined();
    const key = coverageStatus(plan.shelters.find((item) => item.id === shelter.id).coverage);
    expect(glyph.classes.filter((className) => Object.keys(shelterShapes).includes(className))).toEqual([key]);
    expect(glyph.shapes.map((shape) => shape.tag), `${shelter.id} ${key} must have a non-color shape cue`).toEqual([shelterShapes[key]]);
    const shape = glyph.shapes[0];
    expect(shape.width, `${shelter.id} visible glyph width`).toBeGreaterThan(0);
    expect(shape.height, `${shelter.id} visible glyph height`).toBeGreaterThan(0);
    expect(shape.display).not.toBe('none');
    expect(shape.visibility).toBe('visible');
    expect(contrastRatio(shape.fill, background), `${shelter.id} ${key} glyph contrast`).toBeGreaterThanOrEqual(3);
    expect(LEGEND.shelters.keys).toContain(key);
    seenShelters.add(key);
  }
}

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test.describe(`${viewport.width}px rendered presentation`, () => {
    test('central vocabulary and all three complete legends remain visible', async ({ page }) => {
      await openDashboard(page, viewport);
      await assertLegends(page);
      await assertDashboardVocabulary(page);
      await assertTextContrast(page, 'section[data-legend] h3, section[data-legend] strong, section[data-legend] small', 'real legend headings, labels and descriptions');
    });

    test('actual map states match the plan, route patterns are distinct and shelter shapes encode coverage', async ({ page }) => {
      await openDashboard(page, viewport);
      const seenRoads = new Set();
      const seenShelters = new Set();
      const patterns = new Map();
      await assertMap(page, {}, seenRoads, seenShelters, patterns);
      // No inventory leaves positive-capacity roads Open; merely lowering both
      // scales still uses every road in this fixture and never covers that state.
      await setControls(page, { inventoryScale: 0, roadCapacityScale: 0.1 });
      await assertMap(page, { inventoryScale: 0, roadCapacityScale: 0.1 }, seenRoads, seenShelters, patterns);
      await setControls(page, { roadCapacityScale: 0 });
      await assertMap(page, { inventoryScale: 0, roadCapacityScale: 0 }, seenRoads, seenShelters, patterns);
      expect([...seenRoads].sort(), 'missing states must be reached with real what-if controls').toEqual([...routes].sort());
      expect([...seenShelters].sort()).toEqual(Object.keys(shelterShapes).sort());
      expect(new Set(patterns.values()).size, `all five roads need distinct dash patterns, got ${JSON.stringify(Object.fromEntries(patterns))}`).toBe(5);
      await assertLegends(page);
    });

    test('computed contrast passes on dashboard text, controls, alerts, sidebar and report text', async ({ page }) => {
      await openDashboard(page, viewport);
      const groups = [
        ['.topbar, .topbar *', 'dashboard title and snapshot'],
        ['.notice, .notice *', 'planning notice'],
        ['.metric-grid, .metric-grid *', 'dashboard metrics and secondary text'],
        ['.controls-panel, .controls-panel *', 'control labels, hints, values and reset button'],
        ['.alert-card, .alert-card *', 'alert severity, area and description'],
        ['.map-foot, .map-foot *, .map-callout, .map-callout *, .map-node text', 'map labels and footer'],
        ['.inventory-list, .inventory-list *, .ledger-panel td, .ledger-panel td *, .ledger-panel th', 'inventory and shipment text'],
        ['.report-header, .report-header *, .report-tabs *, .report-section-heading *, .report-summary *, .report-equity-summary, .report-footnote, .report-table caption, .report-table th, .report-table td, .report-id, .report-unit', 'report tables, summaries and footnote'],
      ];
      if (viewport.width === 1440) groups.push(['.sidebar, .sidebar *', 'sidebar navigation, brand and local-mode footer']);
      for (const [selector, context] of groups) await assertTextContrast(page, selector, context);
      if (viewport.width === 1440) {
        await expect(page.locator('.sidebar-foot')).toBeVisible();
        await expect(page.locator('.sidebar-foot small')).toHaveText(COPY.noDispatch);
      }
    });

    test('real report badges retain contrast for Met, Shortfall, Disabled and zero-capacity outcomes', async ({ page }) => {
      await openDashboard(page, viewport);
      const seen = new Set();
      await assertReportBadges(page, seen);
      await setControls(page, { equityFloor: 0.8, inventoryScale: 0.1 });
      await assertReportBadges(page, seen);
      await setControls(page, { equityFloor: 0, roadCapacityScale: 0 });
      const equity = page.locator('#report-equity');
      await expect(equity.locator('tbody [data-status="disabled"]')).toHaveCount(scenario.shelters.length * scenario.resources.length);
      await expect(equity.locator('[data-status="met"]')).toHaveCount(0);
      await expect(equity).toContainText(EQUITY.disabled);
      await expect(page.locator('.control-summary')).toContainText(STATUS.disabled.label);
      expect(await equity.innerText()).not.toMatch(/\b\d+\s+(?:met|of\s+\d+\s+shelters\s+met)\b/i);
      await expect(page.locator('#report-bottlenecks [data-status="noCapacity"]')).toHaveCount(scenario.roads.filter((road) => !road.closed).length);
      await expect(page.locator('#report-shelters [data-status="disconnected"]')).toHaveCount(scenario.shelters.length * scenario.resources.length);
      await assertReportBadges(page, seen);
      await assertLegends(page);
      await assertTextContrast(page, 'section[data-legend] h3, section[data-legend] strong, section[data-legend] small', 'legends after zero controls');
      for (const key of [...LEGEND.report.keys, 'noCapacity', 'saturated', 'closed']) expect(seen, `actual report never rendered ${key}`).toContain(key);
    });
  });
}
