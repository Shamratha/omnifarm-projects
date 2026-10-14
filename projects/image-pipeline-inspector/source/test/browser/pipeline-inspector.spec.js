import { test, expect } from '@playwright/test';

const browserErrors = new WeakMap();
test.beforeEach(async ({ page }) => {
  const errors = [];
  browserErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (!request.url().startsWith('http://127.0.0.1:4173/') && !request.url().startsWith('blob:')) errors.push(`Non-local request: ${request.url()}`);
  });
});
test.afterEach(async ({ page }) => expect(browserErrors.get(page)).toEqual([]));

test('selection swaps contextual source and mask inspector content', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('[data-layer-id="background"]')).toHaveClass(/accent-violet/);
  await expect(page.locator('[data-layer-id="broken"]')).toHaveClass(/accent-red/);
  await expect(page.locator('[data-layer-id="mountain"]')).toHaveClass(/selected/);
  await expect(page.locator('#selectedLayerName')).toHaveText('Mountain cutout');
  await page.locator('[data-layer-id="background"]').click();
  await expect(page.locator('#selectedLayerName')).toHaveText('Aurora / base');
  await expect(page.locator('#maskSection')).toContainText('No mask attached');
  await expect(page.locator('#sourceSection')).toContainText('aurora-background.svg');
  await page.locator('[data-layer-id="broken"]').click();
  await expect(page.locator('#selectedLayerName')).toHaveText('Legacy texture');
  await expect(page.locator('#sourceSection')).toContainText('MISSING');
  await expect(page.locator('#sourceSection')).not.toContainText('LINKED');
});

test('mask edits persist, missing assets stay visible, and compare updates', async ({ page }) => {
  await page.goto('/');
  await page.locator('#invertMask').check();
  await page.locator('#featherInput').fill('24');
  await page.locator('#featherInput').dispatchEvent('change');
  const state = await page.evaluate(() => window.pipelineInspector.document.layers.find((layer) => layer.id === 'mountain'));
  expect(state.mask.invert).toBe(true);
  expect(state.mask.feather).toBe(24);
  await page.locator('[data-tab="compare"]').click();
  await expect(page.locator('#compareTab')).toContainText('CHANGE');
  const changes = await page.evaluate(() => window.pipelineInspector.compare().changes.length);
  expect(changes).toBe(4);
  await expect(page.locator('#compareTab .diff-item')).toHaveCount(changes);
  await expect(page.locator('#refCount')).toHaveText('4 / 5');
  await expect(page.locator('#validationPill')).toHaveText('1 ISSUE');
  await expect(page.locator('#destructiveSummary')).toContainText('0');
  await expect(page.locator('#brokenSummary')).toContainText('1');
  await page.locator('[data-tab="inspector"]').click();
  await page.locator('[data-layer-id="grade"]').click();
  await page.locator('#opacityRange').fill('50');
  const grade = await page.evaluate(() => window.pipelineInspector.document.layers.find((layer) => layer.id === 'grade'));
  expect(grade.opacity).toBe(0.5);
});

test('destructive and broken-reference summaries match the exported manifest', async ({ page }) => {
  await page.goto('/');
  const summary = await page.evaluate(() => window.pipelineInspector.manifestSummary());
  await expect(page.locator('#destructiveSummary')).toContainText(String(summary.destructiveEdits.count));
  await expect(page.locator('#brokenSummary')).toContainText(String(summary.brokenReferences.count));
  await expect(page.locator('#summaryFindings')).toContainText('Legacy texture');
  await expect(page.locator('#summaryFindings')).toContainText('asset-legacy-missing');
  await page.locator('[data-tab="compare"]').click();
  await expect(page.locator('.compare-summary')).toContainText(`DESTRUCTIVE CHANGES${summary.destructiveEdits.count}`);
  await expect(page.locator('.compare-summary')).toContainText(`BROKEN REFERENCES${summary.brokenReferences.count}`);
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#manifestButton').click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const manifest = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  expect(manifest.summary).toEqual(summary);
  expect(manifest.operations).toEqual([]);
});

test('destructive operation summary becomes visible and exportable when history records one', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    window.pipelineInspector.document.operations.push({ type: 'rasterize', layerId: 'mountain', destructive: true, reason: 'flattened for delivery' });
    window.pipelineInspector.render();
  });
  await expect(page.locator('#destructiveSummary')).toContainText('1');
  await expect(page.locator('#summaryFindings')).toContainText('Mountain cutout');
  await expect(page.locator('#summaryFindings')).toContainText('rasterize');
  await expect(page.locator('#selectedLayerType')).toContainText('DESTRUCTIVE HISTORY');
  await page.locator('[data-tab="compare"]').click();
  await expect(page.locator('.compare-summary')).toContainText('DESTRUCTIVE CHANGES1');
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#manifestButton').click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const manifest = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  expect(manifest.summary.destructiveEdits.count).toBe(1);
  expect(manifest.summary.destructiveEdits.edits[0].type).toBe('rasterize');
  expect(manifest.operations[0].reason).toBe('flattened for delivery');
});

test('export downloads identical manifests containing persisted edits and unresolved assets', async ({ page }) => {
  await page.goto('/');
  await page.locator('#invertMask').check();
  await page.locator('#featherInput').fill('24');
  await page.locator('#featherInput').dispatchEvent('change');
  await page.locator('#edgeShiftInput').fill('-3');
  await page.locator('#edgeShiftInput').dispatchEvent('change');
  await page.locator('[data-layer-id="background"]').click();
  await page.locator('[data-layer-id="mountain"]').click();
  await expect(page.locator('#invertMask')).toBeChecked();
  await expect(page.locator('#featherInput')).toHaveValue('24');
  await expect(page.locator('#edgeShiftInput')).toHaveValue('-3');
  const contents = [];
  for (const selector of ['#manifestButton', '#exportButton']) {
    const downloadPromise = page.waitForEvent('download');
    await page.locator(selector).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('aurora-study-rev-014-edit-manifest.json');
    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    contents.push(Buffer.concat(chunks).toString('utf8'));
  }
  expect(contents[0]).toBe(contents[1]);
  const manifest = JSON.parse(contents[0]);
  expect(manifest.schemaVersion).toBe(1);
  expect(manifest.layers.find((layer) => layer.id === 'mountain').mask.invert).toBe(true);
  expect(manifest.layers.find((layer) => layer.id === 'mountain').mask.feather).toBe(24);
  expect(manifest.layers.find((layer) => layer.id === 'mountain').mask.edgeShift).toBe(-3);
  expect(manifest.assets.find((asset) => asset.id === 'asset-legacy-missing').present).toBe(false);
  for (const asset of manifest.assets.filter((asset) => asset.present)) {
    const response = await page.request.get(`/${asset.path}`);
    expect(response.ok()).toBe(true);
    expect(await response.text()).toContain('<svg');
  }
});

test('visible preview, pipeline row, and manifest stay in sync after layer edits', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#pipelinePreview')).toHaveAttribute('data-ready', 'true');
  const beforeMask = await page.locator('#pipelinePreview').evaluate((canvas) => canvas.toDataURL());
  await page.locator('#invertMask').check();
  await expect(page.locator('#pipelinePreview')).toHaveAttribute('data-ready', 'true');
  const afterMask = await page.locator('#pipelinePreview').evaluate((canvas) => canvas.toDataURL());
  expect(afterMask).not.toBe(beforeMask);
  await page.locator('[data-layer-id="caption"] [data-action="visibility"]').click();
  await page.locator('[data-layer-id="grade"]').click();
  await page.locator('#blendMode').selectOption('Multiply');
  await page.locator('#opacityRange').fill('65');
  await expect(page.locator('#opacityValue')).toHaveText('65%');
  await expect(page.locator('.art-caption')).toBeHidden();
  await expect(page.locator('[data-layer-id="grade"] .layer-meta')).toContainText('Multiply');
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#manifestButton').click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const manifest = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  expect(manifest.layers.find((layer) => layer.id === 'caption').visible).toBe(false);
  expect(manifest.layers.find((layer) => layer.id === 'grade').blendMode).toBe('Multiply');
  expect(manifest.layers.find((layer) => layer.id === 'grade').opacity).toBe(0.65);
  expect(manifest.layers.find((layer) => layer.id === 'mountain').mask.invert).toBe(true);
});

test('smoke: local entry points load and multiple missing references remain diagnosable', async ({ page }) => {
  for (const path of ['/', '/app.js', '/styles.css', '/src/pipeline.js', '/src/preview.js']) {
    const response = await page.request.get(path);
    expect(response.status()).toBe(200);
  }
  await page.goto('/');
  await expect(page.locator('#pipelinePreview')).toHaveAttribute('data-ready', 'true');
  await page.evaluate(() => {
    const inspector = window.pipelineInspector;
    inspector.document.assets = inspector.document.assets.filter((asset) => asset.id !== 'asset-mask');
    inspector.render();
  });
  await expect(page.locator('#validationPill')).toHaveText('2 ISSUES');
  await expect(page.locator('#brokenSummary')).toContainText('2');
  await expect(page.locator('#refCount')).toHaveText('3 / 5');
  await expect(page.locator('#maskSection')).toContainText('UNRESOLVED');
  await expect(page.locator('[data-layer-id="mountain"] .layer-state')).toHaveText('MISSING');
  await expect(page.locator('#pipelinePreview')).toHaveAttribute('data-ready', 'true');
  const report = await page.evaluate(() => window.pipelineInspector.validate());
  expect(report.issues.map((issue) => issue.code)).toEqual(['MISSING_ASSET', 'MISSING_MASK_ASSET']);
});
