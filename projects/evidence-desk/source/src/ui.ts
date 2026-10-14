import { caseMeta, evidence, evidenceCatalog, entities, timeline, type TimelineItem } from './data/case'
import { buildCaseBrief, deriveConfidence, FINDING_CATEGORIES, groupFindings, summarizeConfidence, type EvidenceRecord, type ValidationFinding } from './domain/evidence'

export const findingCopy = {
  CONFLICTING_OBSERVATIONS: { label: 'Contradictory observations', tone: 'orange', explanation: 'Distinct sources record different values in the same comparison window. Duplicate imports are excluded from this category, not counted as extra contradictory observations. Retain both accounts without choosing one as true. In this synthetic case, the witness recalls a green indicator while telemetry records an offline relay; an indicator may not establish connectivity, but that explanation is unproven.' },
  DUPLICATE_EVIDENCE: { label: 'Duplicate records', tone: 'purple', explanation: 'Repeated IDs, matching declared hashes or matching semantic fingerprints indicate repeated records, not contradictory observations. Preserve the import trail without treating it as independent corroboration. A matching hash identifies matching declared file bytes, not authenticity; verify the bundled files separately. An original record may also have a separate contradiction with another source.' },
  CLOCK_SKEW: { label: 'Clock skew', tone: 'yellow', explanation: 'The recorded observation time is ahead of receipt, or the source clock regresses as later records arrive. Clock drift and delayed batching are possible, unproven explanations. Preserve raw timestamps; no correction has been applied. Compare receipt order separately before relying on event order.' },
  BROKEN_CHAIN_OF_CUSTODY: { label: 'Custody gap', tone: 'red', explanation: 'The custody record jumps from sequence 1 to sequence 3. A required handoff is undocumented; the holder history cannot be established from this bundle. The file is retained, but a declared digest cannot repair missing custody. Do not infer the absent transfer.' },
} as const

export function recordConfidence(record: EvidenceRecord, findings: readonly ValidationFinding[]) {
  return deriveConfidence(record, findings)
}

export function entityRecords(name: string): EvidenceRecord[] {
  return evidence.filter((record) => {
    if (name === 'M. Alvarez') return record.sourceId === 'witness-alvarez'
    return record.subjectId === name || record.sourceId === name || record.custody.some((event) => event.toPartyId === name || event.fromPartyId === name)
  })
}

export const linkedEntities = entities.map((entity) => ({ ...entity, links: entityRecords(entity.name).length }))

export function timelineReview(item: TimelineItem, findings: readonly ValidationFinding[]) {
  const category = FINDING_CATEGORIES.find((category) => category.code === item.findingCode)
  const linkedFindings = category
    ? groupFindings(findings).find((group) => group.code === category.code)!.findings.filter((finding) => item.evidenceId !== undefined && finding.evidenceIds.includes(item.evidenceId))
    : []
  return { category, linkedFindings }
}

export function confidenceSources(findings: readonly ValidationFinding[]) {
  return [
    { label: 'Event logs', kind: 'event-log', color: 'blue' },
    { label: 'Custody documents', kind: 'transfer', color: 'green' },
    { label: 'Witness notes', kind: 'witness-note', color: 'amber' },
    { label: 'Observations', kind: 'observation', color: 'violet' },
  ].map((source) => {
    const records = evidence.filter((record) => evidenceCatalog[record.evidenceId].kind === source.kind)
    const summary = summarizeConfidence(records, findings)
    return { ...source, value: summary.score, count: records.length, summary }
  })
}

export function buildDeskBrief(findings: readonly ValidationFinding[]): string {
  const groups = confidenceSources(findings)
  const lines = ['## Confidence by file type', '', 'Grouped arithmetic means of record integrity scores; not corroboration or probabilities of truth. Retained duplicate imports remain inputs.', '']
  for (const group of groups) {
    lines.push(`### ${group.label}`, `- Confidence: ${group.value === null ? 'unavailable' : `${group.value}%`}`, `- Arithmetic: ${group.summary.calculation}`, '- Supporting record scores:')
    for (const assessment of group.summary.assessments) lines.push(`  - ${assessment.evidenceId}: ${assessment.score}% (${assessment.calculation}). See its full confidence contributions in the evidence register.`)
    lines.push('')
  }
  lines.push('## Timeline', '', 'Raw UTC events are retained. Review classifications use explicit finding codes, not title matching or a record-wide assumption. Duplicate-record events and contradictory-observation events remain separate.', '')
  for (const item of timeline) {
    const review = timelineReview(item, findings)
    lines.push(`- ${item.time} UTC · ${review.category?.title ?? item.type} · ${item.title}: ${item.detail}`)
    lines.push(`  - Linked record: ${item.evidenceId ?? 'none'}; source: ${item.source}.`)
    if (review.category) {
      lines.push(`  - Review category: ${review.category.code}.`)
      lines.push(`  - Supporting review records: ${[...new Set(review.linkedFindings.flatMap((finding) => finding.evidenceIds))].sort().join(', ') || 'none in supplied findings'}.`)
    }
  }
  const brief = buildCaseBrief(evidence, findings).replace('# Synthetic Evidence Case Brief\n', `# Synthetic Evidence Case Brief\n\n**Synthetic case:** ${caseMeta.id} — ${caseMeta.title}\n`)
  return `${brief}\n${lines.join('\n')}\n`
}
