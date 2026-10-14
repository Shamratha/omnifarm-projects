import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { evidence, timeline } from '../data/case'
import { deriveConfidence, validateEvidence } from '../domain/evidence'
import { buildDeskBrief, timelineReview } from '../ui'
import { ReviewFlags } from './CaseViews'
import { ConfidenceDetails } from './ConfidenceDetails'
import { Inspector } from './Inspector'
import { TimelinePanel } from './TimelinePanel'

const { findings } = validateEvidence(evidence, {
  clockSkew: { maxFutureSkewMs: 60_000, maxObservedRegressionMs: 300_000 },
  conflict: { windowMs: 300_000 },
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
async function render(node: ReactNode) { await act(async () => root.render(node)) }
async function filterTimeline(value: string) {
  const select = container.querySelector<HTMLSelectElement>('[aria-label="Timeline review category"]')!
  await act(async () => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })) })
}

describe('separate duplicate and contradiction review flows', () => {
  it('filters and opens timeline findings by explicit category, never a shared generic alert', async () => {
    const onReview = vi.fn()
    await render(<TimelinePanel findings={findings} onReview={onReview} onEvidence={vi.fn()} full />)
    expect(container.querySelector('.marker-duplicate')).not.toBeNull()
    expect(container.querySelector('.marker-contradiction')).not.toBeNull()
    await filterTimeline('DUPLICATE_EVIDENCE')
    const duplicateRows = container.querySelectorAll<HTMLButtonElement>('.timeline-row')
    expect(duplicateRows).toHaveLength(1)
    expect(duplicateRows[0].dataset.reviewCode).toBe('DUPLICATE_EVIDENCE')
    expect(duplicateRows[0].querySelector('.timeline-category')?.textContent).toBe('Duplicate records')
    await act(async () => duplicateRows[0].click())
    expect(onReview.mock.lastCall?.[0].code).toBe('DUPLICATE_EVIDENCE')
    expect(onReview.mock.lastCall?.[0].evidenceIds).toContain('EV-1046')

    await filterTimeline('CONFLICTING_OBSERVATIONS')
    const contradictionRows = container.querySelectorAll<HTMLButtonElement>('.timeline-row')
    expect(contradictionRows).toHaveLength(1)
    expect(contradictionRows[0].dataset.reviewCode).toBe('CONFLICTING_OBSERVATIONS')
    expect(contradictionRows[0].querySelector('.timeline-category')?.textContent).toBe('Contradictory observations')
    await act(async () => contradictionRows[0].click())
    expect(onReview.mock.lastCall?.[0].code).toBe('CONFLICTING_OBSERVATIONS')
    expect(onReview.mock.lastCall?.[0].evidenceIds).toEqual(['EV-1043', 'EV-1044'])
  })

  it('keeps both review groups visible, counts findings separately, and routes each group correctly', async () => {
    const onReview = vi.fn()
    await render(<ReviewFlags findings={findings} onReview={onReview} />)
    const duplicates = container.querySelector<HTMLElement>('[aria-label="Duplicate records"]')!
    const contradictions = container.querySelector<HTMLElement>('[aria-label="Contradictory observations"]')!
    expect(duplicates.querySelectorAll('.flag-row')).toHaveLength(2)
    expect(contradictions.querySelectorAll('.flag-row')).toHaveLength(2)
    expect(duplicates.querySelector('.review-group-heading')?.textContent).toContain('2 findings')
    expect(contradictions.querySelector('.review-group-heading')?.textContent).toContain('2 findings')
    expect(duplicates.querySelector('.flag-list')?.textContent).not.toContain('Observations disagree')
    expect(contradictions.querySelector('.flag-list')?.textContent).not.toContain('semantic fingerprint')
    expect(contradictions.querySelector('.flag-list')?.textContent).not.toContain('EV-1046')
    await act(async () => duplicates.querySelector<HTMLButtonElement>('.flag-row')!.click())
    expect(onReview.mock.lastCall?.[0].code).toBe('DUPLICATE_EVIDENCE')
    await act(async () => contradictions.querySelector<HTMLButtonElement>('.flag-row')!.click())
    expect(onReview.mock.lastCall?.[0].code).toBe('CONFLICTING_OBSERVATIONS')
  })

  it('does not move duplicate findings into an empty contradictory-observation group', async () => {
    await render(<ReviewFlags findings={findings.filter((finding) => finding.code === 'DUPLICATE_EVIDENCE')} onReview={vi.fn()} />)
    const contradictions = container.querySelector('[aria-label="Contradictory observations"]')!
    expect(contradictions.querySelectorAll('.flag-row')).toHaveLength(0)
    expect(contradictions.textContent).toContain('0 findings')
    expect(contradictions.textContent).toContain('No findings in this category.')
    expect(container.querySelector('[aria-label="Duplicate records"]')?.querySelectorAll('.flag-row')).toHaveLength(2)
  })

  it('isolates each score deduction and its supports even when a record has both categories', async () => {
    const assessment = deriveConfidence(evidence[0], findings)
    await render(<ConfidenceDetails assessment={assessment} onEvidence={vi.fn()} />)
    const duplicate = container.querySelector('article[data-review-code="DUPLICATE_EVIDENCE"]')!
    const contradiction = container.querySelector('article[data-review-code="CONFLICTING_OBSERVATIONS"]')!
    expect(duplicate.querySelector('h4')?.textContent).toBe('Duplicate records')
    expect(contradiction.querySelector('h4')?.textContent).toBe('Contradictory observations')
    expect(duplicate.querySelector('.contribution-heading')?.textContent).toContain('−15 points · once')
    expect(contradiction.querySelector('.contribution-heading')?.textContent).toContain('−15 points · once')
    expect(duplicate.querySelectorAll('.contribution-support')).toHaveLength(2)
    expect(contradiction.querySelectorAll('.contribution-support')).toHaveLength(1)
    expect(duplicate.querySelector('.confidence-links')?.textContent).not.toContain('EV-1043')
    expect(contradiction.querySelector('.confidence-links')?.textContent).toContain('EV-1043')
    expect(contradiction.querySelector('.confidence-links')?.textContent).not.toContain('EV-1046')
    expect(container.textContent).toContain('100 - 30 = 70')
  })

  it('does not describe the duplicate inspector as an unresolved disagreement', () => {
    const duplicate = findings.find((finding) => finding.code === 'DUPLICATE_EVIDENCE')!
    container.innerHTML = renderToStaticMarkup(<Inspector inspection={{ type: 'finding', finding: duplicate }} findings={findings} onClose={vi.fn()} onEvidence={vi.fn()} />)
    expect(container.querySelector('h2')?.textContent).toBe('Duplicate records')
    expect(container.querySelector('.notice-block')?.textContent).toContain('repeated-record finding, not a disagreement')
    expect(container.querySelector('.notice-block')?.textContent).not.toContain('no account is selected')
  })

  it('retains category metadata, labels and category-specific supporting records in the exported timeline', () => {
    const brief = buildDeskBrief(findings)
    const duplicateItem = timeline.find((item) => item.type === 'duplicate')!
    const contradictionItem = timeline.find((item) => item.type === 'contradiction')!
    expect(timelineReview(duplicateItem, findings).linkedFindings.every((finding) => finding.code === 'DUPLICATE_EVIDENCE')).toBe(true)
    expect(timelineReview(contradictionItem, findings).linkedFindings.every((finding) => finding.code === 'CONFLICTING_OBSERVATIONS')).toBe(true)
    const exported = brief.split('## Timeline\n')[1]
    const duplicate = exported.split('- 08:52:00 UTC')[1].split('\n- ')[0]
    const contradiction = exported.split('- 08:45:00 UTC')[1].split('\n- ')[0]
    expect(duplicate).toContain('Duplicate records')
    expect(duplicate).toContain('Review category: DUPLICATE_EVIDENCE')
    expect(duplicate).toContain('Supporting review records: EV-1042, EV-1046')
    expect(duplicate).not.toContain('CONFLICTING_OBSERVATIONS')
    expect(contradiction).toContain('Contradictory observations')
    expect(contradiction).toContain('Review category: CONFLICTING_OBSERVATIONS')
    expect(contradiction).toContain('Supporting review records: EV-1043, EV-1044')
    expect(contradiction).not.toContain('EV-1046')
  })
})
