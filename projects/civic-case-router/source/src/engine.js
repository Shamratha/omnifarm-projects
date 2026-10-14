import {
  DEMO_NOW,
  policies as defaultPolicies,
  teams as defaultTeams,
  syntheticCases,
} from './data.js';

const CATEGORY_LABELS = {
  housing: 'Housing',
  benefits: 'Benefits',
  'public-works': 'Public works',
  health: 'Health access',
  permits: 'Permits',
  general: 'General service',
};

const PRIORITY_RANK = { urgent: 3, high: 2, normal: 1 };

const ACCESS_LABELS = {
  interpreter: 'Interpreter',
  'step-free': 'Step-free access',
  'large-print': 'Large print',
  'screen-reader': 'Screen-reader compatible format',
};
const MASK = 'xxxxxxxx';

function compareText(left, right) {
  const a = String(left ?? '');
  const b = String(right ?? '');
  return a < b ? -1 : a > b ? 1 : 0;
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneValue(entry)]));
  }
  return value;
}

function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/ـ/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    // Match Arabic definite articles as well as their unprefixed policy terms.
    .map((word) => /^ال[\u0600-\u06ff]{2}/u.test(word) ? word.slice(2) : word)
    .join(' ');
}

function inputText(input) {
  const fieldText = Array.isArray(input?.fields)
    ? input.fields.filter((field) => !field?.sensitive)
      .map((field) => `${field?.label ?? ''} ${field?.value ?? ''}`).join(' ')
    : '';
  const documentText = Array.isArray(input?.documents)
    ? input.documents.map((document) => document?.type ?? '').join(' ')
    : '';
  return normalizeText([input?.subject, input?.summary, fieldText, documentText].filter(Boolean).join(' '));
}

function recognizedCategory(value) {
  const category = normalizeText(value).replace(/ /g, '-');
  return Object.prototype.hasOwnProperty.call(CATEGORY_LABELS, category) ? category : null;
}

function policyForCategory(category, policies) {
  return policies.find((policy) => policy?.category === category) ?? null;
}

function classify(input, policies) {
  const text = inputText(input);
  const hint = input?.categoryHint == null ? null : recognizedCategory(input.categoryHint);
  const hasUnsupportedHint = input?.categoryHint != null && (!hint || !policyForCategory(hint, policies));
  const scores = new Map();
  const termsByCategory = new Map();

  for (const policy of policies) {
    const category = recognizedCategory(policy?.category);
    if (!category) continue;
    const terms = termsByCategory.get(category) ?? [];
    const normalizedTerms = new Set(terms.map(normalizeText));
    for (const keyword of Array.isArray(policy.keywords) ? policy.keywords : []) {
      const normalizedKeyword = normalizeText(keyword);
      if (normalizedKeyword && ` ${text} `.includes(` ${normalizedKeyword} `) && !normalizedTerms.has(normalizedKeyword)) {
        terms.push(String(keyword));
        normalizedTerms.add(normalizedKeyword);
      }
    }
    scores.set(category, terms.length);
    termsByCategory.set(category, terms);
  }

  const scored = [...scores.entries()].sort((left, right) => {
    if (right[1] !== left[1]) return right[1] - left[1];
    return compareText(left[0], right[0]);
  });
  const top = scored[0];
  const second = scored[1];
  const isTie = Boolean(top && second && top[1] === second[1] && top[1] > 0);
  const hasEvidence = Boolean(top && top[1] > 0);
  const hintSupported = Boolean(hint && policyForCategory(hint, policies));
  const hintConflict = hintSupported && hasEvidence && top[0] !== hint;
  const isUnsupported = hasUnsupportedHint || (!hasEvidence && !hintSupported);
  const isAmbiguous = isTie || hintConflict;
  const manualReview = isUnsupported || isAmbiguous;
  const category = manualReview ? 'general' : (hintSupported ? hint : top[0]);
  const policy = policyForCategory(category, policies);
  const matchedTerms = manualReview
    ? [...new Set([...termsByCategory.values()].flat())]
    : termsByCategory.get(category) ?? [];
  const hintUsed = hint === category;
  let confidence = 0;
  if (!manualReview) confidence = hintUsed && matchedTerms.length ? 0.98 : hintUsed ? 0.8 : Math.min(0.95, 0.7 + matchedTerms.length * 0.05);
  else if (matchedTerms.length) confidence = 0.35;

  let reason;
  if (isAmbiguous) reason = 'Service evidence is ambiguous or conflicts with the hint; the general intake desk must confirm the destination.';
  else if (hasUnsupportedHint) reason = 'The supplied service hint is unsupported; a reviewer must confirm the destination.';
  else if (manualReview) reason = 'No supported service keywords were found; a reviewer must confirm the destination.';
  else if (hintUsed && matchedTerms.length) reason = 'The service hint agrees with normalized policy keywords.';
  else if (hintUsed) reason = 'The supported service hint selected the policy category.';
  else reason = 'Normalized policy keywords identified the service category.';

  return {
    classification: {
      category,
      label: CATEGORY_LABELS[category] ?? category,
      confidence,
      matchedTerms,
      source: manualReview ? 'manual-review' : hintUsed ? (matchedTerms.length ? 'hint+keywords' : 'hint') : 'keywords',
      reason,
    },
    policy,
    manualReview,
  };
}

function parseDate(value) {
  const time = value instanceof Date ? value.getTime()
    : typeof value === 'number' ? value
      : typeof value === 'string' && value.trim() ? Date.parse(value) : NaN;
  return Number.isFinite(time) && Math.abs(time) <= 8640000000000000 ? time : null;
}

function roundNumber(value, digits = 2) {
  const power = 10 ** digits;
  return Math.round(value * power) / power;
}

const DEADLINE_THRESHOLDS = Object.freeze([
  { id: 'urgent', label: 'Urgent cutoff', hours: 24, comparison: '<=', outcome: 'urgent' },
  { id: 'high', label: 'High cutoff', hours: 72, comparison: '<=', outcome: 'high' },
]);

const HOUR_MS = 3600000;

function deadlinePriority(hoursRemaining) {
  if (hoursRemaining == null) return 'normal';
  return DEADLINE_THRESHOLDS.find((rule) => hoursRemaining <= rule.hours)?.outcome ?? 'normal';
}

function deadlineBoundaryExamples(nowTime) {
  return [
    ['overdue', 'Overdue by 1ms', -1, 'remaining <= 24h'],
    ['due-now', 'Due now', 0, 'remaining <= 24h'],
    ['urgent-cutoff', 'Exactly 24h', 24 * HOUR_MS, 'remaining <= 24h'],
    ['urgent-next', '24h + 1ms', 24 * HOUR_MS + 1, '24h < remaining <= 72h'],
    ['high-cutoff', 'Exactly 72h', 72 * HOUR_MS, '24h < remaining <= 72h'],
    ['high-next', '72h + 1ms', 72 * HOUR_MS + 1, 'remaining > 72h'],
  ].map(([id, label, offsetMilliseconds, rule]) => ({
    id, label, offsetMilliseconds, hoursFromNow: offsetMilliseconds / HOUR_MS,
    deadlineAt: new Date(nowTime + offsetMilliseconds).toISOString(),
    resultingPriority: deadlinePriority(offsetMilliseconds / HOUR_MS), rule,
  }));
}

function deadlineDetails(input, policy, nowTime) {
  const supplied = input?.deadline != null && input.deadline !== '';
  const receivedTime = parseDate(input?.receivedAt);
  const submittedTime = supplied ? parseDate(input?.deadline) : null;
  const evaluatedAt = new Date(nowTime).toISOString();
  const policySlaHours = Number.isFinite(policy?.slaHours) && policy.slaHours > 0 ? policy.slaHours : null;
  let deadlineTime = submittedTime;
  let source = supplied ? 'deadline' : 'none';
  let calculation;
  if (!supplied && receivedTime != null && policySlaHours != null) {
    deadlineTime = parseDate(receivedTime + policySlaHours * HOUR_MS);
    source = deadlineTime == null ? 'none' : 'sla';
    calculation = deadlineTime == null
      ? 'Policy SLA would produce an out-of-range deadline; confirm it through review'
      : `receivedAt ${new Date(receivedTime).toISOString()} + policy SLA ${policySlaHours}h = ${new Date(deadlineTime).toISOString()}`;
  } else if (supplied && submittedTime != null) {
    calculation = `submitted deadline ${new Date(submittedTime).toISOString()} takes precedence over the policy SLA`;
  } else if (supplied) {
    calculation = `submitted deadline ${String(input.deadline)} could not be parsed; no replacement deadline was inferred`;
  } else {
    calculation = 'no submitted deadline and no usable receivedAt/policy SLA pair were available';
  }
  if (deadlineTime == null) {
    return {
      hoursRemaining: null,
      dueLabel: supplied ? 'Deadline needs review' : 'No deadline available',
      source,
      sourceLabel: supplied ? 'Submitted deadline (invalid)' : 'No usable deadline',
      submittedDeadline: input?.deadline ?? null,
      receivedAt: receivedTime == null ? null : new Date(receivedTime).toISOString(),
      policySlaHours: Number.isFinite(policy?.slaHours) ? policy.slaHours : null,
      deadlineAt: null,
      evaluatedAt,
      remainingMilliseconds: null,
      deadlinePriority: 'normal',
      priorityOverride: input?.safetyRisk === true ? 'Reported safety risk overrides deadline priority to urgent.' : null,
      calculation,
      thresholdRules: cloneValue(DEADLINE_THRESHOLDS),
      boundaryExamples: deadlineBoundaryExamples(nowTime),
      invalid: supplied,
    };
  }
  const remainingMilliseconds = deadlineTime - nowTime;
  const hoursRemaining = remainingMilliseconds / HOUR_MS;
  let dueLabel;
  if (hoursRemaining < 0) dueLabel = `Overdue by ${Math.abs(hoursRemaining) <= 24 ? `${Math.ceil(-hoursRemaining)}h` : `${Math.ceil(-hoursRemaining / 24)}d`}`;
  else if (hoursRemaining === 0) dueLabel = 'Due now';
  else if (hoursRemaining <= 24) dueLabel = `Due in ${Math.ceil(hoursRemaining)}h`;
  else dueLabel = `Due in ${Math.ceil(hoursRemaining / 24)}d`;
  return {
    hoursRemaining,
    dueLabel,
    source,
    sourceLabel: source === 'sla' ? 'Policy SLA from received time' : 'Submitted deadline',
    submittedDeadline: input?.deadline ?? null,
    receivedAt: receivedTime == null ? null : new Date(receivedTime).toISOString(),
    policySlaHours: Number.isFinite(policy?.slaHours) ? policy.slaHours : null,
    deadlineAt: new Date(deadlineTime).toISOString(),
    evaluatedAt,
    remainingMilliseconds,
    deadlinePriority: deadlinePriority(hoursRemaining),
    priorityOverride: input?.safetyRisk === true ? 'Reported safety risk overrides deadline priority to urgent.' : null,
    calculation: `${calculation}; (${new Date(deadlineTime).toISOString()} − ${evaluatedAt}) / 3,600,000ms = ${hoursRemaining}h remaining`,
    thresholdRules: cloneValue(DEADLINE_THRESHOLDS),
    boundaryExamples: deadlineBoundaryExamples(nowTime),
    invalid: false,
  };
}

function missingDocuments(input, policy) {
  const documents = Array.isArray(input?.documents) ? input.documents : [];
  const receivedTypes = new Set(
    documents.filter((document) => document?.status === 'received').map((document) => document?.type),
  );
  return (Array.isArray(policy?.requiredDocuments) ? policy.requiredDocuments : [])
    .filter((required) => required && !receivedTypes.has(required.type))
    .map((required) => ({ type: required.type, label: required.label }));
}

function languageName(input) {
  return input?.languageLabel || input?.language || 'unspecified language';
}

function calculatePriority(input, deadline, missing, classification) {
  let level = deadlinePriority(deadline.hoursRemaining);
  if (input?.safetyRisk === true) level = 'urgent';

  const reasons = [];
  if (deadline.hoursRemaining != null && deadline.hoursRemaining <= 24) reasons.push('Deadline is within 24 hours.');
  else if (deadline.hoursRemaining != null && deadline.hoursRemaining <= 72) reasons.push('Deadline is within 72 hours.');
  else if (deadline.hoursRemaining != null) reasons.push('Deadline is outside the 72-hour escalation window.');
  else reasons.push('No usable deadline was supplied.');
  if (input?.safetyRisk === true) reasons.push('Reported safety risk requires prompt human attention.');
  if (input?.language && languageCode(input.language) !== 'en') reasons.push(`Preferred language retained: ${languageName(input)}.`);
  if (Array.isArray(input?.accommodations) && input.accommodations.length) reasons.push('Access requirements increase handling attention and must be preserved.');
  if (missing.length) reasons.push(`${missing.length} required document${missing.length === 1 ? '' : 's'} remain outstanding; intake is still accepted.`);
  if (classification.manualReview) reasons.push('Classification needs a manual confirmation.');

  const baseScore = level === 'urgent' ? 90 : level === 'high' ? 65 : 35;
  const attention = (input?.safetyRisk === true ? 8 : 0)
    + (Array.isArray(input?.accommodations) ? new Set(input.accommodations).size * 2 : 0)
    + (missing.length ? 3 : 0)
    + (classification.manualReview ? 4 : 0);
  return { level, score: Math.min(level === 'normal' ? 59 : level === 'high' ? 89 : 100, baseScore + attention), reasons };
}

function loadCount(loads, teamId) {
  if (!loads || !teamId) return 0;
  const value = loads[teamId];
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value);
  // loads contains counts assigned in this batch, excluding the team baseline.
  return 0;
}

function languageCode(value) {
  return String(value ?? '').trim().toLowerCase().split(/[-_]/)[0];
}

function teamCanHandle(team, input) {
  const code = languageCode(input?.language);
  const language = Boolean(code && Array.isArray(team?.languages) && team.languages.some((entry) => languageCode(entry) === code));
  const requested = Array.isArray(input?.accommodations) ? input.accommodations : [];
  const accommodations = [...new Set(requested)].filter((code) => !Object.prototype.hasOwnProperty.call(ACCESS_LABELS, code)
    || !(Array.isArray(team?.accommodations) && team.accommodations.includes(code)));
  return {
    language,
    accommodations,
    eligible: language && accommodations.length === 0,
  };
}

function nonnegative(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function teamLoad(team, loads) {
  const active = nonnegative(team?.baseline) + loadCount(loads, team?.id);
  const capacity = nonnegative(team?.capacity);
  return { active, capacity, projected: active + 1, ratio: capacity > 0 ? (active + 1) / capacity : Infinity };
}

function chooseRoute(input, classification, policy, policies, teams, loads, priority, missing, deadline) {
  const relevantIds = new Set(policies.filter((entry) => entry?.category === classification.category).map((entry) => entry.teamId));
  let relevant = teams.filter((team) => relevantIds.has(team?.id));
  const serviceMissing = !policy || relevant.length === 0;
  if (serviceMissing) {
    const generalIds = new Set(policies.filter((entry) => entry?.category === 'general').map((entry) => entry.teamId));
    relevant = teams.filter((team) => generalIds.has(team?.id));
  }

  const candidates = relevant.map((team) => ({ team, capabilities: teamCanHandle(team, input), load: teamLoad(team, loads) }));
  const eligible = candidates.filter((entry) => entry.capabilities.eligible);
  const pool = eligible.length ? eligible : candidates;
  pool.sort((left, right) => {
    const leftGaps = (left.capabilities.language ? 0 : 1) + left.capabilities.accommodations.length;
    const rightGaps = (right.capabilities.language ? 0 : 1) + right.capabilities.accommodations.length;
    return leftGaps - rightGaps
      || (left.load.ratio < right.load.ratio ? -1 : left.load.ratio > right.load.ratio ? 1 : 0)
      || left.load.active - right.load.active
      || compareText(left.team.id, right.team.id);
  });
  const selected = pool[0];
  const flags = [];
  if (classification.source === 'manual-review') flags.push('Manual service classification review required.');
  if (serviceMissing) flags.push('No configured service team; manual service handoff required.');
  if (!selected) flags.push('No available team assignment; manual assignment required.');
  if (selected && !selected.capabilities.language) flags.push('Preferred language is not supported by this team; arrange confirmed language support through manual review.');
  if (selected?.capabilities.accommodations.length) flags.push('Requested access support is not fully supported by this team; manual accessibility handoff required.');
  if (selected && selected.load.projected > selected.load.capacity) flags.push('Assignment exceeds team capacity; supervisor review required. The case remains accepted.');
  if (missing.length) flags.push('Required documents are outstanding; request them through review while keeping the case accepted.');
  if (deadline.invalid || deadline.hoursRemaining == null) flags.push('A usable deadline is unavailable; confirm the deadline through review.');
  if (priority.level === 'urgent') flags.push('Urgent case: notify the service duty lead and confirm prompt handling.');
  if (priority.level !== 'urgent' && Number.isFinite(policy?.reviewDeadlineHours)
    && deadline.hoursRemaining != null && deadline.hoursRemaining <= policy.reviewDeadlineHours) {
    flags.push(`Service policy deadline is within ${policy.reviewDeadlineHours} hours inclusive; prompt reviewer handling required.`);
  }

  const reason = !selected
    ? 'Intake is accepted, but no configured service team is available; a reviewer must assign a suitable destination.'
    : serviceMissing
      ? 'Provisional general intake assignment because no service team is configured; a reviewer must confirm the service handoff.'
      : !selected.capabilities.eligible
        ? 'The relevant service team is provisionally assigned, with explicit review required for unsupported language or access needs.'
        : `The service policy matches this team and its preferred-language and access capabilities. Lowest projected utilization among eligible service teams: ${selected.load.projected}/${selected.load.capacity} active; ties use active load, then team ID.`;
  return {
    teamId: selected?.team.id ?? null,
    teamName: selected?.team.name ?? 'Manual assignment',
    reason,
    needsReview: flags.length > 0,
    flags,
  };
}

function escalationDetails(input, policy, priority, route, missing, deadline) {
  const triggers = [];
  if (input?.safetyRisk === true) triggers.push('Reported safety risk');
  if (deadline.hoursRemaining != null && deadline.hoursRemaining <= 24) triggers.push('Deadline is at or inside the 24-hour urgent boundary');
  else if (Number.isFinite(policy?.reviewDeadlineHours) && deadline.hoursRemaining != null && deadline.hoursRemaining <= policy.reviewDeadlineHours) {
    triggers.push(`Deadline is at or inside the ${policy.reviewDeadlineHours}-hour service review boundary`);
  }
  if (missing.length) triggers.push(`${missing.length} required document${missing.length === 1 ? '' : 's'} outstanding`);
  if (deadline.hoursRemaining == null) triggers.push('A usable deadline needs human confirmation');
  triggers.push(...route.flags.filter((flag) => /classification review|service handoff|manual assignment|not supported|not fully supported|exceeds team capacity/.test(flag)));
  const reviewRequired = route.needsReview || priority.level === 'urgent' || input?.safetyRisk === true;
  const action = reviewRequired
    ? priority.level === 'urgent' || input?.safetyRisk === true
      ? 'Notify the service duty lead, preserve the case in the assigned queue, and confirm prompt handling.'
      : 'Keep the case accepted in the assigned queue and complete the flagged reviewer follow-up.'
    : 'No escalation trigger is active; continue the standard service route.';
  return {
    policyId: policy?.id ?? null,
    policyName: policy?.name ?? 'Manual intake review',
    rule: policy?.escalationRule ?? 'A human reviewer must confirm the service and its handling requirements.',
    globalRule: 'All services: reported safety risk or remaining time <= 24h requires duty-lead attention. High priority alone does not require manual review; separate service and handoff flags do.',
    serviceReviewHours: policy?.reviewDeadlineHours ?? null,
    status: reviewRequired ? 'review-required' : 'standard',
    reviewRequired,
    triggers,
    action,
  };
}

function deadlineStatus(deadline) {
  if (deadline.invalid || deadline.hoursRemaining == null) return 'needs-review';
  if (deadline.hoursRemaining < 0) return 'overdue';
  if (deadline.hoursRemaining === 0) return 'due-now';
  if (deadline.hoursRemaining <= 24) return 'urgent-window';
  if (deadline.hoursRemaining <= 72) return 'high-window';
  return 'scheduled';
}

function caseStateDetails(route, priority, missing, deadline, escalation) {
  const workflow = !route.teamId ? 'unassigned' : route.needsReview ? 'review-required' : 'routed';
  const documentStatus = missing.length ? 'incomplete' : 'complete';
  const deadlineState = deadlineStatus(deadline);
  const requiresHumanReview = workflow === 'review-required' || workflow === 'unassigned';
  const label = workflow === 'unassigned'
    ? 'Manual assignment'
    : workflow === 'review-required'
      ? 'Review required'
      : 'Routed';
  const reason = workflow === 'unassigned'
    ? 'The intake remains accepted, but no service team is configured.'
    : workflow === 'review-required'
      ? 'The intake remains accepted and assigned while a reviewer or duty lead completes the flagged follow-up.'
      : 'The intake is accepted and has a capability-compatible service destination.';
  return {
    status: workflow,
    label,
    reason,
    intake: 'accepted',
    documentStatus,
    deadlineStatus: deadlineState,
    escalationStatus: escalation.status,
    priority: priority.level,
    requiresHumanReview,
    isAssigned: Boolean(route.teamId),
    canProgress: Boolean(route.teamId) && !requiresHumanReview,
  };
}

function caseFlags(input, priority, missing, deadline, route) {
  const flags = [];
  if (deadline.hoursRemaining != null && deadline.hoursRemaining <= 72) {
    flags.push({ type: 'deadline', label: deadline.hoursRemaining < 0 ? 'Deadline overdue' : `Deadline within ${deadline.hoursRemaining <= 24 ? '24' : '72'}h` });
  } else if (deadline.invalid || deadline.hoursRemaining == null) flags.push({ type: 'deadline', label: 'Confirm deadline' });
  if (missing.length) flags.push({ type: 'documents', label: `${missing.length} required document${missing.length === 1 ? '' : 's'} missing — intake accepted` });
  if (languageCode(input?.language) !== 'en') flags.push({ type: 'language', label: input?.language ? `Preferred language: ${languageName(input)}` : 'Confirm preferred language' });
  for (const code of [...new Set(Array.isArray(input?.accommodations) ? input.accommodations : [])]) {
    flags.push({ type: code === 'interpreter' ? 'language' : 'access', label: ACCESS_LABELS[code] ?? 'Unrecognized access request — confirm support' });
  }
  if (route.needsReview) flags.push({ type: 'review', label: priority.level === 'urgent' ? 'Duty lead / reviewer attention' : 'Manual review required' });
  return flags;
}

// Collect literal values, never interpret submitted names/contacts as regexes.
// All demo identities are covered, including references to a different demo person.
function redactionTokens(input) {
  const tokens = new Set();
  const add = (value) => {
    if (typeof value === 'string' && value.trim() && value !== MASK) tokens.add(value);
    else if (typeof value === 'number') tokens.add(String(value));
  };
  const collect = (value) => {
    if (value && typeof value === 'object') Object.values(value).forEach(collect);
    else add(value);
  };
  for (const source of [input, ...syntheticCases]) {
    if (!source || typeof source !== 'object') continue;
    collect(source.person);
    // Also redact components of a supplied full name in free text.
    if (typeof source.person?.name === 'string') source.person.name.split(/\s+/).filter((part) => part.length > 1).forEach(add);
    for (const field of Array.isArray(source.fields) ? source.fields : []) {
      if (field?.sensitive === true) collect(field.value);
    }
  }
  return [...tokens].sort((left, right) => right.length - left.length || compareText(left, right));
}

function replaceLiterals(text, tokens) {
  // Longest-first, one-pass matching avoids partial leaks and cascading replacements.
  const folded = text.toLowerCase();
  const literals = tokens.map((token) => ({ token, folded: token.toLowerCase() }));
  const wordCharacter = (character) => /[\p{L}\p{N}_]/u.test(character || '');
  let result = '';
  let cursor = 0;
  while (cursor < text.length) {
    let matchAt = -1;
    let length = 0;
    for (const literal of literals) {
      let at = folded.indexOf(literal.folded, cursor);
      // Names such as Ada must not damage innocent words such as metadata.
      // This is literal fixture masking, not arbitrary free-text PII detection.
      while (at !== -1) {
        const end = at + literal.token.length;
        const leftBoundary = !wordCharacter(literal.token[0]) || !wordCharacter(text[at - 1]);
        const rightBoundary = !wordCharacter(literal.token.at(-1)) || !wordCharacter(text[end]);
        if (leftBoundary && rightBoundary) break;
        at = folded.indexOf(literal.folded, at + 1);
      }
      if (at !== -1 && (matchAt === -1 || at < matchAt || (at === matchAt && literal.token.length > length))) {
        matchAt = at;
        length = literal.token.length;
      }
    }
    if (matchAt === -1) return result + text.slice(cursor);
    result += text.slice(cursor, matchAt) + MASK;
    cursor = matchAt + length;
  }
  return result;
}

function sanitize(value, tokens) {
  if (typeof value === 'string') return replaceLiterals(value, tokens);
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry, tokens));
  if (!value || typeof value !== 'object') return value;
  const result = Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitize(entry, tokens)]));
  if (value.sensitive === true && Object.prototype.hasOwnProperty.call(value, 'value')) result.value = MASK;
  if (value.person && typeof value.person === 'object') {
    const maskPerson = (person) => {
      if (Array.isArray(person)) return person.map(maskPerson);
      if (person && typeof person === 'object') return Object.fromEntries(Object.entries(person).map(([key, entry]) => [key, maskPerson(entry)]));
      return MASK;
    };
    result.person = maskPerson(value.person);
  }
  if (Array.isArray(value.documents)) {
    result.documents = result.documents.map((document) => document && typeof document === 'object' ? { ...document, content: MASK } : document);
  }
  return result;
}

/** A deep, non-mutating share-safe copy retaining routing and document metadata. */
export function redactCase(input) {
  return sanitize(input, redactionTokens(input));
}

function prepareCase(input, policies, nowTime) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const classification = classify(source, policies);
  const deadline = deadlineDetails(source, classification.policy, nowTime);
  const missing = missingDocuments(source, classification.policy);
  const priority = calculatePriority(source, deadline, missing, classification);
  return { input: source, ...classification, deadline, missing, priority };
}

function evaluatePrepared(prepared, { nowTime, policies, teams, loads }) {
  const { input, classification, policy, deadline, missing, priority } = prepared;
  const route = chooseRoute(input, classification, policy, policies, teams, loads, priority, missing, deadline);
  const flags = caseFlags(input, priority, missing, deadline, route);
  const escalation = escalationDetails(input, policy, priority, route, missing, deadline);
  const caseState = caseStateDetails(route, priority, missing, deadline, escalation);
  const deadlineReason = deadline.hoursRemaining == null
    ? `${deadline.sourceLabel}: ${deadline.calculation}. A reviewer must confirm a usable deadline.`
    : `${deadline.sourceLabel}: ${deadline.calculation}. Applied inclusive 24-hour urgent and 72-hour high thresholds.`;
  const auditSteps = [
    { action: 'Classification', reason: classification.reason },
    { action: 'Deadline & priority', reason: `${deadlineReason} ${input.safetyRisk === true ? 'Reported safety risk requires urgent attention. ' : ''}Priority: ${priority.level}. Requested access is retained as handling attention without any identity or diagnosis inference.` },
    { action: 'Documents', reason: missing.length ? `${missing.length} required document(s) remain outstanding; intake remains accepted, urgency is preserved, and follow-up review is required.` : 'All required document types are received; this check does not validate document contents.' },
    { action: 'Route', reason: `${route.reason} Escalation status: ${escalation.status}.` },
    { action: 'Redact', reason: 'Created a share-safe copy: personal details, sensitive field values, literal identity references, and every document body are masked; routing metadata is retained.' },
  ];
  if (route.needsReview) {
    // Configured rule text and case identifiers are sanitized below as well.
    auditSteps.push({ action: 'Escalate / review', reason: `${route.flags.join(' ')} ${escalation.rule} Action: ${escalation.action}` });
  }
  const audit = auditSteps.map((step, index) => ({
    id: `${input.id ?? 'case'}-audit-${index + 1}`,
    at: new Date(nowTime).toISOString(),
    action: step.action,
    reason: step.reason,
    actor: 'Local policy engine',
  }));
  const evaluated = {
    ...cloneValue(input),
    classification: cloneValue(classification),
    policy: cloneValue(policy),
    priority: cloneValue(priority),
    route,
    deadlineBreakdown: cloneValue(deadline),
    escalation: cloneValue(escalation),
    caseState: cloneValue(caseState),
    missingDocuments: cloneValue(missing),
    hoursRemaining: deadline.hoursRemaining,
    dueLabel: deadline.dueLabel,
    flags,
    audit: sanitize(audit, redactionTokens(input)),
  };
  // Avoid recursively embedding stale evaluated snapshots when rerunning a case.
  delete evaluated.redacted;
  evaluated.redacted = redactCase(evaluated);
  return evaluated;
}

/** loads is a team-ID -> batch assignment count map, excluding baselines. */
export function evaluateCase(input, {
  now = DEMO_NOW,
  policies = defaultPolicies,
  teams = defaultTeams,
  loads = {},
} = {}) {
  const nowTime = parseDate(now) ?? parseDate(DEMO_NOW);
  const configuredPolicies = Array.isArray(policies) ? policies.filter(Boolean) : [];
  const configuredTeams = Array.isArray(teams) ? teams.filter(Boolean) : [];
  const prepared = prepareCase(input, configuredPolicies, nowTime);
  return evaluatePrepared(prepared, { nowTime, policies: configuredPolicies, teams: configuredTeams, loads });
}

function compareCases(left, right) {
  const leftRank = PRIORITY_RANK[left?.priority?.level] ?? 0;
  const rightRank = PRIORITY_RANK[right?.priority?.level] ?? 0;
  if (rightRank !== leftRank) return rightRank - leftRank;
  const leftDue = Number.isFinite(left?.hoursRemaining) ? left.hoursRemaining : Infinity;
  const rightDue = Number.isFinite(right?.hoursRemaining) ? right.hoursRemaining : Infinity;
  if (leftDue !== rightDue) return leftDue < rightDue ? -1 : 1;
  const scoreDifference = nonnegative(right?.priority?.score) - nonnegative(left?.priority?.score);
  if (scoreDifference) return scoreDifference;
  const leftReceived = parseDate(left?.receivedAt) ?? Infinity;
  const rightReceived = parseDate(right?.receivedAt) ?? Infinity;
  if (leftReceived !== rightReceived) return leftReceived < rightReceived ? -1 : 1;
  return compareText(left?.id, right?.id);
}

/** Stable priority -> earliest deadline -> attention -> intake time -> ID order. */
export function sortCases(evaluated) {
  return (Array.isArray(evaluated) ? [...evaluated] : []).sort(compareCases);
}

/** Assign highest-priority cases first and include each assignment in later loads. */
export function evaluateAll(cases, {
  now = DEMO_NOW,
  policies = defaultPolicies,
  teams = defaultTeams,
} = {}) {
  const nowTime = parseDate(now) ?? parseDate(DEMO_NOW);
  const configuredPolicies = Array.isArray(policies) ? policies.filter(Boolean) : [];
  const configuredTeams = Array.isArray(teams) ? teams.filter(Boolean) : [];
  const prepared = (Array.isArray(cases) ? cases : []).map((input) => prepareCase(input, configuredPolicies, nowTime));
  prepared.sort((left, right) => compareCases(
    { ...left.input, priority: left.priority, hoursRemaining: left.deadline.hoursRemaining },
    { ...right.input, priority: right.priority, hoursRemaining: right.deadline.hoursRemaining },
  ));
  const loads = Object.create(null);
  return prepared.map((entry) => {
    const evaluated = evaluatePrepared(entry, { nowTime, policies: configuredPolicies, teams: configuredTeams, loads });
    if (evaluated.route.teamId != null) loads[evaluated.route.teamId] = loadCount(loads, evaluated.route.teamId) + 1;
    return evaluated;
  });
}

/** Utilization is a percentage (may exceed 100); assigned and urgent are counts. */
export function getWorkloads(evaluated, teams = defaultTeams) {
  const cases = Array.isArray(evaluated) ? evaluated : [];
  return (Array.isArray(teams) ? teams : []).filter(Boolean).map((team) => {
    const assignedCases = cases.filter((entry) => entry?.route?.teamId === team.id);
    const assigned = assignedCases.length;
    const active = nonnegative(team.baseline) + assigned;
    const capacity = nonnegative(team.capacity);
    return {
      ...cloneValue(team),
      active,
      available: Math.max(0, capacity - active),
      utilization: capacity > 0 ? roundNumber(active / capacity * 100, 1) : active > 0 ? 100 : 0,
      assigned,
      urgent: assignedCases.filter((entry) => entry.priority?.level === 'urgent').length,
      awaitingDocuments: assignedCases.filter((entry) => entry.missingDocuments?.length > 0).length,
      overCapacity: Math.max(0, active - capacity),
    };
  });
}
