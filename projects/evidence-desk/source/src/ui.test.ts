import { describe, expect, it } from 'vitest'
import { evidence } from './data/case'
import { deriveConfidence, validateEvidence } from './domain/evidence'
import { buildDeskBrief, confidenceSources } from './ui'

const { findings } = validateEvidence(evidence, {
  clockSkew: { maxFutureSkewMs: 60_000, maxObservedRegressionMs: 300_000 },
  conflict: { windowMs: 300_000 },
})

describe('computed overview and export parity', () => {
  it('computes every source percentage from its listed record scores', () => {
    const groups = confidenceSources(findings)
    expect(groups.reduce((count, group) => count + group.count, 0)).toBe(evidence.length)
    for (const group of groups) {
      expect(group.value).toBe(Math.round(group.summary.assessments.reduce((sum, item) => sum + item.score, 0) / group.count))
      for (const assessment of group.summary.assessments) {
        expect(assessment).toEqual(deriveConfidence(evidence.find((record) => record.evidenceId === assessment.evidenceId)!, findings))
      }
    }
    expect(groups.find((group) => group.kind === 'witness-note')?.value).toBe(85)
    expect(groups.find((group) => group.kind === 'transfer')?.value).toBe(85)
  })

  it('exports the same group values, arithmetic and inputs as the overview with full per-record support', () => {
    const brief = buildDeskBrief(findings)
    expect(buildDeskBrief([...findings].reverse())).toBe(brief)
    for (const group of confidenceSources(findings)) {
      const section = brief.split(`### ${group.label}\n`)[1].split('\n### ')[0]
      expect(section).toContain(`- Confidence: ${group.value}%`)
      expect(section).toContain(group.summary.calculation)
      for (const assessment of group.summary.assessments) expect(section).toContain(`${assessment.evidenceId}: ${assessment.score}% (${assessment.calculation})`)
    }
    expect(brief).toContain('sequence expected 2; actual 3')
    expect(brief).toContain('Observation EV-1043 from source witness-alvarez')
    expect(brief).toContain('detail.duplicateType: semantic')
  })
})
