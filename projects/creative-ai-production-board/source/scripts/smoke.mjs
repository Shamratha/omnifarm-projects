import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect as playwrightExpect } from '@playwright/test';
import { build } from './build.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = join(root, 'scripts', '.smoke-artifacts');
const expect = playwrightExpect.configure({ timeout: 5_000 });
const results = [];
const cards = (page) => page.locator('#board-view .scene-card');
const dialog = (page) => page.getByRole('dialog');
const setting = (page, key) => page.locator(`.settings-list input[data-setting="${key}"]`);
const timestamp = (seconds) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;

export async function startServer(output, files) {
  const available = new Set(files);
  const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.wav': 'audio/wav' };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      const name = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
      if (!['GET', 'HEAD'].includes(request.method) || !available.has(name)) {
        response.writeHead(404).end('Not found');
        return;
      }
      const body = await readFile(join(output, name));
      response.writeHead(200, { 'Content-Type': `${types[extname(name)] || 'application/octet-stream'}; charset=utf-8`, 'Content-Length': body.length, 'Cache-Control': 'no-store' });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch (error) {
      response.writeHead(error instanceof URIError ? 400 : 500).end('Static server error');
    }
  });
  await new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', accept);
  });
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function openBoard(page, origin) {
  const response = await page.goto(origin, { waitUntil: 'networkidle' });
  assert.equal(response.status(), 200, 'The deployed index must be served successfully');
  await expect(page.locator('#board-view')).toBeVisible();
  await expect(cards(page), 'Board must render five scenes without page errors').toHaveCount(5);
}

async function switchView(page, view) {
  await page.locator(`.nav-item[data-view="${view}"]`).click();
  await expect(page.locator(`#${view}-view`)).toBeVisible();
}

async function openExport(page) {
  await page.locator('#export-button').click();
  await expect(dialog(page)).toBeVisible();
  await expect(page.locator('#download-manifest')).toBeVisible();
}

async function expectExportScope(page, cutTitle) {
  const scope = dialog(page).locator('.export-scope');
  await expect(scope).toBeVisible();
  await expect(scope).toContainText(/active cut/i);
  await expect(scope).toContainText(cutTitle);
  await expect(scope).toContainText(/alternate[- ]cut reports are diagnostic only/i);
  await expect(scope).toContainText(/not approved for delivery/i);
  const limitation = dialog(page).locator('.delivery-limitation');
  await expect(limitation).toBeVisible();
  await expect(limitation).toHaveText('Delivery limitation: editorial-only assets restrict this cut to internal review. Public delivery remains blocked.');
}

async function expectSafe(page, cutTitle = 'Quiet Signal') {
  await expect(page.locator('.export-status strong')).toHaveText(/ready for internal-review export/i);
  await expect(page.locator('.export-status small')).toContainText(/active cut only/i);
  await expectExportScope(page, cutTitle);
  await expect(page.locator('#download-manifest')).toBeEnabled();
}

async function expectBlocked(page, reason, cutTitle = 'Quiet Signal') {
  await expect(page.locator('.export-status')).toContainText(/export blocked/i);
  await expect(page.locator('.export-status')).toContainText(reason);
  await expectExportScope(page, cutTitle);
  await expect(page.locator('#download-manifest')).toBeDisabled();
}

async function downloadManifest(page, name) {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#download-manifest').click(),
  ]);
  assert.match(download.suggestedFilename(), /\.json$/i, 'The export must be a real JSON download');
  const destination = join(artifacts, name);
  await download.saveAs(destination);
  assert.equal(await download.failure(), null, 'The browser download must complete');
  const manifest = JSON.parse(await readFile(destination, 'utf8'));
  assert.equal(manifest.localOnly, true);
  assert.equal(manifest.activeCut, 'quiet');
  assert.equal(manifest.duration, 198);
  assert.equal(manifest.scenes.length, 5);
  assert.equal(manifest.assets.length, 6);
  assert.equal(manifest.credits.length, 4);
  assert.equal(manifest.validation.ok, true);
  assert.equal(manifest.validation.rightsLabelsEmbedded, true);
  assert.equal(manifest.safety.safe, true);
  assert.ok(manifest.rightsLabels.length >= 2, 'The manifest must carry active-cut frame and audio rights labels');
  assert.equal(manifest.alternateCuts.length, 1, 'The manifest must include the alternate cut report');
  assert.ok(manifest.alternateCuts[0].rightsLabels.length >= 2, 'The alternate cut report must carry rights labels');
  for (const [key, value] of Object.entries({
    distribution: 'internal-review', embedRightsLabels: true,
    includeUncleared: false, allowUnresolved: false,
  })) assert.equal(manifest.settings[key], value, `Manifest setting ${key} must be safe`);
  assert.ok(manifest.validation.issues.every((issue) => issue.severity !== 'error'));
  const assets = new Map(manifest.assets.map((asset) => [asset.id, asset]));
  let cursor = 0;
  for (const scene of manifest.scenes) {
    assert.equal(scene.start, cursor, `Scene ${scene.id} must follow the previous scene`);
    assert.ok(scene.end > scene.start);
    assert.equal(scene.timingStatus, 'pass');
    assert.equal(scene.continuity, 'pass');
    assert.equal(assets.get(scene.assetId)?.type, 'FRAME');
    assert.ok(scene.rightsLabel?.trim(), `Scene ${scene.id} must retain its rights label`);
    assert.equal(scene.rightsLabel, assets.get(scene.assetId).rightsLabel);
    assert.equal(assets.get(scene.audioCue?.assetId)?.type, 'AUDIO');
    assert.ok(scene.audioCue.rightsLabel?.trim(), `Scene ${scene.id} must retain audio rights`);
    assert.equal(scene.audioCue.start, scene.start);
    assert.equal(scene.audioCue.end, scene.end);
    assert.equal(scene.cueTime, timestamp(scene.start), `Scene ${scene.id} cue timestamp must track reordering`);
    assert.equal(scene.audioCue.time, scene.cueTime);
    cursor = scene.end;
  }
  assert.equal(cursor, manifest.duration);
  await expect(dialog(page)).toHaveCount(0);
  return manifest;
}

async function checkNoOverflow(page, label) {
  await page.evaluate(() => document.fonts.ready);
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    dialogs: [...document.querySelectorAll('[role="dialog"]')].map((element) => ({ width: element.clientWidth, scroll: element.scrollWidth })),
    overflowing: [...document.querySelectorAll('body *')].filter((element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && (box.right > window.innerWidth + 1 || box.left < -1);
    }).slice(0, 8).map((element) => `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}.${String(element.className)}`),
  }));
  assert.ok(dimensions.document <= dimensions.viewport + 1 && dimensions.body <= dimensions.viewport + 1,
    `${label}: horizontal page overflow: ${JSON.stringify(dimensions)}`);
  assert.ok(dimensions.dialogs.every((item) => item.scroll <= item.width + 1),
    `${label}: horizontal dialog overflow: ${JSON.stringify(dimensions)}`);
}

// Appended to the served ES module after its export declarations. Only the
// alternate cut is damaged; source files and the default cut remain untouched.
const brokenAlternate = `
CUTS.pulse.scenes[1].start = CUTS.pulse.scenes[0].end - 3;
CUTS.pulse.scenes[2].cueAssetId = 'smoke-missing-cue';
const smokeFrame = ASSETS.find(asset => asset.id === CUTS.pulse.scenes[3].assetId);
ASSETS.push({ ...smokeFrame, id: 'smoke-frame-no-rights-label', rightsLabel: '' });
CUTS.pulse.scenes[3].assetId = 'smoke-frame-no-rights-label';
`;

export async function runScenario(browser, origin, output, name, run, { injectAlternate = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true, serviceWorkers: 'block', reducedMotion: 'reduce' });
  context.setDefaultTimeout(5_000);
  const blockedRemote = new Set();
  const pageErrors = [];
  const localFailures = [];
  const consoleErrors = [];
  let injectedRequests = 0;
  const result = { name, status: 'failed' };
  let page;
  try {
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) {
        blockedRemote.add(url.href);
        await route.abort('blockedbyclient');
      } else if (injectAlternate && url.pathname === '/board-data.js') {
        injectedRequests += 1;
        await route.fulfill({ status: 200, contentType: 'text/javascript', body: `${await readFile(join(output, 'board-data.js'), 'utf8')}\n${brokenAlternate}` });
      } else await route.continue();
    });
    // WebSocket traffic is a separate browser API and must also stay offline.
    await context.routeWebSocket('**/*', (socket) => socket.close());
    context.on('page', (observed) => {
      observed.on('pageerror', (error) => pageErrors.push(error.stack || error.message));
      observed.on('console', (message) => {
        if (message.type() !== 'error') return;
        const url = message.location().url;
        // Only resource errors caused by our deliberate remote blocking are expected.
        if (blockedRemote.has(url) && /^Failed to load resource: net::ERR_(?:BLOCKED_BY_CLIENT|FAILED)/.test(message.text())) return;
        consoleErrors.push(`${url}: ${message.text()}`);
      });
      observed.on('response', (response) => {
        if (new URL(response.url()).origin === origin && response.status() >= 400) localFailures.push(`${response.status()} ${response.url()}`);
      });
      observed.on('requestfailed', (request) => {
        if (new URL(request.url()).origin === origin) localFailures.push(`${request.failure()?.errorText} ${request.url()}`);
      });
    });
    await context.tracing.start({ screenshots: true, snapshots: true });
    page = await context.newPage();
    await openBoard(page, origin);
    await run(page);
    await page.waitForLoadState('networkidle');
    if (injectAlternate) assert.ok(injectedRequests > 0, 'The browser must actually request the intercepted board-data.js module');
    assert.deepEqual(pageErrors, [], 'There must be no uncaught browser page errors');
    assert.deepEqual(localFailures, [], 'There must be no missing or failed local resources');
    assert.deepEqual(consoleErrors, [], 'There must be no unexpected browser console errors');
    result.status = 'passed';
    console.log(`PASS ${name}`);
  } catch (error) {
    result.error = error.stack || error.message;
    if (page) {
      const screenshot = `${name}.png`;
      try {
        await page.screenshot({ path: join(artifacts, screenshot), fullPage: true, timeout: 5_000 });
        result.screenshot = screenshot;
      } catch (captureError) { result.screenshotError = captureError.message; }
    }
    console.error(`FAIL ${name}: ${error.message}`);
  } finally {
    result.blockedRemote = [...blockedRemote].sort();
    result.pageErrors = pageErrors;
    result.localFailures = localFailures;
    result.consoleErrors = consoleErrors;
    try {
      if (result.status === 'failed') {
        result.trace = `${name}.zip`;
        await context.tracing.stop({ path: join(artifacts, result.trace) });
      } else await context.tracing.stop();
    } finally {
      await context.close();
      results.push(result);
    }
  }
  return result;
}

async function main() {
  await rm(artifacts, { recursive: true, force: true });
  await mkdir(artifacts, { recursive: true });
  let browser;
  let server;
  try {
    const { output, files } = await build();
    const served = await startServer(output, files);
    server = served.server;
    const { origin } = served;
    console.log(`Smoke checks serving fresh dist/ at ${origin}; remote requests are blocked.`);
    try {
      browser = await chromium.launch({ headless: true });
    } catch (error) {
      throw new Error(`Chromium could not launch. Install it with: npx playwright install --with-deps chromium\n${error.message}`, { cause: error });
    }
    const scenario = (name, run, options) => runScenario(browser, origin, output, name, run, options);

    await scenario('board-and-cut-switching', async (page) => {
      await expect(page.locator('.cut-option[data-cut="quiet"]')).toHaveClass(/active/);
      await expect(cards(page).first()).toHaveAttribute('data-scene', 's01');
      await page.locator('.cut-option[data-cut="pulse"]').click();
      await expect(cards(page)).toHaveCount(5);
      await expect(cards(page).first()).toHaveAttribute('data-scene', 'p01');
      await expect(page.locator('#board-view')).toContainText('02:42');
      await page.locator('.cut-option[data-cut="quiet"]').click();
      await expect(cards(page).first()).toHaveAttribute('data-scene', 's01');
      await expect(page.locator('#board-view')).toContainText('03:18');
      await cards(page).first().click();
      await expect(cards(page).first()).toHaveClass(/selected/);
      await expect(page.locator('#inspector')).toContainText('The city holds its breath');
      await switchView(page, 'rights');
      await expect(page.locator('#rights-view')).toContainText(/editorial/i);
      await expect(page.locator('#rights-view')).toContainText('Rae Biko');
      await switchView(page, 'board');
    });

    await scenario('computed-comparison', async (page) => {
      await switchView(page, 'compare');
      const columns = page.locator('#compare-view .cut-column');
      await expect(columns).toHaveCount(2);
      for (const column of [columns.nth(0), columns.nth(1)]) {
        await expect(column).toContainText(/continuity|validation|timing|checks/i);
        await expect(column).toContainText(/pass|review|ready|0 blocking/i);
        await expect(column).not.toContainText(/4\s*\/\s*5\s+continuity/i);
      }
      await expect(columns.nth(0)).toContainText('03:18');
      await expect(columns.nth(1)).toContainText('02:42');
    });

    await scenario('arrow-reorder-and-cue-export', async (page) => {
      const before = await cards(page).evaluateAll((items) => items.map((item) => item.dataset.scene));
      await cards(page).nth(1).hover();
      await cards(page).nth(1).locator('.move-button').filter({ hasText: '↑' }).click();
      const expectedOrder = [before[1], before[0], ...before.slice(2)];
      await expect(cards(page).first()).toHaveAttribute('data-scene', before[1]);
      assert.deepEqual(await cards(page).evaluateAll((items) => items.map((item) => item.dataset.scene)), expectedOrder);
      await expect(cards(page).first()).toContainText('00:00');
      await expect(cards(page).nth(1)).toContainText('00:42');
      await expect(page.locator('#inspector .cue-card')).toContainText('00:00');
      await cards(page).nth(1).click();
      await expect(page.locator('#inspector .cue-card')).toContainText('00:42');
      await openExport(page);
      await expectSafe(page);
      const manifest = await downloadManifest(page, 'reordered-manifest.json');
      assert.deepEqual(manifest.scenes.map((scene) => scene.id), expectedOrder);
      assert.equal(manifest.scenes[0].end, 42);
      assert.equal(manifest.scenes[1].end, 76);
    });

    await scenario('detailed-run-checks', async (page) => {
      await page.locator('#run-checks').click();
      await expect(dialog(page), 'Run checks must open a detailed results dialog').toBeVisible();
      for (const category of [/timing|overlap/i, /audio|cue/i, /asset/i, /credit/i, /rights|editorial/i]) await expect(dialog(page)).toContainText(category);
      await expect(dialog(page)).toContainText(/no blocking|0 blocking|checks passed|ready|safe|passed/i);
      await dialog(page).locator('.modal-close').click();
      await expect(dialog(page)).toHaveCount(0);
    });

    await scenario('export-safety-and-recovery', async (page) => {
      let downloads = 0;
      page.on('download', () => { downloads += 1; });
      await openExport(page);
      await expectSafe(page);
      await downloadManifest(page, 'safe-manifest.json');
      await openExport(page);
      for (const [key, unsafe, reason] of [
        ['includeUncleared', true, /uncleared/i],
        ['allowUnresolved', true, /resolve|unresolved/i],
        ['embedRightsLabels', false, /rights labels/i],
      ]) {
        await setting(page, key).setChecked(unsafe);
        await expectBlocked(page, reason);
        assert.equal(downloads, 1, 'Unsafe settings must not trigger a download');
        await setting(page, key).setChecked(!unsafe);
        await expectSafe(page);
      }
      await setting(page, 'includeUncleared').check();
      await setting(page, 'allowUnresolved').check();
      await setting(page, 'embedRightsLabels').uncheck();
      await expectBlocked(page, /rights labels/i);
      await setting(page, 'includeUncleared').uncheck();
      await setting(page, 'allowUnresolved').uncheck();
      await setting(page, 'embedRightsLabels').check();
      await expectSafe(page);
      const distribution = page.locator('select[data-setting="distribution"]');
      await expect(distribution, 'Export must expose an internal/public distribution selector').toBeVisible();
      const publicValue = (await distribution.locator('option').evaluateAll((options) => options.map((option) => option.value)))
        .find((value) => ['public', 'public-distribution'].includes(value));
      assert.ok(publicValue, 'The distribution selector must offer public distribution');
      await distribution.selectOption(publicValue);
      await expectBlocked(page, /editorial/i);
      await expect(page.locator('.export-status')).toContainText(/public distribution/i);
      assert.equal(downloads, 1, 'Public editorial export must stay blocked');
      await distribution.selectOption('internal-review');
      await expectSafe(page);
      await downloadManifest(page, 'recovered-manifest.json');
      assert.equal(downloads, 2, 'Corrected settings must permit a fresh real download');
    });

    await scenario('broken-alternate-validation', async (page) => {
      await switchView(page, 'compare');
      const quiet = page.locator('#compare-view .cut-column').nth(0);
      const pulse = page.locator('#compare-view .cut-column').nth(1);
      await expect(quiet).toContainText(/pass|review|ready|0 blocking/i);
      await expect(quiet).not.toContainText(/smoke-missing-cue|smoke-frame-no-rights-label|overlaps/i);
      await expect(pulse, 'Compare must compute validation for the alternate cut, not just the active cut').toContainText(/overlap/i);
      await expect(pulse).toContainText(/(?:missing|unresolved)[\s\S]*cue|cue[\s\S]*(?:missing|unresolved)/i);
      await expect(pulse).toContainText(/rights label/i);
      await expect(pulse).toContainText(/block|error|attention/i);
      await page.locator('.cut-option[data-cut="pulse"]').click();
      await page.locator('#run-checks').click();
      await expect(dialog(page)).toBeVisible();
      for (const detail of [/overlap/i, /smoke-missing-cue/, /rights label/i, /smoke-frame-no-rights-label/, /p01/, /p02/, /p03/, /p04/]) await expect(dialog(page)).toContainText(detail);
      await dialog(page).locator('.modal-close').click();
      await openExport(page);
      await expectBlocked(page, /production|blocking/i, 'Pulse Edit');
      await dialog(page).locator('.modal-close').click();
      await page.locator('.cut-option[data-cut="quiet"]').click();
      await openExport(page);
      await expectSafe(page);
      const manifest = await downloadManifest(page, 'alternate-warning-manifest.json');
      assert.equal(manifest.alternateCuts[0].status, 'blocked');
      assert.ok(manifest.validation.alternateCutWarnings.some((warning) => warning.key === 'pulse'));
      const alternate = manifest.alternateCuts[0];
      const warning = manifest.validation.alternateCutWarnings.find((entry) => entry.key === 'pulse');
      assert.equal(alternate.key, 'pulse');
      assert.equal(alternate.validation.ok, false, 'A safe active cut must not approve a broken alternate');
      assert.equal(alternate.validation.safety.safe, false, 'The alternate report must remain diagnostic, not delivery approval');
      assert.equal(warning.status, 'blocked');
      for (const code of ['timing-overlap', 'missing-cue', 'rights-label']) {
        assert.ok(alternate.blockingIssues.some((issue) => issue.code === code && issue.severity === 'error'),
          `The downloaded alternate report must retain its ${code} diagnostic`);
      }
      assert.ok(alternate.warnings.some((issue) => issue.code === 'editorial-rights'), 'The alternate must retain its editorial review warning');
      assert.deepEqual(warning.warnings, alternate.warnings, 'The warning summary must retain alternate review notes');
      assert.deepEqual(warning.blockingIssues, alternate.blockingIssues, 'The warning summary must retain alternate blockers');
      assert.deepEqual(warning.rightsLabels, alternate.rightsLabels, 'The warning summary must retain alternate rights records');
      assert.ok(alternate.rightsLabels.some((entry) => entry.assetId === 'frame-hands' && entry.status === 'editorial' && entry.label?.trim()),
        'The diagnostic report must retain the editorial asset rights label');
      assert.deepEqual(alternate.rightsLabels.find((entry) => entry.assetId === 'smoke-missing-cue'),
        { assetId: 'smoke-missing-cue', type: null, label: null, status: 'missing' },
        'A missing alternate cue must retain an explicit missing-rights record');
      assert.equal(alternate.rightsLabels.find((entry) => entry.assetId === 'smoke-frame-no-rights-label')?.label, null,
        'The alternate report must preserve the missing frame rights label');
      assert.match(manifest.safety.notices.join(' '), /editorial-only assets.*internal-review/i,
        'Active-cut export safety must retain the internal-review limitation, not imply public approval');
    }, { injectAlternate: true });

    await scenario('responsive-no-horizontal-overflow', async (page) => {
      for (const viewport of [{ width: 1440, height: 1000 }, { width: 1024, height: 768 }, { width: 768, height: 1024 }, { width: 390, height: 844 }, { width: 320, height: 740 }]) {
        await page.setViewportSize(viewport);
        for (const view of ['board', 'compare', 'rights']) {
          await switchView(page, view);
          await checkNoOverflow(page, `${viewport.width}px ${view}`);
        }
        await page.locator('#run-checks').click();
        await expect(dialog(page)).toBeVisible();
        await checkNoOverflow(page, `${viewport.width}px checks dialog`);
        await dialog(page).locator('.modal-close').click();
        await openExport(page);
        await checkNoOverflow(page, `${viewport.width}px export dialog`);
        await dialog(page).locator('.modal-close').click();
      }
    });
    const failures = results.filter((result) => result.status === 'failed');
    console.log(`Smoke result: ${results.length - failures.length}/${results.length} scenarios passed.`);
    if (failures.length) process.exitCode = 1;
  } catch (error) {
    results.push({ name: 'setup', status: 'failed', error: error.stack || error.message });
    console.error(`Smoke setup failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    try { await browser?.close(); }
    finally {
      if (server) await new Promise((accept, reject) => server.close((error) => error ? reject(error) : accept()));
      await writeFile(join(artifacts, 'results.json'), `${JSON.stringify({ passed: results.every((result) => result.status === 'passed'), results }, null, 2)}\n`);
      console.log('Artifacts: scripts/.smoke-artifacts/ (replaced on each run; failure screenshots/traces, JSON downloads, results.json).');
    }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
