import { useEffect, useRef, useState } from 'react'
import { evidence, evidenceCatalog } from '../data/case'
import { type ValidationFinding, deriveConfidence, FINDING_CATEGORIES, summarizeConfidence } from '../domain/evidence'
import { confidenceSources, findingCopy } from '../ui'
import { Badge, Icon } from './Primitives'
import { ConfidenceDetails, ConfidenceMean } from './ConfidenceDetails'
import { ScopeBanner } from './Scope'

export type Inspection = { type: 'evidence'; id: string } | { type: 'finding'; finding: ValidationFinding } | { type: 'methodology' } | { type: 'confidence'; kind?: string }

export function Inspector({ inspection, findings, onClose, onEvidence }: { inspection: Inspection; findings: readonly ValidationFinding[]; onClose: () => void; onEvidence: (id: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [verification, setVerification] = useState('')
  const [preview, setPreview] = useState('')
  useEffect(() => {
    dialog.current?.showModal()
    return () => dialog.current?.close()
  }, [])
  useEffect(() => { setVerification(''); setPreview('') }, [inspection])

  const record = inspection.type === 'evidence' ? evidence.find((item) => item.evidenceId === inspection.id) : undefined
  const file = record ? evidenceCatalog[record.evidenceId] : undefined
  const confidence = record ? deriveConfidence(record, findings) : undefined
  const group = inspection.type === 'confidence' ? confidenceSources(findings).find((source) => source.kind === inspection.kind) : undefined
  const summary = inspection.type === 'confidence' ? group?.summary ?? summarizeConfidence(evidence, findings) : undefined
  const reviewCategory = inspection.type === 'finding' ? FINDING_CATEGORIES.find((category) => category.code === inspection.finding.code) : undefined

  async function verify() {
    if (!record || !file) return
    setVerification('Reading bundled bytes…')
    try {
      const response = await fetch(file.path)
      if (!response.ok) throw new Error('Bundled file unavailable')
      const bytes = await response.arrayBuffer()
      const digest = await crypto.subtle.digest('SHA-256', bytes)
      const actual = `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
      setVerification(actual === record.contentHash ? 'Verified · bundled bytes match the declared SHA-256.' : 'Mismatch · bundled bytes differ from the declared hash.')
      setPreview(new TextDecoder().decode(bytes))
    } catch {
      setVerification('Unable to verify the local file. Please retry from localhost.')
    }
  }

  return <dialog ref={dialog} className="inspector" onCancel={onClose} onClose={onClose} onClick={(event) => { if (event.target === event.currentTarget) onClose() }}><div className="inspector-inner"><ScopeBanner compact /><div className="inspector-heading"><div><span className="eyebrow">{inspection.type === 'methodology' ? 'TRANSPARENT BY DESIGN' : inspection.type === 'confidence' ? 'CONFIDENCE EVIDENCE' : inspection.type === 'finding' ? 'REVIEW EXPLANATION' : record?.evidenceId}</span><h2>{inspection.type === 'methodology' ? 'About this evidence desk' : inspection.type === 'confidence' ? group?.label ?? 'Overall confidence' : inspection.type === 'finding' ? findingCopy[inspection.finding.code].label : file?.title}</h2></div><button className="icon-button" aria-label="Close inspector" onClick={onClose}><Icon name="close" /></button></div>
    {summary && <div className="inspector-body"><ConfidenceMean summary={summary} onEvidence={onEvidence} /></div>}
    {inspection.type === 'methodology' && <div className="inspector-body"><div className="notice-block"><Icon name="shield" /><p>All people, assets, events and files are fictional. This desk reads bundled local files only. It never contacts a target, runs investigative tools or uploads evidence.</p></div><h3>Confidence, not certainty</h3><p>Scores are integrity heuristics—not probabilities of truth. Each record starts at 100. One penalty per finding category is applied: duplicate −15, clock skew −20, broken custody −30, conflict −15. A missing or malformed full hash subtracts 10.</p><p>The overview is the mean of all 12 record scores, including retained imports. It is not an independent corroboration score. Source bars are grouped means. No historical improvement is claimed.</p><h3>Time policy</h3><p>All times use UTC. Future observation tolerance is 60 seconds; source regression tolerance is five minutes. Conflicts compare distinct sources for the same subject, kind and unit within five minutes, excluding duplicate imports. Raw source clocks are preserved, not silently corrected.</p><h3>Integrity boundaries</h3><p>The local validator checks custody sequence, holders, references and chronology. It cannot establish authenticity or recover a missing handoff. SHA-256 verification reads only the selected bundled file, never an external address.</p></div>}
    {inspection.type === 'finding' && <div className="inspector-body"><Badge tone={findingCopy[inspection.finding.code].tone}>{reviewCategory?.title}</Badge><p className="review-explanation">{reviewCategory?.description}</p><Badge tone={inspection.finding.severity === 'error' ? 'red' : 'orange'}>{inspection.finding.severity === 'error' ? 'Needs review' : 'Unresolved'}</Badge><h3>What the records show</h3><p>{inspection.finding.message}</p><h3>How to interpret this</h3><p>{findingCopy[inspection.finding.code].explanation}</p><h3>Linked evidence & confidence</h3><div className="linked-records">{inspection.finding.evidenceIds.map((id) => {
      const linked = evidence.find((item) => item.evidenceId === id)
      const assessment = linked ? deriveConfidence(linked, findings) : undefined
      const impact = assessment?.contributions.find((contribution) => contribution.code === inspection.finding.code)
      return <button key={id} onClick={() => onEvidence(id)}><Icon name="file" /><div><strong>{evidenceCatalog[id]?.title ?? id}</strong><span>{id} · {linked?.sourceId}</span>{assessment && <span>{assessment.score}% · {assessment.calculation}; this category {impact?.penalty ?? 0} points once</span>}</div><Icon name="arrow" /></button>
    })}</div><div className="notice-block"><Icon name="alert" /><p>{inspection.finding.code === 'DUPLICATE_EVIDENCE' ? 'This is a repeated-record finding, not a disagreement between observations. Keep the import trail; do not treat copies as independent corroboration.' : inspection.finding.code === 'CONFLICTING_OBSERVATIONS' ? 'This disagreement remains unresolved. The brief retains both observations; no account is selected as true.' : 'This integrity flag remains unresolved.'} Open a linked record to see its separate confidence contributions and supporting facts.</p></div></div>}
    {record && file && confidence && <div className="inspector-body">
      <div className="detail-score"><div><span className="eyebrow">INTEGRITY CONFIDENCE</span><strong>{confidence.score}<small>%</small></strong></div><Badge tone={confidence.level}>{confidence.level}</Badge></div>
      <dl className="detail-grid"><div><dt>Source</dt><dd>{record.sourceId}</dd></div><div><dt>Subject</dt><dd>{record.subjectId}</dd></div><div><dt>Observed (UTC)</dt><dd className="mono">{record.observedAt}</dd></div><div><dt>Received (UTC)</dt><dd className="mono">{record.receivedAt}</dd></div></dl>
      <h3>Recorded observation</h3><div className="observation"><code>{record.observation.kind}</code><strong>{String(record.observation.value)}</strong></div>
      <ConfidenceDetails assessment={confidence} onEvidence={onEvidence} />
      <h3>Declared SHA-256</h3><code className="full-hash">{record.contentHash ?? 'unavailable'}</code>
      <div className="detail-actions"><button className="button button-dark" onClick={verify}><Icon name="shield" /> Verify & preview file</button><a className="button button-outline" download={file.filename} href={file.path}><Icon name="download" /> Source file</a></div>
      {verification && <p className="verification" role="status">{verification}</p>}{preview && <pre className="file-preview">{preview}</pre>}
      <h3>Recorded custody</h3><ol className="detail-custody">{record.custody.map((event) => <li key={event.eventId}><strong>#{event.sequence} · {event.action}</strong><span>{event.fromPartyId ?? 'Synthetic source'} → {event.toPartyId}</span><small>{event.occurredAt} · {event.eventId}</small></li>)}</ol>
      <div className="notice-block"><Icon name="shield" /><p>Declared hashes and continuous records alone do not prove authenticity. Synthetic fixture, defensive review only.</p></div>
    </div>}
  </div></dialog>
}
