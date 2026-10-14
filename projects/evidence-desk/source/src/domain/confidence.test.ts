import { describe, expect, it } from 'vitest'
import {
  buildCaseBrief,
  detectConflictingObservations,
  detectDuplicateEvidence,
  deriveConfidence,
  summarizeConfidence,
  validateChainOfCustody,
  validateEvidence,
  type EvidenceRecord,
  type ValidationFinding,
} from './evidence'

const hash = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const options = { clockSkew: { maxFutureSkewMs: 60_000, maxObservedRegressionMs: 300_000 }, conflict: { windowMs: 300_000 } }

function record(overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    evidenceId: 'EV-confidence', caseId: 'CASE-confidence', subjectId: 'subject', sourceId: 'source-a',
    observation: { kind: 'temperature', value: 21, unit: 'C' },
    observedAt: '2026-10-12T08:00:00Z', receivedAt: '2026-10-12T08:01:00Z', contentHash: hash,
    custody: [{ eventId: 'event-1', evidenceId: 'EV-confidence', sequence: 1, action: 'collected', fromPartyId: null, toPartyId: 'collector', occurredAt: '2026-10-12T08:01:00Z', previousEventId: null }],
    ...overrides,
  }
}

function finding(code: ValidationFinding['code'], ids = ['EV-confidence'], details?: Record<string, unknown>): ValidationFinding {
  return { code, severity: 'warning', evidenceIds: ids, message: `synthetic ${code}`, ...(details ? { details } : {}) }
}

describe('confidence provenance', () => {
  it('always exposes hash and finding contributions with deterministic arithmetic', () => {
    const assessment = deriveConfidence(record(), [finding('CLOCK_SKEW'), finding('CLOCK_SKEW'), finding('DUPLICATE_EVIDENCE')])
    expect(assessment.baseScore).toBe(100)
    expect(assessment.totalPenalty).toBe(35)
    expect(assessment.score).toBe(65)
    expect(assessment.calculation).toBe('100 - 35 = 65')
    expect(assessment.contributions.map((item) => [item.code, item.penalty])).toEqual([
      ['HASH_DECLARATION', 0], ['CLOCK_SKEW', -20], ['DUPLICATE_EVIDENCE', -15],
    ])
    expect(assessment.contributions[1].supports).toHaveLength(2)
  })

  it('supports missing hashes, custom findings, and no invented details', () => {
    const assessment = deriveConfidence(record({ contentHash: undefined }), [finding('CLOCK_SKEW', ['EV-confidence'], undefined)])
    expect(assessment.score).toBe(70)
    expect(assessment.contributions[0].supports[0].facts).toContain('contentHash: unavailable')
    expect(assessment.contributions[1].supports[0].facts).toContain('details unavailable')
    const partial = deriveConfidence(record(), [finding('CONFLICTING_OBSERVATIONS', ['EV-confidence'], { left: { value: false }, unresolved: 'raw-only' })])
    expect(partial.contributions[1].supports[0].facts).toContain('detail.left.value: false')
    expect(partial.contributions[1].supports[0].facts.some((fact) => fact.startsWith('Observation '))).toBe(false)
    expect(partial.contributions[1].supports[0].facts).toContain('detail.unresolved: raw-only')
  })

  it('preserves custody expected-v-actual checks, timestamps, and self record details', () => {
    const bad = record({ custody: [
      { ...record().custody[0], action: 'received', sequence: 2, fromPartyId: 'wrong', previousEventId: 'missing', occurredAt: 'invalid' },
    ] })
    const report = validateChainOfCustody([bad])
    const assessment = deriveConfidence(bad, report)
    const support = assessment.contributions.find((item) => item.code === 'BROKEN_CHAIN_OF_CUSTODY')!.supports[0]
    expect(report[0].details).toMatchObject({ reason: 'custody-chronology', eventCount: 1 })
    expect(support.facts).toContain('Custody event event-1 at invalid: sequence expected 1; actual 2.')
    expect(support.facts).toContain('Custody event event-1 at invalid: previousEventId expected null; actual missing.')
    expect(support.facts).toContain('Custody event event-1 at invalid: holder expected null; actual wrong.')
    expect(support.facts).toContain('Custody event event-1 at invalid: action expected collected; actual received.')
    expect(support.facts.some((fact) => fact.includes('occurredAt: invalid'))).toBe(true)
    expect(support.facts.some((fact) => fact.includes('custody event event-1'))).toBe(true)
  })

  it('retains every failed custody event and every violated check, including sequence gaps and repeated events', () => {
    const first = record().custody[0]
    const bad = record({ custody: [
      { ...first, eventId: 'event-3', sequence: 3, action: 'collected', evidenceId: 'foreign', fromPartyId: 'wrong-holder', toPartyId: '', previousEventId: 'wrong-ref', occurredAt: '2026-10-12T07:00:00Z' },
      first,
      { ...first, sequence: 4, action: 'stored', fromPartyId: '', previousEventId: 'event-3', occurredAt: 'not-a-time' },
    ] })
    const findings = validateChainOfCustody([bad])
    expect(findings).toHaveLength(1)
    const failed = findings[0].details!.failedEvents as Array<{ eventId: string; checks: Array<{ check: string; expected: unknown; actual: unknown }> }>
    expect(failed).toHaveLength(3)
    expect(failed[1].eventId).toBe('event-3')
    expect(failed[1].checks.map((item) => item.check)).toEqual(['evidenceId', 'toPartyId', 'sequence', 'action', 'previousEventId', 'holder', 'occurredAt'])
    expect(failed[1].checks).toContainEqual({ check: 'sequence', expected: 2, actual: 3 })
    expect(failed[1].checks).toContainEqual({ check: 'previousEventId', expected: 'event-1', actual: 'wrong-ref' })
    expect(failed[1].checks).toContainEqual({ check: 'holder', expected: 'collector', actual: 'wrong-holder' })
    expect(failed[0].checks).toContainEqual({ check: 'eventIdCount', expected: 1, actual: 2 })
    const contribution = deriveConfidence(bad, findings).contributions[1]
    expect(contribution.penalty).toBe(-30)
    expect(contribution.supports[0].facts).toContain('Custody event event-3 at 2026-10-12T07:00:00Z: sequence expected 2; actual 3.')
    expect(contribution.supports[0].facts.some((fact) => fact.includes('at or after 2026-10-12T08:01:00Z'))).toBe(true)
    const empty = record({ custody: [] })
    expect(deriveConfidence(empty, validateChainOfCustody([empty])).contributions[1].supports[0].facts).toContain('Record EV-confidence: no custody events recorded.')
  })

  it('describes duplicate types, counts, both contradiction observations, and the conflict window', () => {
    const first = record({ evidenceId: 'EV-a' })
    const second = record({ evidenceId: 'EV-b', sourceId: 'source-b', contentHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', observation: { kind: 'temperature', value: 99, unit: 'C' }, observedAt: '2026-10-12T08:04:00Z' })
    const duplicates = detectDuplicateEvidence([first, { ...first }, { ...first, evidenceId: 'EV-c', contentHash: hash.toUpperCase() }])
    expect(duplicates.find((item) => item.details?.duplicateType === 'evidenceId')?.details).toMatchObject({ count: 2, repeatedIdCount: 2 })
    expect(duplicates.find((item) => item.details?.duplicateType === 'contentHash')?.details).toMatchObject({ count: 3 })
    expect(duplicates.find((item) => item.details?.duplicateType === 'semantic')?.details).toMatchObject({ count: 3, fingerprint: expect.any(String) })
    const duplicateContribution = deriveConfidence(first, duplicates).contributions[1]
    expect(duplicateContribution.penalty).toBe(-15)
    expect(duplicateContribution.supports).toHaveLength(3)
    expect(duplicateContribution.supports.flatMap((item) => item.facts)).toContain(`detail.contentHash: ${hash}`)
    expect(duplicateContribution.supports.flatMap((item) => item.facts)).toContain('detail.evidenceId: EV-a')
    expect(duplicateContribution.supports.flatMap((item) => item.facts)).toContain('detail.repeatedIdCount: 2')
    const conflict = detectConflictingObservations([first, second], { windowMs: 300_000 })[0]
    const support = deriveConfidence(first, conflict ? [conflict] : []).contributions[1].supports[0]
    expect(support.facts.some((fact) => fact.includes('left.value: 21'))).toBe(true)
    expect(support.facts.some((fact) => fact.includes('right.value: 99'))).toBe(true)
    expect(support.facts.some((fact) => fact.includes('conflictWindowMs: 300000'))).toBe(true)
    expect(support.evidenceIds).toEqual(['EV-a', 'EV-b'])
    expect(support.facts).toContain('Observation EV-a from source source-a at 2026-10-12T08:00:00Z: temperature = 21; unit C.')
    expect(support.facts).toContain('Observation EV-b from source source-b at 2026-10-12T08:04:00Z: temperature = 99; unit C.')
    expect(conflict.details).toMatchObject({ observedDifferenceMs: 240_000, conflictWindowMs: 300_000 })
  })

  it('combines all deductions without altering thresholds or reasons and ignores unrelated flags', () => {
    const findings = ['DUPLICATE_EVIDENCE', 'CLOCK_SKEW', 'BROKEN_CHAIN_OF_CUSTODY', 'CONFLICTING_OBSERVATIONS'].map((code) => finding(code as ValidationFinding['code']))
    const assessment = deriveConfidence(record({ contentHash: 'malformed' }), findings)
    expect(assessment.score).toBe(10)
    expect(assessment.level).toBe('low')
    expect(assessment.totalPenalty).toBe(90)
    expect(assessment.totalPenalty).toBe(-assessment.contributions.reduce((sum, item) => sum + item.penalty, 0))
    expect(assessment.calculation).toBe('100 - 90 = 10')
    expect(deriveConfidence(record(), [finding('CLOCK_SKEW')]).level).toBe('high')
    expect(deriveConfidence(record({ contentHash: undefined }), [finding('BROKEN_CHAIN_OF_CUSTODY')]).level).toBe('medium')
    expect(deriveConfidence(record(), [finding('CLOCK_SKEW', ['unrelated'])])).toEqual(deriveConfidence(record(), []))
    expect(deriveConfidence(record(), [finding('CLOCK_SKEW'), finding('CLOCK_SKEW')]).reasons).toHaveLength(1)
  })

  it('combines categories once while retaining unrelated findings out of scope', () => {
    const assessment = deriveConfidence(record(), [finding('DUPLICATE_EVIDENCE'), finding('CLOCK_SKEW'), finding('BROKEN_CHAIN_OF_CUSTODY'), finding('CONFLICTING_OBSERVATIONS', ['other'])])
    expect(assessment.score).toBe(35)
    expect(assessment.contributions.map((item) => item.code)).toEqual(['HASH_DECLARATION', 'BROKEN_CHAIN_OF_CUSTODY', 'CLOCK_SKEW', 'DUPLICATE_EVIDENCE'])
  })
})

describe('confidence summary', () => {
  it('rounds the mean once, retains duplicates, is deterministic, and has an empty state', () => {
    const first = record({ evidenceId: 'EV-a' })
    const second = record({ evidenceId: 'EV-b', contentHash: undefined })
    const findings = [finding('DUPLICATE_EVIDENCE', ['EV-a'])]
    const summary = summarizeConfidence([second, first, first], findings)
    expect(summary.score).toBe(87)
    expect(summary.calculation).toBe('round((85 + 85 + 90) / 3) = 87')
    expect(summary.assessments.map((item) => item.evidenceId)).toEqual(['EV-a', 'EV-a', 'EV-b'])
    expect(summarizeConfidence([], []).score).toBeNull()
    expect(summarizeConfidence([], []).calculation).toContain('No records')
    expect(summarizeConfidence([first, second], findings)).toEqual(summarizeConfidence([second, first], findings))
  })

  it('sorts assessments with repeated IDs deterministically and never hides repeated inputs', () => {
    const complete = record()
    const missing = record({ contentHash: undefined })
    const records = [missing, complete, missing]
    const findings = detectDuplicateEvidence(records)
    const summary = summarizeConfidence(records, findings)
    expect(summary.assessments).toHaveLength(3)
    expect(summary.assessments.map((item) => item.score).sort()).toEqual([75, 75, 85])
    expect(summary.score).toBe(78)
    expect(summarizeConfidence([...records].reverse(), [...findings].reverse())).toEqual(summary)
    const brief = buildCaseBrief(records, findings)
    expect(buildCaseBrief([...records].reverse(), [...findings].reverse())).toBe(brief)
    expect(brief).toContain('Duplicate records and repeated evidence IDs are retained as separate inputs')
    expect(brief).toContain('**Overall confidence:** 78%')
    expect((brief.match(/### EV-confidence/g) ?? [])).toHaveLength(3)
    expect(summarizeConfidence([], findings)).toEqual({ score: null, calculation: 'No records supplied; no mean calculated.', assessments: [] })
    expect(buildCaseBrief([], findings)).toContain('**Overall confidence:** unavailable (no records)')
  })
})

function escaped(value: string): string {
  return value.replace(/[\\`*_{}\[\]<>()#!|]/g, '\\$&').replace(/[\r\n]/g, ' ')
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

describe('confidence export parity and purity', () => {
  it('exports the shared arithmetic, penalty table, support facts, and support IDs verbatim with Markdown escaping', () => {
    const records = [record({ custody: [], contentHash: undefined }), record({ evidenceId: 'EV-other', sourceId: 'source-b', observation: { kind: 'temperature', value: 25, unit: 'C' } })]
    const findings = validateEvidence(records, options).findings
    const summary = summarizeConfidence(records, findings)
    const brief = buildCaseBrief(records, findings)
    expect(brief).toContain('Synthetic fixture data')
    expect(brief).toContain('not a probability of truth or proof of authenticity')
    expect(brief).toContain('no conflicting account is selected as true')
    expect(brief).toContain(`**Overall confidence:** ${summary.score}%`)
    expect(brief).toContain(escaped(summary.calculation))
    expect(brief).toContain('Level thresholds: high ≥80; medium ≥60 and <80; low <60.')
    for (const [code, penalty] of [['DUPLICATE_EVIDENCE', -15], ['CLOCK_SKEW', -20], ['BROKEN_CHAIN_OF_CUSTODY', -30], ['CONFLICTING_OBSERVATIONS', -15]]) {
      expect(brief).toContain(`| ${code} | ${penalty} |`)
    }
    for (const assessment of summary.assessments) {
      expect(brief).toContain(escaped(assessment.explanation))
      expect(brief).toContain(escaped(assessment.calculation))
      for (const contribution of assessment.contributions) {
        expect(brief).toContain(`${escaped(contribution.code)} — ${escaped(contribution.label)}: ${contribution.penalty}.`)
        for (const support of contribution.supports) {
          expect(brief).toContain(`Support (${support.evidenceIds.map(escaped).join(', ')}): ${escaped(support.message)}`)
          for (const fact of support.facts) expect(brief).toContain(escaped(fact))
        }
      }
    }
    expect(buildCaseBrief([...records].reverse(), [...findings].reverse())).toBe(brief)
  })

  it('handles equal category/message findings, sorted IDs, and reordered detail keys deterministically', () => {
    const left = finding('CLOCK_SKEW', ['z', 'EV-confidence', 'a'], { actual: 'later', expected: 'earlier' })
    const right = finding('CLOCK_SKEW', ['b', 'EV-confidence'], { observedAt: 'invalid' })
    const assessment = deriveConfidence(record(), [left, right])
    expect(assessment.contributions[1].supports.map((item) => item.evidenceIds)).toEqual([['a', 'EV-confidence', 'z'], ['b', 'EV-confidence']])
    expect(deriveConfidence(record(), [right, { ...left, evidenceIds: [...left.evidenceIds].reverse(), details: { expected: 'earlier', actual: 'later' } }])).toEqual(assessment)
    expect(buildCaseBrief([record()], [left, right])).toBe(buildCaseBrief([record()], [right, { ...left, evidenceIds: [...left.evidenceIds].reverse() }]))
  })

  it('does not mutate frozen input records, observations, custody, findings, IDs, or details', () => {
    const records = deepFreeze([record(), record({ evidenceId: 'EV-copy', custody: [] })])
    const before = JSON.stringify(records)
    const findings = deepFreeze([...validateEvidence(records, options).findings, finding('CLOCK_SKEW', ['EV-copy', 'EV-confidence'], { exact: ['a', 'b'], nested: { raw: 'unresolved' } })])
    const beforeFindings = JSON.stringify(findings)
    const assessments = records.map((item) => deriveConfidence(item, findings))
    const originalAssessments = JSON.stringify(assessments)
    summarizeConfidence(records, findings)
    buildCaseBrief(records, findings)
    expect(JSON.stringify(records)).toBe(before)
    expect(JSON.stringify(findings)).toBe(beforeFindings)
    expect(JSON.stringify(assessments)).toBe(originalAssessments)
  })
})
