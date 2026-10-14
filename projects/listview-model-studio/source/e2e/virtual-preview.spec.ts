import { expect, test, type Locator, type Page } from '@playwright/test'

const ITEM_COUNT = 12_000
const ROW_HEIGHT = 58

type ListGeometry = {
  clientHeight: number
  scrollHeight: number
  scrollTop: number
  renderedCount: number
  rangeStart: number
  rangeEnd: number
  layoutHeight: number
  rowHeights: number[]
}

function virtualList(page: Page) {
  return page.getByTestId('virtual-list')
}

function fixtureId(index: number) {
  return `fixture-${String(index + 1).padStart(5, '0')}`
}

async function measuredList(page: Page) {
  const list = virtualList(page)
  await expect(list).toBeVisible()
  await expect.poll(async () => Number(await list.getAttribute('data-viewport-height'))).toBeGreaterThan(0)
  return list
}

async function readGeometry(list: Locator): Promise<ListGeometry> {
  return list.evaluate((element) => {
    const node = element as HTMLDivElement
    const options = Array.from(node.querySelectorAll<HTMLElement>('[role="option"]'))
    const spacers = Array.from(node.querySelectorAll<HTMLElement>(':scope > [role="presentation"]'))
    return {
      clientHeight: node.clientHeight,
      scrollHeight: node.scrollHeight,
      scrollTop: node.scrollTop,
      renderedCount: Number(node.dataset.renderedCount),
      rangeStart: Number(node.dataset.rangeStart),
      rangeEnd: Number(node.dataset.rangeEnd),
      layoutHeight: [...options, ...spacers].reduce((total, child) => total + child.getBoundingClientRect().height, 0),
      rowHeights: options.map((option) => option.getBoundingClientRect().height),
    }
  })
}

async function optionIds(list: Locator) {
  return list.locator('[role="option"]').evaluateAll((options) => options.map((option) => option.getAttribute('data-item-id')))
}

async function scrollList(list: Locator, top: number) {
  await list.evaluate((element, nextTop) => {
    ;(element as HTMLDivElement).scrollTo({ top: nextTop, behavior: 'auto' })
  }, top)
  await expect.poll(async () => {
    const geometry = await readGeometry(list)
    return geometry.scrollTop === Math.min(top, geometry.scrollHeight - geometry.clientHeight)
  }).toBe(true)
}

async function activeItemId(list: Locator) {
  return list.evaluate((element) => {
    const activeDescendant = element.getAttribute('aria-activedescendant')
    if (!activeDescendant) return null
    return element.ownerDocument.getElementById(activeDescendant)?.getAttribute('data-item-id') ?? null
  })
}

async function selectedCount(page: Page) {
  return Number((await page.locator('.inspector-stats > div').nth(2).locator('strong').textContent())?.trim() ?? 0)
}

async function updateMetrics(page: Page) {
  const values = await page.getByLabel('Model update counters').locator('strong').evaluateAll((nodes) =>
    nodes.map((node) => Number(node.textContent?.trim() ?? 0)),
  )
  return {
    requested: values[0],
    changed: values[1],
    skipped: values[2],
    rejected: values[3],
    transactions: values[4],
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await measuredList(page)
})

test('keeps the 12,000-row DOM bounded and preserves full spacer height while scrolling', async ({ page }) => {
  const list = virtualList(page)
  const initial = await readGeometry(list)
  const capacityBound = Math.ceil(initial.clientHeight / ROW_HEIGHT) + 11

  expect(initial.clientHeight).toBeGreaterThan(0)
  expect(initial.renderedCount).toBeGreaterThan(0)
  expect(initial.renderedCount).toBeLessThanOrEqual(capacityBound)
  expect(initial.scrollHeight).toBe(ITEM_COUNT * ROW_HEIGHT)
  expect(initial.rowHeights.every((height) => height === ROW_HEIGHT)).toBe(true)
  expect(initial.layoutHeight).toBe(initial.scrollHeight)
  await expect.poll(async () => list.locator('[role="option"]').count()).toBe(initial.renderedCount)
  await expect.poll(async () => Number(await list.getAttribute('data-rendered-count'))).toBe(initial.renderedCount)

  await scrollList(list, initial.scrollHeight / 2)
  await expect.poll(async () => {
    const geometry = await readGeometry(list)
    const firstVisible = Math.floor(geometry.scrollTop / ROW_HEIGHT)
    const lastVisible = Math.min(ITEM_COUNT - 1, Math.ceil((geometry.scrollTop + geometry.clientHeight) / ROW_HEIGHT) - 1)
    const ids = await optionIds(list)
    return ids.includes(fixtureId(firstVisible)) && ids.includes(fixtureId(lastVisible))
  }).toBe(true)
  const middle = await readGeometry(list)
  expect(middle.renderedCount).toBeLessThanOrEqual(Math.ceil(middle.clientHeight / ROW_HEIGHT) + 11)
  expect(middle.scrollHeight).toBe(ITEM_COUNT * ROW_HEIGHT)
  expect(middle.rowHeights.every((height) => height === ROW_HEIGHT)).toBe(true)
  expect(middle.layoutHeight).toBe(middle.scrollHeight)
  expect(await list.locator('[role="option"]').count()).toBe(middle.renderedCount)
  await expect(list).toHaveAttribute('data-rendered-count', String(middle.renderedCount))

  await scrollList(list, Number.MAX_SAFE_INTEGER)
  await expect.poll(async () => (await optionIds(list)).includes(fixtureId(ITEM_COUNT - 1))).toBe(true)
  const end = await readGeometry(list)
  expect(end.scrollTop).toBe(ITEM_COUNT * ROW_HEIGHT - end.clientHeight)
  expect(end.rangeEnd).toBe(ITEM_COUNT)
  expect(end.renderedCount).toBeLessThanOrEqual(Math.ceil(end.clientHeight / ROW_HEIGHT) + 11)
  expect(end.scrollHeight).toBe(ITEM_COUNT * ROW_HEIGHT)
  expect(end.rowHeights.every((height) => height === ROW_HEIGHT)).toBe(true)
  expect(end.layoutHeight).toBe(end.scrollHeight)
  expect(await list.locator('[role="option"]').count()).toBe(end.renderedCount)
  await expect(list).toHaveAttribute('data-rendered-count', String(end.renderedCount))
})

test('recomputes the mounted range from the actual CSS container height', async ({ page }) => {
  const list = virtualList(page)

  await list.evaluate((element) => {
    ;(element as HTMLDivElement).style.height = '290px'
  })
  await expect.poll(async () => (await readGeometry(list)).clientHeight).toBe(290)
  const short = await readGeometry(list)
  expect(short.renderedCount).toBe(Math.ceil(short.clientHeight / ROW_HEIGHT) + 5)
  expect(short.rangeEnd - short.rangeStart).toBe(short.renderedCount)
  await expect.poll(async () => list.locator('[role="option"]').count()).toBe(short.renderedCount)

  await list.evaluate((element) => {
    ;(element as HTMLDivElement).style.height = '580px'
  })
  await expect.poll(async () => (await readGeometry(list)).clientHeight).toBe(580)
  const tall = await readGeometry(list)
  expect(tall.renderedCount).toBe(Math.ceil(tall.clientHeight / ROW_HEIGHT) + 5)
  expect(tall.renderedCount).toBeGreaterThan(short.renderedCount)
  expect(tall.rangeEnd - tall.rangeStart).toBe(tall.renderedCount)
  await expect.poll(async () => list.locator('[role="option"]').count()).toBe(tall.renderedCount)
})

test('jumps by current ID order without changing selection and rejects unknown or filtered IDs', async ({ page }) => {
  const list = virtualList(page)
  const firstRow = list.locator('[data-item-id="fixture-00001"]')
  await firstRow.click()
  await expect.poll(() => selectedCount(page)).toBe(1)
  await expect(page.locator('.stable-id-display strong')).toHaveText('fixture-00001')

  const jumpInput = page.getByLabel('Scroll to ID')
  await jumpInput.fill('fixture-10000')
  await expect(list).not.toBeFocused()
  await page.getByRole('button', { name: 'Go to item' }).click()

  const target = list.locator('[data-item-id="fixture-10000"]')
  await expect(target).toBeAttached()
  await expect.poll(() => activeItemId(list)).toBe('fixture-10000')
  await expect(list).toHaveAttribute('aria-activedescendant', await target.getAttribute('id'))
  await expect.poll(async () => target.evaluate((row) => {
    const container = row.closest('[data-testid="virtual-list"]')
    if (!container) return false
    const rowBox = row.getBoundingClientRect()
    const listBox = container.getBoundingClientRect()
    return rowBox.top >= listBox.top && rowBox.bottom <= listBox.bottom
  })).toBe(true)
  await expect(page.locator('.stable-id-display strong')).toHaveText('fixture-00001')
  await expect.poll(() => selectedCount(page)).toBe(1)

  const scrollBeforeUnknown = (await readGeometry(list)).scrollTop
  await jumpInput.fill('fixture-does-not-exist')
  await page.getByRole('button', { name: 'Go to item' }).click()
  await expect(page.locator('.jump-status')).toContainText('was not found')
  await expect.poll(async () => (await readGeometry(list)).scrollTop).toBe(scrollBeforeUnknown)
  await expect.poll(() => selectedCount(page)).toBe(1)

  const search = page.getByRole('textbox', { name: 'Search list items' })
  await search.fill('fixture-00001')
  await expect.poll(async () => list.locator('[role="option"]').count()).toBe(1)
  const scrollBeforeFiltered = (await readGeometry(list)).scrollTop
  await jumpInput.fill('fixture-10000')
  await page.getByRole('button', { name: 'Go to item' }).click()
  await expect(page.locator('.jump-status')).toContainText('hidden by the current filter')
  await expect.poll(async () => (await readGeometry(list)).scrollTop).toBe(scrollBeforeFiltered)
  await expect(page.locator('.stable-id-display strong')).toHaveText('fixture-00001')
  await expect.poll(() => selectedCount(page)).toBe(1)
})

test('uses measured keyboard capacity for navigation and supports selection commands with no matching rows', async ({ page }) => {
  const list = virtualList(page)
  await list.evaluate((element) => {
    ;(element as HTMLDivElement).style.height = '290px'
  })
  await expect.poll(async () => (await readGeometry(list)).clientHeight).toBe(290)
  const pageRows = Math.floor((await readGeometry(list)).clientHeight / ROW_HEIGHT)

  await list.focus()
  await expect.poll(() => activeItemId(list)).toBe('fixture-00001')
  await list.press('ArrowDown')
  await expect.poll(() => activeItemId(list)).toBe('fixture-00002')
  await expect.poll(() => selectedCount(page)).toBe(0)
  await list.press('PageDown')
  await expect.poll(() => activeItemId(list)).toBe(fixtureId(pageRows + 1))
  await list.press('PageUp')
  await expect.poll(() => activeItemId(list)).toBe('fixture-00002')
  await list.press('Home')
  await expect.poll(() => activeItemId(list)).toBe('fixture-00001')
  await list.press('End')
  await expect.poll(() => activeItemId(list)).toBe('fixture-12000')
  await list.press('ArrowUp')
  await expect.poll(() => activeItemId(list)).toBe('fixture-11999')

  await list.press('Space')
  await expect.poll(() => selectedCount(page)).toBe(1)
  await list.press('Enter')
  await expect.poll(() => selectedCount(page)).toBe(0)
  await list.press('Home')
  await list.press('Shift+ArrowDown')
  await expect.poll(() => selectedCount(page)).toBe(2)
  await list.press('Shift+ArrowDown')
  await expect.poll(() => selectedCount(page)).toBe(3)

  const search = page.getByRole('textbox', { name: 'Search list items' })
  await search.fill('query-that-matches-no-items')
  await expect.poll(async () => list.locator('[role="option"]').count()).toBe(0)
  await expect.poll(() => selectedCount(page)).toBe(3)
  await list.focus()
  await list.press('Escape')
  await expect.poll(() => selectedCount(page)).toBe(0)
})

test('announces visible and hidden selection totals and retains the announcement while scrolling', async ({ page }) => {
  const list = virtualList(page)
  await list.locator('[data-item-id="fixture-00001"]').click()
  await expect.poll(() => selectedCount(page)).toBe(1)
  await list.locator('[data-item-id="fixture-00002"]').click({ modifiers: ['Control'] })
  await expect.poll(() => selectedCount(page)).toBe(2)

  await page.getByRole('checkbox', { name: 'Active only' }).check()
  await expect.poll(async () => list.locator('[role="option"]').count()).toBeGreaterThan(0)
  const announcement = page.getByTestId('selection-announcement')
  await expect(announcement).toContainText('2 items selected')
  await expect(announcement).toContainText('1 hidden by filter')
  const beforeScroll = await announcement.textContent()

  const geometry = await readGeometry(list)
  await scrollList(list, geometry.scrollHeight / 2)
  await expect(announcement).toHaveText(beforeScroll ?? '')
})

test('keeps requested, changed, and skipped counters stable across a batch, noop update, scroll, and log clear', async ({ page }) => {
  const list = virtualList(page)
  await list.locator('[data-item-id="fixture-00001"]').click()
  await expect.poll(() => selectedCount(page)).toBe(1)

  await page.getByRole('button', { name: 'Batch +1 selected' }).click()
  await expect.poll(() => updateMetrics(page)).toEqual({ requested: 1, changed: 1, skipped: 0, rejected: 0, transactions: 1 })
  await expect.poll(async () => page.locator('.field-row input[type="number"]').inputValue()).toBe('13')

  await page.getByRole('button', { name: /Apply update/ }).click()
  await expect.poll(() => updateMetrics(page)).toEqual({ requested: 2, changed: 1, skipped: 1, rejected: 0, transactions: 1 })
  const expected = { requested: 2, changed: 1, skipped: 1, rejected: 0, transactions: 1 }

  const geometry = await readGeometry(list)
  await scrollList(list, geometry.scrollHeight)
  await expect.poll(() => updateMetrics(page)).toEqual(expected)
  await page.getByRole('button', { name: 'Clear log' }).click()
  await expect.poll(() => updateMetrics(page)).toEqual(expected)
})

test('clamps scroll and mounted rows for one-item and zero-item filters', async ({ page }) => {
  const list = virtualList(page)
  await scrollList(list, Number.MAX_SAFE_INTEGER)

  const search = page.getByRole('textbox', { name: 'Search list items' })
  await search.fill('fixture-10000')
  await expect.poll(async () => list.locator('[role="option"]').count()).toBe(1)
  await expect.poll(async () => (await readGeometry(list)).scrollTop).toBe(0)
  await expect.poll(async () => Number(await list.getAttribute('data-rendered-count'))).toBe(1)
  expect((await readGeometry(list)).rangeStart).toBe(0)
  expect((await readGeometry(list)).rangeEnd).toBe(1)

  await search.fill('query-that-matches-no-items')
  await expect.poll(async () => list.locator('[role="option"]').count()).toBe(0)
  await expect.poll(async () => (await readGeometry(list)).scrollTop).toBe(0)
  await expect.poll(async () => Number(await list.getAttribute('data-rendered-count'))).toBe(0)
  const empty = await readGeometry(list)
  expect(empty.rangeStart).toBe(0)
  expect(empty.rangeEnd).toBe(0)
})

test('preserves ID selection through reorder and resolves a jump from the reordered order', async ({ page }) => {
  const list = virtualList(page)
  await list.locator('[data-item-id="fixture-00001"]').click()
  await expect.poll(() => selectedCount(page)).toBe(1)
  await page.getByRole('button', { name: 'Reverse order' }).click()

  await expect(page.locator('.stable-id-display strong')).toHaveText('fixture-00001')
  await expect.poll(() => selectedCount(page)).toBe(1)
  await expect.poll(async () => (await optionIds(list)).includes('fixture-12000')).toBe(true)

  const jumpInput = page.getByLabel('Scroll to ID')
  await jumpInput.fill('fixture-00001')
  await page.getByRole('button', { name: 'Go to item' }).click()
  await expect.poll(() => activeItemId(list)).toBe('fixture-00001')
  const target = list.locator('[data-item-id="fixture-00001"]')
  await expect(target).toBeAttached()
  const geometry = await readGeometry(list)
  expect(geometry.scrollTop).toBe(ITEM_COUNT * ROW_HEIGHT - geometry.clientHeight)
  await expect(page.locator('.jump-status')).toContainText('Scrolled to fixture-00001')
  await expect(page.locator('.stable-id-display strong')).toHaveText('fixture-00001')
})

test('undoes and redoes an authoring update without losing the selected item', async ({ page }) => {
  const list = virtualList(page)
  const firstRow = list.locator('[data-item-id="fixture-00001"]')
  await firstRow.click()
  await expect.poll(() => selectedCount(page)).toBe(1)

  const valueInput = page.locator('.field-row input[type="number"]')
  await expect(valueInput).toHaveValue('12')
  await valueInput.fill('444')
  await page.getByRole('button', { name: /Apply update/ }).click()
  await expect(valueInput).toHaveValue('444')
  await expect(page.getByRole('button', { name: 'Undo' })).toBeEnabled()

  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(valueInput).toHaveValue('12')
  await expect(page.locator('.stable-id-display strong')).toHaveText('fixture-00001')
  await expect.poll(() => selectedCount(page)).toBe(1)

  await page.getByRole('button', { name: 'Redo' }).click()
  await expect(valueInput).toHaveValue('444')
  await expect(page.locator('.stable-id-display strong')).toHaveText('fixture-00001')
})
