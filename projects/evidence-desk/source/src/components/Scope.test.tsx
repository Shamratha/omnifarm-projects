import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../App'
import { caseMeta, evidence } from '../data/case'
import { buildCaseBrief, validateEvidence } from '../domain/evidence'
import { EVIDENCE_DESK_SCOPE } from '../scope'
import { buildDeskBrief } from '../ui'
import { Inspector } from './Inspector'
import { ScopeBanner } from './Scope'

const report = validateEvidence(evidence, {
  clockSkew: { maxFutureSkewMs: 60_000, maxObservedRegressionMs: 5 * 60_000 },
  conflict: { windowMs: 5 * 60_000 },
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function render(node: ReactNode) {
  await act(async () => root.render(node))
}

function scopeText() {
  return [EVIDENCE_DESK_SCOPE.badge, EVIDENCE_DESK_SCOPE.short, EVIDENCE_DESK_SCOPE.label, EVIDENCE_DESK_SCOPE.description]
}

function scopeLabels() {
  return [EVIDENCE_DESK_SCOPE.badge, EVIDENCE_DESK_SCOPE.short, EVIDENCE_DESK_SCOPE.label]
}

function expectScopeVisible(markup: string) {
  for (const text of scopeText()) expect(markup).toContain(text)
}

function expectScopeLabelsVisible(markup: string) {
  for (const text of scopeLabels()) expect(markup).toContain(text)
}

function buttonWithText(text: string) {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes(text))
  expect(button).toBeDefined()
  return button!
}

describe('synthetic case scope boundary', () => {
  it('renders the optional compact and default scope banners with the shared labels', () => {
    expectScopeVisible(renderToStaticMarkup(<ScopeBanner />))
    expectScopeLabelsVisible(renderToStaticMarkup(<ScopeBanner compact />))
  })

  it('keeps the scope banner visible on every App tab and exposes the scope labels in the header', async () => {
    await render(<App />)

    for (const tab of ['Overview', 'Timeline', 'Entities', 'Evidence', 'Custody']) {
      await act(async () => buttonWithText(tab).click())
      expectScopeVisible(container.querySelector('main [aria-label="Synthetic case and no-contact scope"]')?.textContent ?? '')
      expect(container.querySelector('nav button.active')?.textContent).toContain(tab)
      expectScopeLabelsVisible(container.querySelector('header')?.textContent ?? '')
    }
  })

  it('exports the scoped Markdown brief without fetching during navigation or export', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:case-brief')
    const revokeObjectURL = vi.fn()
    const originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
    const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    try {
      await render(<App />)
      for (const tab of ['Overview', 'Timeline', 'Entities', 'Evidence', 'Custody']) {
        await act(async () => buttonWithText(tab).click())
      }
      await act(async () => buttonWithText('Export brief').click())

      expect(fetchMock).not.toHaveBeenCalled()
      expect(createObjectURL).toHaveBeenCalledOnce()
      expect(click).toHaveBeenCalled()
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:case-brief')
      const exported = await createObjectURL.mock.calls[0][0].text()
      expect(exported).toContain('## Scope and safe-use boundary')
      for (const bullet of EVIDENCE_DESK_SCOPE.brief) expect(exported).toContain(bullet)
      expect(exported).toContain(caseMeta.title)
    } finally {
      click.mockRestore()
      if (originalCreateObjectURL) Object.defineProperty(URL, 'createObjectURL', originalCreateObjectURL)
      else Reflect.deleteProperty(URL, 'createObjectURL')
      if (originalRevokeObjectURL) Object.defineProperty(URL, 'revokeObjectURL', originalRevokeObjectURL)
      else Reflect.deleteProperty(URL, 'revokeObjectURL')
    }
  })

  it('keeps the scope boundary in empty and sample export output with matching parity', () => {
    const empty = buildCaseBrief([], [])
    const sample = buildCaseBrief(evidence, report.findings)
    const desk = buildDeskBrief(report.findings)
    const boundary = (markdown: string) => markdown.split('## Scope and safe-use boundary\n')[1]?.split('\n## ')[0]

    expect(empty).toContain('Synthetic Evidence Case Brief')
    expect(empty).toContain('## Scope and safe-use boundary')
    expect(desk).toContain(caseMeta.title)
    expect(boundary(empty)).toBe(boundary(sample))
    expect(boundary(sample)).toBe(boundary(desk))
    for (const bullet of EVIDENCE_DESK_SCOPE.brief) {
      expect(empty).toContain(bullet)
      expect(sample).toContain(bullet)
      expect(desk).toContain(bullet)
    }
  })

  it('includes the compact scope banner for evidence, findings, methodology, and confidence inspections', () => {
    const finding = report.findings.find((item) => item.evidenceIds.includes('EV-1046'))!
    const inspections = [
      { type: 'evidence' as const, id: 'EV-1046' },
      { type: 'finding' as const, finding },
      { type: 'methodology' as const },
      { type: 'confidence' as const, kind: 'transfer' },
    ]

    for (const inspection of inspections) {
      const markup = renderToStaticMarkup(<Inspector inspection={inspection} findings={report.findings} onClose={vi.fn()} onEvidence={vi.fn()} />)
      expectScopeLabelsVisible(markup)
    }
  })
})
