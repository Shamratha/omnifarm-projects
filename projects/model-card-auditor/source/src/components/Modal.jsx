import { useEffect, useRef } from 'react';
import { X, Download, FileText, Check, ShieldCheck, Search } from 'lucide-react';
import { exportReviewPacket } from '../lib/audit.js';
import { downloadReviewPacket } from '../lib/download.js';
import ScoringRulesPanel from './ScoringRulesPanel.jsx';
import ThreatFixturesPanel from './ThreatFixturesPanel.jsx';

export function Modal({ title, children, onClose, className = '' }) {
  const ref = useRef(null);
  useEffect(() => {
    const element = ref.current;
    const previousFocus = document.activeElement;
    element.showModal();
    return () => {
      element.close();
      previousFocus?.focus();
    };
  }, []);

  function trapFocus(event) {
    if (event.key !== 'Tab') return;
    const controls = [...ref.current.querySelectorAll('button, input, textarea, select, a[href], [tabindex="0"]')]
      .filter((node) => !node.disabled && node.getClientRects().length);
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }

  return <dialog ref={ref} className={`modal ${className}`} aria-label={title}
    onKeyDown={trapFocus} onCancel={(event) => { event.preventDefault(); onClose(); }}
    onClick={(event) => { if (event.target === ref.current) onClose(); }}>
    <div className="modal-heading"><h2>{title}</h2><button className="icon-button" aria-label={title === 'Export review packet' ? 'Close export dialog' : `Close ${title}`} onClick={onClose}><X size={20} /></button></div>
    {children}
  </dialog>;
}

export function ExportModal({ card, audit, notes, setNotes, onClose, onDownload, onPreview }) {
  function download() {
    const packet = exportReviewPacket(card, audit, notes);
    downloadReviewPacket(card.id, packet);
    onDownload();
  }
  return <Modal title="Export review packet" onClose={onClose}>
    <p className="modal-intro">Everything a reviewer needs, in one portable snapshot.</p>
    <div className="export-preview"><div className="file-icon"><FileText size={25} /></div><div><strong>{card.name} · v{card.version}</strong><p>Markdown review packet <span>·</span> Synthetic data only</p></div><span className="badge neutral">.md</span></div>
    <ul className="export-includes">{['Coverage scores & methodology', 'Subgroup metrics & evidence references', 'Consent, threats & accessibility checks', 'Findings, trade-offs & recommended actions'].map((label) => <li key={label}><Check size={15} />{label}</li>)}</ul>
    <label className="input-label" htmlFor="reviewer-notes">Reviewer notes <span>Optional</span></label>
    <textarea id="reviewer-notes" aria-label="Reviewer notes" rows={4} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Add context, decisions, or next steps for your review…" />
    <div className="notice-small"><ShieldCheck size={16} /><span>Generated in your browser. Nothing is uploaded or saved to a server.</span></div>
    {onPreview && <p><button className="text-link" onClick={onPreview}>Preview review packet</button></p>}
    <div className="modal-footer"><button className="button secondary" onClick={onClose}>Cancel</button><button className="button primary" onClick={download}><Download size={16} />Download Markdown</button></div>
  </Modal>;
}

export function MethodologyModal({ audit, card, onClose }) {
  return <Modal title="How scoring works" onClose={onClose} className="methodology-modal">
    <p className="modal-intro">Coverage is a starting point for a conversation—not a safety certificate.</p>
    <div className="methodology-formula"><span>Overall evidence coverage</span><strong>{audit.coverage}%</strong><p>Equal-weight mean of five unrounded dimension scores.</p></div>
    <div className="methodology-list">{audit.dimensions.map((item) => <div key={item.id}><strong>{item.label}</strong><span>{item.covered} / {item.total} checks covered</span></div>)}</div>
    <ul className="plain-list"><li><strong>Documentation</strong> covers metadata, limitations, synthetic provenance, and complete claim references.</li><li><strong>Fairness</strong> counts expected subgroups with valid sample sizes, accuracy, and false-positive rates.</li><li><strong>Privacy</strong> checks four policy fields and consistent consent statements across three scopes.</li><li><strong>Security & accessibility</strong> count documented mitigations and passing access checks.</li></ul>
    <div className="callout amber"><strong>Know the limits</strong><p>Referenced evidence is not fact-checked. Consent language uses bounded text heuristics. Threat and accessibility statuses are self-reported. Accuracy gaps are descriptive, not statistical or legal fairness conclusions.</p></div>
    {card && <><ScoringRulesPanel audit={audit} /><ThreatFixturesPanel card={card} /></>}
    <p className="muted small">All bundled values are fictional. Trade-off scores are illustrative estimates and do not affect coverage. Full methodology is included in every exported packet.</p>
  </Modal>;
}

export function SearchModal({ query, setQuery, cards, onSelect, onClose }) {
  const results = cards.filter((card) => `${card.name} ${card.type}`.toLowerCase().includes(query.toLowerCase()));
  return <Modal title="Search model cards" onClose={onClose} className="search-modal">
    <div className="search-input"><Search size={19} /><input autoFocus aria-label="Search model cards" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a synthetic model card…" /></div>
    <p className="eyebrow">LOCAL MODEL CARDS <span>{results.length}</span></p>
    <div className="search-results">{results.map((card) => <button key={card.id} onClick={() => onSelect(card.id)}><FileText size={18} /><span><strong>{card.name}</strong><small>{card.type} · v{card.version}</small></span><span className="badge neutral">Synthetic</span></button>)}{!results.length && <p className="empty-message">No model cards match “{query}”. Try another name or model type.</p>}</div>
    <p className="muted small">Use Tab to move between results and Enter to open a card.</p>
  </Modal>;
}
