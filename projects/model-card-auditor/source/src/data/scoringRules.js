// Shared thresholds for the deterministic evidence-coverage policy. These are
// review prompts, not statistical significance or model-quality thresholds.
export const scoringPolicy = Object.freeze({
  accuracyGapThreshold: 5,
  minimumSubgroupSample: 30,
  version: '1.0',
});

// The nine finding rules plus two coverage explanations. No rule executes a
// threat fixture or treats fixture descriptions as evidence or a scoring input.
export const scoringRules = [
  {
    id: 'fairness-missing-data',
    title: 'Subgroup evaluation data is missing or invalid',
    category: 'fairness',
    trigger: 'An expected subgroup has no valid metric, any supplied metric row is invalid, or no expected subgroups are documented. Expected groups are trimmed, nonempty, unique strings. A valid row needs a nonempty group, a positive integer sampleSize, and finite numeric accuracy and falsePositiveRate in the inclusive range 0–100; a missing, nonnumeric, or out-of-range false-positive rate invalidates the entire row.',
    effect: 'Creates a high-priority finding. Fairness coverage has one unit per unique expected subgroup with at least one valid metric; invalid rows are not counted. The first valid row for each trimmed group is used. Unexpected groups add no coverage units. With no expected groups the denominator is one and coverage is zero. An extra invalid row still triggers review even if valid rows cover every expected group.',
    limit: 'Missing data is not evidence of equal performance. Validity checks establish field completeness, not evaluation quality, representative sampling, comparable groups, or reliable uncertainty estimates.',
  },
  {
    id: 'fairness-small-samples',
    title: 'Some subgroup samples are small',
    category: 'fairness',
    trigger: `Any first valid metric per named subgroup has sampleSize n < ${scoringPolicy.minimumSubgroupSample}. A valid n of 1–29 triggers review; n = 30 does not. This includes valid groups outside the expected inventory, but excludes invalid metric rows.`,
    effect: 'Creates a medium-priority finding. A small but valid sample still covers its expected subgroup unit; this finding does not deduct points or remove the metric from the descriptive accuracy gap.',
    limit: 'The sample threshold is a review heuristic, not a power calculation or confidence interval. The engine does not estimate uncertainty or establish that larger samples are representative or conclusive.',
  },
  {
    id: 'fairness-accuracy-gap',
    title: 'Subgroup accuracy gap exceeds 5 percentage points',
    category: 'fairness',
    trigger: `The max minus min accuracy across the first valid metric per trimmed group, rounded to six decimal places, is strictly > ${scoringPolicy.accuracyGapThreshold} percentage points (gap > 5pp). Exactly 5pp does not trigger review. All valid named groups are included, even unexpected groups or small samples; fewer than two valid groups gives a gap of zero. Invalid false-positive rates also exclude rows from the gap.`,
    effect: 'Creates a high-priority finding and reports the descriptive accuracy range in percentage points. The gap is not a coverage unit and does not deduct points; expected subgroups with valid metrics remain covered.',
    limit: 'A percentage-point gap is not a relative percent change or a statistical fairness determination. Age and language slices may overlap or use incomparable populations and conditions. No significance test or uncertainty interval is computed; a zero gap with sparse data establishes nothing about equal performance.',
  },
  {
    id: 'claims-unsupported',
    title: 'Claims lack complete evidence references',
    category: 'claims',
    trigger: 'There are no claims, or a claim lacks a nonempty ID or text, has no evidence references, or has any invalid or unresolved reference. Every reference must be a nonempty string that resolves by trimmed ID to a bundled evidence entry with a nonempty ID, title, and description. One valid reference does not compensate for another missing reference.',
    effect: 'Creates a medium-priority finding. Each fully referenced claim contributes one Documentation unit; incomplete claims contribute zero while still remaining in the denominator. With no claims, one uncovered claim unit remains. Claims are not a separate sixth coverage dimension.',
    limit: 'Reference presence is not truth: the engine does not read evidence for semantic support, independently verify it, resolve external material, or fact-check a claim. The supported-claims count means complete local references only.',
  },
  {
    id: 'privacy-consent-conflict',
    title: 'Consent requirements conflict within a scope',
    category: 'privacy',
    trigger: 'Both consent-required and consent-not-required positions occur within training, evaluation, or retention. Positions combine boolean requiresConsent flags with bounded affirmative and negative wording heuristics in scoped statement text and dataUse.consent. General consent clauses apply to every scope unless they explicitly name scopes. Agreement between flags does not override conflicting text; different positions in separate scopes alone are not a contradiction.',
    effect: 'Creates a high-priority finding. Each contradictory scope loses its one Privacy scope unit, even if its statements are otherwise complete. The four valid policy-field units remain independent. A consistent requirement of false is not itself a conflict and can count as documented scope coverage.',
    limit: 'Consent parsing is a bounded text heuristic with handling for some negations, not a natural-language policy verdict. Consistent documentation does not establish appropriate consent, lawful data use, enforcement, or a privacy guarantee; a human must interpret the policy.',
  },
  {
    id: 'privacy-missing-data',
    title: 'Data-use documentation is incomplete',
    category: 'privacy',
    trigger: 'Collection, consent, or sensitiveAttributes text is missing; retentionDays is not a non-negative integer; any training, evaluation, or retention scope has no statements or an incomplete statement; or any statement has an unknown scope. Every statement within each required scope must have a nonempty ID, nonempty text, and a boolean requiresConsent flag.',
    effect: 'Creates a medium-priority finding. Privacy has seven units: collection, consent, sensitiveAttributes, retentionDays, and one complete, non-contradictory statement set for each of training, evaluation, and retention. Zero retention days is valid. An unknown scope prevents all three scope units from counting, but does not invalidate otherwise documented field units.',
    limit: 'Completeness and internal consistency do not measure privacy risk. The engine sets no maximum retention period and does not evaluate whether collection or sensitive-attribute handling is justified. Conflicting scope documentation is explained separately by privacy-consent-conflict.',
  },
  {
    id: 'security-unmitigated',
    title: 'Threat mitigations need review',
    category: 'security',
    trigger: 'No threats are documented, or any threat lacks nonempty ID, name, or mitigation text, has severity other than high, medium, or low, or has status other than mitigated.',
    effect: 'Creates a high-priority finding when the threat inventory is empty or any unresolved threat has severity high; otherwise it is medium priority. Security has one unit per threat entry, covered only when all required fields are valid and status is mitigated. An empty inventory leaves one uncovered unit. Severity determines finding priority, not the weight of a coverage unit.',
    limit: 'Threat statuses are self-reported, not independently verified. Mitigation text and mitigated status do not establish control effectiveness or a complete threat inventory. Fictional narrative fixture descriptions are not a scoring input; viewing them does not execute an injection, change status, or verify a mitigation.',
  },
  {
    id: 'accessibility-failed',
    title: 'Accessibility checks failed',
    category: 'accessibility',
    trigger: 'Any accessibility entry has status fail, even if its ID, name, or detail is incomplete.',
    effect: 'Creates a high-priority finding. Accessibility has one unit per listed check; only status pass with nonempty ID, name, and detail covers a unit. Failed checks stay in the denominator and contribute zero. A failed row is not also classified as an incomplete non-failed check by accessibility-missing.',
    limit: 'A recorded failure describes a reported barrier in the fictional workflow, not an independently reproduced result. Statuses are self-reported; the engine neither runs assistive-technology checks nor judges the completeness of the chosen accessibility inventory.',
  },
  {
    id: 'accessibility-missing',
    title: 'Accessibility coverage is incomplete',
    category: 'accessibility',
    trigger: 'There are no accessibility checks, or any non-failed entry is not a documented pass. A documented pass requires status pass and nonempty ID, name, and detail; not-tested, unknown statuses, or incomplete pass entries do not qualify.',
    effect: 'Creates a medium-priority finding. Untested and incomplete entries contribute zero of their Accessibility units. An empty list leaves one uncovered unit. Documented failed checks are handled by accessibility-failed; neither finding applies an additional point penalty.',
    limit: 'No missing-check finding does not establish accessible behavior for every user or assistive technology. The engine does not require particular check types or verify reported passes; recorded coverage is not an accessibility guarantee.',
  },
  {
    id: 'documentation-coverage',
    title: 'Documentation coverage units',
    category: 'documentation',
    trigger: 'This explanation applies to every audit, rather than generating its own finding. Documentation counts the eight nonempty text fields id, name, version, type, description, owner, lastReviewed, and intendedUse; at least one nonempty string in limitations; the explicit synthetic === true flag; and fully referenced claims.',
    effect: 'Each of the eight snapshot fields, the limitations list, and the synthetic flag contributes one unit, plus one unit per fully referenced claim. The denominator is 10 + max(number of claim entries, 1). Missing claims therefore leave one uncovered claim unit; invalid claim entries still count in the denominator. Dimension score = round(100 × covered / total).',
    limit: 'Text presence does not validate dates, determine adequacy, verify a synthetic declaration, or prove claims. Claim-reference presence is not truth. There is no separate documentation-coverage finding and no extra penalty beyond uncovered units.',
  },
  {
    id: 'overall-coverage',
    title: 'Overall evidence coverage formula',
    category: 'overall',
    trigger: 'This explanation applies to every audit, rather than generating its own finding. It combines Documentation, Fairness, Privacy, Security, and Accessibility, including dimensions with missing data.',
    effect: 'Each dimension score = round(100 × covered / total). Overall coverage = round((100 / 5) × sum(covered / total across the five dimensions)): the equal-weight mean of unrounded ratios, rounded once at the end, not the mean of rounded dimension scores or a pooled count of units. Findings do not directly subtract points; their underlying records determine covered units. Tradeoff estimates, comparison choices, and narrative fixture descriptions are not scoring inputs.',
    limit: 'Coverage measures documented evidence and recorded checks, not model quality, real risk, legal compliance, fairness, privacy, accessibility, or overall safety. Dimensions contain different kinds of units, and equal weighting is a policy choice. Missing findings, zero gaps, and 100% coverage are not assurance or certification; no statistical uncertainty is inferred.',
  },
];

/** Unknown rule IDs have no explanation rather than a substituted rule. */
export function getScoringRule(id) {
  return scoringRules.find((rule) => rule.id === id);
}
