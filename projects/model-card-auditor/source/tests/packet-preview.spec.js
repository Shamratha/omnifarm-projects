import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { modelCards } from '../src/data/modelCards.js';
import { auditModelCard, exportReviewPacket } from '../src/lib/audit.js';

const harbor = modelCards.find((card) => card.id === 'harbor-screen');
const lumen = modelCards.find((card) => card.id === 'lumen-caption');
const atlas = modelCards.find((card) => card.id === 'atlas-assist');
const normalize = (text) => text.replace(/\s+/g, ' ').trim();
const packetContent = (page) => page.getByRole('region', { name: 'Review packet content', exact: true });
const reviewerNotes = (page) => page.getByRole('textbox', { name: 'Reviewer notes', exact: true });

async function expectRoute(page, pathname, card) {
  await expect.poll(() => new URL(page.url()).pathname).toBe(pathname);
  await expect.poll(() => new URL(page.url()).searchParams.get('model')).toBe(card.id);
}

async function expectPreview(page, card) {
  await expect(page.getByRole('heading', { name: 'Review packet preview', level: 2, exact: true })).toBeVisible();
  await expect(page.getByText(`${card.name} · v${card.version}`, { exact: true })).toBeVisible();
  await expect(packetContent(page).getByRole('heading', {
    name: `Review packet: ${card.name}`, level: 1, exact: true,
  })).toBeVisible();
  await expectRoute(page, '/packet-preview', card);
}

async function openSelectedPreview(page, card) {
  await page.getByRole('button', { name: 'Packet preview', exact: true }).click();
  await expectPreview(page, card);
}

async function backToDashboard(page, card) {
  await page.getByRole('button', { name: 'Back to risk dashboard', exact: true }).click();
  await expectRoute(page, '/risk-tradeoffs', card);
  await expect(page.getByRole('heading', { name: 'Risk trade-off dashboard', level: 2, exact: true })).toBeVisible();
  await expect(page.getByLabel('Model card', { exact: true })).toHaveValue(card.id);
}

async function downloadedPacket(page, activate = () => (
  page.getByRole('button', { name: 'Download Markdown', exact: true }).click()
)) {
  const pendingDownload = page.waitForEvent('download');
  await activate();
  const download = await pendingDownload;
  expect(download.suggestedFilename()).toMatch(/\.(?:md|markdown)$/i);
  expect(await download.failure()).toBeNull();
  const path = await download.path();
  expect(path).not.toBeNull();
  return readFile(path, 'utf8');
}

// Exercise actual tab order rather than programmatically focusing controls.
async function tabTo(page, target) {
  await expect(target).toBeVisible();
  for (let step = 0; step < 100; step += 1) {
    if (await target.evaluate((element) => element === element.ownerDocument.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  await expect(target, 'Control must be reachable using Tab').toBeFocused();
}

async function expectRecord(content, id, cells) {
  const row = content.getByRole('cell', { name: id, exact: true }).locator('..');
  await expect(row.getByRole('cell')).toHaveText(cells.map(String));
}

async function expectCompletePacket(page, card) {
  const content = packetContent(page);
  const audit = auditModelCard(card);
  const packet = exportReviewPacket(card, audit);

  // The actual export defines the headings, including every individual flag.
  const headings = [...packet.matchAll(/^(#{1,3}) (.+)$/gm)];
  await expect(content.getByRole('heading')).toHaveCount(headings.length);
  for (const [, hashes, name] of headings) {
    await expect(content.getByRole('heading', { name, level: hashes.length, exact: true })).toBeVisible();
  }

  const text = normalize(await content.innerText());
  for (const value of [
    card.id, card.name, card.version, card.type, card.owner, card.lastReviewed,
    card.description, card.intendedUse, ...card.limitations,
    card.dataUse.collection, card.dataUse.consent, card.dataUse.sensitiveAttributes,
  ]) expect(text).toContain(normalize(value));
  expect(text).toContain(`Evidence coverage: ${audit.coverage}%`);
  expect(text).toContain(`Referenced claims: ${audit.supportedClaims} / ${audit.totalClaims}`);
  expect(text).toContain(`Descriptive accuracy gap: ${audit.fairnessGap} percentage points`);
  expect(text).toContain('synthetic and fictional');
  expect(text).toContain('not a safety certification');
  expect(text).toContain('No remote API or external evidence verification is used.');

  for (const other of modelCards.filter((item) => item.id !== card.id)) {
    expect(text).not.toContain(other.name);
    expect(text).not.toContain(other.id);
  }
  for (const claim of card.claims) {
    expect(text).toContain(claim.text);
    for (const id of claim.evidenceIds) expect(text).toContain(id);
  }
  for (const item of card.evidence) {
    await expectRecord(content, item.id, [item.id, item.title, item.description]);
  }
  for (const metric of card.metrics) {
    await expectRecord(content, metric.group, [
      metric.group, metric.sampleSize, metric.accuracy, metric.falsePositiveRate,
      metric.sampleSize < 30 ? 'Valid; small sample (<30)' : 'Valid',
    ]);
  }
  for (const group of card.expectedSubgroups.filter((name) => !card.metrics.some((row) => row.group === name))) {
    await expectRecord(content, group, [group, '—', '—', '—', 'Missing expected group']);
  }
  for (const item of card.dataUse.statements) {
    await expectRecord(content, item.id, [item.id, item.scope, item.requiresConsent, item.text]);
  }
  for (const item of card.threats) {
    await expectRecord(content, item.id, [item.id, item.name, item.severity, item.status, item.mitigation]);
  }
  for (const item of card.accessibility) {
    await expectRecord(content, item.id, [item.id, item.name, item.status, item.detail]);
  }
  for (const item of card.tradeoffs) {
    await expectRecord(content, item.id, [
      item.id, item.name, item.privacyRisk, item.fairnessVisibility, item.current, item.description,
    ]);
  }
  for (const finding of audit.findings) {
    const heading = content.getByRole('heading', {
      name: `${finding.id}: ${finding.title}`, level: 3, exact: true,
    });
    const details = normalize(await heading.evaluate((element) => {
      const parts = [];
      for (let sibling = element.nextElementSibling; sibling; sibling = sibling.nextElementSibling) {
        if (/^H[1-6]$/.test(sibling.tagName)) break;
        parts.push(sibling.textContent);
      }
      return parts.join(' ');
    }));
    expect(details).toContain(`Severity: ${finding.severity}`);
    expect(details).toContain(`Category: ${finding.category}`);
    expect(details).toContain(normalize(finding.description));
    expect(details).toContain(`Evidence: ${normalize(finding.evidence)}`);
    expect(details).toContain(`Suggested action: ${normalize(finding.recommendation)}`);
    for (const entry of finding.sources) {
      expect(details).toContain(entry.path);
      expect(details).toContain(normalize(entry.label));
      expect(details).toContain(normalize(entry.detail));
    }
  }
}

for (const card of [harbor, atlas, lumen]) {
  test(`${card.name} direct route renders every exported section and source record and survives reload`, async ({ page }) => {
    await page.goto(`/packet-preview?model=${card.id}`);
    await expectPreview(page, card);
    await expectCompletePacket(page, card);
    await expect(reviewerNotes(page)).toHaveValue('');
    expect(await downloadedPacket(page)).toBe(exportReviewPacket(card, auditModelCard(card)));

    await page.reload();
    await expectPreview(page, card);
    await expect(packetContent(page)).toContainText(card.owner);
    await expect(reviewerNotes(page)).toHaveValue('');
  });
}

test('reviewer notes update the preview and exact download; reload clears notes', async ({ page }) => {
  await page.goto('/packet-preview?model=harbor-screen');
  await expectPreview(page, harbor);
  const notes = 'Fictional reviewer: reconcile consent before subgroup comparisons.\n\n**Follow up** with more rural samples & accessible appeals.';
  await reviewerNotes(page).fill(notes);
  await expect(packetContent(page)).toContainText(notes);
  await expect(packetContent(page)).not.toContainText('No reviewer notes provided.');
  expect(await downloadedPacket(page)).toBe(exportReviewPacket(harbor, auditModelCard(harbor), notes));

  const revised = 'Revised fictional review: include the sparse rural evidence.';
  await reviewerNotes(page).fill(revised);
  await expect(packetContent(page)).toContainText(revised);
  await expect(packetContent(page)).not.toContainText(notes);
  expect(await downloadedPacket(page)).toBe(exportReviewPacket(harbor, auditModelCard(harbor), revised));

  await page.reload();
  await expectPreview(page, harbor);
  await expect(reviewerNotes(page)).toHaveValue('');
  await expect(packetContent(page)).toContainText('No reviewer notes provided.');
  await expect(packetContent(page)).not.toContainText(revised);
  expect(await downloadedPacket(page)).toBe(exportReviewPacket(harbor, auditModelCard(harbor)));
});

test('in-memory notes stay with their own model card during navigation', async ({ page }) => {
  await page.goto('/packet-preview?model=harbor-screen');
  const harborNotes = 'Harbor-only fictional review: prioritize appeal access.';
  const lumenNotes = 'Lumen-only fictional review: retain human caption editing.';
  await reviewerNotes(page).fill(harborNotes);
  await backToDashboard(page, harbor);
  await page.getByLabel('Model card', { exact: true }).selectOption(lumen.id);
  await openSelectedPreview(page, lumen);
  await expect(reviewerNotes(page)).toHaveValue('');
  await expect(packetContent(page)).not.toContainText(harborNotes);
  await reviewerNotes(page).fill(lumenNotes);
  expect(await downloadedPacket(page)).toBe(exportReviewPacket(lumen, auditModelCard(lumen), lumenNotes));

  await backToDashboard(page, lumen);
  await page.getByLabel('Model card', { exact: true }).selectOption(harbor.id);
  await openSelectedPreview(page, harbor);
  await expect(reviewerNotes(page)).toHaveValue(harborNotes);
  await expect(packetContent(page)).toContainText(harborNotes);
  await expect(packetContent(page)).not.toContainText(lumenNotes);
  expect(await downloadedPacket(page)).toBe(exportReviewPacket(harbor, auditModelCard(harbor), harborNotes));

  await backToDashboard(page, harbor);
  await page.getByLabel('Model card', { exact: true }).selectOption(atlas.id);
  await openSelectedPreview(page, atlas);
  await expect(reviewerNotes(page)).toHaveValue('');
  await expect(packetContent(page)).not.toContainText(harborNotes);
  await expect(packetContent(page)).not.toContainText(lumenNotes);
});

test('Back to risk dashboard and browser back/forward preserve the selected packet and notes', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Model card', { exact: true }).selectOption(harbor.id);
  await openSelectedPreview(page, harbor);
  const notes = 'Fictional history review: keep the Harbor evidence together.';
  await reviewerNotes(page).fill(notes);
  await backToDashboard(page, harbor);

  await page.goBack();
  await expectPreview(page, harbor);
  await expect(reviewerNotes(page)).toHaveValue(notes);
  await expect(packetContent(page)).toContainText(notes);

  await page.goForward();
  await expectRoute(page, '/risk-tradeoffs', harbor);
  await expect(page.getByRole('heading', { name: 'Risk trade-off dashboard', level: 2, exact: true })).toBeVisible();
  await expect(page.getByLabel('Model card', { exact: true })).toHaveValue(harbor.id);

  await page.goBack();
  await expectPreview(page, harbor);
  expect(await downloadedPacket(page)).toBe(exportReviewPacket(harbor, auditModelCard(harbor), notes));
});

test('keyboard navigation opens the correct packet, edits notes, downloads, and opens Risk trade-offs', async ({ page }) => {
  await page.goto('/');
  const select = page.getByLabel('Model card', { exact: true });
  await tabTo(page, select);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(select).toHaveValue(harbor.id);

  await tabTo(page, page.getByRole('button', { name: 'Risk trade-offs', exact: true }));
  await page.keyboard.press('Space');
  await expectRoute(page, '/risk-tradeoffs', harbor);

  await tabTo(page, page.getByRole('button', { name: 'Packet preview', exact: true }));
  await page.keyboard.press('Enter');
  await expectPreview(page, harbor);
  await tabTo(page, reviewerNotes(page));
  const notes = 'Keyboard-only fictional review: document consent and rural samples.';
  await page.keyboard.insertText(notes);
  await expect(packetContent(page)).toContainText(notes);

  await tabTo(page, page.getByRole('button', { name: 'Download Markdown', exact: true }));
  expect(await downloadedPacket(page, () => page.keyboard.press('Space')))
    .toBe(exportReviewPacket(harbor, auditModelCard(harbor), notes));

  await tabTo(page, page.getByRole('button', { name: 'Back to risk dashboard', exact: true }));
  await page.keyboard.press('Enter');
  await expectRoute(page, '/risk-tradeoffs', harbor);
  await expect(select).toHaveValue(harbor.id);
});

for (const [path, heading] of [
  ['/packet-preview?model=unknown-card', /Model card not found|Page not found/],
  ['/unknown-preview-page?model=harbor-screen', /Page not found/],
]) {
  test(`${path} gives a friendly failure instead of a different model packet`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(path);
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    await expect(packetContent(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Download Markdown', exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test('malicious notes remain inert text without links, images, or external network requests', async ({ page, baseURL }) => {
  const externalRequests = [];
  const dialogs = [];
  const origin = new URL(baseURL).origin;
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (/^https?:$/.test(url.protocol) && url.origin !== origin) {
      externalRequests.push(url.href);
      await route.abort();
    } else {
      await route.continue();
    }
  });
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });

  await page.goto('/packet-preview?model=harbor-screen');
  await expectPreview(page, harbor);
  const remote = 'https://packet-preview.invalid';
  const notes = [
    '<script>window.__packetPreviewExecuted = true; alert("executed")</script>',
    `<img src="${remote}/raw-image.png" onerror="window.__packetPreviewExecuted = true">`,
    `<iframe src="${remote}/frame"></iframe>`,
    `[External link](${remote}/link)`,
    `![Remote image](${remote}/markdown-image.png)`,
    '[Script link](javascript:alert("executed"))',
    `${remote}/autolink`,
  ].join('\n\n');
  await reviewerNotes(page).fill(notes);
  const content = packetContent(page);
  await expect(content).toContainText(notes);
  await expect(content.locator('a, img, script, iframe, object, embed, svg')).toHaveCount(0);

  // URL-shaped text stays inert and readable, without an active link.
  const originalURL = page.url();
  await content.getByText(`${remote}/autolink`, { exact: true }).click();
  await expect(page).toHaveURL(originalURL);
  expect(await page.evaluate(() => window.__packetPreviewExecuted)).toBeUndefined();
  expect(await downloadedPacket(page)).toBe(exportReviewPacket(harbor, auditModelCard(harbor), notes));
  expect(dialogs).toEqual([]);
  expect(externalRequests).toEqual([]);
});
