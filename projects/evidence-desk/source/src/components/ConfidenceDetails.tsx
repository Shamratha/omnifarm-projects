import { evidenceCatalog } from '../data/case'
import { FINDING_CATEGORIES, type ConfidenceAssessment, type ConfidenceSummary } from '../domain/evidence'

export function ConfidenceDetails({ assessment, onEvidence }: { assessment: ConfidenceAssessment; onEvidence: (id: string) => void }) {
  const contributions = [
    ...assessment.contributions.filter((contribution) => contribution.code === 'HASH_DECLARATION'),
    ...FINDING_CATEGORIES.flatMap((category) => assessment.contributions.filter((contribution) => contribution.code === category.code)),
  ]
  return <section className="confidence-details" aria-label={`Confidence evidence for ${assessment.evidenceId}`}>
    <h3>Why this score?</h3>
    <div className="confidence-arithmetic"><strong>{assessment.calculation}</strong><span>Baseline {assessment.baseScore} · deductions {assessment.totalPenalty} points</span></div>
    <p className="score-policy">Each finding category deducts once per record, even with multiple supports. High ≥80 · medium ≥60 · low &lt;60. This is an integrity heuristic, not a probability of truth.</p>
    {contributions.map((contribution) => {
      const category = FINDING_CATEGORIES.find((category) => category.code === contribution.code)
      return <article className="score-contribution" data-review-code={contribution.code} key={contribution.code}>
      {category && <div className="score-category"><h4>{category.title}</h4><p>{category.description}</p></div>}
      <div className="contribution-heading"><strong>{contribution.label}</strong><span>{contribution.penalty === 0 ? '0 points' : `−${Math.abs(contribution.penalty)} points · once`}</span></div>
      {contribution.supports.map((support, index) => <div className="contribution-support" key={index}>
        <p>{support.message}</p>
        <div className="confidence-links">{support.evidenceIds.map((id) => <button key={id} className="text-button" disabled={!evidenceCatalog[id]} onClick={() => onEvidence(id)}>{id}{id === assessment.evidenceId ? ' · this record' : ' · inspect related'}</button>)}</div>
        <details><summary>Supporting facts ({support.facts.length})</summary><ul>{support.facts.map((fact, factIndex) => <li key={factIndex}>{fact}</li>)}</ul></details>
      </div>)}
    </article>})}
  </section>
}

export function ConfidenceMean({ summary, onEvidence }: { summary: ConfidenceSummary; onEvidence: (id: string) => void }) {
  return <section className="confidence-mean" aria-label="Confidence mean evidence">
    <h3>{summary.score === null ? 'No confidence mean available' : `Mean integrity score: ${summary.score}%`}</h3>
    <code>{summary.calculation}</code>
    <p>Arithmetic mean, rounded once. Every retained record is listed below, including duplicate imports; this is not independent corroboration. Open a record for its deductions and supporting facts.</p>
    <div className="mean-inputs">{summary.assessments.map((assessment, index) => <button key={`${assessment.evidenceId}-${index}`} onClick={() => onEvidence(assessment.evidenceId)}>
      <strong>{assessment.evidenceId}</strong><span>{assessment.score}%</span><small>{assessment.calculation}</small>
    </button>)}</div>
  </section>
}
