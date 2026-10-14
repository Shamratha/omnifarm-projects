import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Optional browser tooling stays separate from the dependency-free application.
// Set PLAYWRIGHT_MODULE to the absolute path of an installed playwright/index.mjs.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
let base;
const root = fileURLToPath(new URL('../', import.meta.url));
const server = spawn(process.execPath, ['server.js', '--port', '0'], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
let browser;

async function textContrast(locator) {
  return locator.evaluate((element) => {
    const luminance = (channels) => channels.map((value) => {
      const scaled = value / 255;
      return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    const rgb = (color) => color.match(/[\d.]+/g).slice(0, 3).map(Number);
    let parent = element;
    while (parent && ['rgba(0, 0, 0, 0)', 'transparent'].includes(getComputedStyle(parent).backgroundColor)) parent = parent.parentElement;
    const foreground = luminance(rgb(getComputedStyle(element).color));
    const background = luminance(parent ? rgb(getComputedStyle(parent).backgroundColor) : [255, 255, 255]);
    return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
  });
}

try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Local browser-test server did not start.')), 10000);
    server.once('error', (error) => { clearTimeout(timer); reject(error); });
    server.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Local browser-test server exited (${code}).`)); });
    let output = '';
    server.stdout.on('data', (chunk) => {
      output += chunk.toString();
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); base = match[0]; resolve(); }
    });
  });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const errors = [];
  const externalRequests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (/^https?:/.test(request.url()) && !request.url().startsWith(base)) externalRequests.push(request.url());
  });
  await page.goto(base, { waitUntil: 'networkidle' });
  // The first Tab exposes the skip link; activating it skips sidebar controls.
  await page.keyboard.press('Tab');
  const skipLink = page.getByRole('link', { name: 'Skip to workspace', exact: true });
  assert.equal(await skipLink.evaluate((element) => element.matches(':focus')), true);
  assert.equal(await skipLink.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return bounds.top >= 0 && bounds.bottom <= innerHeight;
  }), true, 'Focused skip link is visibly within the viewport');
  await page.keyboard.press('Enter');
  assert.equal(new URL(page.url()).hash, '#main-content');
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('#notifications-button').evaluate((element) => element.matches(':focus')), true, 'Skip link moves keyboard navigation into the workspace');
  assert.equal(await page.locator('#queue-body tr').count(), 6);
  assert.equal(await page.locator('#metric-attention').textContent(), '03');
  assert.equal(await page.locator('#metric-capacity').textContent(), '64%');
  assert.equal(await page.locator('#chart-points circle').count(), 6);
  assert.equal(await page.locator('#queue-body .language-badge').count(), 6);
  assert.equal(await page.locator('#queue-body').getByRole('img', { name: '1 required document missing — intake accepted', exact: true }).count(), 1);
  assert.equal(await page.locator('#audit-view').isVisible(), false);
  await page.locator('#queue-body [data-case-id="CF-0143"] .case-select').focus();
  await page.keyboard.press('Enter');
  assert.match(await page.locator('#case-detail').textContent(), /CF-0143/);
  assert.match(await page.locator('#case-detail .detail-status').textContent(), /Review required/);
  assert.match(await page.locator('#case-detail .detail-facts').textContent(), /accepted/);
  assert.match(await page.getByRole('note', { name: 'Urgent document follow-up' }).textContent(), /do not delay intake/);
  assert.match(await page.locator('#case-announcement').textContent(), /Urgent.*1 missing document; intake accepted/);
  const benefitsMeter = page.locator('#workload-list').getByRole('meter', { name: 'Benefits & Support workload' });
  assert.equal(await benefitsMeter.getAttribute('aria-valuenow'), '70');
  assert.match(await benefitsMeter.getAttribute('aria-valuetext'), /7 active of 10 capacity; 3 available; 1 urgent; 1 awaiting documents; 0 over capacity/);
  assert.equal(await page.locator('#deadline-breakdown-title').isVisible(), true);
  assert.equal(await page.locator('.boundary-row').count(), 6);
  assert.match(await page.locator('.deadline-card').textContent(), /Exactly 24h/);
  assert.match(await page.locator('.deadline-card').textContent(), /Exactly 72h/);
  assert.match(await page.locator('.escalation-card').textContent(), /ESCALATION RULE/);
  assert.match(await page.locator('.escalation-card').textContent(), /Deadline is at or inside the 24-hour urgent boundary/);
  await page.locator('#queue-body [data-case-id="CF-0143"] .route-explain').click();
  assert.match(await page.locator('#dialog-content').textContent(), /Why this route was chosen/);
  assert.equal(await page.locator('#dialog-content .boundary-row').count(), 6);
  assert.match(await page.locator('#dialog-content').textContent(), /No notification or referral is sent/);
  await page.locator('.dialog-close').click();

  await page.locator('#search-input').fill('Arabic');
  assert.equal(await page.locator('#queue-body tr').count(), 1);
  assert.match(await page.locator('#queue-body').textContent(), /CF-0145/);
  await page.locator('#search-input').fill('nothing-matches-this');
  assert.equal(await page.locator('#empty-state').isVisible(), true);
  await page.locator('#search-input').fill('');
  await page.locator('#filter-button').click();
  await page.locator('[data-filter="documents"]').click();
  assert.equal(await page.locator('#queue-body tr').count(), 2);
  await page.locator('#queue-body [data-case-id="CF-0146"] .case-select').click();
  assert.match(await page.locator('#case-detail').textContent(), /CF-0146.*2 missing/s);
  assert.match(await page.locator('#case-detail .escalation-card').textContent(), /72-hour service review boundary/);
  assert.match(await page.locator('#case-detail .escalation-card').textContent(), /2 required document/);
  await page.locator('#open-intake').click();
  assert.match(await page.locator('#dialog-content').textContent(), /Fictional intake only/);
  assert.equal(await page.locator('.missing-attachment').count(), 2);
  await page.locator('.attachment:not(.missing-attachment) summary').click();
  assert.match(await page.locator('.attachment[open] pre').textContent(), /DEMO ONLY/);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#case-dialog').isVisible(), false);
  await page.locator('#open-policy').click();
  assert.match(await page.locator('#dialog-content').textContent(), /Outstanding/);
  assert.match(await page.locator('#dialog-content').textContent(), /within 72 hours/);
  await page.locator('.dialog-close').click();
  await page.locator('#toggle-preview').click();
  assert.equal(await page.locator('#preview-fields').isVisible(), true);
  assert.match(await page.locator('#preview-fields').textContent(), /REDACTED/);
  await page.locator('#share-redacted').click();
  assert.doesNotMatch(await page.locator('#dialog-content').textContent(), /Lucien Moreau|lucien.moreau@example.test|9 Orchard Mews/);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#download-redacted').click(),
  ]);
  assert.equal(download.suggestedFilename(), 'CF-0146-redacted.json');
  const exported = JSON.parse(await readFile(await download.path(), 'utf8'));
  assert.equal(exported.person.email, 'xxxxxxxx');
  assert.equal(exported.route.teamId, 'team-permits');
  assert.ok(exported.documents.every((doc) => doc.content === 'xxxxxxxx'));
  await page.keyboard.press('Escape');

  await page.locator('[data-filter="all"]').click();
  await page.locator('#queue-body [data-case-id="CF-0145"] .case-select').click();
  assert.match(await page.locator('#case-detail').textContent(), /Step-free access/);
  await page.locator('#open-intake').click();
  assert.equal(await page.locator('.source-text').getAttribute('lang'), 'ar');
  assert.equal(await page.locator('.source-text').getAttribute('dir'), 'auto');
  assert.match(await page.locator('.source-text').textContent(), /عيادة/);
  await page.keyboard.press('Escape');

  await page.locator('.nav-item[data-view="overview"]').focus();
  for (const [view, key] of [['queue', 'Enter'], ['workload', 'Space'], ['audit', 'Enter']]) {
    await page.keyboard.press('Tab');
    const navigation = page.locator(`.nav-item[data-view="${view}"]`);
    assert.equal(await navigation.evaluate((element) => element.matches(':focus')), true, `${view} is reachable by Tab`);
    await page.keyboard.press(key);
    assert.equal(await page.locator(`#${view}-view`).isVisible(), true, `${key} activates ${view}`);
    assert.equal(await navigation.getAttribute('aria-current'), 'page');
    assert.equal(await page.locator('.nav-item[aria-current="page"]').count(), 1);
  }
  const initialEvents = await page.locator('.audit-stream-row').count();
  assert.ok(initialEvents >= 30);
  await page.locator('#rerun-button').click();
  assert.equal(await page.locator('.audit-stream-row').count(), initialEvents * 2);
  assert.equal(await page.locator('#metric-capacity').textContent(), '64%');
  await page.locator('.nav-item[data-view="workload"]').click();
  assert.equal(await page.locator('.workload-card').count(), 6);
  assert.equal(await page.locator('#workload-view').isVisible(), true);
  assert.equal(await page.locator('#workload-view').getByRole('meter').count(), 6);
  assert.match(await page.locator('#workload-view').getByRole('meter', { name: 'Benefits & Support workload' }).getAttribute('aria-valuetext'), /7 active of 10 capacity; 3 available; 1 urgent; 1 awaiting documents; 0 over capacity/, 'Routing rerun does not inflate workload counts');
  assert.match(await page.locator('#workload-view [data-team-id="team-benefits"] .workload-attention').textContent(), /1 urgent.*1 awaiting documents/);
  await page.locator('.nav-item[data-view="queue"]').click();
  await page.locator('#full-filter').selectOption('urgent');
  assert.equal(await page.locator('#full-queue-body tr').count(), 2);
  await page.locator('#full-search').fill('housing');
  assert.equal(await page.locator('#full-queue-body tr').count(), 1);
  await page.locator('#full-search').fill('does-not-exist');
  assert.equal(await page.locator('#full-empty').isVisible(), true);
  await page.locator('#full-search').fill('');
  await page.locator('#full-filter').selectOption('all');
  await page.locator('#full-queue-body .case-select').first().click();
  assert.equal(await page.locator('#overview-view').isVisible(), true);
  await page.locator('#open-case-audit').click();
  assert.equal(await page.locator('.dialog-audit li').count(), 12);
  await page.keyboard.press('Escape');

  for (const width of [320, 390, 768, 1024, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const hasOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert.equal(hasOverflow, false, `Page must not overflow at ${width}px`);
    if (width <= 390) {
      const deadline = page.locator('#queue-body [data-case-id="CF-0143"] .deadline-cell');
      await deadline.scrollIntoViewIfNeeded();
      assert.match(await deadline.textContent(), /Due in 18h.*UTC/s);
      const readability = await deadline.evaluate((cell) => {
        const value = cell.querySelector('.due-value');
        const date = cell.querySelector('.due-date');
        const region = cell.closest('.queue-table-wrap').getBoundingClientRect();
        const bounds = cell.getBoundingClientRect();
        return {
          labelSize: parseFloat(getComputedStyle(value).fontSize),
          dateSize: parseFloat(getComputedStyle(date).fontSize),
          labelClipped: value.scrollWidth > value.clientWidth,
          dateClipped: date.scrollWidth > date.clientWidth,
          withinScrollRegion: bounds.left >= region.left - 1 && bounds.right <= region.right + 1,
        };
      });
      assert.ok(readability.labelSize >= 14, `Readable mobile due label at ${width}px`);
      assert.ok(readability.dateSize >= 12, `Readable UTC date at ${width}px`);
      assert.equal(readability.labelClipped, false);
      assert.equal(readability.dateClipped, false);
      assert.equal(readability.withinScrollRegion, true);
      assert.ok(await textContrast(deadline.locator('.due-value')) >= 4.5, 'Mobile deadline label has 4.5:1 contrast');
      assert.ok(await textContrast(deadline.locator('.due-date')) >= 4.5, 'Mobile UTC date has 4.5:1 contrast');
      // The table retains native semantics and can be scrolled without a mouse.
      const region = page.getByRole('region', { name: 'Incoming cases table', exact: true });
      await region.evaluate((element) => { element.scrollLeft = 0; });
      await region.focus();
      await page.keyboard.press('ArrowRight');
      await page.waitForFunction(() => document.querySelector('.queue-table-wrap').scrollLeft > 0);
      const inspect = page.locator('#queue-body [data-case-id="CF-0143"] .route-explain');
      await inspect.focus();
      await page.keyboard.press('Enter');
      assert.match(await page.getByRole('dialog').textContent(), /income evidence/i);
      assert.equal(await page.locator('#case-dialog').evaluate((dialog) => dialog.scrollWidth > dialog.clientWidth), false);
      await page.keyboard.press('Escape');
      assert.equal(await inspect.evaluate((element) => element.matches(':focus')), true, 'Closing the dialog restores keyboard focus to its trigger');
    }
  }

  await page.setViewportSize({ width: 390, height: 900 });
  await page.locator('.nav-item[data-view="queue"]').click();
  const fullDeadline = page.locator('#full-queue-body [data-case-id="CF-0143"] .deadline-cell');
  await fullDeadline.scrollIntoViewIfNeeded();
  assert.match(await fullDeadline.textContent(), /Due in 18h.*UTC/s);
  assert.equal(await fullDeadline.locator('.due-date').evaluate((element) => element.scrollWidth > element.clientWidth), false);
  await page.locator('#full-queue-body [data-case-id="CF-0143"] .case-select').click();
  assert.ok(await textContrast(page.locator('#case-detail .document-followup')) >= 4.5, 'Urgent document note has 4.5:1 contrast');

  // Exercise an urgent incomplete case above capacity using only local synthetic
  // data in this test page. Reload below restores the shipped fixture batch.
  await page.setViewportSize({ width: 390, height: 900 });
  await page.evaluate(async () => {
    const { teams, syntheticCases } = await import('/src/data.js');
    const benefits = teams.find((team) => team.id === 'team-benefits');
    benefits.baseline = benefits.capacity;
    syntheticCases.find((item) => item.id === 'CF-0143').documents = [];
  });
  await page.locator('#rerun-button').click();
  await page.locator('#queue-body [data-case-id="CF-0143"] .case-select').click();
  const followup = page.getByRole('note', { name: 'Urgent document follow-up' });
  assert.match(await followup.textContent(), /do not delay intake/);
  assert.match(await page.locator('#case-detail .detail-facts').textContent(), /accepted intake.*incomplete docs/);
  assert.match(await page.locator('#case-detail .escalation-card').textContent(), /supervisor review/);
  const overflowingMeter = page.locator('#workload-list').getByRole('meter', { name: 'Benefits & Support workload' });
  assert.equal(await overflowingMeter.getAttribute('aria-valuenow'), '100');
  assert.equal(await overflowingMeter.getAttribute('aria-valuemax'), '100');
  assert.match(await overflowingMeter.getAttribute('aria-valuetext'), /11 active of 10 capacity; 0 available; 1 urgent; 1 awaiting documents; 1 over capacity/);
  assert.match(await page.locator('#workload-list [data-team-id="team-benefits"] .workload-attention').textContent(), /1 over capacity · supervisor review/);
  const workloadAccessibility = await page.locator('#workload-list').ariaSnapshot();
  assert.match(workloadAccessibility, /meter "Benefits & Support workload"/);
  assert.match(workloadAccessibility, /1 urgent/);
  assert.match(workloadAccessibility, /1 awaiting documents/);
  assert.ok(await textContrast(page.locator('#workload-list [data-team-id="team-benefits"] .urgent-text')) >= 4.5, 'Urgent workload text has 4.5:1 contrast');
  await page.locator('.nav-item[data-view="workload"]').click();
  assert.match(await page.locator('#workload-view [data-team-id="team-benefits"] .workload-attention').textContent(), /1 over capacity/);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.locator('#metric-capacity').textContent(), '64%');
  assert.deepEqual(errors, [], 'No browser runtime errors');
  assert.deepEqual(externalRequests, [], 'No external API/font/image requests');
  console.log('Browser smoke passed: queue/search/filter, attachments, policies, Arabic/access, redacted download, audit/workload rerun stability, mobile UTC deadline readability, skip link, Tab/Enter/Space navigation, keyboard scrolling/dialog focus return, urgent incomplete intake, labeled workload meters/overflow, responsive layouts, and zero external requests.');
} finally {
  await browser?.close();
  if (server.exitCode == null) {
    const stopped = once(server, 'exit');
    server.kill();
    await stopped;
  }
}
