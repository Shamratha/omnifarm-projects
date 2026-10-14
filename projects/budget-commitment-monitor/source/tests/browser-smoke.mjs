import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Runs against a fresh local server; does not interfere with an existing preview.
const server = spawn(process.execPath, ['server.js'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  env: { ...process.env, PORT: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let browser;
try {
  const address = await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('Local server did not start')), 10000);
    server.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timeout); resolve(match[0]); }
    });
    server.once('error', error => { clearTimeout(timeout); reject(error); });
    server.once('exit', code => { clearTimeout(timeout); reject(new Error(`Server exited: ${code}`)); });
  });
  browser = await chromium.launch({ headless: true });
  for (const width of [1440, 600, 480, 390, 320]) {
    await test(`drawer, readable exceptions and exact filtered totals at ${width}px`, async () => {
      const context = await browser.newContext({
        viewport: { width, height: 900 }, isMobile: width <= 600, hasTouch: width <= 600,
      });
      try {
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(address);
        await page.waitForSelector('#records-body tr');
        const text = async (selector, expected) => assert.equal(await page.locator(selector).textContent(), expected, selector);
        // Check painted text bounds, not just the page's scroll width: overflow
        // can be hidden by a card or table even when the page itself fits.
        const readableText = async (selector, { minFont = 0, minWeight = 0, singleLine = false } = {}) => {
          const results = await page.locator(selector).evaluateAll((elements, options) => elements.map(el => {
            const style = getComputedStyle(el);
            const box = el.getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(el);
            const painted = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0);
            return {
              text: el.textContent,
              fits: box.width > 0 && painted.length > 0 && painted.every(rect => rect.left >= box.left - 1 && rect.right <= box.right + 1),
              font: Number.parseFloat(style.fontSize), weight: Number.parseInt(style.fontWeight, 10),
              whole: !options.singleLine || range.getBoundingClientRect().height <= Number.parseFloat(style.lineHeight) + 1,
            };
          }), { singleLine });
          assert.ok(results.length > 0, `${selector} missing`);
          for (const result of results) {
            assert.ok(result.fits, `${selector}: clipped text ${result.text} at ${width}px`);
            assert.ok(result.font >= minFont, `${selector}: font too small`);
            assert.ok(result.weight >= minWeight, `${selector}: total not prominent`);
            assert.ok(result.whole, `${selector}: currency wrapped across lines`);
          }
        };
        const totals = async ({ projected, untracked, committed, remaining, active, policy, overdue }) => {
          for (const [selector, expected] of Object.entries({
            '#projected-exact': projected, '#untracked-exact': untracked,
            '#committed-label': committed, '#remaining-exact': remaining,
            '#available-label': remaining, '#spent-label': '$1,084,200.00',
            '#active-count': String(active), '#policy-count': String(policy), '#overdue-count': String(overdue),
          })) await text(selector, expected);
          for (const selector of ['#projected-exact', '#untracked-exact', '#remaining-exact', '#committed-label']) {
            const visible = await page.locator(selector).evaluate(el => {
              const rect = el.getBoundingClientRect();
              return el.scrollWidth <= el.clientWidth && rect.left >= 0 && rect.right <= innerWidth;
            });
            assert.ok(visible, `${selector} clipped at ${width}px`);
          }
          if (width <= 600) {
            await readableText('#projected-exact, #untracked-exact, #remaining-exact', { minFont: 20, minWeight: 600, singleLine: true });
            await readableText('#spent-label, #committed-label, #available-label', { minFont: 13, singleLine: true });
          }
        };
        await totals({ projected: '$1,892,200.00', untracked: '$108,000.00', committed: '$808,000.00', remaining: '$607,800.00', active: 14, policy: 3, overdue: 1 });
        assert.equal(await page.locator('.policy-rule-card').count(), 6);
        if (width <= 600) {
          await readableText('.flag, .status-badge', { minFont: 12 });
          await readableText('.policy-rule-threshold, .policy-rule-provenance', { minFont: 13 });
          // Stress the real badge with a long readable label and an unbroken ID.
          const badge = page.locator('[data-row-id="REQ-2026-008"] .flag-policy');
          const original = await badge.innerHTML();
          await badge.evaluate(el => {
            el.lastChild.textContent = 'Policy exception · Approval chain — Missing required purchasing review · PROC-' + 'APPROVAL'.repeat(12);
          });
          await readableText('[data-row-id="REQ-2026-008"] .flag-policy', { minFont: 12 });
          assert.ok(await badge.evaluate(el => el.getBoundingClientRect().height > Number.parseFloat(getComputedStyle(el).lineHeight) * 2), 'Long exception label must wrap onto multiple lines');
          await badge.evaluate((el, html) => { el.innerHTML = html; }, original);
        }
        const open = async id => {
          await page.locator(`[data-row-id="${id}"] .record-button`).click();
          await text('#drawer-id', id);
          assert.equal(await page.locator('.app-shell').evaluate(el => el.inert), true);
          assert.equal(await page.locator('.close-drawer').evaluate(el => el === document.activeElement), true);
        };
        const close = async id => {
          await page.keyboard.press('Escape');
          assert.equal(await page.locator('#detail-drawer').isVisible(), false);
          assert.equal(await page.locator('.app-shell').evaluate(el => el.inert), false);
          assert.equal(await page.locator(`[data-row-id="${id}"] .record-button`).evaluate(el => el === document.activeElement), true);
        };
        await open('REQ-2026-008');
        await text('.verification-state', 'Not verified');
        await text('.approval-progress-count', '1/2 complete');
        assert.equal(await page.locator('.approval-progress').getAttribute('value'), '50');
        assert.ok((await page.locator('.approval-chain').innerText()).includes('Overdue · 6 days'));
        assert.ok((await page.locator('.verification-source').innerText()).includes('2026-09-18'));
        await text('.milestone-progress-count', '1/2 complete');
        assert.ok((await page.locator('.next-milestone').innerText()).includes('Fall planting'));
        await text('.contribution-amount', '$45,000.00');
        const explanation = await page.locator('.detail-flag-policy').innerText();
        for (const value of ['PROC-AP-00', 'Reason:', 'Evidence:', 'Rule:', 'Provenance:', 'Synthetic FY26 policy', 'Threshold / scope:']) assert.ok(explanation.includes(value), value);
        if (width <= 600) await readableText('.detail-flag-policy strong, .detail-flag-policy p', { minFont: 13 });
        await page.locator('.source-description').scrollIntoViewIfNeeded();
        assert.equal(await page.locator('#detail-drawer').evaluate(el => el.scrollWidth <= el.clientWidth), true);
        await close('REQ-2026-008');
        await open('REQ-2026-001');
        await text('.verification-state', 'Verified');
        assert.equal(await page.locator('.approval-progress').getAttribute('value'), '100');
        await text('.contribution-amount', '$180,000.00');
        await close('REQ-2026-001');
        await open('REQ-2026-002');
        await text('.contribution-amount', '$0.00');
        assert.ok((await page.locator('.contribution-explanation').innerText()).includes('Linked duplicate'));
        assert.ok((await page.locator('.detail-flag-policy').innerText()).includes('PROC-CB-01'));
        await close('REQ-2026-002');
        await open('REQ-2026-010');
        assert.ok((await page.locator('.detail-flag-policy').innerText()).includes('PROC-EP-04'));
        await close('REQ-2026-010');
        await open('REQ-2026-011');
        await text('.contribution-amount', '$0.00');
        assert.equal(await page.locator('.detail-list li[data-state="cancelled"]').count(), 2);
        assert.equal(await page.locator('.detail-flag-policy').count(), 0);
        await close('REQ-2026-011');
        const click = filter => page.locator(`[data-filter="${filter}"]`).click();
        await click('untracked'); await click('policy');
        await totals({ projected: '$1,157,200.00', untracked: '$73,000.00', committed: '$73,000.00', remaining: '$1,342,800.00', active: 2, policy: 2, overdue: 1 });
        assert.equal(await page.locator('#records-body tr').count(), 2);
        await text('[data-filter="policy"] span', '2');
        await click('overdue');
        await totals({ projected: '$1,129,200.00', untracked: '$45,000.00', committed: '$45,000.00', remaining: '$1,370,800.00', active: 1, policy: 1, overdue: 1 });
        const before = await page.locator('.kpi-grid').innerText();
        await open('REQ-2026-008'); await close('REQ-2026-008');
        assert.equal(await page.locator('.kpi-grid').innerText(), before, 'Opening drawer must not change totals');
        await page.locator('#record-search').fill('no match');
        await totals({ projected: '$1,084,200.00', untracked: '$0.00', committed: '$0.00', remaining: '$1,415,800.00', active: 0, policy: 0, overdue: 0 });
        assert.equal(await page.locator('#empty-state').isVisible(), true);
        await page.locator('#clear-filters').click();
        await click('policy');
        await page.locator('#record-search').fill('lighting change order');
        await totals({ projected: '$1,084,200.00', untracked: '$0.00', committed: '$0.00', remaining: '$1,415,800.00', active: 1, policy: 1, overdue: 0 });
        await click('all');
        await page.locator('#record-search').fill('REQ-2026-011');
        await totals({ projected: '$1,084,200.00', untracked: '$0.00', committed: '$0.00', remaining: '$1,415,800.00', active: 0, policy: 0, overdue: 0 });
        await page.locator('#record-search').fill('');
        await totals({ projected: '$1,892,200.00', untracked: '$108,000.00', committed: '$808,000.00', remaining: '$607,800.00', active: 14, policy: 3, overdue: 1 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Page must not overflow');
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });
  }
} finally {
  if (browser) await browser.close();
  if (server.exitCode === null) {
    const exited = once(server, 'exit');
    server.kill();
    await exited;
  }
}
