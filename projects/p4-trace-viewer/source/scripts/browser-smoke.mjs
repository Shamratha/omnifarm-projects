import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startLocalServer } from './local-server.mjs';

// Optional verification tooling only; the application itself has no dependencies.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const server = await startLocalServer();
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const externalRequests = [];
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin !== server.url) {
      externalRequests.push(route.request().url());
      return route.abort();
    }
    return route.continue();
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.url);
  await page.waitForSelector('.packet-item');

  const ids = () => page.locator('.packet-item').evaluateAll(items => items.map(item => item.dataset.packetId));
  const download = async () => {
    const pending = page.waitForEvent('download');
    await page.click('#export-button');
    const file = await pending;
    assert.equal(file.suggestedFilename().endsWith('-diagnostic-report.json'), true);
    const stream = await file.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    const report = JSON.parse(text);
    assert.deepEqual(report.packets.map(packet => packet.id), (await ids()).sort());
    assert.equal(report.summary.packets, Number(await page.locator('.metric-value').first().textContent()));
    const selectedItem = page.locator('.packet-item.selected');
    const selected = await selectedItem.count() ? await selectedItem.getAttribute('data-packet-id') : null;
    assert.equal(report.selection.selectedPacketId, selected);
    assert.ok(text.endsWith('\n'));
    return { text, report };
  };

  assert.equal((await ids()).length, 4);
  assert.equal(await page.locator('#empty-detail').isVisible(), false);
  await page.selectOption('#compare-select', 'traceB');
  for (const [diagnostic, expected, markerKinds, expectedPasses, detailText] of [
    ['recirculated', 'p-recirculated', ['recirculate'], 2, 'Pass 0 → pass 1'],
    ['table-miss', 'p-miss', ['drop'], 1, 'table miss'],
    ['ttl-expiry', 'p-ttl', ['rewrite', 'drop'], 1, 'IPv4 TTL rewrite reached zero'],
    ['queue-delay', 'p-forward', ['queue_enqueue', 'queue_dequeue'], 1, '1100 → 1250 ns = 150 ns']
  ]) {
    const shortcut = page.locator(`[data-quick-filter="${diagnostic}"]`);
    await shortcut.click();
    assert.deepEqual(await ids(), [expected]);
    assert.equal(await shortcut.getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#packet-detail .pipeline-pass').count(), expectedPasses);
    for (const kind of markerKinds) assert.ok(await page.locator(`#packet-detail [data-event-kind="${kind}"]`).count(), `${diagnostic} marker ${kind}`);
    assert.match(await page.locator('#packet-detail').textContent(), new RegExp(detailText));
    const first = await download();
    assert.equal(first.report.selection.diagnostic, diagnostic);
    assert.ok(first.report.comparison);
    assert.equal(first.text, (await download()).text);
    if (diagnostic === 'table-miss') {
      assert.deepEqual(first.report.comparison.changedPacketIds, ['p-miss']);
      assert.match(await page.locator('#comparison-detail').textContent(), /p-miss/);
      assert.doesNotMatch(await page.locator('#comparison-detail').textContent(), /p-forward/);
    }
    if (diagnostic === 'queue-delay') {
      assert.equal(first.report.summary.queueDelayNsTotal, 150);
      assert.equal(first.report.comparison.changes[0].after.queueDelayNs, 50);
    }
    await shortcut.click();
    assert.equal((await ids()).length, 4);
  }

  await page.selectOption('#outcome-filter', 'dropped');
  assert.deepEqual(await ids(), ['p-miss', 'p-ttl']);
  await page.click('[data-packet-id="p-ttl"]');
  assert.equal((await download()).report.selection.selectedPacketId, 'p-ttl');
  await page.selectOption('#reason-filter', 'table_miss');
  assert.deepEqual(await ids(), ['p-miss']);
  await page.selectOption('#trace-select', 'traceB');
  assert.equal(await page.inputValue('#reason-filter'), '');
  assert.deepEqual(await ids(), ['p-ttl']);
  assert.equal((await download()).report.traceId, 'trace-b');

  await page.click('#clear-filters');
  await page.selectOption('#trace-select', 'traceA');
  await page.selectOption('#table-filter', 'recirc_control');
  await page.selectOption('#action-filter', 'recirculate');
  assert.deepEqual(await ids(), ['p-recirculated']);
  await page.fill('#query', 'needs_second_pass');
  assert.deepEqual(await ids(), ['p-recirculated']);
  await page.click('#clear-filters');
  await page.fill('#delay-filter', '150');
  assert.deepEqual(await ids(), ['p-forward']);
  await page.fill('#delay-filter', '151');
  assert.deepEqual(await ids(), []);
  assert.equal(await page.locator('#packet-detail').isVisible(), false);
  assert.match(await page.locator('#comparison-detail').textContent(), /No visible packets/);
  const empty = (await download()).report;
  assert.equal(empty.selection.selectedPacketId, null);
  assert.ok(Object.values(empty.summary).every(value => value === 0));
  await page.click('#clear-filters');

  await page.selectOption('#result-filter', 'hit');
  await page.click('[data-quick-filter="table-miss"]');
  assert.deepEqual(await ids(), []); // Contradictory controls must not be overridden.
  await page.click('#clear-filters');

  const fixture = JSON.parse(await readFile(new URL('../public/fixtures.json', import.meta.url)));
  const upload = trace => page.setInputFiles('#file-input', {
    name: 'trace.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(trace))
  });
  await upload(fixture.traceA);
  await page.waitForFunction(() => document.querySelector('#trace-select').value === 'imported');
  const original = await download();
  await upload({ ...fixture.traceA, packets: [...fixture.traceA.packets].reverse() });
  await page.waitForFunction(() => document.querySelector('.packet-item').dataset.packetId === 'p-recirculated');
  assert.equal(original.text, (await download()).text);
  assert.equal(await page.locator('#trace-select option[value="imported"]').count(), 1);

  // Import validation remains local and leaves the previous valid view intact.
  const dialog = page.waitForEvent('dialog').then(async alert => {
    assert.match(alert.message(), /Could not import trace/);
    await alert.dismiss();
  });
  await upload({ packets: [fixture.traceA.packets[0], fixture.traceA.packets[0]] });
  await dialog;
  assert.equal((await ids()).length, 4);

  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);
  console.log('Browser smoke passed: four shortcuts, all filter types, trace switching, scoped comparison, actual deterministic downloads, empty views, and import validation. No page errors or external requests.');
} finally {
  if (browser) await browser.close();
  await server.stop();
}
