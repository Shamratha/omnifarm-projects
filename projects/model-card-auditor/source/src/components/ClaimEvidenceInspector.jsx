import { useId, useState } from 'react';
import { inspectClaimEvidence } from '../lib/audit.js';
import './claim-evidence.css';

const referenceLabels = {
  resolved: 'Resolved reference',
  missing: 'Missing evidence',
  incomplete: 'Incomplete evidence',
  invalid: 'Invalid reference',
};

// Keep filters and native disclosure state local to the selected card.
export default function ClaimEvidenceInspector({ card }) {
  return <Inspector key={card.id} card={card} />;
}

function Inspector({ card }) {
  const id = useId();
  const [filter, setFilter] = useState('unsupported');
  const claims = inspectClaimEvidence(card);
  const completeCount = claims.filter((claim) => claim.referenceComplete).length;
  const unsupportedCount = claims.length - completeCount;
  const visibleClaims = claims.filter((claim) => filter === 'all'
    || (filter === 'complete' ? claim.referenceComplete : !claim.referenceComplete));

  return <section className="claim-evidence" aria-labelledby={`${id}-heading`}>
    <h3 id={`${id}-heading`} className="claim-evidence__heading" tabIndex="-1">Claim evidence inspector</h3>
    <p className="claim-evidence__notice" id={`${id}-notice`}>
      Status describes reference completeness only, not verified truth. Evidence content is not
      semantically checked for relevance or mismatches with a claim. Review the actual source text;
      complete references can still be irrelevant. Only bundled records are inspected; links are never fetched.
    </p>
    <div className="claim-evidence__filter">
      <label htmlFor={`${id}-filter`}>Claim evidence filter</label>
      <select id={`${id}-filter`} value={filter} onChange={(event) => setFilter(event.target.value)}
        aria-describedby={`${id}-notice`}>
        <option value="unsupported">Unsupported claims</option>
        <option value="all">All claims</option>
        <option value="complete">Complete references</option>
      </select>
    </div>
    <p className="claim-evidence__counts" role="status">
      Showing {visibleClaims.length} of {claims.length} claims. {unsupportedCount} unsupported; {completeCount} with complete references.
    </p>
    <div className="claim-evidence__claims">
      {visibleClaims.map((claim) => <details className="claim-evidence__claim" key={claim.id}>
        <summary>
          <span className="claim-evidence__id">{claim.id}</span>{' '}
          <span className={`claim-evidence__badge${claim.referenceComplete ? ' claim-evidence__badge--complete' : ''}`}>
            {claim.referenceComplete ? 'Complete references' : 'Unsupported'}
          </span>
        </summary>
        <div className="claim-evidence__body">
          <p className="claim-evidence__text">{claim.text || 'No claim text documented.'}</p>
          <p className="claim-evidence__path">Claim source: <code>{claim.path}</code></p>
          <h4>Reference completeness reasons</h4>
          {claim.reasons.length > 0 ? <ul className="claim-evidence__reasons">
            {claim.reasons.map((reason, index) => <li key={index}>{reason}</li>)}
          </ul> : <p>No reference gaps found. This does not verify the claim.</p>}
          <h4>Evidence references</h4>
          {claim.references.length > 0 ? <ul className="claim-evidence__references">
            {claim.references.map((reference, index) => <li key={index}
              className={`claim-evidence__reference claim-evidence__reference--${reference.status}`}>
              <p className="claim-evidence__reference-heading">
                <code>{reference.id || '(invalid ID)'}</code>{' · '}
                <strong>{referenceLabels[reference.status]} ({reference.status})</strong>
              </p>
              {reference.title && <p><strong>Title:</strong> {reference.title}</p>}
              {reference.description && <p><strong>Description:</strong> {reference.description}</p>}
              <p className="claim-evidence__path">Evidence source: {reference.path
                ? <code>{reference.path}</code> : 'No local evidence path.'}</p>
              {reference.reason && <p><strong>Reference detail:</strong> {reference.reason}</p>}
            </li>)}
          </ul> : <p className="claim-evidence__empty">No evidence references are recorded for this claim.</p>}
        </div>
      </details>)}
      {!claims.length && <p className="claim-evidence__empty">No claims are documented for this card.</p>}
      {claims.length > 0 && !visibleClaims.length && <p className="claim-evidence__empty">
        {filter === 'unsupported' ? 'No unsupported claims: every claim has complete references. This does not verify their truth.'
          : 'No claims have complete references. Select another filter to inspect the reference gaps.'}
      </p>}
    </div>
  </section>;
}
