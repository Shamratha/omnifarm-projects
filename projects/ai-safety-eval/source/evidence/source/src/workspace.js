import { validateDataset } from './evaluation.js';

export const STORAGE_KEY = 'guardrail.review-annotations.v1';

export function loadWorkspace(base, storage) {
  const data = structuredClone(base);
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return { data, error: null };
    const annotations = JSON.parse(raw);
    if (!annotations || typeof annotations !== 'object' || Array.isArray(annotations)) throw new Error('Invalid annotations');
    for (const record of data.records) {
      if (Object.hasOwn(annotations, record.id)) record.annotation = annotations[record.id];
    }
    if (validateDataset(data).length) throw new Error('Invalid annotations');
    return { data, error: null };
  } catch {
    return { data: structuredClone(base), error: 'Saved reviews could not be loaded. Bundled reviews are shown; this session still works.' };
  }
}

export function saveReview(data, recordId, review, storage, reviewedAt) {
  const record = data.records.find((item) => item.id === recordId);
  if (!record) throw new RangeError('Unknown response record.');
  const annotation = {
    reviewer: String(review.reviewer || '').trim() || 'Local reviewer',
    note: String(review.note || '').trim(),
    reviewedAt,
  };
  const candidate = { ...data, records: data.records.map((item) => item.id === recordId ? { ...item, annotation } : item) };
  if (validateDataset(candidate).length) throw new TypeError('Invalid reviewer annotation.');
  record.annotation = annotation;
  try {
    const annotations = Object.fromEntries(data.records.map((item) => [item.id, item.annotation]));
    storage.setItem(STORAGE_KEY, JSON.stringify(annotations));
    return { persisted: true };
  } catch {
    return { persisted: false };
  }
}

export function filterRows(rows, { query = '', category = 'all', severity = 'all', outcome = 'all' } = {}) {
  const search = query.trim().toLowerCase();
  return rows.filter((row) => {
    const { prompt, candidate, change } = row;
    if (search && !`${prompt.id} ${prompt.title} ${prompt.text} ${prompt.tags.join(' ')} ${prompt.categoryId}`.toLowerCase().includes(search)) return false;
    if (category !== 'all' && prompt.categoryId !== category) return false;
    if (severity !== 'all' && prompt.severity !== severity) return false;
    if (outcome === 'failures' && candidate.resultType !== 'failure') return false;
    if (outcome === 'nonpassing' && (candidate.outcome === 'missing' || candidate.credited)) return false;
    if (outcome === 'regressions' && change !== 'regression') return false;
    if (outcome === 'improvements' && change !== 'improvement') return false;
    if (outcome === 'review' && candidate.record?.annotation) return false;
    if (outcome === 'passes' && candidate.resultType !== 'pass') return false;
    if (outcome === 'credited' && !candidate.credited) return false;
    if (outcome === 'abstentions' && !candidate.isAbstention) return false;
    if (outcome === 'accepted-abstentions' && candidate.abstentionStatus !== 'accepted') return false;
    if (outcome === 'rejected-abstentions' && candidate.abstentionStatus !== 'rejected') return false;
    if (outcome === 'missing' && candidate.outcome !== 'missing') return false;
    return true;
  });
}

export function scorecardCsv(scorecard) {
  // Neutralize formula-like cells when opening an exported file in a spreadsheet.
  const cell = (value) => {
    const text = String(value ?? '');
    return `"${(/^[\s]*[=+@-]/u.test(text) ? "'" : '') + text.replaceAll('"', '""')}"`;
  };
  const explanations = new Map(scorecard.explanations.map((item) => [item.promptId, item.candidate]));
  const header = ['prompt_id', 'title', 'category', 'severity', 'weight', 'expected_mode', 'abstention_policy', 'baseline_run', 'baseline_outcome', 'candidate_run', 'candidate_outcome', 'change', 'transition', 'accounting_changed', 'earned_weight_delta', 'pass_earned_weight_delta', 'abstention_earned_weight_delta', 'failed_properties', 'candidate_response', 'reviewer', 'review_note', 'baseline_result_type', 'candidate_result_type', 'candidate_credited', 'candidate_contribution_source', 'candidate_abstention_status', 'observed_mode', 'mode_matches', 'earned_weight', 'weighted_total', 'contribution_points', 'score_reason', 'property_evidence_json'];
  const rows = scorecard.comparisons.map(({ prompt, baseline, candidate, change, transition, accountingChanged, earnedWeightDelta, contributionDelta }) => [
    prompt.id, prompt.title, prompt.categoryId, prompt.severity, candidate.weight,
    prompt.expected.mode, prompt.expected.abstention, scorecard.baselineId, baseline.outcome,
    scorecard.candidateId, candidate.outcome, change, transition, accountingChanged, earnedWeightDelta,
    contributionDelta.pass, contributionDelta.abstention, candidate.failedProperties.join('; '),
    candidate.record?.response, candidate.record?.annotation?.reviewer, candidate.record?.annotation?.note,
    baseline.resultType, candidate.resultType, candidate.credited, candidate.contributionSource, candidate.abstentionStatus, explanations.get(prompt.id).observedMode,
    candidate.modeMatches, candidate.earnedWeight, explanations.get(prompt.id).weightedTotal,
    explanations.get(prompt.id).contributionPoints, candidate.reason,
    JSON.stringify(explanations.get(prompt.id).properties),
  ]);
  return [header, ...rows].map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
