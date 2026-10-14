import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { modelCards } from '../src/data/modelCards.js';
import { auditModelCard, exportReviewPacket } from '../src/lib/audit.js';

const harbor = modelCards.find((card) => card.id === 'harbor-screen');
const harborAudit = auditModelCard(harbor);
const tabNames = ['Overview', 'Fairness', 'Data & privacy', 'Security', 'Accessibility'];

// Keep UI interaction in the real keyboard tab order, as in keyboard.spec.js.
async function tabTo(page, target) {
  await expect(target).toBeVisible();
  for (let step = 0; step < 60; step += 1) {
    if (await target.evaluate((element) => element === element.ownerDocument.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  await expect(target, 'Control must be reachable using Tab').toBeFocused();
}

async function selectHarborAndAudit(page) {
  const select = page.getByLabel('Model card', { exact: true });
  await expect(select).toHaveJSProperty('tagName', 'SELECT');
  await expect(select.locator('option:checked')).toHaveText('Atlas Assist');
  await tabTo(page, select);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(select).toHaveValue(harbor.id);
  await expect(select.locator('option:checked')).toHaveText(harbor.name);

  const run = page.getByRole('button', { name: 'Run audit', exact: true });
  await tabTo(page, run);
  await page.keyboard.press('Space');
  await expect(page.getByRole('status')).toContainText(
    'Audit complete. Findings are prompts for review, not certification.',
  );
  await expect(run).toBeFocused();
}

async function openTab(page, name) {
  await tabTo(page, page.getByRole('tab', { name: 'Overview', exact: true }));
  for (let step = 0; step < tabNames.indexOf(name); step += 1) {
    await page.keyboard.press('ArrowRight');
  }
  const tab = page.getByRole('tab', { name, exact: true });
  await expect(tab).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}

async function expectFocusInside(dialog) {
  await expect.poll(() => dialog.evaluate((element) => (
    element.contains(element.ownerDocument.activeElement)
  )), { message: 'Focus must stay inside the export dialog' }).toBe(true);
}

async function checkFocusTrap(page, dialog) {
  const possibleTabStops = await dialog.locator(
    'a[href], button, input, select, textarea, [tabindex]',
  ).count();
  // Cross both boundaries even if the dialog gains another control.
  for (const key of ['Tab', 'Shift+Tab']) {
    for (let step = 0; step <= possibleTabStops; step += 1) {
      await page.keyboard.press(key);
      await expectFocusInside(dialog);
    }
  }
}

async function expectNoPageOverflow(page, section) {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  // Soft layout checks let the remaining keyboard/evidence checks run on the baseline.
  expect.soft(
    Math.max(dimensions.document, dimensions.body) - dimensions.viewport,
    `${section}: whole-document horizontal overflow (${JSON.stringify(dimensions)})`,
  ).toBeLessThanOrEqual(1);
}

async function expectRowValues(row, values) {
  const cells = row.locator(':scope > *');
  await expect(cells).toHaveCount(values.length);
  for (const [index, value] of values.entries()) {
    // Allow responsive captions alongside an intact value in its original cell.
    await expect.poll(() => cells.nth(index).evaluate((cell, expected) => (
      [cell, ...cell.querySelectorAll('*')].some((node) => node.textContent.trim() === expected)
    ), value), { message: `${values[0]}: cell ${index + 1} must contain the exact value ${value}` })
      .toBe(true);
  }
}

async function expectReadableRow(row, group) {
  const label = row.locator(':scope > :first-child');
  await expect(label).toHaveText(group);
  expect.soft(await label.isVisible(), `${group}: label must be visible`).toBe(true);
  const layout = await row.evaluate((element) => {
    const labelElement = element.firstElementChild;
    const labelBox = labelElement.getBoundingClientRect();
    const rowBox = element.getBoundingClientRect();
    const walker = document.createTreeWalker(labelElement, NodeFilter.SHOW_TEXT);
    const fonts = [];
    const textRects = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.textContent.trim()) continue;
      const style = getComputedStyle(node.parentElement);
      const fontSize = Number.parseFloat(style.fontSize);
      fonts.push({ fontSize, lineHeightRatio: Number.parseFloat(style.lineHeight) / fontSize });
      const range = document.createRange();
      range.selectNodeContents(node);
      textRects.push(...range.getClientRects());
    }
    const cellBoxes = [...element.children].map((cell) => cell.getBoundingClientRect());
    let cellOverlap = 0;
    for (let first = 0; first < cellBoxes.length; first += 1) {
      for (let second = first + 1; second < cellBoxes.length; second += 1) {
        const a = cellBoxes[first];
        const b = cellBoxes[second];
        cellOverlap = Math.max(cellOverlap, Math.min(
          Math.min(a.right, b.right) - Math.max(a.left, b.left),
          Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top),
        ));
      }
    }
    return {
      fonts,
      widthOverflow: labelElement.scrollWidth - labelElement.clientWidth,
      heightOverflow: labelElement.scrollHeight - labelElement.clientHeight,
      textClipping: Math.max(0, ...textRects.flatMap((rect) => [
        labelBox.left - rect.left, rect.right - labelBox.right,
        labelBox.top - rect.top, rect.bottom - labelBox.bottom,
      ])),
      viewportOverflow: Math.max(0, -rowBox.left, rowBox.right - document.documentElement.clientWidth),
      cellOverlap,
    };
  });
  expect(layout.fonts.length, `${group}: must contain rendered label text`).toBeGreaterThan(0);
  for (const font of layout.fonts) {
    expect.soft(font.fontSize, `${group}: readable label font`).toBeGreaterThanOrEqual(13);
    expect.soft(font.lineHeightRatio, `${group}: label line-height`).toBeGreaterThanOrEqual(1.4);
  }
  for (const bound of ['widthOverflow', 'heightOverflow', 'textClipping', 'viewportOverflow', 'cellOverlap']) {
    expect.soft(layout[bound], `${group}: ${bound}`).toBeLessThanOrEqual(1);
  }
}

for (const width of [320, 375, 740]) {
  test.describe(`${width}px audit shell`, () => {
    test.use({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });

    test.beforeEach(async ({ page }) => {
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'Model card audit', level: 1, exact: true }))
        .toBeVisible();
      await page.evaluate(() => document.fonts.ready);
    });

    test('Overview and Fairness retain readable Harbor labels and complete metrics without page overflow', async ({ page }) => {
      await expectNoPageOverflow(page, 'Default Atlas Overview');
      await selectHarborAndAudit(page);
      await expect(page.getByRole('tab', { name: 'Overview', exact: true }))
        .toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('.score-row > strong')).toHaveText(`${harborAudit.coverage}%`);
      await expectNoPageOverflow(page, 'Harbor Overview');

      const snapshotRows = page.locator('.mini-table .table-row');
      const missingGroups = harbor.expectedSubgroups.filter((group) => (
        !harbor.metrics.some((metric) => metric.group === group)
      ));
      // Overview is a bounded snapshot: two recorded metrics and the first missing group.
      await expect(snapshotRows).toHaveCount(3);
      for (const group of [...harbor.metrics.map((metric) => metric.group), missingGroups[0]]) {
        const row = snapshotRows.filter({ has: page.getByText(group, { exact: true }) });
        const metric = harbor.metrics.find((item) => item.group === group);
        await expectRowValues(row, metric
          ? [group, `${metric.accuracy}%`, `${metric.falsePositiveRate}%`]
          : [group, '—', 'Missing']);
        await expectReadableRow(row, group);
      }

      await openTab(page, 'Fairness');
      await expect(page.getByRole('heading', { name: 'Subgroup fairness', exact: true })).toBeVisible();
      await expect(page.getByText('Evidence-only', { exact: true })).toBeVisible();
      await expectNoPageOverflow(page, 'Harbor Fairness');
      const fullRows = page.locator('.full-table-row');
      await expect(fullRows).toHaveCount(harbor.expectedSubgroups.length);
      for (const group of harbor.expectedSubgroups) {
        const row = fullRows.filter({ has: page.getByText(group, { exact: true }) });
        const metric = harbor.metrics.find((item) => item.group === group);
        await expectRowValues(row, metric
          ? [group, String(metric.sampleSize), `${metric.accuracy}%`, `${metric.falsePositiveRate}%`,
            metric.sampleSize < 30 ? 'Small sample' : 'Documented']
          : [group, '—', '—', '—', 'Missing data']);
        // Both long missing-group labels, including Multilingual applicants, must fit.
        await expectReadableRow(row, group);
      }
    });

    test('keyboard-only consent review and export preserve evidence, dialog focus, and the complete packet', async ({ page }) => {
      await expectNoPageOverflow(page, 'Default Atlas Overview');
      await selectHarborAndAudit(page);
      const consentNavigation = page.getByRole('button', { name: 'Data & consent', exact: true });
      if (await consentNavigation.isVisible()) {
        await tabTo(page, consentNavigation);
        await page.keyboard.press('Space');
        await expect(consentNavigation).toHaveAttribute('aria-current', 'page');
      } else {
        await openTab(page, 'Data & privacy');
      }
      await expect(page.getByRole('tab', { name: 'Data & privacy', exact: true }))
        .toHaveAttribute('aria-selected', 'true');
      await expect(page.getByRole('heading', { name: 'Data use & consent', exact: true })).toBeVisible();
      const finding = page.getByRole('article', {
        name: 'Consent contradiction: requirements are contradictory', exact: true,
      });
      await expect(finding).toBeVisible();
      await expect(finding).toContainText('within these scopes: training.');
      await expect(finding).toContainText('Agreement between flags alone is insufficient');
      for (const id of ['harbor-du1', 'harbor-du2']) {
        const statement = harbor.dataUse.statements.find((item) => item.id === id);
        const source = finding.getByRole('listitem').filter({ hasText: id });
        await expect(source).toContainText(statement.text);
        await expect(source).toContainText('requiresConsent=true');
      }
      await expect(finding.locator('code')).toHaveText([
        'dataUse.statements[0]', 'dataUse.statements[1]', 'dataUse.consent',
      ]);
      await expectNoPageOverflow(page, 'Harbor Data & privacy');

      const exportButton = page.getByRole('button', { name: 'Export review packet', exact: true });
      await tabTo(page, exportButton);
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', { name: 'Export review packet', exact: true });
      await expect(dialog).toBeVisible();
      await expectFocusInside(dialog);
      await expectNoPageOverflow(page, 'Export dialog');
      const dialogBox = await dialog.boundingBox();
      expect.soft(dialogBox.x, 'Dialog left edge must fit the viewport').toBeGreaterThanOrEqual(-1);
      expect.soft(dialogBox.x + dialogBox.width, 'Dialog right edge must fit the viewport')
        .toBeLessThanOrEqual(width + 1);

      const notes = dialog.getByLabel('Reviewer notes', { exact: true });
      await expect(notes).toHaveJSProperty('tagName', 'TEXTAREA');
      await tabTo(page, notes);
      const reviewerNotes = `Synthetic narrow-screen review at ${width}px: reconcile training consent; evidence-only, not certification.`;
      await page.keyboard.type(reviewerNotes);
      await expect(notes).toHaveValue(reviewerNotes);
      await checkFocusTrap(page, dialog);
      await page.keyboard.press('Escape');
      await expect(dialog).not.toBeVisible();
      await expect(exportButton).toBeFocused();

      await page.keyboard.press('Space');
      await expect(dialog).toBeVisible();
      await expectFocusInside(dialog);
      await expect(notes).toHaveValue(reviewerNotes);
      await tabTo(page, dialog.getByRole('button', { name: 'Download Markdown', exact: true }));
      const pendingDownload = page.waitForEvent('download');
      await page.keyboard.press('Enter');
      const download = await pendingDownload;
      expect(download.suggestedFilename()).toMatch(/\.(?:md|markdown)$/i);
      expect(await download.failure()).toBeNull();
      const downloadPath = await download.path();
      expect(downloadPath).not.toBeNull();
      const packet = await readFile(downloadPath, 'utf8');
      expect(packet).toContain(`# Review packet: ${harbor.name}`);
      expect(packet).toContain(reviewerNotes);
      expect(packet).toContain('privacy-consent-conflict: Consent contradiction: requirements are contradictory');
      for (const id of ['harbor-du1', 'harbor-du2']) {
        const statement = harbor.dataUse.statements.find((item) => item.id === id);
        expect(packet).toContain(`| ${id} | training | true | ${statement.text} |`);
      }
      for (const path of ['dataUse.statements\\[0\\]', 'dataUse.statements\\[1\\]', 'dataUse.consent']) {
        expect(packet).toContain(path);
      }
      expect(packet).toMatch(/\*\*Synthetic notice:\*\*.*explicitly synthetic and fictional/);
      expect(packet).toContain('not a safety certification or permission to deploy');
      expect(packet).toContain('Evidence-reference coverage does not verify the evidence or establish the truth of the claim.');
      expect(packet).toContain('Coverage measures documentation and recorded checks, not model quality, legal compliance, fairness guarantees, privacy guarantees, or overall safety.');
      for (const section of [
        'Card snapshot', 'Scoring methodology and caveats', 'Coverage dimensions',
        'Claims and evidence references', 'Claim evidence inspection', 'Subgroup evaluation',
        'Data use and consent', 'Threat scenarios and mitigations', 'Accessibility checks',
        'Privacy / fairness strategy tradeoffs', 'Synthetic threat fixtures',
        'Scoring-rule explanations', 'Findings and suggested actions', 'Reviewer notes', 'Limitations',
      ]) {
        expect(packet).toContain(`\n## ${section}\n`);
      }
      // Responsive layout and navigation must not filter records or change scoring.
      expect(packet).toBe(exportReviewPacket(harbor, harborAudit, reviewerNotes));
      await expect(dialog).not.toBeVisible();
      await expect(exportButton).toBeFocused();
    });
  });
}
