import { getThreatFixtures } from '../data/threatFixtures.js';
import { scoringPolicy, scoringRules } from '../data/scoringRules.js';

const SCOPES = ['training', 'evaluation', 'retention'];
const DOCUMENTATION_FIELDS = [
  'id', 'name', 'version', 'type', 'description', 'owner', 'lastReviewed', 'intendedUse',
];

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
const list = (value) => Array.isArray(value) ? value : [];
const hasText = (value) => typeof value === 'string' && value.trim().length > 0;
const strings = (value) => [...new Set(list(value).filter(hasText).map((item) => item.trim()))];
const inRange = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
const identifier = (value, fallback) => hasText(value) ? value.trim() : fallback;

export function validMetric(value) {
  const metric = record(value);
  return hasText(metric.group) && Number.isInteger(metric.sampleSize) && metric.sampleSize > 0
    && inRange(metric.accuracy) && inRange(metric.falsePositiveRate);
}

/**
 * Return claim-level reference inspection without deciding whether the claim
 * is true. Every source path is local to the synthetic card bundle.
 */
export function inspectClaimEvidence(input) {
  const card = record(input);
  const evidence = list(card.evidence).map(record);
  const evidenceById = new Map(evidence.filter((item) => hasText(item.id)).map((item, index) => [item.id.trim(), { item, index }]));
  return list(card.claims).map((value, index) => {
    const claim = record(value);
    const refs = list(claim.evidenceIds);
    const references = refs.map((ref) => {
      const id = hasText(ref) ? ref.trim() : null;
      if (!id) return { id: ref, status: 'invalid', path: null, title: '', description: '', reason: 'Reference ID is not a nonempty string.' };
      const match = evidenceById.get(id);
      if (!match) return { id, status: 'missing', path: null, title: '', description: '', reason: 'No bundled evidence entry resolves this ID.' };
      const complete = hasText(match.item.id) && hasText(match.item.title) && hasText(match.item.description);
      return { id, status: complete ? 'resolved' : 'incomplete', path: `evidence[${match.index}]`, title: identifier(match.item.title, ''), description: identifier(match.item.description, ''), reason: complete ? 'Bundled evidence entry has an ID, title, and description.' : 'Bundled evidence entry is missing a title or description.' };
    });
    const reasons = [];
    if (!hasText(claim.id) || !hasText(claim.text)) reasons.push('incomplete claim');
    if (!refs.length) reasons.push('no evidence references');
    const unresolved = references.filter((reference) => reference.status !== 'resolved');
    if (unresolved.length) reasons.push(`missing or incomplete evidence: ${unresolved.map((reference) => identifier(reference.id, '(invalid ID)')).join(', ')}`);
    return {
      id: identifier(claim.id, `claim-${index + 1}`),
      text: hasText(claim.text) ? claim.text : '',
      path: `claims[${index}]`,
      referenceComplete: hasText(claim.id) && hasText(claim.text) && refs.length > 0 && unresolved.length === 0,
      reasons,
      references,
    };
  });
}

// Source paths identify bundled card fields, not external evidence verification.
const sourceValue = (value) => value === undefined || value === null ? 'Not documented'
  : typeof value === 'object' ? JSON.stringify(value) : String(value);
const source = (path, label, detail) => ({ path, label, detail });
const metricSource = (metric, index) => {
  const row = record(metric);
  return source(`metrics[${index}]`, identifier(row.group, 'Unnamed subgroup metric'),
    `Sample size: ${sourceValue(row.sampleSize)}; accuracy: ${sourceValue(row.accuracy)}%; false-positive rate: ${sourceValue(row.falsePositiveRate)}%. ${validMetric(metric) ? 'Valid metric.' : 'Invalid metric; does not count toward coverage.'}`);
};
const threatSource = (threat, index) => source(`threats[${index}]`,
  `${identifier(threat.id, 'Unnamed threat')}: ${identifier(threat.name, 'No threat name')}`,
  `Severity: ${sourceValue(threat.severity)}; status: ${sourceValue(threat.status)}. Mitigation: ${identifier(threat.mitigation, 'Not documented')}`);
const checkSource = (check, index) => source(`accessibility[${index}]`,
  `${identifier(check.id, 'Unnamed check')}: ${identifier(check.name, 'No check name')}`,
  `Status: ${sourceValue(check.status)}. ${identifier(check.detail, 'No detail recorded')}`);

function claimReview(card) {
  // A reference counts only when its locally bundled evidence entry is documented.
  const evidenceIds = new Set(list(card.evidence).filter((value) => {
    const item = record(value);
    return hasText(item.id) && hasText(item.title) && hasText(item.description);
  }).map((item) => item.id.trim()));

  return list(card.claims).map((value, index) => {
    const claim = record(value);
    const refs = list(claim.evidenceIds);
    const missing = refs.filter((id) => !hasText(id) || !evidenceIds.has(id.trim()));
    const supported = hasText(claim.id) && hasText(claim.text) && refs.length > 0 && missing.length === 0;
    const reasons = [];
    if (!hasText(claim.id) || !hasText(claim.text)) reasons.push('incomplete claim');
    if (!refs.length) reasons.push('no evidence references');
    if (missing.length) reasons.push(`missing or incomplete evidence: ${missing.map((id) => identifier(id, '(invalid ID)')).join(', ')}`);
    return { claim, id: identifier(claim.id, `claim-${index + 1}`), supported, reasons };
  });
}

function clauses(value) {
  if (!hasText(value)) return [];
  return value.toLowerCase().replace(/[’]/g, "'")
    .replace(/\b(isn't|aren't|wasn't|weren't)\b/g, (word) => `${word.split("'")[0].replace(/n$/, '')} not`)
    .replace(/\bdoesn't\b/g, 'does not').replace(/\bdon't\b/g, 'do not')
    .replace(/\bdidn't\b/g, 'did not').replace(/\bcan't\b/g, 'cannot')
    .replace(/\bwon't\b/g, 'will not')
    .split(/[.;!?]|\b(?:but|however|although)\b/).filter((part) => part.trim());
}

function consentPositions(clause) {
  // Deliberately bounded text heuristics, not a natural-language policy verdict.
  // Mask explicit phrases after interpreting them so "does not require consent"
  // cannot also be read as the affirmative substring "require consent".
  const positions = new Set();
  let remaining = clause;
  const mask = (pattern, position) => {
    remaining = remaining.replace(pattern, (match) => {
      positions.add(position);
      return ' '.repeat(match.length);
    });
  };
  mask(/\bconsent\s+(?:is\s+)?not\s+(?:optional|unnecessary|waived)\b/g, true);
  mask(/\b(?:do|does|did)\s+not\s+(?:waive|bypass|skip)\s+(?:(?:explicit|informed|affirmative)\s+)?consent\b/g, true);
  mask(/\bconsent\s+(?:is\s+)?(?:not\s+(?:required|needed|necessary|mandatory)|optional|unnecessary|waived)\b/g, false);
  mask(/\bconsent\s+(?:is\s+)?(?:never|required\s+not|not\s+always)\s+(?:required|needed|necessary|mandatory)\b/g, false);
  mask(/\b(?:do|does|did)\s+not\s+(?:require|need)\s+(?:(?:explicit|informed|affirmative|opt[- ]in)\s+)?consent\b/g, false);
  mask(/\b(?:require|requires|required|need|needs)\s+no\s+(?:(?:explicit|informed|affirmative|opt[- ]in|prior|user)\s+)?consent\b/g, false);
  mask(/\bno\s+(?:(?:explicit|informed|affirmative)\s+)?consent\s+(?:is\s+)?(?:required|needed|necessary)\b/g, false);
  mask(/\b(?:no\s+need|not\s+(?:required|necessary))\s+to\s+(?:obtain|seek|request)\s+consent\b/g, false);
  mask(/\b(?:waive|bypass|skip)\s+(?:(?:explicit|informed|affirmative)\s+)?consent\b/g, false);
  mask(/\b(?:with|if)\s+no\s+(?:(?:explicit|informed|affirmative|prior|user)\s+)?consent\b/g, false);
  mask(/\bconsent\s+(?:is\s+)?(?:not\s+(?:given|provided|obtained|collected|secured)|has\s+not\s+been\s+(?:given|provided|obtained))\b/g, false);
  remaining = remaining.replace(/\bwithout\s+(?:(?:\w[\w-]*)\s+){0,4}consent\b/g, (match, offset) => {
    const prefix = remaining.slice(0, offset);
    const prohibited = /\b(?:cannot|can not|must not|may not|will not|shall not|should not|never)\b(?:\s+[\w-]+){0,8}\s*$/.test(prefix)
      || /\b(?:do|does|did|is|are)\s+not\s+(?:proceed|train|use|collect|process|retain|operate|share|evaluate|perform|allow|permit)\w*(?:\s+[\w-]+){0,6}\s*$/.test(prefix)
      || /\b(?:not|never)\s*$/.test(prefix)
      || /\bnot\s+(?:allowed|permitted|authorized)(?:\s+[\w-]+){0,6}\s*$/.test(prefix)
      || /\bno\s+(?:training|evaluation|retention|collection|processing|use)(?:\s+[\w-]+){0,6}\s*$/.test(prefix);
    positions.add(prohibited);
    return ' '.repeat(match.length);
  });
  mask(/\bnot\s+(?:only\s+)?with\s+(?:(?:explicit|informed|affirmative|opt[- ]in)\s+)?consent\b/g, false);
  if (/\b(?:requires?|needs?|obtain(?:ing)?|seek(?:ing)?|with)\s+(?:(?:explicit|informed|affirmative|opt[- ]in)\s+)?consent\b/.test(remaining)
    || /\bconsent\s+(?:is\s+)?(?:required|needed|necessary|mandatory)\b/.test(remaining)
    || /\b(?:must\s+(?:obtain|have|secure)|only\s+after|unless|until)\s+(?:(?:explicit|informed|affirmative|opt[- ]in)\s+)?consent\b/.test(remaining)
    || /\bconsent\s+must\s+be\s+(?:obtained|provided|secured|required)\b/.test(remaining)
    || /\bopt[- ]in\b/.test(remaining)) positions.add(true);
  return positions;
}

function privacyReview(card) {
  const data = record(card.dataUse);
  const statements = list(data.statements).map(record);
  const policies = new Map(SCOPES.map((scope) => [scope, { positions: new Set(), references: [], sources: [], complete: false }]));
  for (const scope of SCOPES) {
    const policy = policies.get(scope);
    const scoped = statements.filter((statement) => statement.scope === scope);
    policy.complete = scoped.length > 0 && scoped.every((statement) => hasText(statement.id)
      && hasText(statement.text) && typeof statement.requiresConsent === 'boolean');
    for (const statement of scoped) {
      if (typeof statement.requiresConsent === 'boolean') policy.positions.add(statement.requiresConsent);
      for (const clause of clauses(statement.text)) {
        for (const position of consentPositions(clause)) policy.positions.add(position);
      }
      policy.references.push(`${identifier(statement.id, 'unnamed statement')}: ${identifier(statement.text, 'No statement text')} (requiresConsent=${String(statement.requiresConsent)})`);
      policy.sources.push(source(`dataUse.statements[${statements.indexOf(statement)}]`,
        `${identifier(statement.id, 'Unnamed statement')} · ${scope}`,
        `${identifier(statement.text, 'No statement text')} (requiresConsent=${sourceValue(statement.requiresConsent)})`));
    }
  }
  // A general policy applies to all scopes; explicitly named scopes stay separate.
  for (const clause of clauses(data.consent)) {
    const positions = consentPositions(clause);
    if (!positions.size) continue;
    const scopes = SCOPES.filter((scope) => ({
      training: /\btrain(?:ing)?\b/,
      evaluation: /\bevaluat(?:ion|e|ing)\b/,
      retention: /\b(?:retention|retain(?:ed|ing)?)\b/,
    })[scope].test(clause));
    for (const scope of scopes.length ? scopes : SCOPES) {
      const policy = policies.get(scope);
      for (const position of positions) policy.positions.add(position);
      policy.references.push(`dataUse.consent: ${data.consent}`);
      if (!policy.sources.some((item) => item.path === 'dataUse.consent')) {
        policy.sources.push(source('dataUse.consent', 'General consent policy', data.consent));
      }
    }
  }
  const contradictions = SCOPES.filter((scope) => policies.get(scope).positions.size > 1);
  const fieldChecks = [
    ['collection', hasText(data.collection)],
    ['consent', hasText(data.consent)],
    ['sensitiveAttributes', hasText(data.sensitiveAttributes)],
    ['retentionDays', Number.isInteger(data.retentionDays) && data.retentionDays >= 0],
  ];
  const invalidScopes = statements.some((statement) => !SCOPES.includes(statement.scope));
  const missing = fieldChecks.filter(([, present]) => !present).map(([field]) => field);
  for (const scope of SCOPES) if (!policies.get(scope).complete) missing.push(`${scope} statements`);
  if (invalidScopes) missing.push('valid scope on every statement');
  const covered = fieldChecks.filter(([, present]) => present).length
    + SCOPES.filter((scope) => policies.get(scope).complete && !contradictions.includes(scope) && !invalidScopes).length;
  return { data, policies, contradictions, missing, covered, total: 7 };
}

function dimension(id, label, covered, total) {
  return { id, label, score: Math.round(100 * covered / total), covered, total };
}

/** Deterministic evidence coverage and review prompts, never a safety certification. */
export function auditModelCard(input) {
  const card = record(input);
  const claims = claimReview(card);
  const supportedClaims = claims.filter((claim) => claim.supported).length;
  const metrics = list(card.metrics);
  const expected = strings(card.expectedSubgroups);
  const validByGroup = new Map();
  for (const metric of metrics) {
    if (validMetric(metric) && !validByGroup.has(metric.group.trim())) validByGroup.set(metric.group.trim(), metric);
  }
  const validMetrics = [...validByGroup.values()];
  const missingGroups = expected.filter((group) => !validByGroup.has(group));
  const invalidMetrics = metrics.filter((metric) => !validMetric(metric));
  const smallSamples = validMetrics.filter((metric) => metric.sampleSize < 30);
  const accuracies = validMetrics.map((metric) => metric.accuracy);
  const fairnessGap = accuracies.length > 1
    ? Number((Math.max(...accuracies) - Math.min(...accuracies)).toFixed(6)) : 0;
  const privacy = privacyReview(card);
  const threats = list(card.threats).map(record);
  const mitigated = (threat) => threat.status === 'mitigated' && hasText(threat.id)
    && hasText(threat.name) && ['high', 'medium', 'low'].includes(threat.severity) && hasText(threat.mitigation);
  const accessibility = list(card.accessibility).map(record);
  const passed = (check) => check.status === 'pass' && hasText(check.id) && hasText(check.name) && hasText(check.detail);
  const documentationCovered = DOCUMENTATION_FIELDS.filter((field) => hasText(card[field])).length
    + Number(strings(card.limitations).length > 0) + Number(card.synthetic === true) + supportedClaims;
  const dimensions = [
    dimension('documentation', 'Documentation', documentationCovered, 10 + Math.max(claims.length, 1)),
    dimension('fairness', 'Fairness', expected.length - missingGroups.length, Math.max(expected.length, 1)),
    dimension('privacy', 'Privacy', privacy.covered, privacy.total),
    dimension('security', 'Security', threats.filter(mitigated).length, Math.max(threats.length, 1)),
    dimension('accessibility', 'Accessibility', accessibility.filter(passed).length, Math.max(accessibility.length, 1)),
  ];
  const findings = [];
  const finding = (id, severity, category, title, description, recommendation, evidence, sources) => {
    findings.push({ id, severity, category, title, description, recommendation, evidence, sources });
  };
  if (missingGroups.length || invalidMetrics.length || !expected.length) {
    finding('fairness-missing-data', 'high', 'fairness', 'Subgroup evaluation data is missing or invalid',
      'Each expected subgroup needs a valid metric with a named group, positive integer sample size, and accuracy and false-positive rate between 0 and 100.',
      'Document expected subgroups and collect or correct their evaluation metrics before comparing performance.',
      [missingGroups.length ? `Missing expected groups: ${missingGroups.join(', ')}.` : '',
        !expected.length ? 'No expected subgroups are documented.' : '',
        invalidMetrics.length ? `Invalid metric rows: ${invalidMetrics.map((metric, index) => identifier(record(metric).group, `unnamed row ${index + 1}`)).join(', ')}.` : ''].filter(Boolean).join(' '),
      [source('expectedSubgroups', 'Expected subgroup inventory', expected.length ? expected.join(', ') : 'No expected subgroups documented.'),
        ...missingGroups.map((group) => source(`expectedSubgroups[${list(card.expectedSubgroups).findIndex((item) => hasText(item) && item.trim() === group)}]`, group, 'No valid metric for this expected group. Missing data is not evidence of equal performance.')),
        ...invalidMetrics.map((metric) => metricSource(metric, metrics.indexOf(metric)))]);
  }
  if (smallSamples.length) {
    finding('fairness-small-samples', 'medium', 'fairness', 'Some subgroup samples are small',
      'Subgroup samples below 30 provide limited support for stable error estimates.',
      'Expand the synthetic evaluation samples and report uncertainty rather than treating small-sample results as conclusive.',
      smallSamples.map((metric) => `${metric.group}: n=${metric.sampleSize}`).join('; '),
      smallSamples.map((metric) => metricSource(metric, metrics.indexOf(metric))));
  }
  if (fairnessGap > 5) {
    finding('fairness-accuracy-gap', 'high', 'fairness', 'Subgroup accuracy gap exceeds 5 percentage points',
      `The highest and lowest valid subgroup accuracies differ by ${fairnessGap} percentage points. This descriptive range is not a statistical fairness determination.`,
      'Investigate subgroup errors, sample uncertainty, and comparable evaluation conditions; document corrective actions.',
      validMetrics.map((metric) => `${metric.group}: ${metric.accuracy}% (n=${metric.sampleSize})`).join('; '),
      validMetrics.map((metric) => metricSource(metric, metrics.indexOf(metric))));
  }
  const unsupported = claims.filter((claim) => !claim.supported);
  if (unsupported.length || !claims.length) {
    finding('claims-unsupported', 'medium', 'claims', unsupported.length ? 'Claims lack complete evidence references' : 'Claims and evidence are missing',
      'A claim counts as supported only when it has an ID, text, and at least one reference, and every reference resolves to a documented local evidence entry. Reference presence does not establish that a claim is true.',
      'Attach the missing evidence and verify it substantiates each claim, or narrow or remove the claim.',
      unsupported.length ? unsupported.map((claim) => `${claim.id}: ${claim.reasons.join('; ')}`).join(' | ') : 'No claims are documented.',
      unsupported.length ? unsupported.map((item) => source(`claims[${claims.indexOf(item)}]`, item.id,
        `${identifier(item.claim.text, 'No claim text')} Evidence IDs: ${strings(item.claim.evidenceIds).join(', ') || 'None'}. Reference gaps: ${item.reasons.join('; ')}`))
        : [source('claims', 'Claim inventory', 'No claims documented.')]);
  }
  if (privacy.contradictions.length) {
    finding('privacy-consent-conflict', 'high', 'privacy', 'Consent contradiction: requirements are contradictory',
      `Structured flags or basic policy wording disagree within these scopes: ${privacy.contradictions.join(', ')}. Agreement between flags alone is insufficient when the text permits non-consensual use.`,
      'Reconcile the policy text and requiresConsent flags within each scope; document a single clear consent requirement before using data.',
      privacy.contradictions.map((scope) => `${scope}: ${privacy.policies.get(scope).references.join(' | ')}`).join('\n'),
      [...new Map(privacy.contradictions.flatMap((scope) => privacy.policies.get(scope).sources).map((item) => [item.path, item])).values()]);
  }
  if (privacy.missing.length) {
    finding('privacy-missing-data', 'medium', 'privacy', 'Data-use documentation is incomplete',
      'Collection, consent, sensitive attributes, a non-negative integer retention period, and complete statements for each scope are required for coverage.',
      'Complete the missing data-use fields and give each statement a valid scope, ID, text, and boolean consent flag.',
      `Missing or invalid: ${privacy.missing.join(', ')}.`,
      privacy.missing.map((field) => {
        const scope = SCOPES.find((item) => field === `${item} statements`);
        return scope ? source('dataUse.statements', `${scope} statements`,
          sourceValue(list(privacy.data.statements).filter((item) => record(item).scope === scope)))
          : source(field === 'valid scope on every statement' ? 'dataUse.statements' : `dataUse.${field}`, field,
            sourceValue(field === 'valid scope on every statement' ? privacy.data.statements : privacy.data[field]));
      }));
  }
  const unresolvedThreats = threats.filter((threat) => !mitigated(threat));
  if (unresolvedThreats.length || !threats.length) {
    finding('security-unmitigated', !threats.length || unresolvedThreats.some((threat) => threat.severity === 'high') ? 'high' : 'medium',
      'security', 'Threat mitigations need review',
      'Threat coverage requires a documented scenario, valid severity, mitigation, and mitigated status; the status is self-reported rather than verified.',
      'Document missing threat scenarios and complete and verify mitigations for unresolved threats.',
      unresolvedThreats.length ? unresolvedThreats.map((threat, index) => `${identifier(threat.id, `threat-${index + 1}`)}: ${identifier(threat.name, 'Unnamed threat')} (${identifier(threat.status, 'missing status')})`).join('; ') : 'No threats are documented.',
      unresolvedThreats.length ? unresolvedThreats.map((threat) => threatSource(threat, threats.indexOf(threat)))
        : [source('threats', 'Threat inventory', 'No threats documented.')]);
  }
  const failed = accessibility.filter((check) => check.status === 'fail');
  if (failed.length) {
    finding('accessibility-failed', 'high', 'accessibility', 'Accessibility checks failed',
      'Failed checks indicate documented barriers in the fictional workflow.',
      'Resolve the reported barriers and repeat the accessibility checks with relevant users and assistive technologies.',
      failed.map((check) => `${identifier(check.id, 'unnamed check')}: ${identifier(check.name, 'Unnamed check')} — ${identifier(check.detail, 'No detail recorded')}`).join('; '),
      failed.map((check) => checkSource(check, accessibility.indexOf(check))));
  }
  const incompleteChecks = accessibility.filter((check) => check.status !== 'fail' && !passed(check));
  if (incompleteChecks.length || !accessibility.length) {
    finding('accessibility-missing', 'medium', 'accessibility', 'Accessibility coverage is incomplete',
      'Untested, missing, or incompletely documented accessibility checks do not count as passes.',
      'Record complete checks for keyboard, screen-reader, and other relevant access needs and retain their results.',
      incompleteChecks.length ? incompleteChecks.map((check) => `${identifier(check.id, 'unnamed check')}: ${identifier(check.name, 'Unnamed check')} (${identifier(check.status, 'missing status')})`).join('; ') : 'No accessibility checks are documented.',
      incompleteChecks.length ? incompleteChecks.map((check) => checkSource(check, accessibility.indexOf(check)))
        : [source('accessibility', 'Accessibility check inventory', 'No accessibility checks documented.')]);
  }
  return {
    coverage: Math.round(dimensions.reduce((sum, item) => sum + 100 * item.covered / item.total, 0) / dimensions.length),
    dimensions, findings, supportedClaims, totalClaims: claims.length, fairnessGap, subgroups: metrics,
  };
}

function markdown(value) {
  const text = hasText(value) ? value.trim()
    : typeof value === 'number' && Number.isFinite(value) ? String(value)
      : typeof value === 'boolean' ? String(value) : 'Not documented';
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\`*_[\]|]/g, '\\$&')
    // Keep URL-shaped field text literal, including adjacent escaped HTML tags.
    .replace(/\b([a-z][a-z0-9+.-]*):(?=\/\/)/gi, '$1\\:')
    .replace(/^([ \t]*)([#>+]|-(?=\s))/gm, '$1\\$2');
}

function table(headers, rows) {
  const row = (cells) => `| ${cells.map((cell) => markdown(cell).replace(/\r?\n/g, '<br>')).join(' | ')} |`;
  return [row(headers), row(headers.map(() => '---')), ...rows.map(row)].join('\n');
}

/** A local, deterministic Markdown snapshot for a human reviewer. */
export function exportReviewPacket(input, auditInput, reviewerNotes = '') {
  const card = record(input);
  const audit = auditInput !== null && typeof auditInput === 'object' && !Array.isArray(auditInput)
    ? auditInput : auditModelCard(card);
  const claims = claimReview(card);
  const claimEvidence = inspectClaimEvidence(card);
  const data = record(card.dataUse);
  const metrics = list(card.metrics);
  const expected = strings(card.expectedSubgroups);
  const sections = [
    `# Review packet: ${markdown(card.name)}`,
    '> **Synthetic notice:** Bundled scenarios, organizations, records, metrics, and evidence are explicitly synthetic and fictional. This is a local review aid, not a safety certification or permission to deploy. No remote API or external evidence verification is used.',
    '## Card snapshot',
    table(['Field', 'Value'], [
      ['ID', card.id], ['Name', card.name], ['Version', card.version], ['Type', card.type],
      ['Owner', card.owner], ['Last reviewed (card metadata)', card.lastReviewed],
      ['Synthetic flag', card.synthetic], ['Description', card.description], ['Intended use', card.intendedUse],
    ]),
    '## Scoring methodology and caveats',
    `Evidence coverage: **${markdown(audit.coverage)}%**. Referenced claims: **${markdown(audit.supportedClaims)} / ${markdown(audit.totalClaims)}**. Descriptive accuracy gap: **${markdown(audit.fairnessGap)} percentage points**.`,
    [
      '- Each dimension score is round(100 × covered / total). Overall coverage is the rounded, equal-weight mean of the five unrounded dimension ratios, not the mean of rounded scores.',
      '- Documentation: eight nonempty snapshot fields (ID, name, version, type, description, owner, lastReviewed, intendedUse), a nonempty limitations list, an explicit synthetic=true flag, and one unit per fully referenced claim. With no claims, one uncovered claim unit remains.',
      '- A referenced claim needs an ID, text, at least one evidence ID, and every ID must resolve to a local entry with ID, title, and description. Evidence-reference coverage does not verify the evidence or establish the truth of the claim.',
      '- Fairness: one unit per unique expected subgroup with a valid metric. Valid metrics require a named group, a positive integer sample size, and finite numeric accuracy and false-positive rate in 0–100. Invalid rows never count. No expected groups means one uncovered unit.',
      '- The gap is max minus min accuracy across valid named groups (first valid row per group). Different age and language slices may overlap and are not necessarily comparable populations. Gaps above 5 percentage points and samples below 30 prompt review; no statistical significance or uncertainty is inferred.',
      '- Privacy: seven units for collection, consent, sensitive-attribute documentation, non-negative integer retentionDays, and complete, non-contradictory statements for each of training, evaluation, and retention. Unknown scopes prevent scope coverage. Consent checks compare boolean flags and bounded affirmative/negative text heuristics within each scope, including the general consent policy; human interpretation is still required.',
      '- Security: one unit per documented threat with valid severity, nonempty mitigation, and mitigated status. Accessibility: one unit per named, documented passing check. An empty list leaves one uncovered unit in either dimension. These statuses are self-reported, not independently verified.',
      '- Coverage measures documentation and recorded checks, not model quality, legal compliance, fairness guarantees, privacy guarantees, or overall safety. Findings are review prompts and do not directly subtract points. Tradeoff scores are fictional comparative estimates, not measurements or scoring inputs.',
    ].join('\n'),
    '## Coverage dimensions',
    table(['Dimension', 'Score (%)', 'Covered', 'Total'], list(audit.dimensions).map((value) => {
      const item = record(value);
      return [item.label, item.score, item.covered, item.total];
    })),
    '## Claims and evidence references',
  ];
  if (!claims.length) sections.push('No claims documented.');
  for (const { claim, id, supported, reasons } of claims) {
    sections.push(`### ${markdown(id)}\n\n${markdown(claim.text)}\n\nReference status: ${supported ? 'Supported by complete references (content not verified)' : 'Unsupported'}\n\nEvidence IDs: ${strings(claim.evidenceIds).map(markdown).join(', ') || 'None'}${reasons.length ? `\n\nReference gaps: ${markdown(reasons.join('; '))}` : ''}`);
  }
  sections.push('### Bundled evidence');
  const evidence = list(card.evidence).map(record);
  sections.push(evidence.length ? table(['ID', 'Title', 'Description'], evidence.map((item) => [item.id, item.title, item.description])) : 'No evidence documented.');

  sections.push('## Claim evidence inspection',
    'Reference status describes completeness only; it does not establish truth or semantic relevance. Only bundled records are inspected and no external links are fetched.');
  if (!claimEvidence.length) sections.push('No claims are documented.');
  for (const claim of claimEvidence) {
    sections.push(`### ${markdown(claim.id)} · ${claim.referenceComplete ? 'Complete references' : 'Unsupported'}\n\nClaim source: ${markdown(claim.path)}\n\n${markdown(claim.text || 'No claim text documented.')}\n\nReference completeness reasons: ${claim.reasons.length ? markdown(claim.reasons.join('; ')) : 'No reference gaps found. This does not verify the claim.'}`);
    if (!claim.references.length) sections.push('No evidence references are recorded for this claim.');
    else sections.push(table(['Claim evidence ID', 'Status', 'Source path', 'Title', 'Description', 'Reference detail'], claim.references.map((reference) => [`Claim reference: ${reference.id || '(invalid ID)'}`, reference.status, reference.path || 'No local evidence path.', reference.title, reference.description, reference.reason])));
  }

  sections.push('## Subgroup evaluation');
  const groups = [...new Set([...expected, ...metrics.map((value) => record(value).group).filter(hasText).map((group) => group.trim())])];
  const metricRows = [];
  for (const group of groups) {
    const rows = metrics.filter((value) => hasText(record(value).group) && value.group.trim() === group);
    if (!rows.length) metricRows.push([group, '—', '—', '—', 'Missing expected group']);
    for (const value of rows) {
      const metric = record(value);
      const status = validMetric(metric) ? (metric.sampleSize < 30 ? 'Valid; small sample (<30)' : 'Valid')
        : expected.includes(group) && !rows.some(validMetric) ? 'Invalid metric; missing valid expected data' : 'Invalid metric';
      metricRows.push([group, metric.sampleSize, metric.accuracy, metric.falsePositiveRate, status]);
    }
  }
  for (const value of metrics.filter((metric) => !hasText(record(metric).group))) {
    const metric = record(value);
    metricRows.push(['Unnamed group', metric.sampleSize, metric.accuracy, metric.falsePositiveRate, 'Invalid metric']);
  }
  sections.push(metricRows.length ? table(['Group', 'Sample size', 'Accuracy (%)', 'False-positive rate (%)', 'Data status'], metricRows) : 'No expected subgroups or metrics documented.');

  sections.push('## Data use and consent', table(['Policy field', 'Value'], [
    ['Collection', data.collection], ['Consent', data.consent],
    ['Sensitive attributes', data.sensitiveAttributes], ['Retention days', data.retentionDays],
  ]));
  const statements = list(data.statements).map(record);
  sections.push(statements.length ? table(['Statement ID', 'Scope', 'Requires consent (flag)', 'Statement text'], statements.map((item) => [item.id, item.scope, item.requiresConsent, item.text])) : 'No data-use statements documented.');
  sections.push('## Threat scenarios and mitigations');
  const threats = list(card.threats).map(record);
  sections.push(threats.length ? table(['ID', 'Threat', 'Severity', 'Status', 'Mitigation'], threats.map((item) => [item.id, item.name, item.severity, item.status, item.mitigation])) : 'No threats documented.');
  sections.push('## Accessibility checks');
  const checks = list(card.accessibility).map(record);
  sections.push(checks.length ? table(['ID', 'Check', 'Status', 'Detail'], checks.map((item) => [item.id, item.name, item.status, item.detail])) : 'No accessibility checks documented.');
  sections.push('## Privacy / fairness strategy tradeoffs');
  const tradeoffs = list(card.tradeoffs).map(record);
  sections.push(tradeoffs.length ? table(['ID', 'Strategy', 'Privacy risk (0–100)', 'Fairness visibility (0–100)', 'Current', 'Description'], tradeoffs.map((item) => [item.id, item.name, item.privacyRisk, item.fairnessVisibility, item.current, item.description])) : 'No tradeoff comparisons documented.');

  const fixtures = getThreatFixtures(card);
  sections.push('## Synthetic threat fixtures',
    'These fixture narratives are explicitly synthetic, inert, and for manual review only. They are not executed, measured, or used as scoring inputs. Expected behavior is a human reviewer expectation, not a test result.');
  if (!fixtures.length) sections.push(card.synthetic === true ? 'No synthetic threat fixtures are bundled for this card’s documented threats.' : 'Synthetic threat fixtures are available only for explicitly synthetic model cards; none are shown for this card.');
  for (const fixture of fixtures) {
    const threat = list(card.threats).map(record).find((item) => item.id === fixture.threatId);
    sections.push(`### ${markdown(fixture.title)} · ${markdown(fixture.id)}\n\nFixture ID: ${markdown(fixture.id)}\n\nModel ID: ${markdown(fixture.modelId)}\n\nThreat ID: ${markdown(fixture.threatId)}\n\nSynthetic: ${markdown(fixture.synthetic)}\n\nKind: ${markdown(fixture.kind)}\n\nSetup: ${markdown(fixture.setup)}\n\nInput example:\n\n\`\`\`text\n${markdown(fixture.input)}\n\`\`\`\n\nExpected behavior: ${markdown(fixture.expectedBehavior)}\n\nWhy this fixture matters: ${markdown(fixture.explanation)}\n\nManual review check: ${markdown(fixture.reviewCheck)}\n\nLinked threat: ${markdown(threat?.name || fixture.threatId)}; severity: ${markdown(threat?.severity)}; status: ${markdown(threat?.status)}; mitigation: ${markdown(threat?.mitigation)}`);
  }

  sections.push('## Scoring-rule explanations',
    `Policy version: ${markdown(scoringPolicy.version)}. Accuracy-gap review threshold: strictly greater than ${markdown(scoringPolicy.accuracyGapThreshold)} percentage points. Small-sample review threshold: sampleSize < ${markdown(scoringPolicy.minimumSubgroupSample)}.`,
    'Formula summary: each dimension score is round(100 × covered / total). Overall coverage is the equal-weight mean of the five unrounded dimension ratios, rounded once at the end. Findings, trade-off estimates, and threat fixture narratives do not directly alter scores.');
  for (const rule of scoringRules) {
    sections.push(`### ${markdown(rule.title)} · ${markdown(rule.id)}\n\nCategory: ${markdown(rule.category)}\n\nTrigger: ${markdown(rule.trigger)}\n\nEffect: ${markdown(rule.effect)}\n\nLimit and uncertainty caveat: ${markdown(rule.limit)}`);
  }

  sections.push('## Findings and suggested actions');
  const findings = list(audit.findings).map(record);
  if (!findings.length) sections.push('No findings generated. This does not establish safety or completeness beyond the documented checks.');
  for (const item of findings) {
    sections.push(`### ${markdown(item.id)}: ${markdown(item.title)}\n\nSeverity: **${markdown(item.severity)}** · Category: ${markdown(item.category)}\n\n${markdown(item.description)}\n\nEvidence: ${markdown(item.evidence)}\n\nSuggested action: ${markdown(item.recommendation)}`);
    if (list(item.sources).length) sections.push('Source records (bundled card paths; content not independently verified):\n\n'
      + item.sources.map((value) => { const entry = record(value); return `- **${markdown(entry.label)}** — ${markdown(entry.path)}: ${markdown(entry.detail)}`; }).join('\n'));
  }
  sections.push('## Reviewer notes', hasText(reviewerNotes) ? markdown(reviewerNotes) : 'No reviewer notes provided.');
  sections.push('## Limitations', strings(card.limitations).length
    ? strings(card.limitations).map((limitation) => `- ${markdown(limitation)}`).join('\n') : 'No card limitations documented.');
  sections.push('This packet is a synthetic, fictional review exercise. Review the underlying evidence, sampling assumptions, consent policy, and accessibility context before drawing conclusions. Missing findings do not imply the absence of harm.');
  return `${sections.join('\n\n')}\n`;
}
