import { useState } from 'react'
import { evidence, evidenceCatalog } from '../data/case'
import { groupFindings, type ValidationFinding } from '../domain/evidence'
import { entityRecords, findingCopy, linkedEntities, recordConfidence } from '../ui'
import { Badge, Icon } from './Primitives'

type ViewProps = { findings: readonly ValidationFinding[]; onEvidence: (id: string) => void }

export function EvidenceView({ findings, onEvidence }: ViewProps) {
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState('all')
  const records = evidence.filter((record) => {
    const file = evidenceCatalog[record.evidenceId]
    return (kind === 'all' || kind === file.kind) && `${record.evidenceId} ${file.title} ${record.sourceId}`.toLowerCase().includes(query.toLowerCase())
  })
  return <section className="panel full-view"><div className="panel-heading"><div><h2>Evidence register <Badge>{evidence.length} items</Badge></h2><p>Bundled source files, declared SHA-256 digests and integrity assessments</p></div><Badge tone="green">Synthetic files only</Badge></div><div className="timeline-tools"><label className="search-box"><Icon name="search" /><input aria-label="Search evidence" placeholder="Search evidence, source or ID…" value={query} onChange={(event) => setQuery(event.target.value)} /></label><select aria-label="Evidence type" className="filter-button" value={kind} onChange={(event) => setKind(event.target.value)}><option value="all">All types</option><option value="event-log">Event logs</option><option value="witness-note">Witness notes</option><option value="transfer">Transfers</option><option value="observation">Observations</option></select></div><div className="table-wrap"><table><thead><tr><th>Evidence</th><th>Source / type</th><th>SHA-256</th><th>Confidence</th><th>Review</th></tr></thead><tbody>{records.map((record) => {
    const file = evidenceCatalog[record.evidenceId]
    const confidence = recordConfidence(record, findings)
    const count = findings.filter((finding) => finding.evidenceIds.includes(record.evidenceId)).length
    return <tr key={record.evidenceId}>
      <td><button className="table-title" onClick={() => onEvidence(record.evidenceId)}>{file.title}</button><span className="mono table-secondary">{record.evidenceId}</span></td>
      <td>{record.sourceId}<span className="table-secondary">{file.kind.replace('-', ' ')}</span></td>
      <td><code title={record.contentHash}>{record.contentHash?.slice(7, 19)}…</code></td>
      <td><button className="confidence-badge-button" aria-label={`Explain ${record.evidenceId} confidence`} onClick={() => onEvidence(record.evidenceId)}><Badge tone={confidence.level}>{confidence.score}% · {confidence.level}</Badge></button><span className="table-secondary">{confidence.calculation}</span></td>
      <td><button className="text-button" onClick={() => onEvidence(record.evidenceId)}>{count ? `${count} flags` : 'Inspect'} <Icon name="arrow" /></button></td>
    </tr>
  })}</tbody></table></div>{records.length === 0 && <div className="empty-state">No matching evidence. Try another search or type.</div>}<div className="panel-note"><Icon name="shield" /> Hashes identify file bytes, not authenticity. Open an item to verify its bundled source.</div></section>
}

export function EntityView({ onEvidence }: ViewProps) {
  const [selected, setSelected] = useState('Northstar relay')
  const records = entityRecords(selected)
  return <section className="panel full-view"><div className="panel-heading"><div><h2>Entity connections</h2><p>Explicit links from observations and custody records. No inferred identity matches.</p></div><Badge>{linkedEntities.length} entities</Badge></div><div className="entity-workspace"><div className="entity-choices">{linkedEntities.map((entity) => <button className={`entity-choice ${selected === entity.name ? 'chosen' : ''}`} key={entity.name} onClick={() => setSelected(entity.name)}><div className={`entity-avatar tone-${entity.tone}`}>{entity.initials}</div><div><strong>{entity.name}</strong><small>{entity.kind} · {entity.links} evidence links</small></div><Icon name="arrow" /></button>)}</div><div className="connection-view"><div className="connection-root"><Icon name="link" /><span className="eyebrow">SELECTED ENTITY</span><h3>{selected}</h3><p>{records.length} direct evidence connections</p></div><div className="connections">{records.map((record) => <button key={record.evidenceId} onClick={() => onEvidence(record.evidenceId)}><span className="connection-line" /><Icon name="file" /><div><strong>{evidenceCatalog[record.evidenceId].title}</strong><span>{record.evidenceId} · {record.subjectId === selected ? 'observation subject' : record.sourceId === selected || selected === 'M. Alvarez' ? 'observation source' : 'custody holder'}</span></div><Icon name="arrow" /></button>)}</div></div></div></section>
}

export function CustodyView({ findings, onEvidence }: ViewProps) {
  const [id, setId] = useState('EV-1042')
  const record = evidence.find((item) => item.evidenceId === id)!
  const broken = findings.filter((finding) => finding.code === 'BROKEN_CHAIN_OF_CUSTODY' && finding.evidenceIds.includes(id))
  return <section className="panel full-view"><div className="panel-heading"><div><h2>Chain of custody</h2><p>Accountable handoffs, in recorded sequence order</p></div><select className="filter-button" aria-label="Custody evidence" value={id} onChange={(event) => setId(event.target.value)}>{evidence.map((item) => <option key={item.evidenceId} value={item.evidenceId}>{item.evidenceId} · {evidenceCatalog[item.evidenceId].title}</option>)}</select></div><div className="custody-status"><Icon name={broken.length ? 'alert' : 'shield'} /><div><strong>{broken.length ? 'Custody requires review' : 'Recorded chain is continuous'}</strong><p>{broken.length ? broken[0].message : 'Sequence, event references, holders and chronology pass the local checks. This does not prove authenticity.'}</p></div><Badge tone={broken.length ? 'red' : 'green'}>{broken.length ? 'Gap detected' : 'Checks passed'}</Badge></div><div className="custody-list">{record.custody.map((event) => <div className="custody-step" key={event.eventId}><div className="custody-number">{event.sequence.toString().padStart(2, '0')}</div><div><span className="eyebrow">{event.action}</span><h3>{event.fromPartyId ?? 'Synthetic source'} <span>→</span> {event.toPartyId}</h3><p>{event.occurredAt.replace('T', ' ').replace('Z', ' UTC')}</p><small className="mono">{event.eventId} · previous: {event.previousEventId ?? 'none / collection'}</small></div></div>)}</div><div className="panel-note"><span className="mono">{id}</span><button className="text-button" onClick={() => onEvidence(id)}>Inspect source & full hash <Icon name="arrow" /></button></div></section>
}

export function ReviewFlags({ findings, onReview }: { findings: readonly ValidationFinding[]; onReview: (finding: ValidationFinding) => void }) {
  const [expanded, setExpanded] = useState(false)
  const groups = groupFindings(findings)
  return <section className="panel flags-panel">
    <div className="panel-heading"><div><h2>Review groups <Badge tone="orange">{findings.length} open findings</Badge></h2><p>Repeated records and differing observations are separate review categories.</p></div>{groups.some((group) => group.findings.length > 2) && <button className="text-button" onClick={() => setExpanded(!expanded)}>{expanded ? 'Show less' : 'Review all'} <Icon name="arrow" /></button>}</div>
    <div className="review-groups">{groups.map((group) => <section className="review-group" aria-label={group.title} data-review-code={group.code} key={group.code}>
      <div className="review-group-heading"><h3>{group.title}</h3><Badge tone={findingCopy[group.code].tone}>{group.findings.length} findings</Badge></div>
      <p className="review-group-description">{group.description}</p>
      <div className="flag-list">{group.findings.slice(0, expanded ? undefined : 2).map((finding, index) => <button className="flag-row" key={`${finding.code}-${index}`} onClick={() => onReview(finding)}>
        <div className={`flag-icon flag-${findingCopy[finding.code].tone}`}><Icon name={finding.code === 'CONFLICTING_OBSERVATIONS' ? 'alert' : 'file'} /></div>
        <div className="flag-text"><strong>{finding.evidenceIds.join(' / ')}</strong><p>{finding.message}</p></div>
        <Badge tone={finding.severity === 'error' ? 'red' : findingCopy[group.code].tone}>{finding.severity === 'error' ? 'Needs review' : group.code === 'DUPLICATE_EVIDENCE' ? 'Repeated record' : group.code === 'CONFLICTING_OBSERVATIONS' ? 'Contradiction' : 'Unresolved'}</Badge><span className="row-arrow"><Icon name="arrow" /></span>
      </button>)}{group.findings.length === 0 && <div className="empty-state">No findings in this category.</div>}{!expanded && group.findings.length > 2 && <p className="review-group-description">{group.findings.length - 2} more findings · select Review all</p>}</div>
    </section>)}</div>
  </section>
}
