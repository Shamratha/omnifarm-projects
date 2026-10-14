import { test, expect } from '@playwright/test';

test('keyboard, nested filter clearing, responsive grid, and malformed import stay safe', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#stat-total')).toHaveText('24');

  await expect(page.locator('#result-count')).toHaveText('8 photographs');
  const before = await page.locator('#result-count').textContent();
  await page.locator('[data-action="add-group"]').first().click();
  await page.locator('.group-card').nth(1).locator('[data-action="add-rule"]').click();
  expect(await page.locator('.group-card').count()).toBe(2);
  await page.locator('.group-card').nth(1).getByRole('button', { name: 'Clear filter' }).click();
  expect(await page.locator('.group-card').count()).toBe(2);
  await expect(page.locator('.group-card').nth(1)).toContainText('No criteria yet');

  await page.locator('#phrase-input').fill('mountains in 2024');
  await page.locator('#parse-button').press('Enter');
  await expect(page.getByRole('heading', { name: 'Interpreted criteria' })).toBeVisible();
  await expect(page.locator('#result-count')).toHaveText(before);
  await page.getByRole('button', { name: 'Apply interpretation' }).click();
  await expect(page.locator('.review-status')).toHaveText('Applied');

  await page.locator('#catalog-file').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"photos":[{"bad":true}]}') });
  await page.getByRole('button', { name: 'Import catalog' }).click();
  await expect(page.locator('#catalog-message')).toContainText('Import failed');
  await expect(page.locator('#stat-total')).toHaveText('24');

  await expect(page.getByRole('button', { name: 'Why Dawn over the Dolomites matched' })).toHaveCount(0);
  await expect(page.locator('.match-details').first()).toBeVisible();
  await page.locator('.match-details').first().locator('summary').press('Enter');
  await expect(page.locator('.match-reasons').first()).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.photo-card').first()).toBeVisible();
  expect(await page.locator('.results-grid').evaluate((node) => getComputedStyle(node).gridTemplateColumns)).not.toContain('repeat(3');

  await page.getByRole('button', { name: 'Clear history' }).click();
});

test('phrase review resolves clarification, edits criteria, and persists search state', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#stat-total')).toHaveText('24');
  await expect(page.locator('#result-count')).toHaveText('8 photographs');

  await page.locator('#phrase-input').fill('near me');
  await page.getByRole('button', { name: /Interpret phrase/ }).click();
  await expect(page.getByRole('heading', { name: 'Interpreted criteria' })).toBeVisible();
  await expect(page.getByText(/choice needed/)).toBeVisible();
  const clarificationOptions = page.locator('[data-action="clarification"]');
  await expect(clarificationOptions).toHaveCount(6);
  await clarificationOptions.filter({ hasText: 'Kyoto, Japan' }).click();
  await expect(page.getByRole('button', { name: 'Apply interpretation' })).toBeEnabled();

  const criterionValue = page.locator('.rule-card .value-input').first();
  await criterionValue.fill('Japan');
  await page.getByRole('button', { name: /Run search/ }).click();
  await expect(page.locator('#result-count')).toHaveText('4 photographs');

  const searchName = `Keyboard phrase ${Date.now()}`;
  await page.locator('#saved-search-name').fill(searchName);
  await page.getByRole('button', { name: 'Save search' }).click();
  await expect(page.getByRole('button', { name: `Load saved search ${searchName}` })).toBeVisible();
  await expect(page.locator('.history-load').first()).toBeVisible();

  await page.reload();
  await expect(page.getByRole('button', { name: `Load saved search ${searchName}` })).toBeVisible();
  await expect(page.locator('.history-load').first()).toBeVisible();
  await page.getByRole('button', { name: `Delete saved search ${searchName}` }).click();
});
