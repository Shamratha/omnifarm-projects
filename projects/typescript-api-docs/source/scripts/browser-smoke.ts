import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const port = 4173;
const preview = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(port)], {
  stdio: 'ignore',
});

async function waitForPreview(): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.ok) return;
    } catch { /* preview is still starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Vite preview did not start.');
}

try {
  await waitForPreview();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  if (await page.locator('.symbol-item').count() === 0) throw new Error('Reference navigation rendered no symbols.');

  await page.locator('#symbol-search').fill('Compiler');
  const resultVersions = await page.locator('.result-version').allTextContents();
  if (!resultVersions.some(text => text.includes('5.99.0')) || !resultVersions.some(text => text.includes('5.98.0'))) {
    throw new Error('Search results did not show both documentation versions.');
  }
  await page.locator('.symbol-item').first().click();
  if (!new URL(page.url()).searchParams.has('symbol')) throw new Error('Search result did not create a symbol deep link.');
  const sourceLink = await page.locator('.source-link').getAttribute('href');
  if (!sourceLink || !sourceLink.includes('source=') || !sourceLink.includes('#L')) throw new Error('Symbol source link is not a line-addressable deep link.');
  const sourceResponse = await page.request.get(new URL(sourceLink, page.url()).toString());
  if (!sourceResponse.ok()) throw new Error(`Symbol source link returned ${sourceResponse.status()}.`);

  await page.goto(`http://127.0.0.1:${port}/?version=5.99.0&compare=true#compare`, { waitUntil: 'networkidle' });
  if ((await page.locator('h1').first().textContent()) !== 'Compare API versions') throw new Error('Comparison page did not render.');
  if (await page.locator('.diff-group').count() < 3 || await page.locator('.signature-diff-row').count() === 0) throw new Error('Comparison page did not render classifications and side-by-side signatures.');
  const comparisonLink = await page.locator('.diff-row').first().getAttribute('href');
  if (!comparisonLink || !comparisonLink.includes('symbol=') || !comparisonLink.includes('#')) throw new Error('Comparison symbol link is not a stable deep link.');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`http://127.0.0.1:${port}/?version=5.99.0#reference/Compiler`, { waitUntil: 'networkidle' });
  await page.locator('[data-action="toggle-sidebar"]').click();
  if (await page.locator('#symbol-search').evaluate(element => document.activeElement !== element)) throw new Error('Mobile navigation did not move focus into the drawer.');
  await page.keyboard.press('Escape');
  if (await page.locator('.sidebar-is-open').count() !== 0) throw new Error('Escape did not close mobile navigation.');

  console.log('browser smoke: search, deep links, comparison, and mobile navigation passed');
  await browser.close();
} finally {
  preview.kill('SIGTERM');
}
