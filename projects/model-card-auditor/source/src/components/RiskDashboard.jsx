import { useEffect, useId, useRef, useState } from 'react';
import ClaimEvidenceInspector from './ClaimEvidenceInspector.jsx';
import { FindingEvidence } from './FindingEvidence.jsx';
import ScoringRulesPanel from './ScoringRulesPanel.jsx';
import ThreatFixturesPanel from './ThreatFixturesPanel.jsx';
import './risk-dashboard.css';

const categories = [
  { id: 'privacy', label: 'Privacy' },
  { id: 'fairness', label: 'Fairness' },
  { id: 'security', label: 'Threats', summaryLabel: 'Threats / security' },
  { id: 'accessibility', label: 'Accessibility' },
  { id: 'claims', label: 'Claims' },
];

function estimate(value) {
  return Number.isFinite(value) ? value : 'Not documented';
}

function delta(value, baseline, metric) {
  if (!Number.isFinite(value) || !Number.isFinite(baseline)) return 'Comparison unavailable';
  const change = Number((value - baseline).toFixed(2));
  if (change === 0) return '+0 points · no change from current';
  return `${change > 0 ? '+' : ''}${change} points · ${change > 0 ? 'more' : 'less'} ${metric} than current`;
}

// A model change resets local inspection, finding filters, and comparison display.
export default function RiskDashboard({ card, audit, onPreview }) {
  return <Dashboard key={card.id} card={card} audit={audit} onPreview={onPreview} />;
}

function Dashboard({ card, audit, onPreview }) {
  const id = useId();
  const [category, setCategory] = useState('all');
  const [severity, setSeverity] = useState('all');
  const [inspectionRequest, setInspectionRequest] = useState(0);
  const inspectorRef = useRef(null);
  const findings = audit.findings || [];
  const dimensions = audit.dimensions || [];
  const filteredFindings = findings.filter((finding) => (
    (category === 'all' || finding.category === category)
    && (severity === 'all' || finding.severity === severity)
  ));
  const summaryCategories = categories.filter((item) => item.id !== 'claims'
    || audit.totalClaims > 0 || findings.some((finding) => finding.category === 'claims'));

  useEffect(() => {
    if (inspectionRequest === 0) return;
    const heading = inspectorRef.current?.querySelector('h3');
    heading?.focus({ preventScroll: true });
    heading?.scrollIntoView({ block: 'start' });
  }, [inspectionRequest]);

  function clearFilters() {
    setCategory('all');
    setSeverity('all');
  }

  function inspectCategory(value) {
    setCategory(value);
    setSeverity('all');
  }

  return <section className="risk-dashboard" aria-labelledby={`${id}-heading`}>
    <header className="risk-dashboard__header">
      <div>
        <p className="risk-dashboard__eyebrow">EVIDENCE-FIRST REVIEW</p>
        <h2 id={`${id}-heading`}>Risk trade-off dashboard</h2>
        <p>Review all findings for {card.name} and compare illustrative privacy and fairness strategies.</p>
      </div>
      <button type="button" className="risk-dashboard__preview" onClick={() => onPreview()}>
        Preview review packet
      </button>
    </header>

    <p className="risk-dashboard__notice">
      All bundled scenarios, evidence, and estimates are synthetic and fictional.
      Evidence coverage reflects documented checks, not real risk measurements or a safety certification.
    </p>

    <section className="risk-dashboard__audit-summary" aria-label="Audit summary">
      <dl>
        <div>
          <dt>Evidence coverage</dt>
          <dd>{Number.isFinite(audit.coverage) ? `${audit.coverage}%` : 'Not documented'}</dd>
        </div>
        <div>
          <dt>Review findings</dt>
          <dd>{findings.length}</dd>
        </div>
      </dl>
      <p>Findings remain review prompts until the underlying evidence is addressed.</p>
    </section>

    <div className="risk-dashboard__quick-actions" role="group" aria-label="Inspection quick actions">
      <button type="button" className="risk-dashboard__quick-action"
        onClick={() => setInspectionRequest((request) => request + 1)}>Inspect unsupported claims</button>
      <button type="button" className="risk-dashboard__quick-action"
        aria-pressed={category === 'privacy'} onClick={() => inspectCategory('privacy')}>
        Inspect privacy findings
      </button>
      <button type="button" className="risk-dashboard__quick-action"
        aria-pressed={category === 'fairness'} onClick={() => inspectCategory('fairness')}>
        Inspect fairness findings
      </button>
    </div>

    <section className="risk-dashboard__section" aria-labelledby={`${id}-categories`}>
      <h3 id={`${id}-categories`}>Category summary</h3>
      <p className="risk-dashboard__intro">Counts and coverage describe the full audit; filters only change the findings shown.</p>
      <ul className="risk-dashboard__category-grid">
        {summaryCategories.map((item) => {
          const dimension = dimensions.find((entry) => entry.id === item.id);
          const claims = item.id === 'claims';
          const score = claims
            ? (audit.totalClaims > 0 && Number.isFinite(audit.supportedClaims)
              ? Math.round(100 * audit.supportedClaims / audit.totalClaims) : null)
            : dimension?.score;
          const count = findings.filter((finding) => finding.category === item.id).length;
          return <li className="risk-dashboard__category" key={item.id}>
            <h4>{item.summaryLabel || item.label}</h4>
            <p><strong>{count}</strong> {count === 1 ? 'finding' : 'findings'}</p>
            <dl>
              <div>
                <dt>{claims ? 'Evidence-reference coverage' : 'Evidence coverage'}</dt>
                <dd>{Number.isFinite(score) ? `${score}%` : 'Not documented'}</dd>
              </div>
            </dl>
            <small>{claims
              ? `${estimate(audit.supportedClaims)} / ${estimate(audit.totalClaims)} complete claim references`
              : dimension ? `${dimension.covered} / ${dimension.total} covered checks` : 'No coverage dimension recorded'}</small>
          </li>;
        })}
      </ul>
    </section>

    <section className="risk-dashboard__section" aria-labelledby={`${id}-findings`}>
      <h3 id={`${id}-findings`}>Review findings</h3>
      <div className="risk-dashboard__filters">
        <div>
          <label htmlFor={`${id}-category`}>Finding category</label>
          <select id={`${id}-category`} value={category} onChange={(event) => setCategory(event.target.value)}>
            <option value="all">All findings</option>
            {categories.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor={`${id}-severity`}>Finding severity</label>
          <select id={`${id}-severity`} value={severity} onChange={(event) => setSeverity(event.target.value)}>
            <option value="all">All severities</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </div>
        {(category !== 'all' || severity !== 'all') && <button type="button"
          className="risk-dashboard__clear" onClick={clearFilters}>Clear finding filters</button>}
      </div>
      <p className="risk-dashboard__results" role="status">
        Showing {filteredFindings.length} of {findings.length} findings.
      </p>
      <div className="risk-dashboard__findings-list">
        {filteredFindings.map((finding) => <FindingEvidence key={finding.id} finding={finding} />)}
        {!findings.length && <p className="risk-dashboard__empty">
          No findings were generated for this card. This is not assurance of safety, fairness, privacy,
          or accessibility; coverage only reflects documented checks.
        </p>}
        {findings.length > 0 && !filteredFindings.length && <p className="risk-dashboard__empty">
          No findings match these filters. Existing audit findings have not been resolved;
          choose another category or severity, or clear the filters.
        </p>}
      </div>
    </section>

    <div ref={inspectorRef}>
      <ClaimEvidenceInspector key={inspectionRequest} card={card} />
    </div>
    <StrategyComparison card={card} id={id} />
    <ScoringRulesPanel audit={audit} />
    <ThreatFixturesPanel card={card} />
  </section>;
}

function StrategyComparison({ card, id }) {
  const strategies = card.tradeoffs || [];
  const current = strategies.find((strategy) => strategy.current);
  const [selectedId, setSelectedId] = useState(() => (current || strategies[0])?.id || '');
  const [showPrivacy, setShowPrivacy] = useState(true);
  const [showFairness, setShowFairness] = useState(true);
  const selected = strategies.find((strategy) => strategy.id === selectedId) || current || strategies[0];

  function resetEstimates() {
    setShowPrivacy(true);
    setShowFairness(true);
  }

  return <section className="risk-dashboard__section risk-dashboard__comparison"
    aria-labelledby={`${id}-comparison`}>
    <h3 id={`${id}-comparison`}>Illustrative strategy comparison</h3>
    <p className="risk-dashboard__notice" id={`${id}-comparison-notice`}>
      Comparison only: these 0–100 estimates are fictional, not real risk measurements.
      Selecting a strategy does not apply it, resolve any flags, or recalculate audit evidence or coverage.
      Higher values mean more illustrative privacy risk or more fairness visibility, not greater fairness.
    </p>
    {!strategies.length ? <p className="risk-dashboard__empty">No illustrative strategies are documented for this card.</p> : <>
      <fieldset className="risk-dashboard__visibility" aria-describedby={`${id}-visibility-notice`}>
        <legend>Estimate visibility</legend>
        <p id={`${id}-visibility-notice`}>
          Display-only controls: hiding estimates does not apply an intervention or change scores,
          coverage, or audit flags. All estimates remain in the exported review packet.
        </p>
        <div className="risk-dashboard__visibility-controls">
          <label htmlFor={`${id}-show-privacy`}>
            <input type="checkbox" id={`${id}-show-privacy`} checked={showPrivacy}
              onChange={(event) => setShowPrivacy(event.target.checked)} />
            Show privacy risk estimates
          </label>
          <label htmlFor={`${id}-show-fairness`}>
            <input type="checkbox" id={`${id}-show-fairness`} checked={showFairness}
              onChange={(event) => setShowFairness(event.target.checked)} />
            Show fairness visibility estimates
          </label>
          <button type="button" className="risk-dashboard__clear" onClick={resetEstimates}>Reset estimates</button>
        </div>
        <p className="risk-dashboard__visibility-status" role="status">
          {!showPrivacy && !showFairness
            ? 'Both estimates are hidden. Strategy descriptions remain visible; use Reset estimates to show both again.'
            : `${showPrivacy ? 'Privacy risk estimates shown.' : 'Privacy risk estimates hidden.'} ${showFairness ? 'Fairness visibility estimates shown.' : 'Fairness visibility estimates hidden.'}`}
        </p>
      </fieldset>
      <p className="risk-dashboard__intro" id={`${id}-current`}>
        {current ? <>Current strategy and delta reference: <strong>{current.name}</strong>.</>
          : 'No current strategy is documented; changes versus current are unavailable.'}
      </p>
      <fieldset className="risk-dashboard__strategies" aria-describedby={`${id}-comparison-notice ${id}-current`}>
        <legend>Illustrative comparison strategy</legend>
        <div className="risk-dashboard__strategy-grid">
          {strategies.map((strategy) => <div key={strategy.id}
            className={`risk-dashboard__strategy${selected.id === strategy.id ? ' risk-dashboard__strategy--selected' : ''}`}>
            <input type="radio" id={`${id}-${strategy.id}`} name={`${id}-strategy`}
              value={strategy.id} checked={selected.id === strategy.id}
              onChange={() => setSelectedId(strategy.id)} aria-describedby={`${id}-${strategy.id}-description`} />
            <div>
              <div className="risk-dashboard__strategy-name">
                <label htmlFor={`${id}-${strategy.id}`}>{strategy.name}</label>
                {strategy.current && <span className="risk-dashboard__badge">Current</span>}
              </div>
              <p id={`${id}-${strategy.id}-description`}>{strategy.description}</p>
            </div>
          </div>)}
        </div>
      </fieldset>

      <section className="risk-dashboard__selected" aria-label="Selected strategy estimates" aria-live="polite">
        <h4>{selected.name}</h4>
        <p>{selected.description}</p>
        {(showPrivacy || showFairness) && <dl className="risk-dashboard__estimates">
          {showPrivacy && <div>
            <dt>Privacy risk estimate</dt>
            <dd>{estimate(selected.privacyRisk)} <span>/ 100</span></dd>
            <dd className="risk-dashboard__delta">{delta(selected.privacyRisk, current?.privacyRisk, 'privacy risk')}</dd>
          </div>}
          {showFairness && <div>
            <dt>Fairness visibility estimate</dt>
            <dd>{estimate(selected.fairnessVisibility)} <span>/ 100</span></dd>
            <dd className="risk-dashboard__delta">{delta(selected.fairnessVisibility, current?.fairnessVisibility, 'fairness visibility')}</dd>
          </div>}
        </dl>}
      </section>

      <div className="risk-dashboard__table-scroll" role="region" aria-label="Strategy comparison table"
        tabIndex="0" aria-describedby={`${id}-comparison-notice`}>
        <table className="risk-dashboard__table">
          <caption>Illustrative strategy comparison</caption>
          <thead><tr>
            <th scope="col">Strategy</th>
            {showPrivacy && <th scope="col">Privacy risk (0–100)</th>}
            {showFairness && <th scope="col">Fairness visibility (0–100)</th>}
            <th scope="col">Description</th>
          </tr></thead>
          <tbody>{strategies.map((strategy) => <tr key={strategy.id}>
            <th scope="row">{strategy.name}{strategy.current && <span className="risk-dashboard__badge">Current</span>}</th>
            {showPrivacy && <td><strong>{estimate(strategy.privacyRisk)}</strong><small>{delta(strategy.privacyRisk, current?.privacyRisk, 'privacy risk')}</small></td>}
            {showFairness && <td><strong>{estimate(strategy.fairnessVisibility)}</strong><small>{delta(strategy.fairnessVisibility, current?.fairnessVisibility, 'fairness visibility')}</small></td>}
            <td>{strategy.description}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </>}
  </section>;
}
