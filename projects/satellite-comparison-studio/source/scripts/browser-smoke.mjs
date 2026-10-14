import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
const errors = [], external = [];
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => { if (!request.url().startsWith('http://localhost:4173/')) external.push(request.url()); });

const viewSpecs = {
  'side-by-side': { heading: 'Infrared signal', canvas: null },
  difference: { heading: 'Absolute difference', canvas: 'differenceCanvas' },
  masks: { heading: 'Mask classes', canvas: 'maskCanvas' },
  confidence: { heading: 'Confidence scale', canvas: 'confidenceCanvas' },
};

const number = value => value.toLocaleString('en-GB');
const percent = value => `${(value * 100).toFixed(1)}%`;

async function selectComparison(fixture, band, threshold) {
  await page.locator('#fixtureSelect').selectOption(fixture);
  await page.locator(`[data-band="${band}"]`).click();
  await page.locator('#thresholdInput').evaluate((input, value) => {
    input.value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, threshold);
  assert.equal(await page.locator('#thresholdValue').textContent(), threshold.toFixed(2));
}

function assertReportCounts(report) {
  const { stats, pixels, excluded, geometry } = report;
  assert.equal(stats.totalCount, geometry.width * geometry.height);
  assert.equal(stats.totalCount, 9216);
  assert.equal(geometry.width, 96);
  assert.equal(geometry.height, 96);
  for (const key of ['differences', 'confidence', 'valid', 'changed']) {
    assert.equal(pixels[key].length, stats.totalCount, key);
  }
  const indices = flags => flags.flatMap((flag, index) => flag ? [index] : []);
  const validIndices = indices(pixels.valid);
  const changedIndices = indices(pixels.changed);
  assert.equal(stats.validCount, validIndices.length);
  assert.equal(stats.changedCount, changedIndices.length);
  assert.deepEqual(pixels.changedIndices, changedIndices);
  assert.deepEqual(pixels.changedRows, changedIndices.map(index => ({
    index,
    row: Math.floor(index / geometry.width),
    column: index % geometry.width,
    difference: pixels.differences[index],
    confidence: pixels.confidence[index],
  })));
  assert.equal(pixels.changedRows.length, stats.changedCount);
  assert.deepEqual(excluded.indices, indices(pixels.valid.map(valid => !valid)));
  assert.equal(excluded.count, excluded.indices.length);
  assert.equal(stats.excludedCount, excluded.count);
  assert.equal(stats.validCount + stats.excludedCount, stats.totalCount);
  const belowThresholdCount = pixels.valid.filter((valid, index) => valid && !pixels.changed[index]).length;
  assert.equal(stats.changedCount + belowThresholdCount + stats.excludedCount, stats.totalCount);
  const exclusionUnion = new Set();
  for (const category of ['cloud', 'nodata', 'nonFinite']) {
    const categoryIndices = excluded[`${category}Indices`];
    assert.equal(excluded[`${category}Count`], categoryIndices.length);
    assert.equal(stats[`${category}Count`], categoryIndices.length);
    assert.equal(new Set(categoryIndices).size, categoryIndices.length);
    for (const index of categoryIndices) {
      assert.ok(Number.isInteger(index) && index >= 0 && index < stats.totalCount);
      exclusionUnion.add(index);
    }
  }
  assert.deepEqual([...exclusionUnion].sort((a, b) => a - b), excluded.indices);
  for (const index of changedIndices) {
    assert.equal(pixels.valid[index], true, `changed pixel ${index} must be valid`);
    assert.equal(exclusionUnion.has(index), false);
    assert.ok(pixels.differences[index] + Number.EPSILON * 8 >= report.threshold.value);
  }
  assert.equal(stats.coverage, stats.validCount / stats.totalCount);
  assert.equal(stats.changedFraction, stats.validCount ? stats.changedCount / stats.validCount : 0);
  const meanConfidence = stats.validCount
    ? validIndices.reduce((sum, index) => sum + pixels.confidence[index], 0) / stats.validCount
    : null;
  assert.equal(stats.meanConfidence, meanConfidence);
  assert.deepEqual(pixels.lowConfidenceIndices, validIndices.filter(index => pixels.confidence[index] < report.confidencePolicy.lowConfidenceThreshold));
  assert.equal(stats.lowConfidenceCount, pixels.lowConfidenceIndices.length);
}

async function assertExport({ fixture, band, threshold, changedCount, outcome, stale, suffix = '', screenshot = false }) {
  const artifactName = `fieldnote-${fixture}-${band}-threshold-${threshold.toFixed(2)}${suffix ? `-${suffix}` : ''}`;
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#exportButton').click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), `fieldnote-${fixture}-${band}.html`);
  // A real .html file is required for Chromium to render the offline document.
  const savedReportPath = `${process.cwd()}/test-results/${artifactName}.html`;
  await download.saveAs(savedReportPath);
  const readable = await readFile(savedReportPath, 'utf8');
  for (const text of ['Fieldnote change-detection report', 'Decision summary', 'Confidence interpretation', 'Mask exclusions']) {
    assert.ok(readable.includes(text), text);
  }
  const reportErrors = [], reportExternal = [];
  const reportContext = await browser.newContext();
  try {
    const reportPage = await reportContext.newPage();
    reportPage.on('pageerror', error => reportErrors.push(error.message));
    reportPage.on('request', request => {
      if (!['file:', 'data:', 'blob:'].includes(new URL(request.url()).protocol)) reportExternal.push(request.url());
    });
    await reportPage.goto(pathToFileURL(savedReportPath).href, { waitUntil: 'load' });
    const report = JSON.parse(await reportPage.locator('#reportData').textContent());
    assert.equal(await reportPage.locator('h1').textContent(), 'Fieldnote change-detection report');
    for (const heading of ['Mask exclusions', 'Confidence interpretation']) {
      assert.equal(await reportPage.locator('section').filter({ hasText: heading }).first().isVisible(), true);
    }
    const jsonDownloadPromise = reportPage.waitForEvent('download');
    await reportPage.locator('#downloadJson').click();
    const jsonDownload = await jsonDownloadPromise;
    assert.equal(jsonDownload.suggestedFilename(), 'fieldnote-report.json');
    const savedJsonPath = `${process.cwd()}/test-results/${artifactName}.json`;
    await jsonDownload.saveAs(savedJsonPath);
    assert.deepEqual(JSON.parse(await readFile(savedJsonPath, 'utf8')), report);
    assert.deepEqual(reportErrors, []);
    assert.deepEqual(reportExternal, []);
    assert.equal(report.synthetic, true);
    assert.equal(report.band, band);
    assert.equal(report.threshold.value, threshold);
    assert.equal(report.threshold.inclusive, true);
    assert.deepEqual(report.stale, stale);
    assertReportCounts(report);
    assert.equal(report.generatedAt, '2025-06-18T12:00:00.000Z');
    assert.equal(report.analysisAt, report.generatedAt, 'report.analysisAt must match the fixed generatedAt clock');
    if (changedCount === 'positive') {
      assert.ok(report.stats.changedCount > 0);
      if (threshold === 0) assert.equal(report.stats.changedCount, report.stats.validCount);
    } else assert.equal(report.stats.changedCount, changedCount);
    assert.equal(report.summary.outcome, outcome, artifactName);
    for (const [id, text] of [['reportHeadline', report.summary.headline], ['reportInterpretation', report.summary.interpretation]]) {
      assert.equal(typeof text, 'string');
      assert.ok(text.length > 0);
      assert.equal(await reportPage.locator(`#${id}`).isVisible(), true);
      assert.equal(await reportPage.locator(`#${id}`).textContent(), text);
    }
    assert.equal(await page.locator('#changeSummary').textContent(), report.summary.headline);
    assert.equal(await page.locator('#changedPixels').textContent(), `${number(report.stats.changedCount)} / ${number(report.stats.totalCount)}`);
    assert.equal(await page.locator('#changedPercent').textContent(), report.stats.validCount ? percent(report.stats.changedCount / report.stats.totalCount) : 'N/A');
    assert.equal(await page.locator('#validCoverage').textContent(), percent(report.stats.coverage));
    assert.equal(await page.locator('#meanConfidence').textContent(), report.stats.meanConfidence === null ? '—' : percent(report.stats.meanConfidence));
    const metrics = reportPage.locator('.metric');
    for (const text of [
      report.stats.validCount ? `${number(report.stats.changedCount)} / ${number(report.stats.totalCount)}` : 'Not comparable',
      report.stats.validCount ? `${percent(report.stats.changedCount / report.stats.totalCount)} of all pixels` : 'No valid pixels were available',
      percent(report.stats.coverage),
      report.stats.meanConfidence === null ? '—' : percent(report.stats.meanConfidence),
    ]) assert.equal(await metrics.filter({ hasText: text }).first().isVisible(), true, text);
    if (report.pixels.changedRows.length === 0) {
      assert.equal(typeof report.summary.appendixWording, 'string');
      assert.ok(report.summary.appendixWording.length > 0);
      assert.equal(await reportPage.locator('#appendixMessage').isVisible(), true);
      assert.ok((await reportPage.locator('#appendixMessage').textContent()).includes(report.summary.appendixWording));
    } else {
      assert.equal(await reportPage.locator('#appendixMessage').count(), 0);
      const renderedRows = reportPage.locator('table tbody tr');
      const expectedRows = report.pixels.changedRows.slice(0, 250);
      assert.equal(await renderedRows.count(), expectedRows.length);
      for (let i = 0; i < expectedRows.length; i++) {
        const pixel = expectedRows[i];
        assert.deepEqual(await renderedRows.nth(i).locator('td').allTextContents(), [
          String(pixel.index), String(pixel.row), String(pixel.column), pixel.difference.toFixed(4), percent(pixel.confidence),
        ]);
      }
    }
    if (outcome === 'no-change-detected') {
      assert.ok(report.stats.validCount > 0);
      assert.match(await reportPage.locator('#reportHeadline').textContent(), /No change detected at threshold/);
      assert.match(report.summary.interpretation, /threshold/i);
      // A negative result at one threshold is not a claim that the images are identical.
      for (const text of [report.summary.headline, report.summary.interpretation, report.summary.appendixWording]) {
        for (const sentence of text.split(/(?<=[.!?])\s+/).filter(sentence => /\bidentical\b/i.test(sentence))) {
          assert.match(sentence, /\b(?:not|never|no|doesn't|don't|cannot|can't)\b/i, 'No-change wording must not claim identical imagery');
        }
      }
    } else if (outcome === 'not-comparable') {
      assert.equal(report.stats.validCount, 0);
      assert.match(await reportPage.locator('#reportHeadline').textContent(), /Not comparable/);
      assert.match(await reportPage.locator('#reportInterpretation').textContent(), /No valid pixels were available/);
    }
    if (stale.before || stale.after) {
      assert.match(readable, /STALE IMAGERY/);
      assert.match(readable, /Do not read a detected difference as a current event/);
      if (stale.before && !stale.after) assert.match(report.summary.headline, /before/i);
    }
    if (fixture === 'archive-haze') assert.equal(report.excluded.cloudCount, 911);
    if (screenshot) await reportPage.screenshot({ path: 'test-results/report.png', fullPage: true });
  } finally {
    await reportContext.close();
  }
}

async function assertFreshness(expectedStatus) {
  for (const id of ['beforeFreshness', 'afterFreshness']) {
    const freshness = page.locator(`#${id}`);
    assert.equal(await freshness.isVisible(), true);
    const text = await freshness.textContent();
    assert.match(text, new RegExp(id.startsWith('before') ? 'BEFORE' : 'AFTER'));
    assert.match(text, new RegExp(expectedStatus));
    assert.match(text, /\d{2}\s+[A-Z]{3,4}\s+2025/);
    assert.match(text, /\d+\.\d+/);
    assert.match(text, /14[- ]day(?:s)?/i);
  }
}

async function assertTileBadges() {
  const cards = page.locator('#tilePair .tile-card');
  assert.equal(await cards.count(), 2);
  for (let index = 0; index < await cards.count(); index++) {
    const card = cards.nth(index);
    assert.equal(await card.locator('.tile-mask-badges').isVisible(), true);
    for (const [className, label] of [['cloud', 'Cloud'], ['nodata', 'Nodata']]) {
      const badge = card.locator(`.tile-mask-badges .mask-badge.${className}`);
      assert.equal(await badge.isVisible(), true);
      const text = await badge.textContent();
      assert.match(text, new RegExp(label, 'i'));
      assert.match(text, /\b\d[\d,]*\b/);
    }
  }
}

async function assertMaskListBadges() {
  assert.equal(await page.locator('#maskList .mask-index.cloud').textContent(), 'Cloud');
  assert.equal(await page.locator('#maskList .mask-index.nodata').textContent(), 'Nodata');
}

async function assertCanvasDescriptions() {
  const expected = {
    beforeCanvas: ['comparisonLegend', 'viewLegend', 'inspectionHelp', 'beforeFreshness'],
    afterCanvas: ['comparisonLegend', 'viewLegend', 'inspectionHelp', 'afterFreshness'],
    differenceCanvas: ['comparisonLegend', 'viewLegend', 'inspectionHelp', 'beforeFreshness', 'afterFreshness'],
    maskCanvas: ['comparisonLegend', 'viewLegend', 'inspectionHelp', 'beforeFreshness', 'afterFreshness'],
    confidenceCanvas: ['comparisonLegend', 'viewLegend', 'inspectionHelp', 'beforeFreshness', 'afterFreshness'],
  };
  assert.equal(await page.locator('#inspectionHelp').count(), 1);
  for (const [id, requiredIds] of Object.entries(expected)) {
    const canvas = page.locator(`#${id}`);
    assert.equal(await canvas.getAttribute('tabindex'), '0');
    const describedBy = (await canvas.getAttribute('aria-describedby')).split(/\s+/);
    for (const requiredId of requiredIds) assert.ok(describedBy.includes(requiredId), `${id} should describe ${requiredId}`);
  }
  assert.equal(await page.locator('#pixelInfo').getAttribute('aria-live'), 'polite');
}

async function assertContext(view, heading, expectedFreshness) {
  assert.equal(await page.locator('#comparisonLegend').isVisible(), true);
  assert.equal(await page.locator('#comparisonLegend .mask-badge.cloud').textContent(), 'Cloud');
  assert.equal(await page.locator('#comparisonLegend .mask-badge.nodata').textContent(), 'Nodata');
  assert.equal(await page.locator('#comparisonLegend').evaluate(node => !node.closest('#tilePair, #differenceWrap, #maskWrap, #confidenceWrap')), true);
  assert.equal(await page.locator('#viewLegend').isVisible(), true);
  assert.match(await page.locator('#viewLegend').textContent(), new RegExp(heading.replace('-', '[- ]')));
  const freshnessBanners = page.locator('#freshnessBanners');
  const notice = freshnessBanners.locator('#freshnessNotice');
  assert.equal(await freshnessBanners.isVisible(), true);
  assert.equal(await notice.isVisible(), true);
  const noticeText = await notice.textContent();
  assert.match(noticeText, /analysis clock/i);
  assert.match(noticeText, /18\s+JUN(?:E)?\s+2025/i);
  if (expectedFreshness === 'STALE') assert.match(noticeText, /not current observations/i);
  await assertFreshness(expectedFreshness);
  await assertCanvasDescriptions();
}

async function activateView(view, method = 'click') {
  const tab = page.locator(`[data-view="${view}"]`);
  if (method === 'keyboard') {
    await tab.focus();
    await page.keyboard.press('Enter');
  } else {
    await tab.click();
  }
  for (const [name] of Object.entries(viewSpecs)) {
    const button = page.locator(`[data-view="${name}"]`);
    assert.equal(await button.getAttribute('role'), 'tab');
    assert.equal(await button.getAttribute('aria-selected'), name === view ? 'true' : 'false');
  }
}

try {
  await mkdir('test-results', { recursive: true });
  await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
  assert.equal(await page.locator('#changedPixels').textContent(), '585 / 9,216');
  assert.equal(await page.locator('#freshnessStatus').textContent(), 'FRESH');
  await assertContext('side-by-side', 'Infrared signal', 'FRESH');
  await assertTileBadges();
  await assertMaskListBadges();
  assert.match(await page.locator('#beforeCanvas').getAttribute('aria-label'), /fresh/);
  assert.match(await page.locator('#tilePair .tile-card').first().locator('.mask-badge.cloud').textContent(), /Cloud\s+0 px/);
  assert.match(await page.locator('#tilePair .tile-card').last().locator('.mask-badge.cloud').textContent(), /Cloud\s+173 px/);
  // Exercise mixed freshness without adding or permanently changing a fixture.
  const originalDate = await page.evaluate(async () => {
    const { FIXTURES } = await import('/src/fixtures.js');
    const date = FIXTURES['river-bend'].before.date;
    FIXTURES['river-bend'].before.date = '2025-05-01T09:20:00Z';
    document.getElementById('fixtureSelect').dispatchEvent(new Event('change'));
    return date;
  });
  try {
    assert.match(await page.locator('#beforeFreshness').textContent(), /STALE/);
    assert.match(await page.locator('#afterFreshness').textContent(), /FRESH/);
    assert.match(await page.locator('#freshnessNotice').textContent(), /not current observations/);
    assert.match(await page.locator('#beforeCanvas').getAttribute('aria-label'), /stale/);
    await assertExport({ fixture: 'river-bend', band: 'infrared', threshold: .2, changedCount: 585, outcome: 'change-detected', stale: { before: true, after: false }, suffix: 'before-stale' });
  } finally {
    await page.evaluate(async date => {
      const { FIXTURES } = await import('/src/fixtures.js');
      FIXTURES['river-bend'].before.date = date;
      document.getElementById('fixtureSelect').dispatchEvent(new Event('change'));
    }, originalDate);
  }
  await assertFreshness('FRESH');
  await page.screenshot({ path: 'test-results/desktop.png', fullPage: true });
   await page.locator('#beforeCanvas').scrollIntoViewIfNeeded();
   const image = await page.locator('#beforeCanvas').boundingBox();
  await page.mouse.move(image.x + image.width / 2, image.y + image.height / 2);
  assert.match(await page.locator('#pixelInfo').textContent(), /confidence.*(CHANGED|BELOW THRESHOLD)/);
  await page.locator('#beforeCanvas').focus();
  await page.keyboard.press('ArrowRight');
  assert.match(await page.locator('#pixelInfo').textContent(), /\(49, 48\)/);
  for (const [view, canvas] of [['difference', 'differenceCanvas'], ['masks', 'maskCanvas'], ['confidence', 'confidenceCanvas']]) {
    await activateView(view);
    assert.equal(await page.locator(`#${canvas}`).isVisible(), true);
    assert.equal(await page.locator(`#${canvas}`).evaluate(node => node.width), 96);
    const colors = await page.locator(`#${canvas}`).evaluate(node => new Set(node.getContext('2d').getImageData(0, 0, 96, 96).data).size);
    assert.ok(colors > 3, `${view} map should be painted`);
    await assertContext(view, viewSpecs[view].heading, 'FRESH');
  }
  await page.locator('[data-band="visible"]').click();
  assert.equal(await page.locator('[data-band="visible"]').getAttribute('class'), 'segment is-active');
  await activateView('side-by-side');
  await assertContext('side-by-side', 'Visible-light signal', 'FRESH');
  assert.match(await page.locator('#viewLegend').textContent(), /Visible-light signal/);
  await assertTileBadges();
  await assertMaskListBadges();
  for (const view of Object.keys(viewSpecs)) {
    await activateView(view, 'keyboard');
    await assertContext(view, view === 'side-by-side' ? 'Visible-light signal' : viewSpecs[view].heading, 'FRESH');
  }
  await page.locator('#thresholdInput').focus();
  await page.keyboard.press('Home');
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#thresholdValue').textContent(), '0.10');
  await activateView('difference');
  await page.locator('#differenceCanvas').focus();
  for (let i = 0; i < 96; i++) await page.keyboard.press('ArrowLeft');
  assert.match(await page.locator('#pixelInfo').textContent(), /NODATA/);
  await page.locator('#fixtureSelect').selectOption('archive-haze');
  assert.equal(await page.locator('#freshnessStatus').textContent(), 'STALE');
  assert.equal(await page.locator('#changedPixels').textContent(), '0 / 9,216');
  for (const view of Object.keys(viewSpecs)) {
    await activateView(view);
    await assertContext(view, view === 'side-by-side' ? 'Visible-light signal' : viewSpecs[view].heading, 'STALE');
    if (view === 'side-by-side') await assertTileBadges();
    await assertMaskListBadges();
  }
  await activateView('side-by-side');
  const staleArchive = { before: true, after: true };
  await assertExport({ fixture: 'archive-haze', band: 'visible', threshold: .1, changedCount: 0, outcome: 'no-change-detected', stale: staleArchive, screenshot: true });
  const fixtureCounts = { 'river-bend': [585, 306], 'new-block': [411, 36], 'archive-haze': [0, 0] };
  for (const [fixture, counts] of Object.entries(fixtureCounts)) {
    for (const [index, band] of ['infrared', 'visible'].entries()) {
      await selectComparison(fixture, band, .2);
      await assertExport({ fixture, band, threshold: .2, changedCount: counts[index], outcome: counts[index] ? 'change-detected' : 'no-change-detected', stale: fixture === 'archive-haze' ? staleArchive : { before: false, after: false } });
    }
  }
  await selectComparison('new-block', 'visible', .5);
  await assertExport({ fixture: 'new-block', band: 'visible', threshold: .5, changedCount: 0, outcome: 'no-change-detected', stale: { before: false, after: false } });
  await selectComparison('archive-haze', 'visible', 0);
  await assertExport({ fixture: 'archive-haze', band: 'visible', threshold: 0, changedCount: 'positive', outcome: 'change-detected', stale: staleArchive });
  await selectComparison('archive-haze', 'visible', .2);
  const originalNodata = await page.evaluate(async () => {
    const { FIXTURES } = await import('/src/fixtures.js');
    const nodata = FIXTURES['archive-haze'].before.nodata.slice();
    FIXTURES['archive-haze'].before.nodata.fill(true);
    document.getElementById('fixtureSelect').dispatchEvent(new Event('change'));
    return nodata;
  });
  try {
    await assertExport({ fixture: 'archive-haze', band: 'visible', threshold: .2, changedCount: 0, outcome: 'not-comparable', stale: staleArchive, suffix: 'all-nodata' });
  } finally {
    await page.evaluate(async nodata => {
      const { FIXTURES } = await import('/src/fixtures.js');
      FIXTURES['archive-haze'].before.nodata.splice(0, nodata.length, ...nodata);
      document.getElementById('fixtureSelect').dispatchEvent(new Event('change'));
    }, originalNodata);
    await selectComparison('archive-haze', 'visible', .1);
    await activateView('side-by-side');
  }
  assert.equal(await page.locator('#changedPixels').textContent(), '0 / 9,216');
  await assertContext('side-by-side', 'Visible-light signal', 'STALE');
  await page.locator('#helpButton').click();
  assert.equal(await page.locator('#helpDialog').isVisible(), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#helpDialog').isVisible(), false);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-view="side-by-side"]').click();
  await page.screenshot({ path: 'test-results/mobile.png', fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  console.log('Browser smoke passed: contextual legends, freshness, masks, maps, keyboard inspection, all fixture/band HTML/JSON exports, threshold boundaries, before-stale and all-nodata outcomes, help, mobile layout, no external requests.');
} finally {
  await browser.close();
}
