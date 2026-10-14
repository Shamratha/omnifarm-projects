import { describe, expect, it } from 'vitest'
import { evidence, evidenceCatalog } from '../data/case'
import {
  buildCaseBrief,
  detectClockSkew,
  detectConflictingObservations,
  detectDuplicateEvidence,
  deriveConfidence,
  fingerprintEvidence,
  isFiniteIsoTimestamp,
  isSha256Hash,
  validateChainOfCustody,
  validateEvidence,
  type EvidenceRecord,
} from './evidence'

const options = {
  clockSkew: { maxFutureSkewMs: 60_000, maxObservedRegressionMs: 5 * 60_000 },
  conflict: { windowMs: 5 * 60_000 },
}

function record(overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    evidenceId: 'EV-test',
    caseId: 'CASE-test',
    subjectId: 'relay-test',
    sourceId: 'source-test',
    observation: { kind: 'relay.status', value: 'offline' },
    observedAt: '2026-10-12T08:00:00Z',
    receivedAt: '2026-10-12T08:01:00Z',
    contentHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    custody: [{ eventId: 'event-test', evidenceId: 'EV-test', sequence: 1, action: 'collected', fromPartyId: null, toPartyId: 'collector', occurredAt: '2026-10-12T08:01:00Z', previousEventId: null }],
    ...overrides,
  }
}

describe('evidence integrity baseline', () => {
  it('accepts an empty bundle and exports its absence explicitly', () => {
    expect(validateEvidence([], options)).toEqual({ valid: true, findings: [] })
    expect(buildCaseBrief([], [])).toContain('No evidence records supplied.')
  })

  it('accepts a well-formed record and keeps validation deterministic', () => {
    const report = validateEvidence([record()], options)
    expect(report.valid).toBe(true)
    expect(report.findings).toEqual([])
    expect(isFiniteIsoTimestamp('2026-02-29T08:00:00Z')).toBe(false)
    expect(isFiniteIsoTimestamp('2026-02-28T08:00:00Z')).toBe(true)
  })

  it('finds duplicate IDs, hashes, and semantic records', () => {
    const first = record({ evidenceId: 'EV-a', contentHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' })
    const sameId = { ...first }
    const sameHash = { ...record({ evidenceId: 'EV-b' }), contentHash: first.contentHash }
    const semantic = { ...record({ evidenceId: 'EV-c', contentHash: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' }) }
    const findings = detectDuplicateEvidence([first, sameId, sameHash, semantic])
    expect(findings.filter((item) => item.details?.duplicateType === 'evidenceId')).toHaveLength(1)
    expect(findings.filter((item) => item.details?.duplicateType === 'contentHash')).toHaveLength(1)
    expect(findings.filter((item) => item.details?.duplicateType === 'semantic')).toHaveLength(1)
  })

  it('normalizes equivalent instants and observation key order in semantic fingerprints', () => {
    const left = record()
    const right = record({ observedAt: '2026-10-12T10:00:00+02:00', observation: { value: 'offline', kind: 'relay.status' } })
    expect(fingerprintEvidence(left)).toBe(fingerprintEvidence(right))
    expect(detectDuplicateEvidence([left, { ...right, evidenceId: 'EV-copy', contentHash: undefined }]).some((item) => item.details?.duplicateType === 'semantic')).toBe(true)
  })

  it('detects case-insensitive hash repeats despite distinct semantics, without treating absent hashes as duplicates', () => {
    const other = record({ evidenceId: 'EV-other', subjectId: 'another relay', contentHash: record().contentHash?.toUpperCase() })
    expect(detectDuplicateEvidence([record(), other]).map((item) => item.details?.duplicateType)).toEqual(['contentHash'])
    expect(detectDuplicateEvidence([{ ...record(), contentHash: undefined }, { ...other, contentHash: undefined }])).toEqual([])
    expect(detectDuplicateEvidence([record(), other], () => 'custom').some((item) => item.details?.duplicateType === 'semantic')).toBe(true)
  })
})

describe('evidence boundaries', () => {
  it.each(['not-a-date', 'Infinity', '2026-10-12', '2026-10-12T08:00:00', '2026-02-30T08:00:00Z', '2026-10-12T24:00:00Z', '2026-10-12T08:60:00Z', '2026-10-12T08:00:00+99:99'])('rejects non-instant or invalid timestamp %s', (value) => {
    expect(isFiniteIsoTimestamp(value)).toBe(false)
    expect(detectClockSkew([record({ receivedAt: value })], options.clockSkew)[0].severity).toBe('error')
  })

  it('accepts leap days, timezone offsets, and millisecond precision', () => {
    expect(isFiniteIsoTimestamp('2024-02-29T08:00:00.123+02:30')).toBe(true)
    expect(isFiniteIsoTimestamp('2000-02-29T08:00:00Z')).toBe(true)
    expect(isFiniteIsoTimestamp('1900-02-29T08:00:00Z')).toBe(false)
  })

  it('uses strict greater-than clock thresholds and inclusive conflict windows', () => {
    const atThreshold = record({ observedAt: '2026-10-12T08:01:00Z', receivedAt: '2026-10-12T08:00:00Z' })
    expect(detectClockSkew([atThreshold], options.clockSkew)).toEqual([])
    expect(detectClockSkew([{ ...atThreshold, observedAt: '2026-10-12T08:01:00.001Z' }], options.clockSkew)).toHaveLength(1)
    const previous = record({ observedAt: '2026-10-12T08:05:00Z', receivedAt: '2026-10-12T08:05:00Z' })
    const current = record({ evidenceId: 'EV-next', receivedAt: '2026-10-12T08:06:00Z' })
    expect(detectClockSkew([previous, current], options.clockSkew)).toEqual([])
    expect(detectClockSkew([previous, { ...current, observedAt: '2026-10-12T07:59:59.999Z' }], options.clockSkew)).toHaveLength(1)
  })

  it('rejects non-finite or negative policy thresholds', () => {
    expect(() => detectClockSkew([], { ...options.clockSkew, maxFutureSkewMs: NaN })).toThrow(RangeError)
    expect(() => detectConflictingObservations([], { windowMs: -1 })).toThrow(RangeError)
    expect(() => detectConflictingObservations([], { windowMs: Infinity })).toThrow(RangeError)
  })

  it('rejects invalid timestamps and future observations', () => {
    const invalid = record({ observedAt: '2026-02-29T08:00:00Z' })
    const future = record({ evidenceId: 'EV-future', observedAt: '2026-10-12T08:10:00Z', receivedAt: '2026-10-12T08:00:00Z' })
    expect(detectClockSkew([invalid, future], options.clockSkew).map((item) => item.details?.reason)).toEqual(['invalid-timestamp', 'observation-after-receipt'])
  })

  it('detects source clock regressions only after receipt advances', () => {
    const earlier = record({ evidenceId: 'EV-early', observedAt: '2026-10-12T08:00:00Z', receivedAt: '2026-10-12T08:01:00Z' })
    const regression = record({ evidenceId: 'EV-regress', observedAt: '2026-10-12T07:00:00Z', receivedAt: '2026-10-12T08:10:00Z' })
    expect(detectClockSkew([earlier, regression], options.clockSkew)).toHaveLength(1)
    expect(detectClockSkew([regression, earlier], options.clockSkew)).toEqual(detectClockSkew([earlier, regression], options.clockSkew))
    expect(detectClockSkew([earlier, { ...regression, receivedAt: earlier.receivedAt }], options.clockSkew)).toEqual([])
    expect(detectClockSkew([earlier, { ...regression, caseId: 'another-case' }], options.clockSkew)).toEqual([])
    expect(detectClockSkew([earlier, { ...regression, sourceId: 'another-source' }], options.clockSkew)).toEqual([])
  })
})

describe('custody and conflict integrity', () => {
  it('requires collection first and chronological linked events', () => {
    const notCollected = record({ custody: [{ ...record().custody[0], action: 'received' }] })
    const gap = record({ evidenceId: 'EV-gap', custody: [
      record().custody[0],
      { eventId: 'event-gap-2', evidenceId: 'EV-gap', sequence: 2, action: 'received', fromPartyId: 'wrong-holder', toPartyId: 'desk', occurredAt: '2026-10-12T07:00:00Z', previousEventId: 'event-test' },
    ] })
    expect(validateChainOfCustody([notCollected, gap])).toHaveLength(2)
    expect(validateChainOfCustody([notCollected])[0].details?.reason).toBe('first-event-not-collected')
  })

  it('accepts unordered storage of a complete chronological chain and allows simultaneous handoff', () => {
    const first = record().custody[0]
    const second = { ...first, eventId: 'event-2', sequence: 2, action: 'stored' as const, fromPartyId: first.toPartyId, toPartyId: 'locker', previousEventId: first.eventId }
    expect(validateChainOfCustody([record({ custody: [second, first] })])).toEqual([])
    expect(validateChainOfCustody([record({ custody: [first, { ...second, occurredAt: '2026-10-12T07:59:00Z' }] })])[0].details?.reason).toBe('custody-chronology')
  })

  it('rejects empty chains, invalid custody dates, sequence gaps, wrong holders, foreign evidence, and repeated event IDs', () => {
    const first = record().custody[0]
    for (const changed of [
      { ...first, occurredAt: 'invalid' },
      { ...first, sequence: 2 },
      { ...first, fromPartyId: 'unexpected' },
      { ...first, evidenceId: 'foreign' },
      { ...first, toPartyId: '' },
      { ...first, previousEventId: 'missing' },
    ]) expect(validateChainOfCustody([record({ custody: [changed] })])).toHaveLength(1)
    expect(validateChainOfCustody([record({ custody: [] })])).toHaveLength(1)
    const other = record({ evidenceId: 'EV-other', custody: [{ ...first, evidenceId: 'EV-other' }] })
    expect(validateChainOfCustody([record(), other])).toHaveLength(2)
    expect(validateChainOfCustody([other, record()]).map((item) => item.evidenceIds[0]).sort()).toEqual(['EV-other', 'EV-test'])
  })

  it('flags conflicts only for the same case, subject, kind, unit, window, and distinct sources', () => {
    const left = record({ evidenceId: 'EV-left', sourceId: 'telemetry-a' })
    const right = record({ evidenceId: 'EV-right', sourceId: 'telemetry-b', contentHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', observation: { kind: 'relay.status', value: 'active' }, observedAt: '2026-10-12T08:04:00Z' })
    const otherCase = { ...right, evidenceId: 'EV-other', caseId: 'CASE-other' }
    expect(detectConflictingObservations([left, right, otherCase], options.conflict)).toHaveLength(1)
    for (const changed of [
      { ...right, subjectId: 'other-subject' },
      { ...right, sourceId: left.sourceId },
      { ...right, evidenceId: left.evidenceId },
      { ...right, observation: { ...right.observation, kind: 'other.kind' } },
      { ...right, observation: { ...right.observation, unit: 'other-unit' } },
      { ...right, observation: { ...right.observation, value: null } },
      { ...right, observation: left.observation },
      { ...right, observedAt: 'invalid' },
      { ...right, observedAt: '2026-10-12T08:05:00.001Z' },
      { ...right, contentHash: left.contentHash },
    ]) expect(detectConflictingObservations([left, changed], options.conflict)).toEqual([])
    expect(detectConflictingObservations([left, { ...right, observedAt: '2026-10-12T08:05:00Z' }], options.conflict)).toHaveLength(1)
    expect(detectConflictingObservations([left, right], { ...options.conflict, equivalent: () => true })).toEqual([])
    expect(detectConflictingObservations([left, right, { ...left, evidenceId: 'EV-z-copy' }], options.conflict)).toHaveLength(1)
  })
})

describe('confidence, brief, and synthetic bundle', () => {
  it('derives a stable explained confidence and complete Markdown export', () => {
    const report = validateEvidence(evidence, options)
    const assessment = deriveConfidence(evidence[0], report.findings)
    const brief = buildCaseBrief(evidence, report.findings)
    expect(assessment).toEqual(deriveConfidence(evidence[0], report.findings))
    expect(assessment.explanation).toContain(`${assessment.score}%`)
    expect(brief).toContain('Synthetic fixture data')
    expect(brief).toContain('SHA-256: sha256:')
    expect(brief).toContain('Custody:')
    expect(brief).toContain('Uncertainty and findings')
    expect(buildCaseBrief([...evidence].reverse(), [...report.findings].reverse())).toBe(brief)
    expect(brief).toContain('not a probability of truth')
    for (const item of evidence) {
      expect(brief).toContain(item.contentHash)
      for (const event of item.custody) expect(brief).toContain(event.eventId)
    }
  })

  it('does not mutate records or findings when validating or exporting', () => {
    const before = JSON.stringify(evidence)
    const report = validateEvidence(evidence, options)
    const beforeFindings = JSON.stringify(report.findings)
    buildCaseBrief(evidence, report.findings)
    for (const item of evidence) deriveConfidence(item, report.findings)
    expect(JSON.stringify(evidence)).toBe(before)
    expect(JSON.stringify(report.findings)).toBe(beforeFindings)
  })

  it('explains confidence deductions without double penalizing repeated flags in a category', () => {
    expect(deriveConfidence(record(), []).score).toBe(100)
    expect(deriveConfidence(record({ contentHash: undefined }), []).score).toBe(90)
    const report = validateEvidence(evidence, options)
    const conflictRecord = evidence[1]
    const relevant = report.findings.filter((item) => item.evidenceIds.includes(conflictRecord.evidenceId))
    expect(relevant).toHaveLength(2)
    expect(deriveConfidence(conflictRecord, report.findings).score).toBe(85)
    expect(deriveConfidence(evidence[8], report.findings).level).toBe('medium')
    expect(deriveConfidence(conflictRecord, [...report.findings].reverse())).toEqual(deriveConfidence(conflictRecord, report.findings))
    const allCodes = ['DUPLICATE_EVIDENCE', 'CLOCK_SKEW', 'BROKEN_CHAIN_OF_CUSTODY', 'CONFLICTING_OBSERVATIONS'] as const
    const assessment = deriveConfidence(record(), allCodes.map((code) => ({ code, severity: 'error', evidenceIds: ['EV-test'], message: 'Synthetic issue' })))
    expect(assessment.score).toBe(20)
    expect(assessment.level).toBe('low')
  })

  it('has 12 catalog entries with full SHA-256 declarations and unique static paths', () => {
    expect(evidence).toHaveLength(12)
    expect(Object.keys(evidenceCatalog)).toHaveLength(12)
    expect(new Set(Object.values(evidenceCatalog).map((entry) => entry.path)).size).toBe(12)
    for (const item of evidence) expect(isSha256Hash(item.contentHash ?? '')).toBe(true)
  })
})
