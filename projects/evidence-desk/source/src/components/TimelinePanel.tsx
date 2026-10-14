import { useMemo, useState } from 'react'
import { evidence, timeline } from '../data/case'
import { deriveConfidence, FINDING_CATEGORIES, type ValidationFinding } from '../domain/evidence'
import { findingCopy, timelineReview } from '../ui'
import { Badge, Icon } from './Primitives'

export function TimelinePanel({ findings, onEvidence, onReview, full = false }: {
  findings: readonly ValidationFinding[]
  onEvidence: (id: string) => void
  onReview: (finding: ValidationFinding) => void
  full?: boolean
}) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('all')
  const [selected, setSelected] = useState('t2')
  const [expanded, setExpanded] = useState(false)
  const items = useMemo(() => timeline.filter((item) => {
    const review = timelineReview(item, findings)
    return (category === 'all' || item.findingCode === category)
      && `${item.title} ${item.detail} ${item.source} ${item.evidenceId ?? ''} ${review.category?.title ?? ''}`.toLowerCase().includes(query.toLowerCase())
  }), [category, query, findings])

  return <div className="panel timeline-panel">
    <div className="panel-heading"><div><h2>Investigation timeline</h2><p>Raw UTC events · duplicates and contradictions classified separately</p></div></div>
    <div className="timeline-tools"><label className="search-box"><Icon name="search" /><input id="timeline-filter" aria-label="Search timeline" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter events…" /></label>
      <select className="filter-button" aria-label="Timeline review category" value={category} onChange={(event) => setCategory(event.target.value)}><option value="all">All events</option>{FINDING_CATEGORIES.map((item) => <option value={item.code} key={item.code}>{item.title}</option>)}</select>
    </div>
    <div className="timeline-list">{items.slice(0, expanded || full || category !== 'all' || query ? undefined : 6).map((item) => {
      const record = evidence.find((record) => record.evidenceId === item.evidenceId)
      const assessment = record ? deriveConfidence(record, findings) : undefined
      const review = timelineReview(item, findings)
      return <button className={`timeline-row ${selected === item.id ? 'selected' : ''}`} data-review-code={item.findingCode} key={item.id} onClick={() => {
        setSelected(item.id)
        if (review.linkedFindings.length) onReview(review.linkedFindings[0])
        else if (item.evidenceId) onEvidence(item.evidenceId)
      }}>
        <div className={`timeline-marker marker-${item.type}`}><span /></div>
        <div className="timeline-time">{item.time}<small>UTC</small></div>
        <div className="timeline-content"><strong>{item.title}</strong><span>{item.detail}</span><small>{item.source}</small>{review.category && <div className="timeline-category"><Badge tone={findingCopy[review.category.code].tone}>{review.category.title}</Badge></div>}</div>
        <Badge tone={assessment?.level}>{assessment ? `${assessment.score}% · ${assessment.level}` : 'unassessed'}</Badge><span className="row-arrow"><Icon name="arrow" /></span>
      </button>
    })}{items.length === 0 && <div className="empty-state">No events match this category and search.</div>}</div>
    {!full && category === 'all' && !query && <button className="view-link" onClick={() => setExpanded(!expanded)}>{expanded ? 'Collapse timeline' : 'View full timeline'} <Icon name="arrow" /></button>}
  </div>
}
