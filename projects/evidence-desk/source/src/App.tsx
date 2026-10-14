import { useState } from 'react'
import { caseMeta, entities, evidence, timeline } from './data/case'
import { summarizeConfidence, validateEvidence, type ValidationFinding } from './domain/evidence'
import { buildDeskBrief, confidenceSources } from './ui'
import { Badge, Icon } from './components/Primitives'
import { CustodyView, EntityView, EvidenceView, ReviewFlags } from './components/CaseViews'
import { Inspector, type Inspection } from './components/Inspector'
import { TimelinePanel } from './components/TimelinePanel'
import { ScopeBanner } from './components/Scope'
import { EVIDENCE_DESK_SCOPE } from './scope'

const validation = validateEvidence(evidence, { clockSkew: { maxFutureSkewMs: 60_000, maxObservedRegressionMs: 5 * 60_000 }, conflict: { windowMs: 5 * 60_000 } })

function exportBrief() {
  const text = buildDeskBrief(validation.findings)
  const link = document.createElement('a')
  link.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }))
  link.download = `${caseMeta.id.toLowerCase()}-case-brief.md`
  link.click()
  URL.revokeObjectURL(link.href)
}

export function App() {
  const [activeTab, setActiveTab] = useState('Overview')
  const [notice, setNotice] = useState('')
  const [inspection, setInspection] = useState<Inspection | null>(null)
  const confidence = summarizeConfidence(evidence, validation.findings).score
  const openNotice = (text: string) => { setNotice(text); window.setTimeout(() => setNotice(''), 2600) }

  const openEvidence = (id: string) => setInspection({ type: 'evidence', id })
  const content = activeTab === 'Evidence' ? <EvidenceView findings={validation.findings} onEvidence={openEvidence} /> : activeTab === 'Entities' ? <EntityView findings={validation.findings} onEvidence={openEvidence} /> : activeTab === 'Custody' ? <CustodyView findings={validation.findings} onEvidence={openEvidence} /> : null

  return <div className="app-shell">
    <header className="topbar"><div className="brand"><div className="brand-mark"><span /></div><div><strong>SIGNALROOM</strong><small>DEFENSIVE EVIDENCE DESK</small></div></div><div className="header-case"><span className="eyebrow">ACTIVE CASE</span><span className="case-id">{caseMeta.id}</span><span className="status-dot" /> <span className="open-label">OPEN</span></div><div className="header-scope"><Badge tone="purple">{EVIDENCE_DESK_SCOPE.badge}</Badge><span>{EVIDENCE_DESK_SCOPE.label}</span><span>{EVIDENCE_DESK_SCOPE.short}</span></div><div className="header-actions"><button className="icon-button" aria-label="Search" onClick={() => document.getElementById('timeline-filter')?.focus()}><Icon name="search" /></button><button className="icon-button" aria-label="Methodology" onClick={() => setInspection({ type: 'methodology' })}><Icon name="sliders" /></button><button className="button button-light" onClick={exportBrief}><Icon name="download" /> Export brief</button><div className="avatar">AC</div></div></header>
    <nav className="tabs">{['Overview', 'Timeline', 'Entities', 'Evidence', 'Custody'].map((tab) => <button key={tab} className={activeTab === tab ? 'active' : ''} onClick={() => setActiveTab(tab)}>{tab}{tab === 'Evidence' && <span className="tab-count">{evidence.length}</span>}</button>)}<span className="tabs-spacer" /><span className="sync"><span className="status-dot" /> Local bundle · synced</span></nav>
    <main className="page"><ScopeBanner />{content ?? <>
      <section className="case-heading"><div><div className="breadcrumb">CASES <span>/</span> {caseMeta.id}</div><h1>{caseMeta.title}</h1><p>{caseMeta.subtitle}</p></div><div className="heading-actions"><button className="button button-outline" onClick={() => openNotice('Evidence intake is ready for synthetic files')}><Icon name="plus" /> Add evidence</button><button className="button button-dark" onClick={exportBrief}><Icon name="download" /> Export brief</button></div></section>
      <section className="metric-grid">
        <button className="metric-card confidence" aria-label="Inspect overall confidence evidence" onClick={() => setInspection({ type: 'confidence' })}><div className="metric-top"><span className="metric-label">EVIDENCE CONFIDENCE</span><span className="confidence-chip">integrity mean</span></div><div className="metric-value">{confidence ?? '—'}<span>%</span></div><div className="meter"><i style={{ width: `${confidence ?? 0}%` }} /></div><div className="metric-foot"><span>Across {evidence.length} items</span><span>Inspect inputs →</span></div></button>
        <div className="metric-card"><div className="metric-top"><span className="metric-label">TIMELINE EVENTS</span><span className="metric-icon"><Icon name="file" /></span></div><div className="metric-value">{timeline.length.toString().padStart(2, '0')}</div><div className="metric-foot"><span>Linked record integrity</span><span>UTC</span></div></div>
        <div className="metric-card"><div className="metric-top"><span className="metric-label">LINKED ENTITIES</span><span className="metric-icon"><Icon name="link" /></span></div><div className="metric-value">{entities.length.toString().padStart(2, '0')}</div><div className="metric-foot"><span>2 people</span><span>3 systems/assets</span></div></div>
        <div className="metric-card alert-card"><div className="metric-top"><span className="metric-label">OPEN FLAGS</span><span className="metric-icon"><Icon name="alert" /></span></div><div className="metric-value">{validation.findings.length.toString().padStart(2, '0')}</div><div className="metric-foot"><span className="orange-text">{validation.findings.filter((finding) => finding.severity === 'error').length} need review</span><span>Local scan</span></div></div>
      </section>
      <section className="work-grid"><TimelinePanel findings={validation.findings} onEvidence={openEvidence} onReview={(finding) => setInspection({ type: 'finding', finding })} full={activeTab === 'Timeline'} /><div className="side-stack"><ConfidencePanel findings={validation.findings} onMethodology={() => setInspection({ type: 'methodology' })} onInspect={(kind) => setInspection({ type: 'confidence', kind })} /><EntitiesPanel onEvidence={openEvidence} onView={() => setActiveTab('Entities')} /></div></section>
      <ReviewFlags findings={validation.findings} onReview={(finding) => setInspection({ type: 'finding', finding })} />
    </>}
    <footer><span>Signalroom is a defensive analysis workspace.</span><span><span className="status-dot" /> Synthetic case data · No target contact · No external actions</span></footer></main>
    {inspection && <Inspector inspection={inspection} findings={validation.findings} onClose={() => setInspection(null)} onEvidence={(id) => setInspection({ type: 'evidence', id })} />}{notice && <div className="toast">{notice}</div>}
  </div>
}

function ConfidencePanel({ findings, onMethodology, onInspect }: { findings: readonly ValidationFinding[]; onMethodology: () => void; onInspect: (kind: string) => void }) {
  const sources = confidenceSources(findings)
  return <div className="panel confidence-panel"><div className="panel-heading"><div><h2>Confidence by file type</h2><p>Computed means · select a bar to inspect inputs</p></div></div><div className="source-list">{sources.map((source) => <button className="source-row source-button" aria-label={`Inspect ${source.label} confidence`} key={source.label} onClick={() => onInspect(source.kind)}><div><span>{source.label} · {source.count} items</span><strong>{source.value ?? '—'}%</strong></div><div className="source-meter"><i className={`fill-${source.color}`} style={{ width: `${source.value ?? 0}%` }} /></div></button>)}</div><div className="confidence-summary"><span className="summary-check"><Icon name="alert" /></span><div><strong>Integrity is not certainty</strong><span>Duplicates remain inputs; all flags remain unresolved.</span></div></div><button className="panel-method" onClick={onMethodology}>How scores are calculated <Icon name="arrow" /></button></div>
}

function EntitiesPanel({ onEvidence, onView }: { onEvidence: (id: string) => void; onView: () => void }) {
  return <div className="panel entities-panel"><div className="panel-heading"><div><h2>Key entities</h2><p>People, assets & systems</p></div><button className="more-button">•••</button></div><div className="entity-list">{entities.slice(0, 4).map((entity) => <div className="entity-row" key={entity.name}><div className={`entity-avatar tone-${entity.tone}`}>{entity.initials}</div><div className="entity-name"><strong>{entity.name}</strong><span>{entity.role}</span></div><span className="entity-links"><Icon name="link" /> {entity.links}</span><button className="row-arrow" onClick={() => { const item = evidence.find((record) => record.subjectId === entity.name || record.sourceId === entity.name); if (item) onEvidence(item.evidenceId); else onView() }}><Icon name="arrow" /></button></div>)}</div><button className="view-link" onClick={onView}>View entity map <Icon name="arrow" /></button></div>
}
