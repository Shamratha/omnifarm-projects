import { scoringPolicy, scoringRules } from '../data/scoringRules.js';
import './explanations.css';

function dimensionLabel(dimension) {
  return dimension?.label || dimension?.id || 'Unnamed dimension';
}

/** Explain the deterministic audit rules without duplicating or changing the engine. */
export default function ScoringRulesPanel({ audit }) {
  const dimensions = Array.isArray(audit?.dimensions) ? audit.dimensions : [];

  return <section className="explanation-panel scoring-rules-panel"
    aria-label="Scoring-rule explanations">
    <header className="explanation-panel__header">
      <div>
        <p className="explanation-panel__eyebrow">DETERMINISTIC POLICY · VERSION {scoringPolicy.version}</p>
        <h3>Scoring-rule explanations</h3>
        <p>Review what each finding means, how coverage units are counted, and where interpretation is still required.</p>
      </div>
    </header>
    <div className="explanation-panel__formula" role="note">
      <strong>Formula summary</strong>
      <p>Each dimension score is round(100 × covered / total). Overall coverage is the equal-weight mean of the five unrounded dimension ratios, rounded once at the end.</p>
      <p>Findings are review prompts; they do not directly subtract points. Tradeoff estimates and synthetic fixture descriptions are not scoring inputs.</p>
    </div>
    <section className="explanation-panel__coverage" aria-label="Coverage dimensions">
      <h4>Current dimension coverage</h4>
      <p className="explanation-panel__coverage-label">Covered / total evidence units</p>
      {!dimensions.length ? <p className="explanation-panel__empty">No audit coverage is available yet.</p> : <ul>
        {dimensions.map((dimension) => <li key={dimension.id}>
          <span>{dimensionLabel(dimension)}</span>
          <strong>{dimension.covered} / {dimension.total}</strong>
        </li>)}
      </ul>}
    </section>
    <div className="explanation-panel__details">
      {scoringRules.map((rule) => <details className="explanation-panel__detail" key={rule.id}>
        <summary>
          <span>{rule.title}</span>
          <code>{rule.id}</code>
        </summary>
        <div className="explanation-panel__detail-body">
          <p className="explanation-panel__rule-category">{rule.category} rule</p>
          <div className="explanation-panel__text-block">
            <h4>Trigger</h4>
            <p>{rule.trigger}</p>
          </div>
          <div className="explanation-panel__text-block">
            <h4>Effect</h4>
            <p>{rule.effect}</p>
          </div>
          <div className="explanation-panel__text-block">
            <h4>Limit and uncertainty caveat</h4>
            <p>{rule.limit}</p>
          </div>
        </div>
      </details>)}
    </div>
  </section>;
}
