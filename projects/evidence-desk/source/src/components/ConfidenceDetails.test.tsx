import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { evidence } from '../data/case'
import { deriveConfidence, validateEvidence } from '../domain/evidence'
import { ConfidenceDetails } from './ConfidenceDetails'
import { EvidenceView } from './CaseViews'
import { Inspector } from './Inspector'

const report = validateEvidence(evidence, {
  clockSkew: { maxFutureSkewMs: 60_000, maxObservedRegressionMs: 300_000 },
  conflict: { windowMs: 300_000 },
})
const originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal')
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close')
let container: HTMLDivElement
let root: Root

beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true } })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.open = false } })
})
afterAll(() => {
  if (originalShow) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShow)
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal')
  if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, 'close', originalClose)
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'close')
})
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
async function render(node: ReactNode) { await act(async () => root.render(node)) }
async function click(button: HTMLButtonElement | null) {
  expect(button).not.toBeNull()
  await act(async () => button!.click())
}

describe('confidence evidence review', () => {
  it('shows the custody deduction with the exact failed event and expected versus actual sequence', async () => {
    await render(<Inspector inspection={{ type: 'evidence', id: 'EV-1050' }} findings={report.findings} onClose={vi.fn()} onEvidence={vi.fn()} />)
    expect(container.textContent).toContain('100 - 30 = 70')
    expect(container.textContent).toContain('−30 points · once')
    expect(container.textContent).toContain('Custody event co-12')
    expect(container.textContent).toContain('expected 2; actual 3')
    expect(container.querySelector('.confidence-details details')).not.toBeNull()
  })

  it('shows every duplicate support but applies the category once and opens related evidence', async () => {
    const onEvidence = vi.fn()
    const assessment = deriveConfidence(evidence[0], report.findings)
    await render(<ConfidenceDetails assessment={assessment} onEvidence={onEvidence} />)
    const duplicate = [...container.querySelectorAll('article')].find((article) => article.textContent?.includes('Duplicate evidence category'))!
    expect(duplicate.querySelectorAll('.contribution-support')).toHaveLength(2)
    expect(duplicate.textContent).toContain('−15 points · once')
    expect(duplicate.textContent).toContain('contentHash')
    expect(duplicate.textContent).toContain('semantic')
    expect(duplicate.textContent).toContain('EV-1046')
    const related = [...duplicate.querySelectorAll('button')].find((button) => button.textContent?.startsWith('EV-1046'))!
    await click(related)
    expect(onEvidence).toHaveBeenCalledWith('EV-1046')
  })

  it('preserves both contradictory observations and excludes unrelated custody flags', async () => {
    await render(<Inspector inspection={{ type: 'evidence', id: 'EV-1043' }} findings={report.findings} onClose={vi.fn()} onEvidence={vi.fn()} />)
    expect(container.textContent).toContain('100 - 15 = 85')
    expect(container.textContent).toContain('relay.status = active')
    expect(container.textContent).toContain('relay.status = offline')
    expect(container.textContent).toContain('source witness-alvarez')
    expect(container.textContent).toContain('source gateway-02')
    expect(container.textContent).toContain('2026-10-12T08:41:00Z')
    expect(container.textContent).not.toContain('co-12')
    expect(container.textContent).not.toContain('Broken chain of custody category')
  })

  it('lists every group mean input and navigates to its supporting record', async () => {
    const onEvidence = vi.fn()
    await render(<Inspector inspection={{ type: 'confidence', kind: 'transfer' }} findings={report.findings} onClose={vi.fn()} onEvidence={onEvidence} />)
    expect(container.textContent).toContain('Mean integrity score: 85%')
    expect(container.textContent).toContain('round((70 + 100) / 2) = 85')
    expect(container.querySelectorAll('.mean-inputs button')).toHaveLength(2)
    await click(container.querySelector<HTMLButtonElement>('.mean-inputs button'))
    expect(onEvidence).toHaveBeenCalledWith('EV-1050')
  })

  it('makes evidence-register scores actionable with matching arithmetic', async () => {
    const onEvidence = vi.fn()
    await render(<EvidenceView findings={report.findings} onEvidence={onEvidence} />)
    const button = container.querySelector<HTMLButtonElement>('[aria-label="Explain EV-1050 confidence"]')
    expect(button?.textContent).toContain('70%')
    expect(button?.parentElement?.textContent).toContain('100 - 30 = 70')
    await click(button)
    expect(onEvidence).toHaveBeenCalledWith('EV-1050')
  })
})
