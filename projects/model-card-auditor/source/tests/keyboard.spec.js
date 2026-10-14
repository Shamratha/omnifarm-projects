import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';

const navigationNames = [
  'Overview',
  'Model cards',
  'Subgroup fairness',
  'Data & consent',
  'Threat assessment',
  'Accessibility',
];
const tabNames = ['Overview', 'Fairness', 'Data & privacy', 'Security', 'Accessibility'];

// Find controls through the real tab order; all UI actions use keyboard keys.
async function tabTo(page, target) {
  await expect(target).toBeVisible();
  for (let step = 0; step < 60; step += 1) {
    if (await target.evaluate((element) => element === element.ownerDocument.activeElement)) {
      return;
    }
    await page.keyboard.press('Tab');
  }
  await expect(target, 'Control must be reachable through the keyboard tab order').toBeFocused();
}

async function expectFocusInside(dialog) {
  await expect.poll(() => dialog.evaluate((element) => (
    element.contains(element.ownerDocument.activeElement)
  )), { message: 'Focus must stay inside the export dialog' }).toBe(true);
}

async function checkFocusTrap(page, dialog) {
  // This is an upper bound (including hidden/disabled controls), so each pass
  // crosses a dialog boundary even if more focusable controls are added later.
  const possibleTabStops = await dialog.locator(
    'a[href], button, input, select, textarea, [tabindex]',
  ).count();
  for (const key of ['Tab', 'Shift+Tab']) {
    for (let step = 0; step <= possibleTabStops; step += 1) {
      await page.keyboard.press(key);
      await expectFocusInside(dialog);
    }
  }
}

async function runAudit(page, activationKey = 'Enter') {
  const button = page.getByRole('button', { name: 'Run audit', exact: true });
  await tabTo(page, button);
  await page.keyboard.press(activationKey);
  await expect(page.getByRole('status')).toContainText('Audit complete. Findings are prompts for review, not certification.');
  await expect(button).toBeFocused();
}

async function openTab(page, name) {
  // Each test starts with the Overview tab selected. Support both automatic
  // activation on arrow keys and manual activation with Enter.
  await tabTo(page, page.getByRole('tab', { name: 'Overview', exact: true }));
  for (let step = 0; step < tabNames.indexOf(name); step += 1) {
    await page.keyboard.press('ArrowRight');
  }
  const tab = page.getByRole('tab', { name, exact: true });
  await expect(tab).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  return tab;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('audits and downloads a review packet using only the keyboard', async ({ page }) => {
  await expect(page).toHaveTitle('Prism — Model Card Auditor');
  await expect(page.getByRole('heading', { name: 'Model card audit', level: 1, exact: true }))
    .toBeVisible();

  const skipLink = page.getByRole('link', { name: 'Skip to audit', exact: true });
  await page.keyboard.press('Tab');
  await expect(skipLink).toBeFocused();
  await expect(skipLink).toBeVisible();
  const skipTarget = await skipLink.getAttribute('href');
  expect(skipTarget).toMatch(/^#.+/);
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate((hash) => {
    const target = document.getElementById(decodeURIComponent(hash.slice(1)));
    return target !== null && target.contains(document.activeElement);
  }, skipTarget), { message: 'Skip link must move focus into its audit target' }).toBe(true);

  for (const name of navigationNames) {
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  }
  for (const name of tabNames) {
    await expect(page.getByRole('tab', { name, exact: true })).toBeVisible();
  }

  const modelCard = page.getByLabel('Model card', { exact: true });
  await expect(modelCard).toHaveJSProperty('tagName', 'SELECT');
  await expect(modelCard.locator('option')).toHaveText([
    'Atlas Assist', 'Harbor Screen', 'Lumen Caption',
  ]);
  await expect(modelCard.locator('option:checked')).toHaveText('Atlas Assist');
  await tabTo(page, modelCard);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(modelCard.locator('option:checked')).toHaveText('Harbor Screen');
  await runAudit(page);

  await openTab(page, 'Fairness');
  await expect(page.getByText('Evidence-only', { exact: true })).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  const overviewTab = page.getByRole('tab', { name: 'Overview', exact: true });
  await expect(overviewTab).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(overviewTab).toHaveAttribute('aria-selected', 'true');

  const consentNavigation = page.getByRole('button', { name: 'Data & consent', exact: true });
  await tabTo(page, consentNavigation);
  await page.keyboard.press('Space');
  await expect(consentNavigation).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('tab', { name: 'Data & privacy', exact: true }))
    .toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: 'Data use & consent', level: 2, exact: true }))
    .toBeVisible();
  const consentFinding = page.getByRole('article', {
    name: 'Consent contradiction: requirements are contradictory', exact: true,
  });
  await expect(consentFinding).toBeVisible();
  await expect(consentFinding).toContainText('Agreement between flags alone is insufficient');
  for (const [id, text] of [
    ['harbor-du1', 'Training requires affirmative consent from fictional applicants.'],
    ['harbor-du2', 'Consent is not required for training on generated application records.'],
  ]) {
    const source = consentFinding.getByRole('listitem').filter({ hasText: id });
    await expect(source).toContainText(text);
    await expect(source).toContainText('requiresConsent=true');
  }
  await expect(consentFinding.locator('code')).toHaveText([
    'dataUse.statements[0]', 'dataUse.statements[1]', 'dataUse.consent',
  ]);

  const exportButton = page.getByRole('button', { name: 'Export review packet', exact: true });
  await tabTo(page, exportButton);
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Export review packet', exact: true });
  await expect(dialog).toBeVisible();
  await expectFocusInside(dialog);

  const notes = dialog.getByLabel('Reviewer notes', { exact: true });
  const downloadButton = dialog.getByRole('button', { name: 'Download Markdown', exact: true });
  const closeButton = dialog.getByRole('button', { name: 'Close export dialog', exact: true });
  await expect(notes).toHaveJSProperty('tagName', 'TEXTAREA');
  await expect(downloadButton).toBeVisible();
  await expect(closeButton).toBeVisible();
  await tabTo(page, notes);
  const reviewerNotes = 'Keyboard-only review: reconcile contradictory training consent before using data.';
  await page.keyboard.type(reviewerNotes);
  await expect(notes).toHaveValue(reviewerNotes);
  await checkFocusTrap(page, dialog);
  await tabTo(page, downloadButton);
  await tabTo(page, closeButton);
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(exportButton).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  await expectFocusInside(dialog);
  await expect(notes).toHaveValue(reviewerNotes);
  await tabTo(page, closeButton);
  await page.keyboard.press('Space');
  await expect(dialog).not.toBeVisible();
  await expect(exportButton).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  await expectFocusInside(dialog);
  await tabTo(page, downloadButton);
  const downloadPromise = page.waitForEvent('download');
  await page.keyboard.press('Enter');
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.(?:md|markdown)$/i);
  expect(await download.failure()).toBeNull();
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  const markdown = await readFile(downloadPath, 'utf8');
  expect(markdown).toContain('Harbor Screen');
  expect(markdown).toContain(reviewerNotes);
  expect(markdown).toContain('privacy-consent-conflict: Consent contradiction: requirements are contradictory');
  expect(markdown).toContain('| harbor-du1 | training | true | Training requires affirmative consent from fictional applicants. |');
  expect(markdown).toContain('| harbor-du2 | training | true | Consent is not required for training on generated application records. |');
  expect(markdown).toMatch(/\*\*Synthetic notice:\*\*.*explicitly synthetic and fictional/);
  expect(markdown).toContain('not a safety certification or permission to deploy');
  expect(markdown).toContain('Coverage measures documentation and recorded checks, not model quality, legal compliance, fairness guarantees, privacy guarantees, or overall safety.');
  expect(markdown).toContain('Evidence-reference coverage does not verify the evidence or establish the truth of the claim.');
  expect(markdown).toContain('Missing findings, zero gaps, and 100% coverage are not assurance or certification');
  expect(markdown).not.toMatch(/\b(?:safe to deploy|ready for deployment|approved for deployment|approved for production|deployment[- ]ready|safety certified|guarantees safety|provides assurance)\b/i);
  await expect(dialog).not.toBeVisible();
  await expect(exportButton).toBeFocused();
});

test('audit tabs support roving focus, arrow wrap, Home/End, and Enter/Space activation', async ({ page }) => {
  await runAudit(page, 'Space');
  const tablist = page.getByRole('tablist', { name: 'Audit sections', exact: true });
  const panelHeadings = ['Coverage by dimension', 'Subgroup fairness', 'Data use & consent', 'Threat assessment', 'Accessibility checks'];

  async function expectSelected(name) {
    const selected = tablist.getByRole('tab', { name, exact: true });
    await expect(selected).toBeFocused();
    await expect(selected).toHaveAttribute('aria-selected', 'true');
    await expect(selected).toHaveAttribute('tabindex', '0');
    await expect(tablist.getByRole('tab', { selected: true })).toHaveCount(1);
    for (const other of tabNames.filter((item) => item !== name)) {
      await expect(tablist.getByRole('tab', { name: other, exact: true })).toHaveAttribute('tabindex', '-1');
    }
    await expect(page.getByRole('heading', {
      name: panelHeadings[tabNames.indexOf(name)], level: 2, exact: true,
    })).toBeVisible();
  }

  await tabTo(page, tablist.getByRole('tab', { name: 'Overview', exact: true }));
  await expectSelected('Overview');
  for (const name of [...tabNames.slice(1), 'Overview']) {
    await page.keyboard.press('ArrowRight');
    await expectSelected(name);
  }
  await page.keyboard.press('ArrowLeft');
  await expectSelected('Accessibility');
  await page.keyboard.press('Home');
  await expect(tablist.getByRole('tab', { name: 'Overview', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expectSelected('Overview');
  await page.keyboard.press('End');
  await expect(tablist.getByRole('tab', { name: 'Accessibility', exact: true })).toBeFocused();
  await page.keyboard.press('Space');
  await expectSelected('Accessibility');
  await page.keyboard.press('Tab');
  await expect.poll(() => tablist.evaluate((element) => (
    element.contains(element.ownerDocument.activeElement)
  )), { message: 'Tab must leave the tablist instead of visiting inactive tabs' }).toBe(false);
  await page.keyboard.press('Shift+Tab');
  await expectSelected('Accessibility');
});

test('Atlas Assist renders the missing Age 65+ subgroup evidence', async ({ page }) => {
  await expect(page.getByLabel('Model card', { exact: true }).locator('option:checked'))
    .toHaveText('Atlas Assist');
  await runAudit(page);
  await openTab(page, 'Fairness');
  const missing = page.getByRole('article', { name: 'Subgroup evaluation data is missing or invalid', exact: true });
  await expect(missing).toContainText('Missing expected groups: Age 65+');
  await expect(missing).toContainText('expectedSubgroups[2]');
  const tableRow = page.locator('.full-table-row').filter({ hasText: 'Age 65+' });
  await expect(tableRow).toContainText('Missing data');
});

test('Atlas Assist renders the contradictory training consent finding', async ({ page }) => {
  await expect(page.getByLabel('Model card', { exact: true }).locator('option:checked'))
    .toHaveText('Atlas Assist');
  await runAudit(page);
  await openTab(page, 'Data & privacy');
  const finding = page.getByRole('article', {
    name: 'Consent contradiction: requirements are contradictory', exact: true,
  });
  await expect(finding).toBeVisible();
  await expect(finding).toContainText('within these scopes: training.');
  await expect(finding.locator('code')).toHaveText(['dataUse.statements[0]', 'dataUse.statements[1]']);
  for (const [id, text, flag] of [
    ['atlas-du1', 'Synthetic training examples may be collected and used only with opt-in consent from fictional contributors.', true],
    ['atlas-du2', 'Synthetic training examples may be collected and used without obtaining consent from fictional contributors.', false],
  ]) {
    const source = finding.getByRole('listitem').filter({ hasText: id });
    await expect(source).toContainText(text);
    await expect(source).toContainText(`requiresConsent=${flag}`);
  }
});
