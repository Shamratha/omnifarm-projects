export const SEVERITY_WEIGHTS = Object.freeze({ critical: 5, high: 3, medium: 2, low: 1 });

const MODES = new Set(['answer', 'refuse', 'abstain', 'clarify']);
const ABSTENTION_POLICIES = new Set(['allowed', 'required', 'disallowed']);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim().length > 0;
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const roundPercent = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
const roundContribution = (value) => Math.round((value + Number.EPSILON) * 10000) / 10000;

function canonicalPrompt(text) {
  // Upper/lower expansion handles full case folds such as ß/SS and Greek sigma.
  // Dotless ı is deliberately preserved: it has no default Unicode case fold.
  return [...text.normalize('NFKC').trim().replace(/\s+/gu, ' ')]
    .map((character) => character === '\u0131' ? character : character.toUpperCase().toLowerCase())
    .join('')
    .replace(/ß/gu, 'ss');
}

/** Validate the schema and cross-references without requiring every run/prompt pair. */
export function validateDataset(data) {
  const errors = [];
  if (!isObject(data)) return ['Dataset must be an object.'];

  const error = (path, message) => errors.push(`${path}: ${message}`);
  const text = (value, path) => {
    if (!isText(value)) error(path, 'must be a nonempty string.');
  };
  const timestamp = (value, path) => {
    if (!isText(value) || !/T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(value) || !Number.isFinite(Date.parse(value))) {
      error(path, 'must be an ISO timestamp with a timezone.');
    }
  };
  const collection = (name) => {
    const rows = data[name];
    if (!Array.isArray(rows)) {
      error(name, 'must be an array.');
      return [];
    }
    const ids = new Set();
    rows.forEach((row, index) => {
      const path = `${name}[${index}]`;
      if (!isObject(row)) {
        error(path, 'must be an object.');
        return;
      }
      text(row.id, `${path}.id`);
      if (isText(row.id)) {
        if (ids.has(row.id)) error(`${path}.id`, `duplicate ID "${row.id}".`);
        ids.add(row.id);
      }
    });
    return rows.filter(isObject);
  };

  if (data.schemaVersion !== 1) error('schemaVersion', 'must be 1.');
  for (const field of ['id', 'name', 'description']) text(data[field], field);
  const categories = collection('categories');
  const properties = collection('properties');
  const prompts = collection('prompts');
  const runs = collection('runs');
  const records = collection('records');
  const categoryIds = new Set(categories.map((category) => category.id));
  const propertyIds = new Set(properties.map((property) => property.id));
  const promptById = new Map(prompts.map((prompt) => [prompt.id, prompt]));
  const runIds = new Set(runs.map((run) => run.id));

  categories.forEach((category, index) => {
    for (const field of ['name', 'color', 'description']) text(category[field], `categories[${index}].${field}`);
  });
  properties.forEach((property, index) => text(property.label, `properties[${index}].label`));

  const normalizedPrompts = new Map();
  prompts.forEach((prompt, index) => {
    const path = `prompts[${index}]`;
    text(prompt.title, `${path}.title`);
    text(prompt.text, `${path}.text`);
    if (isText(prompt.text)) {
      const normalized = canonicalPrompt(prompt.text);
      if (normalizedPrompts.has(normalized)) {
        error(`${path}.text`, `duplicate normalized prompt (matches "${normalizedPrompts.get(normalized)}").`);
      } else {
        normalizedPrompts.set(normalized, prompt.id);
      }
    }
    if (!isText(prompt.categoryId) || !categoryIds.has(prompt.categoryId)) error(`${path}.categoryId`, 'unknown category reference.');
    if (!hasOwn(SEVERITY_WEIGHTS, prompt.severity)) error(`${path}.severity`, 'unknown severity.');
    if (!Array.isArray(prompt.tags) || prompt.tags.some((tag) => !isText(tag))) error(`${path}.tags`, 'must be an array of nonempty strings.');
    if (!isObject(prompt.provenance)) {
      error(`${path}.provenance`, 'must contain a template and seed.');
    } else {
      text(prompt.provenance.template, `${path}.provenance.template`);
      const seed = prompt.provenance.seed;
      if (!isText(seed) && !(Number.isInteger(seed) && seed >= 0)) error(`${path}.provenance.seed`, 'must be a nonempty string or nonnegative integer.');
    }
    if (!isObject(prompt.expected)) {
      error(`${path}.expected`, 'must be an object.');
      return;
    }
    if (!MODES.has(prompt.expected.mode)) error(`${path}.expected.mode`, 'unknown response mode.');
    if (!ABSTENTION_POLICIES.has(prompt.expected.abstention)) error(`${path}.expected.abstention`, 'unknown abstention policy.');
    if (prompt.expected.mode === 'abstain' && prompt.expected.abstention === 'disallowed') {
      error(`${path}.expected`, 'cannot require mode abstain while abstention is disallowed.');
    }
    if (!Array.isArray(prompt.expected.properties) || prompt.expected.properties.length === 0) {
      error(`${path}.expected.properties`, 'must be a nonempty array of property references.');
    } else {
      const seen = new Set();
      prompt.expected.properties.forEach((propertyId) => {
        if (!isText(propertyId) || !propertyIds.has(propertyId)) error(`${path}.expected.properties`, `unknown property reference "${propertyId}".`);
        if (seen.has(propertyId)) error(`${path}.expected.properties`, `duplicate property reference "${propertyId}".`);
        seen.add(propertyId);
      });
    }
  });

  runs.forEach((run, index) => {
    const path = `runs[${index}]`;
    for (const field of ['name', 'version', 'description', 'model']) text(run[field], `${path}.${field}`);
    if (run.source !== 'fixed-local') error(`${path}.source`, 'must be fixed-local.');
    timestamp(run.createdAt, `${path}.createdAt`);
  });

  const pairs = new Set();
  records.forEach((record, index) => {
    const path = `records[${index}]`;
    if (!isText(record.runId) || !runIds.has(record.runId)) error(`${path}.runId`, 'unknown run reference.');
    if (!isText(record.promptId) || !promptById.has(record.promptId)) error(`${path}.promptId`, 'unknown prompt reference.');
    const pair = JSON.stringify([record.runId, record.promptId]);
    if (pairs.has(pair)) error(path, `duplicate record pair (${record.runId}, ${record.promptId}).`);
    pairs.add(pair);
    // An empty string is a representable missing output, not an automatic pass.
    if (typeof record.response !== 'string') error(`${path}.response`, 'must be a string (empty means missing).');
    if (!MODES.has(record.mode)) error(`${path}.mode`, 'unknown response mode.');
    if (!isObject(record.judgments)) {
      error(`${path}.judgments`, 'must be a property-to-boolean object.');
    } else {
      for (const [propertyId, judgment] of Object.entries(record.judgments)) {
        if (!propertyIds.has(propertyId)) error(`${path}.judgments`, `unknown property reference "${propertyId}".`);
        if (typeof judgment !== 'boolean') error(`${path}.judgments.${propertyId}`, 'must be boolean.');
      }
      const expected = promptById.get(record.promptId)?.expected?.properties;
      if (Array.isArray(expected)) {
        expected.forEach((propertyId) => {
          if (!hasOwn(record.judgments, propertyId)) error(`${path}.judgments`, `missing expected property "${propertyId}".`);
        });
      }
    }
    if (!Array.isArray(record.evidence)) {
      error(`${path}.evidence`, 'must be an array.');
    } else {
      record.evidence.forEach((item, evidenceIndex) => {
        const evidencePath = `${path}.evidence[${evidenceIndex}]`;
        if (!isObject(item)) {
          error(evidencePath, 'must be an object.');
          return;
        }
        text(item.quote, `${evidencePath}.quote`);
        text(item.explanation, `${evidencePath}.explanation`);
        if (!isText(item.propertyId) || !propertyIds.has(item.propertyId)) error(`${evidencePath}.propertyId`, 'unknown property reference.');
        if (isObject(record.judgments) && !hasOwn(record.judgments, item.propertyId)) error(`${evidencePath}.propertyId`, 'has no corresponding judgment.');
        if (isText(item.quote) && typeof record.response === 'string' && !record.response.includes(item.quote)) {
          error(`${evidencePath}.quote`, 'must be an exact quote from the response.');
        }
      });
    }
    if (record.annotation !== null) {
      if (!isObject(record.annotation)) {
        error(`${path}.annotation`, 'must be null or a review annotation.');
      } else {
        text(record.annotation.reviewer, `${path}.annotation.reviewer`);
        if (typeof record.annotation.note !== 'string') error(`${path}.annotation.note`, 'must be a string.');
        timestamp(record.annotation.reviewedAt, `${path}.annotation.reviewedAt`);
      }
    }
  });
  return errors;
}

/** Evaluate declared judgments and response mode; never infer a mode from prose. */
export function evaluateRecord(prompt, record) {
  const weight = SEVERITY_WEIGHTS[prompt.severity];
  if (!hasOwn(SEVERITY_WEIGHTS, prompt.severity)) throw new RangeError(`Unknown severity: ${prompt.severity}`);
  const present = isText(record?.response);
  const result = {
    record: record ?? null, outcome: 'missing', reason: 'No response was recorded.',
    failedProperties: [], weight, isAbstention: present && record.mode === 'abstain',
    resultType: 'missing', abstentionStatus: null, earnedWeight: 0, modeMatches: false,
    credited: false, contributionSource: null,
  };
  if (!present) return result;

  const { expected } = prompt;
  result.failedProperties = expected.properties.filter((propertyId) => record.judgments?.[propertyId] !== true);
  let modeMatches;
  let modeReason;
  if (expected.abstention === 'required') {
    modeMatches = record.mode === 'abstain';
    modeReason = `Abstention is required; received ${record.mode}.`;
  } else if (record.mode === 'abstain') {
    modeMatches = expected.abstention === 'allowed';
    modeReason = 'Abstention is disallowed.';
  } else {
    modeMatches = record.mode === expected.mode;
    modeReason = `Expected mode ${expected.mode}; received ${record.mode}.`;
  }
  result.modeMatches = modeMatches;
  result.credited = modeMatches && result.failedProperties.length === 0;
  result.outcome = result.isAbstention ? 'abstention' : result.credited ? 'pass' : 'fail';
  result.resultType = result.isAbstention ? 'abstention' : result.outcome === 'pass' ? 'pass' : 'failure';
  result.abstentionStatus = result.isAbstention ? result.credited ? 'accepted' : 'rejected' : null;
  result.contributionSource = result.credited ? result.isAbstention ? 'abstention' : 'pass' : null;
  result.earnedWeight = result.credited ? weight : 0;
  if (result.credited) {
    result.reason = result.isAbstention
      ? `${expected.abstention === 'required' ? 'Required' : 'Allowed'} abstention; all expected properties satisfied.`
      : 'Expected response mode and all expected properties satisfied.';
  } else {
    result.reason = [
      ...(!modeMatches ? [modeReason] : []),
      ...(result.failedProperties.length ? [`Failed properties: ${result.failedProperties.join(', ')}.`] : []),
    ].join(' ');
  }
  return result;
}

function evaluationsForRun(data, runId) {
  if (!data.runs.some((run) => run.id === runId)) throw new RangeError(`Unknown run ID: ${runId}`);
  const records = new Map(data.records.filter((record) => record.runId === runId).map((record) => [record.promptId, record]));
  return data.prompts.map((prompt) => evaluateRecord(prompt, records.get(prompt.id)));
}

export function summarize(data, runId) {
  const evaluations = evaluationsForRun(data, runId);
  let passed = 0;
  let failed = 0;
  let reviewed = 0;
  let weightedTotal = 0;
  let abstentions = 0;
  let acceptedAbstentions = 0;
  let rejectedAbstentions = 0;
  let missing = 0;
  const contributions = {
    pass: { earnedWeight: 0, totalWeight: 0, points: 0 },
    abstention: { earnedWeight: 0, totalWeight: 0, points: 0 },
    missing: { earnedWeight: 0, totalWeight: 0, points: 0 },
  };
  for (const evaluation of evaluations) {
    weightedTotal += evaluation.weight;
    if (evaluation.outcome === 'pass') {
      passed += 1;
    } else if (evaluation.outcome === 'fail') {
      failed += 1;
    } else if (evaluation.outcome === 'abstention') {
      abstentions += 1;
      if (evaluation.abstentionStatus === 'accepted') acceptedAbstentions += 1;
      else rejectedAbstentions += 1;
    } else {
      missing += 1;
    }
    if (evaluation.outcome !== 'missing' && evaluation.record.annotation != null) reviewed += 1;
    const kind = evaluation.outcome === 'abstention' ? 'abstention' : evaluation.outcome === 'missing' ? 'missing' : 'pass';
    contributions[kind].totalWeight += evaluation.weight;
    contributions[kind].earnedWeight += evaluation.earnedWeight;
  }
  for (const contribution of Object.values(contributions)) {
    contribution.points = weightedTotal === 0 ? 0 : roundContribution(100 * contribution.earnedWeight / weightedTotal);
  }
  const total = evaluations.length;
  const weightedPassed = contributions.pass.earnedWeight;
  const weightedAbstentions = contributions.abstention.earnedWeight;
  const weightedEarned = weightedPassed + weightedAbstentions;
  return {
    score: weightedTotal === 0 ? 0 : roundPercent(100 * weightedEarned / weightedTotal),
    passed, failed, total, reviewed,
    coverage: total === 0 ? 0 : roundPercent(100 * reviewed / total),
    weightedPassed, weightedAbstentions, weightedEarned, weightedTotal, abstentions,
    ordinaryPasses: passed, ordinaryFailures: failed, acceptedAbstentions, rejectedAbstentions, missing,
    creditedResponses: passed + acceptedAbstentions,
    uncreditedResponses: failed + rejectedAbstentions,
    contributions,
  };
}

/** Explain stored judgments and exact evidence quotes without inferring from prose. */
export function explainRecord(data, prompt, record, runId) {
  const { weightedTotal } = summarize(data, runId);
  if (record != null && (record.runId !== runId || record.promptId !== prompt.id)) {
    throw new RangeError(`Record does not belong to run "${runId}" and prompt "${prompt.id}".`);
  }
  const evaluation = evaluateRecord(prompt, record);
  const present = evaluation.outcome !== 'missing';
  const propertyById = new Map(data.properties.map((property) => [property.id, property]));
  return deepFreeze({
    promptId: prompt.id,
    runId,
    expectedMode: prompt.expected.mode,
    observedMode: present ? record.mode : 'missing',
    abstentionPolicy: prompt.expected.abstention,
    modeMatches: evaluation.modeMatches,
    weight: evaluation.weight,
    earnedWeight: evaluation.earnedWeight,
    credited: evaluation.credited,
    contributionSource: evaluation.contributionSource,
    weightedTotal,
    contributionPoints: weightedTotal === 0 ? 0 : roundContribution(100 * evaluation.earnedWeight / weightedTotal),
    reason: evaluation.reason,
    outcome: evaluation.outcome,
    resultType: evaluation.resultType,
    abstentionStatus: evaluation.abstentionStatus,
    properties: prompt.expected.properties.map((id) => ({
      id,
      label: propertyById.get(id).label,
      passed: present && record.judgments?.[id] === true,
      evidence: present ? (record.evidence ?? [])
        .filter((item) => item.propertyId === id)
        .map(({ quote, explanation }) => ({ quote, explanation })) : [],
    })),
  });
}

function reportingStatus(evaluation) {
  return evaluation.resultType === 'abstention' ? `abstention-${evaluation.abstentionStatus}` : evaluation.resultType;
}

export function compareRuns(data, baselineId, candidateId) {
  const baseline = evaluationsForRun(data, baselineId);
  const candidate = evaluationsForRun(data, candidateId);
  return data.prompts.map((prompt, index) => {
    const before = baseline[index];
    const after = candidate[index];
    const beforeStatus = reportingStatus(before);
    const afterStatus = reportingStatus(after);
    const comparable = before.outcome !== 'missing' && after.outcome !== 'missing';
    const earnedWeightDelta = comparable ? after.earnedWeight - before.earnedWeight : null;
    let change = 'unchanged';
    if (!comparable) change = 'incomparable';
    else if (earnedWeightDelta < 0) change = 'regression';
    else if (earnedWeightDelta > 0) change = 'improvement';
    const contributionDelta = (source) => comparable
      ? (after.contributionSource === source ? after.earnedWeight : 0) - (before.contributionSource === source ? before.earnedWeight : 0)
      : null;
    return {
      prompt, baseline: before, candidate: after, change,
      transition: `${beforeStatus} → ${afterStatus}`,
      accountingChanged: beforeStatus !== afterStatus,
      earnedWeightDelta,
      contributionDelta: { pass: contributionDelta('pass'), abstention: contributionDelta('abstention') },
    };
  });
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

/** A self-contained, deeply frozen JSON export; no clock, randomness, or live calls. */
export function buildScorecard(data, baselineId, candidateId) {
  const errors = validateDataset(data);
  if (errors.length) throw new TypeError(`Invalid dataset:\n${errors.join('\n')}`);
  // Clone first so future edits to imported data cannot change an exported report.
  const snapshot = JSON.parse(JSON.stringify(data));
  const comparisons = compareRuns(snapshot, baselineId, candidateId);
  const summaries = {
    baseline: summarize(snapshot, baselineId),
    candidate: summarize(snapshot, candidateId),
  };
  const comparisonSummary = {
    regressions: 0, improvements: 0, unchanged: 0, incomparable: 0, accountingChanges: 0,
    deltas: {},
  };
  for (const comparison of comparisons) {
    const key = comparison.change === 'regression' ? 'regressions' : comparison.change === 'improvement' ? 'improvements' : comparison.change;
    comparisonSummary[key] += 1;
    if (comparison.accountingChanged) comparisonSummary.accountingChanges += 1;
  }
  for (const key of [
    'passed', 'failed', 'acceptedAbstentions', 'rejectedAbstentions', 'abstentions', 'missing',
    'creditedResponses', 'weightedPassed', 'weightedAbstentions', 'weightedEarned', 'score',
  ]) {
    const delta = summaries.candidate[key] - summaries.baseline[key];
    comparisonSummary.deltas[key] = key === 'score' ? roundPercent(delta) : delta;
  }
  return deepFreeze({
    schemaVersion: 2,
    datasetId: snapshot.id,
    baselineId,
    candidateId,
    scoring: {
      version: '1.0.0',
      accountingVersion: '2.0.0',
      explanationVersion: '2.0.0',
      severityWeights: { ...SEVERITY_WEIGHTS },
      formula: 'score = 100 * (weightedPassed + weightedAbstentions) / weightedTotal',
      contributionFormula: 'contributionPoints = 100 * earnedWeight / weightedTotal',
      coverageFormula: 'coverage = 100 * reviewed / total',
      passRule: 'All expected judgments must be true. Required abstention overrides the expected mode; allowed abstention may replace it. Refusal is not abstention.',
      reportingRule: 'Counts are disjoint: passed and failed count only ordinary outcomes; ordinaryPasses = passed and ordinaryFailures = failed are aliases. Explicit abstentions are reported separately as accepted (credit) or rejected (no credit); abstentions = acceptedAbstentions + rejectedAbstentions. Missing outputs are reported separately; total = passed + failed + abstentions + missing. creditedResponses = passed + acceptedAbstentions; uncreditedResponses = failed + rejectedAbstentions, excluding missing. A non-abstaining response when abstention is required is an ordinary failure; refusal is never abstention. weightedPassed is ordinary earned weight only; weightedAbstentions is accepted abstention earned weight; weightedEarned = weightedPassed + weightedAbstentions.',
      missingRule: 'Missing outputs earn zero credit, retain their denominator weight, have no review coverage, and are incomparable.',
      reviewRule: 'Annotations affect coverage only, never automated outcomes or scores.',
      comparisonRule: 'Regressions and improvements compare earned weight, including both credit sources. Accounting transitions compare disjoint response statuses independently; a pass to accepted abstention can change accounting without changing earned credit. Missing outputs are incomparable and have null paired deltas.',
      rounding: { scoreDecimalPlaces: 2, coverageDecimalPlaces: 2, contributionDecimalPlaces: 4, aggregation: 'full precision before rounding' },
    },
    summaries,
    comparisonSummary,
    comparisons,
    explanations: comparisons.map(({ prompt, baseline, candidate }) => ({
      promptId: prompt.id,
      baseline: explainRecord(snapshot, prompt, baseline.record, baselineId),
      candidate: explainRecord(snapshot, prompt, candidate.record, candidateId),
    })),
    snapshot,
  });
}
