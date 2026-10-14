import { EVIDENCE_DESK_SCOPE } from '../scope'

export type ObservationValue = string | number | boolean | null

export interface Observation {
  kind: string
  value: ObservationValue
  unit?: string
}

export interface CustodyEvent {
  eventId: string
  evidenceId: string
  sequence: number
  action: 'collected' | 'transferred' | 'received' | 'stored' | 'released'
  fromPartyId: string | null
  toPartyId: string
  occurredAt: string
  previousEventId: string | null
}

export interface EvidenceRecord {
  evidenceId: string
  caseId: string
  subjectId: string
  sourceId: string
  observation: Observation
  observedAt: string
  receivedAt: string
  contentHash?: string
  custody: readonly CustodyEvent[]
}

export type FindingCode =
  | 'DUPLICATE_EVIDENCE'
  | 'CLOCK_SKEW'
  | 'BROKEN_CHAIN_OF_CUSTODY'
  | 'CONFLICTING_OBSERVATIONS'

export interface ValidationFinding {
  code: FindingCode
  severity: 'error' | 'warning'
  evidenceIds: readonly string[]
  message: string
  details?: Readonly<Record<string, unknown>>
}

export interface FindingCategory {
  readonly code: FindingCode
  readonly title: string
  readonly description: string
}

export const FINDING_CATEGORIES: readonly FindingCategory[] = [
  {
    code: 'DUPLICATE_EVIDENCE',
    title: 'Duplicate records',
    description: 'Repeated evidence IDs, matching declared content hashes, or semantic matches identify repeated records. Duplicates are not independent contradictions. A record may belong to both duplicate and contradiction categories when each has separate supporting findings.',
  },
  {
    code: 'CONFLICTING_OBSERVATIONS',
    title: 'Contradictory observations',
    description: 'Distinct sources asserting different values for the same case, subject, observation kind and unit within the comparison window are contradictory observations. Duplicate records are not independent contradictions; a record may also have separate duplicate findings. Neither account is selected as true.',
  },
  {
    code: 'CLOCK_SKEW',
    title: 'Clock skew',
    description: 'Invalid timestamps, observations ahead of receipt, or source clocks moving backward require review of the timing and ordering of records.',
  },
  {
    code: 'BROKEN_CHAIN_OF_CUSTODY',
    title: 'Custody gaps',
    description: 'Missing collection events, incomplete handoffs, broken links, or invalid custody chronology leave gaps in the recorded chain of custody.',
  },
]

export interface FindingGroup extends FindingCategory {
  readonly findings: readonly ValidationFinding[]
}

/** Returns every category in display order, retaining each finding only under its own code. */
export function groupFindings(findings: readonly ValidationFinding[]): readonly FindingGroup[] {
  return FINDING_CATEGORIES.map((category) => ({
    ...category,
    findings: findings.filter((item) => item.code === category.code)
      .sort((left, right) => {
        const key = (item: ValidationFinding) => stableKey([sortedIds(item.evidenceIds), item.message, item.severity, item.details ?? null])
        return key(left).localeCompare(key(right)) || stableKey(left).localeCompare(stableKey(right))
      }),
  }))
}

export interface ValidationReport {
  valid: boolean
  findings: readonly ValidationFinding[]
}

export interface ClockSkewOptions {
  maxFutureSkewMs: number
  maxObservedRegressionMs: number
}

export interface ConflictOptions {
  windowMs: number
  equivalent?: (left: Observation, right: Observation) => boolean
}

export interface EvidenceValidationOptions {
  clockSkew: ClockSkewOptions
  conflict: ConflictOptions
  duplicateFingerprint?: (record: EvidenceRecord) => string
}

export interface ConfidenceAssessment {
  evidenceId: string
  score: number
  level: 'high' | 'medium' | 'low'
  reasons: readonly string[]
  explanation: string
  baseScore: number
  totalPenalty: number
  calculation: string
  contributions: readonly ConfidenceContribution[]
}

export interface ConfidenceSupport {
  message: string
  evidenceIds: readonly string[]
  facts: readonly string[]
}

export interface ConfidenceContribution {
  code: FindingCode | 'HASH_DECLARATION'
  label: string
  penalty: number
  supports: readonly ConfidenceSupport[]
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/
const SHA256 = /^sha256:[a-f0-9]{64}$/i

function timestamp(value: string): number | null {
  if (!ISO_TIMESTAMP.test(value)) return null
  const year = Number(value.slice(0, 4))
  const month = Number(value.slice(5, 7))
  const day = Number(value.slice(8, 10))
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]
    || Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59
    || Number(value.slice(17, 19)) > 59) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function nonnegativeOption(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be finite and nonnegative.`)
}

function minutes(value: number): number {
  return Math.max(1, Math.round(Math.abs(value) / 60000))
}

export function isFiniteIsoTimestamp(value: string): boolean {
  return timestamp(value) !== null
}

export function isSha256Hash(value: string): boolean {
  return SHA256.test(value)
}

export function fingerprintEvidence(record: EvidenceRecord): string {
  return JSON.stringify({
    caseId: record.caseId,
    subjectId: record.subjectId,
    sourceId: record.sourceId,
    observation: { kind: record.observation.kind, value: record.observation.value, unit: record.observation.unit },
    observedAt: timestamp(record.observedAt) ?? record.observedAt,
  })
}

function finding(
  code: FindingCode,
  severity: ValidationFinding['severity'],
  evidenceIds: readonly string[],
  message: string,
  details?: Readonly<Record<string, unknown>>,
): ValidationFinding {
  return { code, severity, evidenceIds: sortedIds(evidenceIds), message, ...(details ? { details } : {}) }
}

function sortedIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right))
}

export function detectDuplicateEvidence(
  records: readonly EvidenceRecord[],
  fingerprint: (record: EvidenceRecord) => string = fingerprintEvidence,
): readonly ValidationFinding[] {
  const findings: ValidationFinding[] = []
  const byId = new Map<string, string[]>()
  const byHash = new Map<string, string[]>()
  const byFingerprint = new Map<string, string[]>()

  for (const record of records) {
    byId.set(record.evidenceId, [...(byId.get(record.evidenceId) ?? []), record.evidenceId])
    if (record.contentHash) {
      byHash.set(record.contentHash.toLowerCase(), [...(byHash.get(record.contentHash.toLowerCase()) ?? []), record.evidenceId])
    }
    const key = fingerprint(record)
    byFingerprint.set(key, [...(byFingerprint.get(key) ?? []), record.evidenceId])
  }

  for (const ids of byId.values()) {
    if (ids.length > 1) {
      findings.push(finding(
        'DUPLICATE_EVIDENCE',
        'error',
        [...new Set(ids)],
        `Evidence ID ${ids[0]} appears more than once in the case bundle.`,
        { duplicateType: 'evidenceId', duplicateKind: 'id', evidenceId: ids[0], count: ids.length, repeatedIdCount: ids.length },
      ))
    }
  }

  for (const [hash, ids] of byHash) {
    if (ids.length > 1) {
      findings.push(finding(
        'DUPLICATE_EVIDENCE',
        'warning',
        [...new Set(ids)],
        `Content hash ${hash} is attached to more than one evidence record.`,
        { duplicateType: 'contentHash', duplicateKind: 'hash', contentHash: hash, count: ids.length },
      ))
    }
  }

  for (const [fingerprint, ids] of byFingerprint) {
    if (ids.length > 1 && new Set(ids).size > 1) {
      findings.push(finding(
        'DUPLICATE_EVIDENCE',
        'warning',
        [...new Set(ids)],
        'Records share the same semantic fingerprint but have different IDs.',
        { duplicateType: 'semantic', duplicateKind: 'fingerprint', fingerprint, count: ids.length },
      ))
    }
  }

  return findings
}

export function detectClockSkew(
  records: readonly EvidenceRecord[],
  options: ClockSkewOptions,
): readonly ValidationFinding[] {
  nonnegativeOption(options.maxFutureSkewMs, 'maxFutureSkewMs')
  nonnegativeOption(options.maxObservedRegressionMs, 'maxObservedRegressionMs')
  const findings: ValidationFinding[] = []
  const grouped = new Map<string, EvidenceRecord[]>()

  for (const record of records) {
    const observed = timestamp(record.observedAt)
    const received = timestamp(record.receivedAt)
    if (observed === null || received === null) {
      findings.push(finding(
        'CLOCK_SKEW',
        'error',
        [record.evidenceId],
        'Observation and receipt timestamps must be finite ISO-8601 instants.',
        { reason: 'invalid-timestamp', observedAt: record.observedAt, receivedAt: record.receivedAt },
      ))
    } else if (observed - received > options.maxFutureSkewMs) {
      findings.push(finding(
        'CLOCK_SKEW',
        'error',
        [record.evidenceId],
        `Observation time is ${minutes(observed - received)}m ahead of receipt time.`,
        { reason: 'observation-after-receipt', observedAt: record.observedAt, receivedAt: record.receivedAt },
      ))
    }
    const context = JSON.stringify([record.caseId, record.sourceId])
    grouped.set(context, [...(grouped.get(context) ?? []), record])
  }

  for (const recordsForSource of grouped.values()) {
    const ordered = [...recordsForSource]
      .filter((record) => timestamp(record.receivedAt) !== null && timestamp(record.observedAt) !== null)
      .sort((a, b) => timestamp(a.receivedAt)! - timestamp(b.receivedAt)! || a.evidenceId.localeCompare(b.evidenceId))
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1]
      const current = ordered[index]
      const regression = timestamp(previous.observedAt)! - timestamp(current.observedAt)!
      if (timestamp(current.receivedAt)! > timestamp(previous.receivedAt)! && regression > options.maxObservedRegressionMs) {
        findings.push(finding(
          'CLOCK_SKEW',
          'warning',
          [previous.evidenceId, current.evidenceId],
          `Source ${current.sourceId} moves backward by ${minutes(regression)}m between observations.`,
          {
            reason: 'observed-time-regression',
            sourceId: current.sourceId,
            previousEvidenceId: previous.evidenceId,
            currentEvidenceId: current.evidenceId,
            previousObservedAt: previous.observedAt,
            currentObservedAt: current.observedAt,
            previousReceivedAt: previous.receivedAt,
            currentReceivedAt: current.receivedAt,
          },
        ))
      }
    }
  }
  return findings
}

export function validateChainOfCustody(records: readonly EvidenceRecord[]): readonly ValidationFinding[] {
  const findings: ValidationFinding[] = []
  const eventCounts = new Map<string, number>()
  for (const record of records) {
    for (const event of record.custody) eventCounts.set(event.eventId, (eventCounts.get(event.eventId) ?? 0) + 1)
  }

  for (const record of records) {
    const custody = [...record.custody].sort((a, b) => a.sequence - b.sequence || a.eventId.localeCompare(b.eventId))
    let reason: string | undefined
    const failedEvents: Array<Record<string, unknown>> = []
    for (let index = 0; index < custody.length; index += 1) {
      const event = custody[index]
      const previous = custody[index - 1]
      const eventTime = timestamp(event.occurredAt)
      const previousTime = previous ? timestamp(previous.occurredAt) : null
      const expectedPreviousEventId = index === 0 ? null : previous.eventId
      const expectedFromPartyId = index === 0 ? null : previous.toPartyId
      const checks = [
        { check: 'evidenceId', expected: record.evidenceId, actual: event.evidenceId, violated: event.evidenceId !== record.evidenceId },
        { check: 'eventId', expected: 'non-empty', actual: event.eventId, violated: event.eventId.trim().length === 0 },
        { check: 'toPartyId', expected: 'non-empty', actual: event.toPartyId, violated: event.toPartyId.trim().length === 0 },
        { check: 'sequence', expected: index + 1, actual: event.sequence, violated: event.sequence !== index + 1 },
        { check: 'action', expected: index === 0 ? 'collected' : 'not collected', actual: event.action, violated: index === 0 ? event.action !== 'collected' : event.action === 'collected' },
        { check: 'previousEventId', expected: expectedPreviousEventId, actual: event.previousEventId, violated: event.previousEventId !== expectedPreviousEventId },
        { check: 'holder', expected: expectedFromPartyId, actual: event.fromPartyId, violated: event.fromPartyId !== expectedFromPartyId },
        { check: 'occurredAt', expected: previousTime === null ? 'finite ISO timestamp' : `finite ISO timestamp at or after ${previous.occurredAt}`, actual: event.occurredAt, violated: eventTime === null || (previousTime !== null && eventTime < previousTime) },
        { check: 'eventIdCount', expected: 1, actual: eventCounts.get(event.eventId) ?? 0, violated: eventCounts.get(event.eventId) !== 1 },
      ]
      const valid = checks.every((check) => !check.violated)
      if (!valid && reason === undefined) {
        reason = eventTime === null || (previousTime !== null && eventTime < previousTime)
          ? 'custody-chronology'
          : index === 0 && event.action !== 'collected'
            ? 'first-event-not-collected'
            : 'broken-link'
      }
      if (!valid) failedEvents.push({
        eventId: event.eventId,
        sequence: event.sequence,
        occurredAt: event.occurredAt,
        previousOccurredAt: previous?.occurredAt ?? null,
        expectedSequence: index + 1,
        actualSequence: event.sequence,
        expectedPreviousEventId,
        actualPreviousEventId: event.previousEventId,
        expectedHolder: expectedFromPartyId,
        actualHolder: event.fromPartyId,
        checks: checks.filter((check) => check.violated).map(({ check, expected, actual }) => ({ check, expected, actual })),
      })
    }
    if (reason || custody.length === 0) {
      findings.push(finding(
        'BROKEN_CHAIN_OF_CUSTODY',
        'error',
        [record.evidenceId],
        reason === 'first-event-not-collected'
          ? 'The first custody event must be a collection from no prior holder.'
          : reason === 'custody-chronology'
            ? 'Custody events must use finite ISO timestamps in chronological order.'
            : 'Custody handoff is incomplete or cannot be linked to the prior holder.',
        {
          reason: reason ?? 'empty-chain',
          eventCount: custody.length,
          failedEvents,
          timestamps: custody.map((event) => event.occurredAt),
        },
      ))
    }
  }
  return findings
}

const defaultEquivalent = (left: Observation, right: Observation) => (
  left.kind === right.kind && left.unit === right.unit && left.value === right.value
)

export function detectConflictingObservations(
  records: readonly EvidenceRecord[],
  options: ConflictOptions,
): readonly ValidationFinding[] {
  nonnegativeOption(options.windowMs, 'windowMs')
  const findings: ValidationFinding[] = []
  const equivalent = options.equivalent ?? defaultEquivalent
  // Duplicate imports are not independent corroboration or extra conflicts.
  const seenFingerprints = new Set<string>()
  const seenHashes = new Set<string>()
  const unique = [...records].sort((a, b) => a.evidenceId.localeCompare(b.evidenceId)).filter((record) => {
    const fingerprint = fingerprintEvidence(record)
    const hashKey = record.contentHash && isSha256Hash(record.contentHash)
      ? JSON.stringify([record.caseId, record.subjectId, record.observation.kind, record.observation.unit, record.contentHash.toLowerCase()])
      : undefined
    const duplicate = seenFingerprints.has(fingerprint) || (hashKey !== undefined && seenHashes.has(hashKey))
    seenFingerprints.add(fingerprint)
    if (hashKey) seenHashes.add(hashKey)
    return !duplicate
  })
  for (let leftIndex = 0; leftIndex < unique.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < unique.length; rightIndex += 1) {
      const left = unique[leftIndex]
      const right = unique[rightIndex]
      const leftTime = timestamp(left.observedAt)
      const rightTime = timestamp(right.observedAt)
      const sameContext = left.caseId === right.caseId
        && left.evidenceId !== right.evidenceId
        && left.subjectId === right.subjectId
        && left.sourceId !== right.sourceId
        && left.observation.kind === right.observation.kind
        && left.observation.unit === right.observation.unit
        && left.observation.value !== null
        && right.observation.value !== null
        && !(left.contentHash && right.contentHash && left.contentHash.toLowerCase() === right.contentHash.toLowerCase())
        && leftTime !== null
        && rightTime !== null
        && Math.abs(leftTime - rightTime) <= options.windowMs
      if (sameContext && !equivalent(left.observation, right.observation)) {
        findings.push(finding(
          'CONFLICTING_OBSERVATIONS',
          'warning',
          [left.evidenceId, right.evidenceId],
          `Observations disagree on ${left.observation.kind} within the same time window.`,
          {
            caseId: left.caseId,
            subjectId: left.subjectId,
            sources: [left.sourceId, right.sourceId],
            left: {
              evidenceId: left.evidenceId,
              sourceId: left.sourceId,
              observedAt: left.observedAt,
              kind: left.observation.kind,
              value: left.observation.value,
              unit: left.observation.unit,
            },
            right: {
              evidenceId: right.evidenceId,
              sourceId: right.sourceId,
              observedAt: right.observedAt,
              kind: right.observation.kind,
              value: right.observation.value,
              unit: right.observation.unit,
            },
            conflictWindowMs: options.windowMs,
            observedDifferenceMs: Math.abs(leftTime - rightTime),
          },
        ))
      }
    }
  }
  return findings
}

export function validateEvidence(
  records: readonly EvidenceRecord[],
  options: EvidenceValidationOptions,
): ValidationReport {
  const findings = [
    ...detectDuplicateEvidence(records, options.duplicateFingerprint),
    ...detectClockSkew(records, options.clockSkew),
    ...validateChainOfCustody(records),
    ...detectConflictingObservations(records, options.conflict),
  ].sort((left, right) => `${left.code}-${left.evidenceIds.join(',')}-${left.message}`.localeCompare(`${right.code}-${right.evidenceIds.join(',')}-${right.message}`))
  return { valid: findings.every((item) => item.severity !== 'error'), findings }
}

const confidencePenalty: Record<FindingCode, number> = {
  DUPLICATE_EVIDENCE: 15,
  CLOCK_SKEW: 20,
  BROKEN_CHAIN_OF_CUSTODY: 30,
  CONFLICTING_OBSERVATIONS: 15,
}

const confidenceLabels: Record<FindingCode, string> = {
  DUPLICATE_EVIDENCE: 'Duplicate evidence category',
  CLOCK_SKEW: 'Clock skew category',
  BROKEN_CHAIN_OF_CUSTODY: 'Broken chain of custody category',
  CONFLICTING_OBSERVATIONS: 'Conflicting observations category',
}

function factValue(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `[${value.map(factValue).join(', ')}]`
  if (typeof value === 'object') return stableKey(value)
  return String(value)
}

function stableKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableKey((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

function detailFacts(value: unknown, path = 'detail'): string[] {
  if (Array.isArray(value)) return value.length === 0 ? [`${path}: []`] : value.flatMap((child, index) => detailFacts(child, `${path}[${index}]`))
  if (value === null || typeof value !== 'object') return [`${path}: ${factValue(value)}`]
  return Object.keys(value as Record<string, unknown>).sort().flatMap((key) => {
    const child = (value as Record<string, unknown>)[key]
    return detailFacts(child, `${path}.${key}`)
  })
}

function custodyFacts(record: EvidenceRecord): string[] {
  return [...record.custody]
    .sort((left, right) => left.sequence - right.sequence || left.eventId.localeCompare(right.eventId) || stableKey(left).localeCompare(stableKey(right)))
    .map((event) => `custody event ${event.eventId}: sequence ${event.sequence}; action ${event.action}; from ${event.fromPartyId ?? 'null'}; to ${event.toPartyId}; occurredAt ${event.occurredAt}; previousEventId ${event.previousEventId ?? 'null'}; evidenceId ${event.evidenceId}`)
}

function findingFacts(record: EvidenceRecord, item: ValidationFinding): string[] {
  const facts = item.details && Object.keys(item.details).length > 0 ? detailFacts(item.details) : ['details unavailable']
  facts.push(`Finding evidence IDs: ${sortedIds(item.evidenceIds).join(', ')}.`)
  if (item.code === 'CONFLICTING_OBSERVATIONS') {
    for (const side of ['left', 'right']) {
      const raw = item.details?.[side]
      if (raw && typeof raw === 'object') {
        const observation = raw as Record<string, unknown>
        if (['evidenceId', 'sourceId', 'observedAt', 'kind', 'value'].every((key) => key in observation)) {
          facts.push(`Observation ${factValue(observation.evidenceId)} from source ${factValue(observation.sourceId)} at ${factValue(observation.observedAt)}: ${factValue(observation.kind)} = ${factValue(observation.value)}; unit ${observation.unit === undefined ? 'not supplied' : factValue(observation.unit)}.`)
        }
      }
    }
  }
  if (item.code === 'BROKEN_CHAIN_OF_CUSTODY') {
    facts.push(...custodyFacts(record))
    if (record.custody.length === 0) facts.push(`Record ${record.evidenceId}: no custody events recorded.`)
    const failedEvents = item.details?.failedEvents
    if (Array.isArray(failedEvents)) for (const event of failedEvents) {
      if (event && Array.isArray(event.checks)) for (const check of event.checks) {
        if (check && typeof check === 'object' && 'eventId' in event && 'occurredAt' in event && ['check', 'expected', 'actual'].every((key) => key in check)) {
          facts.push(`Custody event ${factValue(event.eventId)} at ${factValue(event.occurredAt)}: ${factValue(check.check)} expected ${factValue(check.expected)}; actual ${factValue(check.actual)}.`)
        }
      }
    }
  }
  return facts.sort((left, right) => left.localeCompare(right))
}

function supportFor(record: EvidenceRecord, item: ValidationFinding): ConfidenceSupport {
  return {
    message: item.message,
    evidenceIds: sortedIds(item.evidenceIds),
    facts: findingFacts(record, item),
  }
}

export function deriveConfidence(
  record: EvidenceRecord,
  findings: readonly ValidationFinding[],
): ConfidenceAssessment {
  const relevant = findings
    .filter((item) => item.evidenceIds.includes(record.evidenceId))
    .sort((left, right) => `${left.code}-${left.message}-${sortedIds(left.evidenceIds).join(',')}-${stableKey(left.details ?? null)}`.localeCompare(`${right.code}-${right.message}-${sortedIds(right.evidenceIds).join(',')}-${stableKey(right.details ?? null)}`))
  const hashValid = record.contentHash !== undefined && isSha256Hash(record.contentHash)
  const hashContribution: ConfidenceContribution = {
    code: 'HASH_DECLARATION',
    label: hashValid ? 'Full SHA-256 digest declared' : 'Full SHA-256 digest missing or malformed',
    penalty: hashValid ? 0 : -10,
    supports: [{
      message: hashValid ? 'The record declares a full SHA-256 digest.' : 'The record does not declare a valid full SHA-256 digest.',
      evidenceIds: [record.evidenceId],
      facts: [`evidenceId: ${record.evidenceId}`, `contentHash: ${record.contentHash ?? 'unavailable'}`, `sha256DeclarationValid: ${hashValid}`],
    }],
  }
  const codes = [...new Set(relevant.map((item) => item.code))].sort((left, right) => left.localeCompare(right))
  const contributions: ConfidenceContribution[] = [hashContribution]
  for (const code of codes) {
    const penalty = confidencePenalty[code]
    if (penalty === undefined) continue
    contributions.push({
      code,
      label: confidenceLabels[code],
      penalty: -penalty,
      supports: relevant.filter((item) => item.code === code).map((item) => supportFor(record, item)),
    })
  }
  const totalPenalty = contributions.reduce((total, contribution) => total - contribution.penalty, 0)
  const score = Math.max(0, Math.min(100, 100 - totalPenalty))
  const level = score >= 80 ? 'high' : score >= 60 ? 'medium' : 'low'
  const reasons = [...new Set(relevant.map((item) => `${item.code}: ${item.message}`))]
  if (!hashValid) reasons.push('A full SHA-256 digest is missing or malformed (-10).')
  if (reasons.length === 0) reasons.push('No integrity findings are attached to this record; a full SHA-256 digest is declared.')
  const calculation = `${100} - ${totalPenalty} = ${score}`
  return {
    evidenceId: record.evidenceId,
    score,
    level,
    reasons,
    explanation: `${score}% (${level}) integrity heuristic — ${reasons.join(' ')}`,
    baseScore: 100,
    totalPenalty,
    calculation,
    contributions,
  }
}

export interface ConfidenceSummary {
  score: number | null
  calculation: string
  assessments: readonly ConfidenceAssessment[]
}

export function summarizeConfidence(
  records: readonly EvidenceRecord[],
  findings: readonly ValidationFinding[],
): ConfidenceSummary {
  const assessments = records.map((record) => deriveConfidence(record, findings))
    .sort((left, right) => left.evidenceId.localeCompare(right.evidenceId) || stableKey(left).localeCompare(stableKey(right)))
  if (assessments.length === 0) return { score: null, calculation: 'No records supplied; no mean calculated.', assessments }
  const score = Math.round(assessments.reduce((total, assessment) => total + assessment.score, 0) / assessments.length)
  return {
    score,
    calculation: `round((${assessments.map((assessment) => assessment.score).join(' + ')}) / ${assessments.length}) = ${score}`,
    assessments,
  }
}

function markdown(value: unknown): string {
  return String(value).replace(/[\\`*_{}\[\]<>()#!|]/g, '\\$&').replace(/[\r\n]/g, ' ')
}

function confidenceBreakdown(assessment: ConfidenceAssessment): string[] {
  const contributionLines = (contribution: ConfidenceContribution): string[] => [
    `  - ${markdown(contribution.code)} — ${markdown(contribution.label)}: ${contribution.penalty}.`,
    ...contribution.supports.flatMap((support) => [
      `    - Support (${support.evidenceIds.map(markdown).join(', ')}): ${markdown(support.message)}`,
      ...support.facts.map((fact) => `      - ${markdown(fact)}`),
    ]),
  ]
  return [
    `- Confidence arithmetic: ${markdown(assessment.calculation)}; base score ${assessment.baseScore}; total penalty ${assessment.totalPenalty}.`,
    '- Confidence contributions:',
    ...assessment.contributions.filter((contribution) => contribution.code === 'HASH_DECLARATION').flatMap(contributionLines),
    ...FINDING_CATEGORIES.flatMap((category) => {
      const contribution = assessment.contributions.find((item) => item.code === category.code)
      return contribution ? [
        '',
        `#### ${markdown(category.title)} · ${markdown(category.code)}`,
        '',
        category.description,
        '',
        ...contributionLines(contribution),
      ] : []
    }),
  ]
}

export function buildCaseBrief(
  records: readonly EvidenceRecord[],
  findings: readonly ValidationFinding[],
): string {
  const orderedRecords = [...records].sort((left, right) => left.evidenceId.localeCompare(right.evidenceId) || stableKey(left).localeCompare(stableKey(right)))
  const findingGroups = groupFindings(findings)
  const orderedFindings = findingGroups.flatMap((group) => group.findings)
  const summary = summarizeConfidence(records, findings)
  const lines = [
    '# Synthetic Evidence Case Brief',
    '',
    '> Synthetic fixture data for defensive review only. No real people, systems, targets, or external actions are represented.',
    '',
    `**Records:** ${orderedRecords.length}  `,
    `**Findings:** ${orderedFindings.length}  `,
    `**Integrity status:** ${orderedFindings.some((item) => item.severity === 'error') ? 'Review required' : 'No blocking errors'}`,
    '',
    '## Scope and safe-use boundary',
    '',
    `**${EVIDENCE_DESK_SCOPE.badge} · ${EVIDENCE_DESK_SCOPE.short}**`,
    '',
    EVIDENCE_DESK_SCOPE.label,
    '',
    EVIDENCE_DESK_SCOPE.description,
    '',
    ...EVIDENCE_DESK_SCOPE.brief,
    '',
    '## Uncertainty and findings',
    '',
    'Confidence is a deterministic integrity heuristic, not a probability of truth or proof of authenticity. Hashes are declared digests; this pure export does not read or verify file bytes. Clock skew, custody gaps, duplicates, and conflicting accounts require review; no conflicting account is selected as true.',
    '',
    ...(orderedFindings.length === 0 ? ['No validation findings.', ''] : []),
    ...findingGroups.flatMap((group) => [
      `### ${group.title}`,
      '',
      `**Findings:** ${group.findings.length}`,
      '',
      group.description,
      '',
      ...(group.findings.length === 0
        ? ['No findings in this category.']
        : group.findings.map((item) => `- **${item.severity.toUpperCase()} · ${item.code}** (${sortedIds(item.evidenceIds).map(markdown).join(', ')}): ${markdown(item.message)}`)),
      '',
    ]),
    '',
    '## Confidence methodology',
    '',
    'Each record starts at 100. Finding categories deduct once per record, regardless of the number or severity of supports. All supplied supports remain visible. Scores are clamped to 0–100.',
    '',
    '| Contribution | Score adjustment |',
    '| --- | ---: |',
    '| HASH_DECLARATION (full SHA-256 declared) | 0 |',
    '| HASH_DECLARATION (missing or malformed) | -10 |',
    ...Object.keys(confidencePenalty).sort().map((code) => `| ${code} | -${confidencePenalty[code as FindingCode]} |`),
    '',
    'Level thresholds: high ≥80; medium ≥60 and <80; low <60.',
    'The overall score is the arithmetic mean of all supplied record scores, rounded once to the nearest integer. Duplicate records and repeated evidence IDs are retained as separate inputs; this is not independent corroboration.',
    '',
    `**Overall confidence:** ${summary.score === null ? 'unavailable (no records)' : `${summary.score}%`}`,
    `- Overall arithmetic: ${markdown(summary.calculation)}`,
    '- Mean inputs (one entry per supplied record):',
    ...summary.assessments.map((assessment) => `  - ${markdown(assessment.evidenceId)}: ${assessment.score}%`),
    '',
    '## Evidence register',
    '',
    ...(orderedRecords.length === 0 ? ['No evidence records supplied.', ''] : []),
    ...orderedRecords.flatMap((record) => {
      const confidence = deriveConfidence(record, findings)
      const custody = [...record.custody].sort((left, right) => left.sequence - right.sequence || left.eventId.localeCompare(right.eventId) || stableKey(left).localeCompare(stableKey(right)))
      return [
        `### ${markdown(record.evidenceId)} — ${markdown(record.subjectId)}`,
        `- Case: ${markdown(record.caseId)}; source: ${markdown(record.sourceId)}`,
        `- Observation: ${markdown(record.observation.kind)} = ${markdown(record.observation.value)}${record.observation.unit ? ` ${markdown(record.observation.unit)}` : ''}`,
        `- Observed: ${markdown(record.observedAt)}; received: ${markdown(record.receivedAt)}`,
        `- SHA-256: ${markdown(record.contentHash ?? 'unavailable')}`,
        `- Confidence: ${markdown(confidence.explanation)}`,
        ...confidenceBreakdown(confidence),
        '- Custody:',
        ...(custody.length === 0
          ? ['  - No custody events recorded.']
          : custody.map((event) => `  - #${event.sequence} ${markdown(event.action)} ${markdown(event.fromPartyId ?? 'collection')} → ${markdown(event.toPartyId)} at ${markdown(event.occurredAt)}; event ${markdown(event.eventId)}; evidence ${markdown(event.evidenceId)}; previous ${markdown(event.previousEventId ?? 'none')}`)),
        '',
      ]
    }),
  ]
  return `${lines.join('\n').trimEnd()}\n`
}
