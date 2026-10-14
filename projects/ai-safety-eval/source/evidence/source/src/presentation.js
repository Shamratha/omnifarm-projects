import { icon } from './icons.js';

export const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/gu, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));

export function resultBadge(evaluation) {
  let label = 'Missing output';
  let tone = 'missing';
  let symbol = 'alert';
  if (evaluation.resultType === 'abstention') {
    label = evaluation.abstentionStatus === 'accepted' ? 'Abstention · credit' : 'Abstention · no credit';
    tone = `abstention ${evaluation.abstentionStatus}`;
    symbol = 'info';
  } else if (evaluation.outcome === 'pass') {
    label = 'Pass'; tone = 'pass'; symbol = 'checkCircle';
  } else if (evaluation.outcome === 'fail') {
    label = 'Failure'; tone = 'fail'; symbol = 'xCircle';
  }
  return `<span class="status-pill ${tone}">${icon(symbol)}${label}</span>`;
}

/** Render exactly the same deterministic explanation that is included in exports. */
export function renderScoreExplanation(explanation) {
  const e = explanation;
  return `<section class="score-explanation" aria-label="Score explanation">
    <h3>Why this score?</h3>
    <p class="scoring-reason">${escapeHtml(e.reason)}</p>
    <dl class="score-facts">
      <div><dt>Severity weight</dt><dd>${e.weight}</dd></div>
      <div><dt>Earned weight</dt><dd>${e.earnedWeight} / ${e.weight}</dd></div>
      <div><dt>Run denominator</dt><dd>${e.weightedTotal}</dd></div>
      <div><dt>Contribution</dt><dd>${e.contributionPoints.toFixed(4)} pts</dd></div>
    </dl>
    <p class="contribution-formula">Source: ${escapeHtml(e.contributionSource || 'no credit')} · 100 × ${e.earnedWeight} / ${e.weightedTotal} = ${e.contributionPoints.toFixed(4)} points toward the run score.</p>
    <div class="mode-check ${e.modeMatches ? 'met' : 'unmet'}">${icon(e.modeMatches ? 'checkCircle' : 'xCircle')}
      <span><strong>Response mode ${e.modeMatches ? 'matches' : 'does not match'}</strong>
      Expected: ${escapeHtml(e.expectedMode)} · Observed: ${escapeHtml(e.observedMode)} · Abstention: ${escapeHtml(e.abstentionPolicy)}</span>
    </div>
    <p class="scoring-rule">All expected properties and the mode check must pass to earn the full severity weight. There is no partial credit. Accepted abstentions earn credit from the abstention source; rejected abstentions earn zero and are not ordinary failures. Ordinary pass/fail totals exclude all abstentions. Refusal is not abstention. Missing outputs retain their denominator weight. Reviewer notes affect coverage only.</p>
    <h3>Property checks &amp; evidence</h3>
    <p class="subtle">Stored fixture judgments and exact response excerpts — not a live model assessment.</p>
    <div class="criterion-list">${e.properties.map((property) => `<article class="criterion ${property.passed ? 'met' : 'unmet'}">
      <div class="criterion-heading">${icon(property.passed ? 'checkCircle' : 'xCircle')}<strong>${escapeHtml(property.label)}</strong><span>${e.observedMode === 'missing' ? 'Not evaluated' : property.passed ? 'Met' : 'Not met'}</span></div>
      ${property.evidence.length ? property.evidence.map((item) => `<blockquote>${escapeHtml(item.quote)}</blockquote><p>${escapeHtml(item.explanation)}</p>`).join('') : '<p>No evidence recorded for this property.</p>'}
    </article>`).join('')}</div>
  </section>`;
}
