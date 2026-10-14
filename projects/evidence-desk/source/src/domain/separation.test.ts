import { describe, expect, it } from 'vitest'
import { evidence } from '../data/case'
import {
  FINDING_CATEGORIES,
  buildCaseBrief,
  deriveConfidence,
  detectConflictingObservations,
  detectDuplicateEvidence,
  groupFindings,
  validateEvidence,
  type EvidenceRecord,
  type FindingCode,
  type ValidationFinding,
} from './evidence'

const options = {
  clockSkew: { maxFutureSkewMs: 60_000, maxObservedRegressionMs: 300_000 },
  conflict: { windowMs: 300_000 },
}
const hash = (digit: string) => `sha256:${digit.repeat(64)}`

function record(evidenceId: string, overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    evidenceId, caseId: 'CASE-separation', subjectId: 'subject', sourceId: 'source-a',
    observation: { kind: 'temperature', value: 21, unit: 'C' },
    observedAt: '2026-10-12T08:00:00Z', receivedAt: '2026-10-12T08:01:00Z', contentHash: hash('a'),
    custody: [{ eventId: `collected-${evidenceId}`, evidenceId, sequence: 1, action: 'collected', fromPartyId: null, toPartyId: 'collector', occurredAt: '2026-10-12T08:01:00Z', previousEventId: null }],
    ...overrides,
  }
}

function contradictoryRecord(): EvidenceRecord {
  return record('EV-b', {
    sourceId: 'source-b', contentHash: hash('b'),
    observation: { kind: 'temperature', value: 99, unit: 'C' },
  })
}

function escape(value: string): string {
  return value.replace(/[\\`*_{}\[\]<>()#!|]/g, '\\$&').replace(/[\r\n]/g, ' ')
}

function uncertaintySection(brief: string, title: string): string {
  const uncertainty = brief.split('## Uncertainty and findings\n')[1].split('\n## Confidence methodology')[0]
  return uncertainty.split(`### ${title}\n`)[1].split('\n### ')[0]
}

function recordSection(brief: string, id: string): string {
  return brief.split(`### ${id} —`)[1].split('\n### ')[0]
}

function contributionSection(section: string, title: string, code: FindingCode): string {
  return section.split(`#### ${title} · ${escape(code)}\n`)[1].split('\n#### ')[0]
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

describe('finding category separation', () => {
  it('exposes the fixed display order and explains duplicates versus independent contradictions', () => {
    expect(FINDING_CATEGORIES.map(({ code, title }) => ({ code, title }))).toEqual([
      { code: 'DUPLICATE_EVIDENCE', title: 'Duplicate records' },
      { code: 'CONFLICTING_OBSERVATIONS', title: 'Contradictory observations' },
      { code: 'CLOCK_SKEW', title: 'Clock skew' },
      { code: 'BROKEN_CHAIN_OF_CUSTODY', title: 'Custody gaps' },
    ])
    expect(FINDING_CATEGORIES[0].description).toMatch(/evidence IDs.*content hashes.*semantic matches/)
    expect(FINDING_CATEGORIES[0].description).toContain('not independent contradictions')
    expect(FINDING_CATEGORIES[0].description).toContain('both duplicate and contradiction categories')
    expect(FINDING_CATEGORIES[1].description).toContain('Distinct sources asserting different values')
  })

  it('keeps the fixture’s two duplicates and two original contradictions in separate exported groups', () => {
    const findings = validateEvidence(evidence, options).findings
    const groups = groupFindings(findings)
    expect(groups.map((group) => group.findings.length)).toEqual([2, 2, 2, 1])
    expect(groups[0].findings.map((item) => item.details?.duplicateType).sort()).toEqual(['contentHash', 'semantic'])
    expect(groups[1].findings.map((item) => item.evidenceIds)).toEqual([
      ['EV-1042', 'EV-1043'], ['EV-1043', 'EV-1044'],
    ])
    const brief = buildCaseBrief(evidence, findings)
    const positions = groups.map((group) => brief.indexOf(`### ${group.title}\n`))
    expect(positions).toEqual([...positions].sort((left, right) => left - right))
    for (const group of groups) {
      const section = uncertaintySection(brief, group.title)
      expect(section).toContain(`**Findings:** ${group.findings.length}`)
      expect(section).toContain(group.description)
      for (const item of findings) {
        const line = `- **${item.severity.toUpperCase()} · ${item.code}** (${item.evidenceIds.map(escape).join(', ')}): ${escape(item.message)}`
        if (item.code === group.code) expect(section).toContain(line)
        else expect(section).not.toContain(line)
      }
    }
  })

  it.each(['id', 'hash', 'semantic'] as const)('keeps a %s duplicate pair out of contradictions', (kind) => {
    const original = record('EV-a')
    const copy = kind === 'id'
      ? record('EV-a', {
        ...contradictoryRecord(), evidenceId: 'EV-a',
        custody: [{ ...original.custody[0], eventId: 'collected-reimport' }],
      })
      : kind === 'hash'
        ? record('EV-copy', { sourceId: 'source-copy', contentHash: hash('a').toUpperCase(), observation: { kind: 'temperature', value: 99, unit: 'C' } })
        : record('EV-copy', { contentHash: hash('c'), observedAt: '2026-10-12T10:00:00+02:00' })
    const records = [original, copy]
    const findings = validateEvidence(records, options).findings
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ code: 'DUPLICATE_EVIDENCE', details: { duplicateType: kind === 'id' ? 'evidenceId' : kind === 'hash' ? 'contentHash' : 'semantic' } })
    expect(detectConflictingObservations(records, options.conflict)).toEqual([])
    expect(groupFindings(findings).map((group) => group.findings.length)).toEqual([1, 0, 0, 0])
    const assessment = deriveConfidence(original, findings)
    expect(assessment.score).toBe(85)
    expect(assessment.contributions.map((item) => [item.code, item.penalty])).toEqual([
      ['HASH_DECLARATION', 0], ['DUPLICATE_EVIDENCE', -15],
    ])
    const brief = buildCaseBrief(records, findings)
    expect(uncertaintySection(brief, 'Contradictory observations')).toContain('**Findings:** 0')
    expect(uncertaintySection(brief, 'Duplicate records')).toContain('**Findings:** 1')
    expect(recordSection(brief, 'EV-a')).not.toContain('#### Contradictory observations')
  })

  it('exports contradiction-only records without assigning them to duplicates', () => {
    const original = record('EV-a')
    const records = [original, contradictoryRecord()]
    const findings = validateEvidence(records, options).findings
    expect(findings).toHaveLength(1)
    expect(findings[0].code).toBe('CONFLICTING_OBSERVATIONS')
    expect(groupFindings(findings).map((group) => group.findings.length)).toEqual([0, 1, 0, 0])
    expect(deriveConfidence(original, findings).contributions.map((item) => [item.code, item.penalty])).toEqual([
      ['HASH_DECLARATION', 0], ['CONFLICTING_OBSERVATIONS', -15],
    ])
    const brief = buildCaseBrief(records, findings)
    expect(uncertaintySection(brief, 'Duplicate records')).toContain('**Findings:** 0')
    expect(uncertaintySection(brief, 'Contradictory observations')).toContain('**Findings:** 1')
    const section = recordSection(brief, 'EV-a')
    expect(section).not.toContain('#### Duplicate records')
    const contradiction = contributionSection(section, 'Contradictory observations', 'CONFLICTING_OBSERVATIONS')
    expect(contradiction).toContain(FINDING_CATEGORIES[1].description)
    expect(contradiction).toContain('Support (EV-a, EV-b):')
    expect(contradiction).toContain('Observation EV-a from source source-a')
    expect(contradiction).toContain('Observation EV-b from source source-b')
  })

  it('deducts both categories independently and exports only each category’s own support IDs and facts', () => {
    const original = record('EV-a')
    const records = [original, contradictoryRecord(), record('EV-copy', { contentHash: hash('c') })]
    const findings = validateEvidence(records, options).findings
    expect(groupFindings(findings).map((group) => group.findings.length)).toEqual([1, 1, 0, 0])
    const assessment = deriveConfidence(original, findings)
    expect(assessment.score).toBe(70)
    expect(assessment.totalPenalty).toBe(30)
    expect(assessment.calculation).toBe('100 - 30 = 70')
    const duplicate = assessment.contributions.find((item) => item.code === 'DUPLICATE_EVIDENCE')!
    const contradiction = assessment.contributions.find((item) => item.code === 'CONFLICTING_OBSERVATIONS')!
    expect([duplicate.penalty, contradiction.penalty]).toEqual([-15, -15])
    expect(duplicate.supports.map((support) => support.evidenceIds)).toEqual([['EV-a', 'EV-copy']])
    expect(contradiction.supports.map((support) => support.evidenceIds)).toEqual([['EV-a', 'EV-b']])
    expect(duplicate.supports[0].facts).toContain('detail.duplicateType: semantic')
    expect(duplicate.supports[0].facts.some((fact) => fact.startsWith('Observation '))).toBe(false)
    expect(contradiction.supports[0].facts).toContain('detail.left.value: 21')
    expect(contradiction.supports[0].facts).toContain('detail.right.value: 99')
    expect(contradiction.supports[0].facts.some((fact) => fact.includes('duplicateType'))).toBe(false)

    const section = recordSection(buildCaseBrief(records, findings), 'EV-a')
    const duplicateSection = contributionSection(section, 'Duplicate records', 'DUPLICATE_EVIDENCE')
    const contradictionSection = contributionSection(section, 'Contradictory observations', 'CONFLICTING_OBSERVATIONS')
    for (const [contribution, exported, category] of [
      [duplicate, duplicateSection, FINDING_CATEGORIES[0]],
      [contradiction, contradictionSection, FINDING_CATEGORIES[1]],
    ] as const) {
      expect(exported).toContain(category.description)
      expect(exported).toContain(`${escape(contribution.code)} — ${escape(contribution.label)}: -15.`)
      for (const support of contribution.supports) {
        expect(exported).toContain(`Support (${support.evidenceIds.map(escape).join(', ')}): ${escape(support.message)}`)
        for (const fact of support.facts) expect(exported).toContain(escape(fact))
      }
    }
    expect(duplicateSection).not.toContain('Support (EV-a, EV-b):')
    expect(duplicateSection).not.toContain('detail.left.value')
    expect(contradictionSection).not.toContain('Support (EV-a, EV-copy):')
    expect(contradictionSection).not.toContain('detail.duplicateType')
  })

  it('retains original cross-source contradictions without multiplying conflicts on duplicate import', () => {
    const originals = evidence.filter((item) => !['EV-1046', 'EV-1047'].includes(item.evidenceId))
    const baseline = detectConflictingObservations(originals, options.conflict)
    expect(baseline).toHaveLength(2)
    expect(detectConflictingObservations(evidence, options.conflict)).toEqual(baseline)
    const repeated = [...evidence, ...evidence.map((item) => ({ ...item }))]
    expect(detectConflictingObservations(repeated, options.conflict)).toEqual(baseline)
    const findings = [...detectDuplicateEvidence(repeated), ...baseline]
    expect(groupFindings(findings)[1].findings).toEqual(baseline)
    expect(deriveConfidence(evidence[0], findings).contributions.filter((item) => item.code !== 'HASH_DECLARATION').map((item) => item.penalty)).toEqual([-15, -15])
  })

  it('groups and exports deterministically without mutating frozen records, findings, IDs, or details', () => {
    const records = deepFreeze([record('EV-a'), contradictoryRecord(), record('EV-copy', { contentHash: hash('c') })])
    const extra: ValidationFinding = {
      code: 'DUPLICATE_EVIDENCE', severity: 'warning', evidenceIds: ['EV-copy', 'EV-a'],
      message: 'same message', details: { nested: { count: 2, matches: ['raw-a', 'raw-b'] }, marker: 'z' },
    }
    const findings = deepFreeze([
      ...validateEvidence(records, options).findings, extra,
      { ...extra, details: { marker: 'a', nested: { matches: ['raw-a', 'raw-b'], count: 2 } } },
      { ...extra, severity: 'error' as const }, extra,
    ])
    const beforeRecords = JSON.stringify(records)
    const beforeFindings = JSON.stringify(findings)
    const groups = groupFindings(findings)
    expect(groupFindings([...findings].reverse())).toEqual(groups)
    expect(groups.flatMap((group) => group.findings)).toHaveLength(findings.length)
    for (const group of groups) {
      const { findings: grouped, ...category } = group
      expect(category).toEqual(FINDING_CATEGORIES.find((item) => item.code === group.code))
      expect(grouped.every((item) => item.code === group.code && findings.includes(item))).toBe(true)
    }
    const brief = buildCaseBrief(records, findings)
    const reordered = [...findings].reverse().map((item) => ({
      ...item, evidenceIds: [...item.evidenceIds].reverse(),
      ...(item.details ? { details: Object.fromEntries(Object.entries(item.details).reverse()) } : {}),
    }))
    expect(buildCaseBrief([...records].reverse(), reordered)).toBe(brief)
    expect(JSON.stringify(records)).toBe(beforeRecords)
    expect(JSON.stringify(findings)).toBe(beforeFindings)
    expect(groupFindings([]).every((group) => group.findings.length === 0)).toBe(true)
  })

  it('includes all empty groups and preserves the literal no-findings export for empty or clean bundles', () => {
    expect(groupFindings([])).toEqual(FINDING_CATEGORIES.map((category) => ({ ...category, findings: [] })))
    for (const records of [[], [record('EV-clean')]]) {
      const brief = buildCaseBrief(records, [])
      expect(brief).toContain('No validation findings.')
      for (const category of FINDING_CATEGORIES) {
        const section = uncertaintySection(brief, category.title)
        expect(section).toContain('**Findings:** 0')
        expect(section).toContain(category.description)
        expect(section).toContain('No findings in this category.')
      }
      expect(brief).toContain('## Confidence methodology')
      expect(brief).toContain('## Evidence register')
    }
    expect(buildCaseBrief([], [])).toContain('No evidence records supplied.')
  })
})
