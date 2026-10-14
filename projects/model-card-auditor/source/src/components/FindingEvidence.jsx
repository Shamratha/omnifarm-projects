import { useId } from 'react';
import './finding-evidence.css';

const categoryLabels = { privacy: 'Privacy', fairness: 'Fairness', security: 'Threats', accessibility: 'Accessibility', claims: 'Claims' };

/** Show the rule rationale and the exact local records that triggered the flag. */
export function FindingEvidence({ finding }) {
  const id = useId();
  if (!finding) return null;
  return <article className="finding-evidence" aria-labelledby={`${id}-title`}>
    <header className="finding-evidence__header">
      <h3 id={`${id}-title`}>{finding.title}</h3>
      <span className={`severity-badge ${finding.severity}`}>{finding.severity} priority</span>
    </header>
    <p className="finding-evidence__category">{categoryLabels[finding.category] || finding.category} · {finding.id}</p>
    <p>{finding.description}</p>
    <div className="finding-evidence__rationale"><strong>Evidence behind this flag</strong><p>{finding.evidence}</p></div>
    {!!finding.sources?.length && <div className="finding-evidence__sources">
      <h4>Source records</h4>
      <p className="finding-evidence__caveat">Bundled synthetic card paths, not independently verified evidence.</p>
      <ul>{finding.sources.map((entry, index) => <li key={`${entry.path}-${index}`}>
        <strong>{entry.label}</strong><code>{entry.path}</code><p>{entry.detail}</p>
      </li>)}</ul>
    </div>}
    <p className="finding-evidence__action"><strong>Suggested action:</strong> {finding.recommendation}</p>
  </article>;
}
