import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5174', '--strictPort'], { stdio: 'pipe' });
const url = 'http://127.0.0.1:5174';
let browser;
let output = '';
server.stdout.on('data', (chunk) => { output += chunk; });
server.stderr.on('data', (chunk) => { output += chunk; });

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Vite exited: ${output}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch { /* server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Vite did not start: ${output}`);
}

async function downloadText(page, name) {
  const waiting = page.waitForEvent('download');
  await page.getByRole('button', { name, exact: true }).click();
  const download = await waiting;
  const chunks = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function parseWebVtt(text) {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  assert.match(normalized, /^WEBVTT(?:\n|$)/, 'subtitle export must have a WEBVTT header');
  return normalized.split(/\n\n+/).slice(1).filter(Boolean).map((block) => {
    const lines = block.split('\n');
    const cueLineIndex = lines.findIndex((line) => line.includes(' --> '));
    assert.ok(cueLineIndex > 0, `invalid WebVTT cue: ${block}`);
    const [start, end] = lines[cueLineIndex].split(' --> ');
    assert.match(start, /^\d{2,}:\d{2}:\d{2}\.\d{3}$/);
    assert.match(end, /^\d{2,}:\d{2}:\d{2}\.\d{3}$/);
    return { id: lines[0], start, end, text: lines.slice(cueLineIndex + 1).join('\n') };
  });
}

async function parseKml(page, text) {
  return page.evaluate((source) => {
    const KML = 'http://www.opengis.net/kml/2.2';
    const GX = 'http://www.google.com/kml/ext/2.2';
    const documentNode = new DOMParser().parseFromString(source, 'application/xml');
    if (documentNode.querySelector('parsererror')) throw new Error(documentNode.querySelector('parsererror').textContent);
    const textOf = (node, namespace, name) => node.getElementsByTagNameNS(namespace, name)[0]?.textContent;
    const playlist = documentNode.getElementsByTagNameNS(GX, 'Playlist')[0];
    const flyTos = [...documentNode.getElementsByTagNameNS(GX, 'FlyTo')];
    const waits = [...documentNode.getElementsByTagNameNS(GX, 'Wait')];
    const cameras = flyTos.map((flyTo) => {
      const camera = flyTo.getElementsByTagNameNS(KML, 'Camera')[0];
      return {
        longitude: textOf(camera, KML, 'longitude'),
        latitude: textOf(camera, KML, 'latitude'),
        altitude: textOf(camera, KML, 'altitude'),
      };
    });
    return {
      documentName: textOf(documentNode, KML, 'name'),
      hasTour: documentNode.getElementsByTagNameNS(GX, 'Tour').length === 1,
      hasPlaylist: Boolean(playlist),
      flyToCount: flyTos.length,
      waitDurations: waits.map((wait) => textOf(wait, GX, 'duration')),
      cameras,
    };
  }, text);
}

try {
  await waitForServer();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const errors = [];
  const consoleErrors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await page.goto(url);
  const panel = page.getByRole('region', { name: 'Storyboard validation' });
  const warnings = async (count) => {
    await page.waitForFunction((expected) => document.querySelector('.validation-panel__header strong')?.textContent === `${expected} ${expected === 1 ? 'warning' : 'warnings'}`, count);
  };
  const issue = (code) => panel.locator('button').filter({ has: page.locator('code', { hasText: code }) });
  await warnings(0);
  assert.match(await page.locator('.timeline-total').textContent(), /02:00 total/);

  await page.getByLabel('Scene title', { exact: true }).fill('Clock over the river');
  await page.getByLabel('Caption / narration', { exact: true }).fill('A saved opening caption for the museum team.');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.reload();
  await warnings(0);
  assert.equal(await page.getByLabel('Scene title', { exact: true }).inputValue(), 'Clock over the river');
  assert.equal(await page.getByLabel('Caption / narration', { exact: true }).inputValue(), 'A saved opening caption for the museum team.');
  console.log('PASS: scene title/caption editing survives explicit save and browser reload');

  await page.getByLabel('LAT', { exact: true }).fill('');
  await warnings(1);
  assert.match(await issue('missing_coordinates').textContent(), /latitude is required/);
  assert.match(await page.locator('.route-metrics').textContent(), /Route distance unavailable/);
  await page.getByLabel('LAT', { exact: true }).fill('91');
  await warnings(1);
  assert.equal(await issue('invalid_latitude').count(), 1);
  await page.getByLabel('LAT', { exact: true }).fill('48.8599');
  await warnings(0);
  await page.getByLabel('LNG', { exact: true }).fill('-181');
  await warnings(1);
  assert.equal(await issue('invalid_longitude').count(), 1);
  await page.getByLabel('LNG', { exact: true }).fill('2.3266');
  await warnings(0);

  const altitude = page.locator('.camera-altitude input');
  for (const impossible of ['-10', '0', '100001']) {
    await altitude.fill(impossible);
    await warnings(1);
    assert.equal(await issue('invalid_altitude').count(), 1);
  }
  await altitude.fill('250');
  await warnings(0);
  await page.getByLabel('Hold duration', { exact: true }).fill('0');
  await warnings(1);
  assert.equal(await issue('invalid_duration').count(), 1);
  assert.match(await page.locator('.timeline-total').textContent(), /Duration unavailable/);
  await page.getByRole('button', { name: 'Export KML gx:Tour', exact: true }).click();
  assert.match(await page.locator('.toast').textContent(), /Export blocked/);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.reload();
  await warnings(1);
  await page.getByLabel('Hold duration', { exact: true }).fill('25');
  await warnings(0);

  await page.getByLabel('END', { exact: true }).fill('30');
  await warnings(2);
  assert.equal(await issue('caption_overlap').count(), 2, 'both scenes link to their overlap');
  await issue('caption_overlap').last().click();
  assert.equal(await page.getByLabel('Scene title', { exact: true }).inputValue(), 'Courtyards of collected time');
  await issue('caption_overlap').first().click();
  await page.getByLabel('END', { exact: true }).fill('25');
  await warnings(0);
  await page.getByRole('button', { name: 'Use full scene', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Load', exact: true }).click();
  await warnings(0);
  const restored = await page.evaluate(() => JSON.parse(localStorage.getItem('museum-tour-storyboard-v1')));
  assert.equal(restored.scenes[0].duration, 25);
  assert.equal(restored.scenes[0].camera.altitude, 250);
  assert.equal(restored.scenes[0].captionTiming, undefined);
  console.log('PASS: live missing/invalid coordinates, altitude, zero duration, overlap links, corrections, and draft persistence');

  const camera = { lat: 48.8599, lng: 2.3266, altitude: 250, bearing: 18, tilt: 12, zoom: 1.2 };
  const scene = (id, caption, duration, values = {}) => ({ id, title: id, caption, duration, landmarkId: 'musee-orsay', camera: { ...camera, ...values } });
  const importDraft = async (scenes) => {
    await page.locator('input[type=file]').setInputFiles({
      name: 'storyboard.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ schemaVersion: 2, title: 'Smoke tour', subtitle: '', scenes })),
    });
    await page.waitForFunction((id) => document.querySelector('[data-scene-id]')?.dataset.sceneId === id, scenes[0].id);
    await warnings(0);
  };
  await importDraft([scene('only', 'Only scene caption', 3.5)]);
  assert.match(await page.locator('.route-metrics').textContent(), /0 m/);
  const singleKml = await downloadText(page, 'Export KML gx:Tour');
  const singleVtt = await downloadText(page, 'Export WebVTT captions');
  const singleKmlSummary = await parseKml(page, singleKml);
  assert.equal(singleKmlSummary.hasTour, true);
  assert.equal(singleKmlSummary.hasPlaylist, true);
  assert.equal(singleKmlSummary.flyToCount, 1);
  assert.deepEqual(singleKmlSummary.waitDurations, ['3.5']);
  const singleVttCues = parseWebVtt(singleVtt);
  assert.deepEqual(singleVttCues, [{ id: '1', start: '00:00:00.000', end: '00:00:03.500', text: 'Only scene caption' }]);
  console.log('PASS: single-scene distance, duration and delivery exports');

  await importDraft([
    scene('east', 'East caption', 2.5, { lat: 0, lng: 179 }),
    scene('west', 'West caption', 7.5, { lat: 0, lng: -179 }),
  ]);
  assert.match(await page.locator('.route-metrics').textContent(), /222.4 km/);
  assert.match(await page.locator('.timeline-total').textContent(), /00:10 total/);
  await page.locator('[data-scene-id="west"]').getByRole('button', { name: 'Move scene up' }).click();
  await page.waitForFunction(() => document.querySelector('[data-scene-id]')?.dataset.sceneId === 'west');
  const kml = await downloadText(page, 'Export KML gx:Tour');
  const vtt = await downloadText(page, 'Export WebVTT captions');
  const kmlSummary = await parseKml(page, kml);
  assert.deepEqual(kmlSummary.waitDurations, ['7.5', '2.5']);
  assert.deepEqual(kmlSummary.cameras.map((camera) => camera.longitude), ['-179', '179']);
  const vttCues = parseWebVtt(vtt);
  assert.deepEqual(vttCues.map(({ text, start, end }) => ({ text, start, end })), [
    { text: 'West caption', start: '00:00:00.000', end: '00:00:07.500' },
    { text: 'East caption', start: '00:00:07.500', end: '00:00:10.000' },
  ]);
  console.log('PASS: antimeridian route totals and visible reorder reflected in parsed KML and WebVTT');

  await importDraft([
    scene('keyboard-one', 'Keyboard one', 10, { lat: 48, lng: 2 }),
    scene('keyboard-two', 'Keyboard two', 10, { lat: 49, lng: 3 }),
  ]);
  assert.equal(await page.locator('[data-scene-id]').first().getAttribute('data-scene-id'), 'keyboard-one');
  await page.locator('[data-scene-id="keyboard-one"]').focus();
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction(() => document.querySelector('[data-scene-id]')?.dataset.sceneId === 'keyboard-two');
  await page.getByRole('button', { name: 'Undo last change', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-scene-id]')?.dataset.sceneId === 'keyboard-one');
  await page.getByRole('button', { name: 'Redo change', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-scene-id]')?.dataset.sceneId === 'keyboard-two');
  console.log('PASS: focused scene ArrowDown reorder plus undo/redo');

  await importDraft([scene('timed-caption', 'Timed camera scene', 10, { lat: 48, lng: 2 })]);
  await page.getByLabel('START', { exact: true }).fill('3');
  await page.getByLabel('END', { exact: true }).fill('6');
  await warnings(0);
  await page.getByRole('button', { name: 'Preview tour', exact: true }).click();
  const preview = page.getByRole('dialog', { name: 'Tour preview' });
  assert.match(await preview.textContent(), /Caption 00:03 – 00:06/);
  assert.match(await preview.textContent(), /Caption is not on screen at this moment/);
  assert.match(await preview.textContent(), /Camera 48\.0000, 2\.0000/);
  await preview.getByRole('slider', { name: 'Scrub preview' }).fill('4');
  await page.waitForFunction(() => document.querySelector('.preview-clock')?.textContent.includes('00:04'));
  assert.match(await preview.textContent(), /Keyboard|Timed camera scene/);
  assert.doesNotMatch(await preview.textContent(), /Caption is not on screen at this moment/);
  assert.equal(await preview.locator('.map-progress-dot').count(), 1);
  await preview.getByRole('button', { name: 'Close preview', exact: true }).click();
  console.log('PASS: synchronized preview cursor, camera state, and caption timing');

  const narrow = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await narrow.goto(url);
  assert.equal(await narrow.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, 'narrow layout should not overflow horizontally');
  assert.ok(await narrow.locator('.scene-card').count() > 0);
  await narrow.close();
  console.log('PASS: narrow-screen layout stays readable without horizontal overflow');
  assert.deepEqual(errors, [], 'browser must not raise runtime errors');
  assert.deepEqual(consoleErrors, [], 'browser must not log console errors');
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
