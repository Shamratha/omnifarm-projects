import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { modules, productCatalog, dependencyModules } from '../../data.js';
import { enrichModules, buildRemediationQueue, exportQueueCsv, exportQueueMarkdown, PATCH_LABELS } from '../../triage.js';
import { modules as aliasModules, productCatalog as aliasCatalog, dependencyModules as aliasDependencies } from '../fixtures/alias-review.js';

const ranked = enrichModules(modules, { productCatalog, dependencyModules });
const queue = buildRemediationQueue(ranked);
const rowFor = (page, id) => page.locator(`.module-row[data-module-id="${id}"]`);

test('local alias search, evidence groups, patch explanations, and direct dependency navigation', async ({ page }) => {
  const errors = [];
  const externalRequests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (!request.url().startsWith('http://127.0.0.1:4174/') && !request.url().startsWith('blob:')) externalRequests.push(request.url());
  });
  await page.goto('/');
  await expect(page.locator('.module-row')).toHaveCount(ranked.length);
  await expect(page.locator('#metric-queue')).toHaveText('08');
  await expect(page.locator('#dependency-count')).toHaveText('6 direct links · 6 resolved');
  await expect(page.locator('.dep-node')).toHaveCount(6);

  for (const search of ['Verdant Reports', 'Reporting Server', 'verdant-reporting-server']) {
    await page.locator('#search').fill(search);
    await expect(page.locator('.module-row')).toHaveCount(1);
    await expect(page.locator('.module-product').first()).toContainText('Reporting Server · alias resolved');
  }
  await page.locator('.module-row').click();
  await expect(page.locator('.product-resolution')).toContainText('Raw label: Verdant Software · Verdant Reports');
  await expect(page.locator('.product-resolution')).toContainText('5.0 - 5.1.6');
  await expect(page.locator('.reason-list')).toContainText('Unknown status remains uncertain');
  await page.locator('[data-record-id="auxiliary/scanner/http/verdant-reporting"]').click();
  await expect(page.locator('.drawer-title')).toHaveText('Verdant Reporting version check');
  await expect(page.locator('#drawer-content')).toContainText('Metadata-only record, not ranked and never executed.');
  await page.locator('[data-record-id="exploit/linux/http/verdant-reporting"]').click();
  await expect(page.locator('.drawer-title')).toHaveText('Verdant Reporting template injection');
  await page.locator('#close-drawer').click();

  await page.locator('#clear-filters').click();
  const atlas = ranked.find((item) => item.id.includes('atlas-console'));
  await rowFor(page, atlas.id).click();
  const group = page.locator('.advisory-group[data-advisory-id="SYN-ADV-2026-014"]');
  await group.locator('summary').click();
  await expect(group.locator('.source-record')).toHaveCount(4 + 5 + 3);
  await expect(group).toContainText('9.8');
  await expect(group).toContainText('8.1');
  await expect(group).toContainText('quartz-collab');
  await page.keyboard.press('Escape');
  await rowFor(page, 'exploit/windows/http/orbit-gateway').click();
  await expect(page.locator('.advisory-group summary')).toContainText('2 occurrences · 1 modules');
  await expect(page.locator('.reason-list')).toContainText('3 of 7');
  await page.locator('#close-drawer').click();

  for (const module of ranked) {
    await rowFor(page, module.id).click();
    await expect(page.locator('.action-card')).toContainText(`${module.patchConfidence.score}/100 ${module.patchConfidence.label}`);
    for (const reason of module.patchConfidence.reasons) await expect(page.locator('.reason-list')).toContainText(reason);
    await expect(page.locator('.patch-observation')).toHaveCount(module.patchConfidence.evidence.length);
    await expect(page.locator('.product-resolution')).toContainText(module.resolvedProducts[0].name);
    await expect(page.locator('#drawer-content .dependency-link')).toHaveCount(module.dependencyLinks.length);
    await page.locator('#close-drawer').click();
  }
  await page.locator('.dep-node').first().click();
  await expect(page.locator('#detail-drawer')).toHaveAttribute('aria-hidden', 'false');
  await page.locator('#close-drawer').click();
  await page.locator('#search').fill('no such product');
  await expect(page.locator('#empty-state')).toBeVisible();
  await expect(page.locator('#metric-queue')).toHaveText('08');
  expect(errors).toEqual([]);
  expect(externalRequests).toEqual([]);
});

test('downloaded CSV and Markdown preserve the same workspace queue shown by the UI, even with filters', async ({ page }) => {
  await page.goto('/');
  await page.locator('#show-all-queue').click();
  await expect(page.locator('.queue-item')).toHaveCount(queue.length);
  const rendered = await page.locator('.queue-item').evaluateAll((items) => items.map((item) => ({
    id: item.dataset.moduleId,
    name: item.querySelector('strong').textContent,
    action: item.querySelector('.queue-action').textContent,
    priority: Number(item.querySelector('.queue-priority').textContent),
  })));
  expect(rendered).toEqual(queue.map((item) => ({ id: item.moduleId, name: item.name, action: item.action, priority: item.priority })));
  for (const item of queue) {
    const renderedItem = page.locator(`.queue-item[data-module-id="${item.moduleId}"]`);
    await expect(renderedItem).toContainText(PATCH_LABELS[item.patchStatus]);
    await expect(renderedItem).toContainText(`${item.patchConfidence.score}/100 ${item.patchConfidence.label}`);
    await expect(renderedItem).toContainText(item.owner);
    await expect(renderedItem).toContainText(item.due);
  }
  await page.locator('#patch-filter').selectOption('unavailable');
  await expect(page.locator('.module-row')).toHaveCount(2);
  await expect(page.locator('.queue-item')).toHaveCount(8);

  const csvEvent = page.waitForEvent('download');
  await page.locator('#export-queue').click();
  const csv = await csvEvent;
  expect(csv.suggestedFilename()).toBe('safe-remediation-queue.csv');
  expect(await readFile(await csv.path(), 'utf8')).toBe(exportQueueCsv(queue));

  const markdownEvent = page.waitForEvent('download');
  await page.locator('#export-report').click();
  const markdown = await markdownEvent;
  expect(markdown.suggestedFilename()).toBe('safe-remediation-queue.md');
  const report = await readFile(await markdown.path(), 'utf8');
  const normalizeDate = (text) => text.replace(/Generated [^.]+\.\d{3}Z/, 'Generated <timestamp>');
  expect(normalizeDate(report)).toBe(normalizeDate(exportQueueMarkdown(queue)));
  const contexts = [...report.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => JSON.parse(match[1]));
  expect(contexts).toHaveLength(queue.length);
  for (let index = 0; index < queue.length; index++) {
    expect(contexts[index].advisoryGroups).toEqual(queue[index].advisoryGroups);
    expect(contexts[index].evidence).toEqual(queue[index].evidence);
    expect(contexts[index].patchEvidence).toEqual(queue[index].patchConfidence.evidence);
  }
});

test('ambiguous products, missing dependencies, and conflicting patch claims stay visible in UI and exports', async ({ page }) => {
  const fixture = {
    ...structuredClone(modules[0]),
    id: 'synthetic/review/edge-cases',
    name: 'Synthetic ambiguity review',
    products: [{ vendor: 'Acme', name: 'Shared label', versions: '< 2.0' }],
    dependencies: [{ moduleId: 'synthetic/missing', relation: 'needs inventory' }],
    advisories: [{ id: 'SYN-DUP', source: 'Synthetic feed A' }, { id: 'SYN-DUP', source: 'Synthetic feed B' }],
    patchStatus: {
      status: 'available', note: 'Conflicting synthetic records require human review.',
      evidence: [
        { source: 'Synthetic vendor', status: 'available', confidence: 90, detail: 'Published package claim.' },
        { source: 'Synthetic branch bulletin', status: 'unavailable', confidence: 90, detail: 'No package for this branch.' },
      ],
    },
  };
  const catalog = [
    { id: 'first', vendor: 'Acme', name: 'First product', aliases: [{ vendor: 'Acme', name: 'Shared label' }] },
    { id: 'second', vendor: 'Acme', name: 'Second product', aliases: [{ vendor: 'Acme', name: 'Shared label' }] },
  ];
  await page.route('**/data.js', (route) => route.fulfill({
    contentType: 'text/javascript',
    body: `export const modules = ${JSON.stringify([fixture])}; export const productCatalog = ${JSON.stringify(catalog)}; export const dependencyModules = [];`,
  }));
  await page.goto('/');
  await expect(page.locator('.module-product').first()).toContainText('Shared label · ambiguous');
  await expect(page.locator('#dependency-count')).toHaveText('1 direct links · 0 resolved');
  await page.locator('.module-row').click();
  await expect(page.locator('.product-resolution')).toContainText('Candidates: first, second');
  await expect(page.locator('.product-row')).toContainText('< 2.0');
  await expect(page.locator('.action-card')).toContainText('65/100 Medium');
  await expect(page.locator('.reason-list')).toContainText('subtract 25 confidence points');
  await expect(page.locator('.patch-observation')).toHaveCount(2);
  await expect(page.locator('.dependency-link')).toContainText('synthetic/missing (missing metadata)');
  await expect(page.locator('.dependency-link button')).toHaveCount(0);
  await page.locator('.advisory-group summary').click();
  await expect(page.locator('.advisory-group')).toContainText('Synthetic feed A');
  await expect(page.locator('.advisory-group')).toContainText('Synthetic feed B');
  await page.locator('#close-drawer').click();
  const downloadEvent = page.waitForEvent('download');
  await page.locator('#export-queue').click();
  const download = await downloadEvent;
  const expectedQueue = buildRemediationQueue(enrichModules([fixture], { productCatalog: catalog }));
  expect(await readFile(await download.path(), 'utf8')).toBe(exportQueueCsv(expectedQueue));
});

test('final alias/dependency pass keeps multi-advisory evidence and conservative patch confidence in the local UI', async ({ page }) => {
  await page.route('**/data.js', (route) => route.fulfill({
    contentType: 'text/javascript',
    body: `export const modules = ${JSON.stringify(aliasModules)}; export const productCatalog = ${JSON.stringify(aliasCatalog)}; export const dependencyModules = ${JSON.stringify(aliasDependencies)};`,
  }));
  await page.goto('/');
  await expect(page.locator('.module-row')).toHaveCount(2);
  await expect(page.locator('#dependency-count')).toHaveText('4 direct links · 3 resolved');
  await page.locator('#search').fill('Legacy Reports');
  await expect(page.locator('.module-row')).toHaveCount(2);
  await expect(page.locator('.module-product').first()).toContainText('Reporting Server · alias resolved');
  await page.locator('.module-row[data-module-id="synthetic/alias-one"]').click();
  await expect(page.locator('.action-card')).toContainText('Unavailable');
  await expect(page.locator('.action-card')).toContainText('90/100 High');
  await expect(page.locator('.reason-list')).toContainText('not a patch availability score');
  await expect(page.locator('.dependency-link')).toHaveCount(3);
  await expect(page.locator('.dependency-link').filter({ hasText: 'synthetic/missing' })).toContainText('synthetic/missing (missing metadata)');
  const shared = page.locator('.advisory-group[data-advisory-id="SYN-SHARED"]');
  await expect(shared).toContainText('3 occurrences · 2 modules');
  await shared.locator('summary').click();
  await expect(shared.locator('.source-record')).toHaveCount(8);
  await expect(shared).toContainText('9.8');
  await expect(shared).toContainText('8.1');
  await expect(shared).toContainText('6.5');
  await page.locator('[data-record-id="synthetic/inventory"]').click();
  await expect(page.locator('.drawer-title')).toHaveText('Synthetic inventory metadata');
  await page.locator('[data-record-id="synthetic/alias-one"]').click();
  await page.locator('[data-record-id="synthetic/alias-two"]').click();
  await expect(page.locator('.drawer-title')).toHaveText('Synthetic second review');
  await expect(page.locator('.dependency-link')).toHaveCount(1);
  await page.locator('[data-record-id="synthetic/alias-one"]').click();
  await expect(page.locator('.drawer-title')).toHaveText('Synthetic first review');
  await page.locator('#close-drawer').click();
  await page.locator('#clear-filters').click();
  await page.locator('.module-row[data-module-id="synthetic/alias-two"]').click();
  await expect(page.locator('.action-card')).toContainText('Unknown');
  await expect(page.locator('.action-card')).toContainText('0/100 Low');
  await expect(page.locator('.reason-list')).toContainText('No explicit patch-status evidence');
  await page.locator('#close-drawer').click();
  const expectedQueue = buildRemediationQueue(enrichModules(aliasModules, { productCatalog: aliasCatalog, dependencyModules: aliasDependencies }));
  const csvEvent = page.waitForEvent('download');
  await page.locator('#export-queue').click();
  const csv = await csvEvent;
  expect(await readFile(await csv.path(), 'utf8')).toBe(exportQueueCsv(expectedQueue));
  const markdownEvent = page.waitForEvent('download');
  await page.locator('#export-report').click();
  const markdown = await markdownEvent;
  const report = await readFile(await markdown.path(), 'utf8');
  const generatedAt = report.match(/Generated (\S+)\. Synthetic/)[1];
  expect(report).toBe(exportQueueMarkdown(expectedQueue, generatedAt));
});
