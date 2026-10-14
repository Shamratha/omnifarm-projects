import test from 'node:test';
import assert from 'node:assert/strict';

import { DEMO_NOW, policies, teams } from '../src/data.js';
import {
  evaluateAll,
  evaluateCase,
  getWorkloads,
  sortCases,
} from '../src/engine.js';

const HOUR = 60 * 60 * 1000;

function atHoursFromNow(hours) {
  return new Date(Date.parse(DEMO_NOW) + hours * HOUR).toISOString();
}

function caseFixture(overrides = {}) {
  return {
    id: 'TEST-CASE',
    receivedAt: DEMO_NOW,
    subject: 'Community health service request',
    summary: 'Please coordinate a health clinic appointment.',
    categoryHint: 'health',
    language: 'en',
    languageLabel: 'English',
    person: { name: 'Test Person', email: 'test@example.test' },
    fields: [
      { label: 'Requested service', value: 'Health appointment', sensitive: false },
    ],
    documents: [
      { id: 'DOC-1', type: 'service-referral', status: 'received', content: 'Referral details' },
      { id: 'DOC-2', type: 'contact-consent', status: 'received', content: 'Consent details' },
    ],
    deadline: atHoursFromNow(96),
    safetyRisk: false,
    accommodations: [],
    region: 'Test district',
    ...overrides,
  };
}

function hasFlag(route, text) {
  return route.flags.some((flag) => flag.includes(text));
}

test('normalizes multilingual evidence while preserving Spanish, French, and RTL source fields', () => {
  const spanish = caseFixture({
    id: 'LANG-ES',
    subject: 'VÍVIENDA y DESALOJO',
    summary: 'Necesito alojamiento temporal antes de esta noche.',
    categoryHint: null,
    language: 'es',
    languageLabel: 'Español',
    fields: [
      { label: 'Servicio solicitado', value: 'Alojamiento de emergencia', sensitive: false },
    ],
    documents: [],
  });
  const french = caseFixture({
    id: 'LANG-FR',
    subject: 'PÉRMIS de construire',
    summary: 'Une autorisation est demandée pour une petite structure.',
    categoryHint: null,
    language: 'fr',
    languageLabel: 'Français',
    fields: [
      { label: 'Service demandé', value: 'Permis et autorisation', sensitive: false },
    ],
    documents: [],
  });
  const arabicSubject = 'الصِّحَّة المجتمعية';
  const arabicField = 'رعاية صحية مع مترجم ومدخل دون درجات';
  const arabic = caseFixture({
    id: 'LANG-AR',
    subject: arabicSubject,
    summary: 'أحتاج إلى موعد قريب في العيادة.',
    categoryHint: null,
    language: 'ar',
    languageLabel: 'العربية',
    fields: [
      { label: 'الوصول', value: arabicField, sensitive: false },
    ],
    documents: [],
  });

  const spanishResult = evaluateCase(spanish, { now: DEMO_NOW });
  const frenchResult = evaluateCase(french, { now: DEMO_NOW });
  const arabicResult = evaluateCase(arabic, { now: DEMO_NOW });

  assert.equal(spanishResult.classification.category, 'housing');
  assert.equal(spanishResult.route.teamId, 'team-housing');
  assert.equal(frenchResult.classification.category, 'permits');
  assert.equal(frenchResult.route.teamId, 'team-permits');
  assert.equal(arabicResult.classification.category, 'health');
  assert.equal(arabicResult.route.teamId, 'team-health');
  assert.equal(arabicResult.subject, arabicSubject);
  assert.equal(arabicResult.fields[0].value, arabicField);
  assert.equal(arabicResult.languageLabel, 'العربية');
});

test('applies inclusive urgent and high thresholds and labels overdue work', () => {
  const urgent = evaluateCase(caseFixture({ id: 'DUE-24', deadline: atHoursFromNow(24) }), { now: DEMO_NOW });
  const high = evaluateCase(caseFixture({ id: 'DUE-72', deadline: atHoursFromNow(72) }), { now: DEMO_NOW });
  const overdue = evaluateCase(caseFixture({ id: 'OVERDUE', deadline: atHoursFromNow(-1) }), { now: DEMO_NOW });

  assert.equal(urgent.hoursRemaining, 24);
  assert.equal(urgent.priority.level, 'urgent');
  assert.equal(urgent.dueLabel, 'Due in 24h');
  assert.deepEqual(urgent.flags.find((flag) => flag.type === 'deadline'), {
    type: 'deadline',
    label: 'Deadline within 24h',
  });

  assert.equal(high.hoursRemaining, 72);
  assert.equal(high.priority.level, 'high');
  assert.equal(high.dueLabel, 'Due in 3d');
  assert.deepEqual(high.flags.find((flag) => flag.type === 'deadline'), {
    type: 'deadline',
    label: 'Deadline within 72h',
  });

  assert.equal(overdue.hoursRemaining, -1);
  assert.equal(overdue.priority.level, 'urgent');
  assert.equal(overdue.dueLabel, 'Overdue by 1h');
  assert.deepEqual(overdue.flags.find((flag) => flag.type === 'deadline'), {
    type: 'deadline',
    label: 'Deadline overdue',
  });
});

test('returns an inspectable deadline calculation with inclusive boundary examples', () => {
  const submitted = evaluateCase(caseFixture({ id: 'BREAKDOWN-SUBMITTED', deadline: atHoursFromNow(24) }), { now: DEMO_NOW });
  const breakdown = submitted.deadlineBreakdown;

  assert.equal(breakdown.source, 'deadline');
  assert.equal(breakdown.sourceLabel, 'Submitted deadline');
  assert.match(breakdown.calculation, /submitted deadline/);
  assert.match(breakdown.calculation, /24h remaining/);
  assert.deepEqual(breakdown.thresholdRules.map((rule) => [rule.hours, rule.comparison, rule.outcome]), [
    [24, '<=', 'urgent'],
    [72, '<=', 'high'],
  ]);
  assert.deepEqual(breakdown.boundaryExamples.map((example) => [example.label, example.resultingPriority]), [
    ['Overdue by 1ms', 'urgent'],
    ['Due now', 'urgent'],
    ['Exactly 24h', 'urgent'],
    ['24h + 1ms', 'high'],
    ['Exactly 72h', 'high'],
    ['72h + 1ms', 'normal'],
  ]);
  assert.equal(submitted.route.teamId, 'team-health');
  assert.equal(submitted.audit.find((event) => event.action === 'Deadline & priority').reason.includes('inclusive 24-hour urgent'), true);
});

test('deadline breakdown explains policy SLA fallback and invalid deadline review', () => {
  const sla = evaluateCase(caseFixture({ id: 'BREAKDOWN-SLA', deadline: undefined, receivedAt: atHoursFromNow(-48) }), { now: DEMO_NOW });
  assert.equal(sla.deadlineBreakdown.source, 'sla');
  assert.equal(sla.deadlineBreakdown.policySlaHours, 72);
  assert.match(sla.deadlineBreakdown.calculation, /policy SLA 72h/);
  assert.equal(sla.deadlineBreakdown.deadlineAt, atHoursFromNow(24));

  const invalid = evaluateCase(caseFixture({ id: 'BREAKDOWN-INVALID', deadline: 'not-a-date' }), { now: DEMO_NOW });
  assert.equal(invalid.deadlineBreakdown.invalid, true);
  assert.equal(invalid.deadlineBreakdown.deadlineAt, null);
  assert.match(invalid.deadlineBreakdown.calculation, /could not be parsed/);
  assert.equal(invalid.route.needsReview, true);
});

test('returns the policy escalation rule, trigger breakdown, and next handling action beside the route', () => {
  const safety = evaluateCase(caseFixture({ id: 'ESCALATION-SAFETY', deadline: atHoursFromNow(96), safetyRisk: true }), { now: DEMO_NOW });
  assert.equal(safety.escalation.policyId, 'POL-HEALTH');
  assert.equal(safety.escalation.status, 'review-required');
  assert.equal(safety.escalation.reviewRequired, true);
  assert.ok(safety.escalation.triggers.includes('Reported safety risk'));
  assert.match(safety.escalation.rule, /safety risks/);
  assert.match(safety.escalation.action, /duty lead/);

  const standard = evaluateCase(caseFixture({ id: 'ESCALATION-STANDARD', deadline: atHoursFromNow(96) }), { now: DEMO_NOW });
  assert.equal(standard.escalation.status, 'standard');
  assert.equal(standard.escalation.reviewRequired, false);
  assert.deepEqual(standard.escalation.triggers, []);
  assert.match(standard.escalation.action, /standard service route/);
});

test('honors a service-specific review boundary separately from the global urgent boundary', () => {
  const completePermit = {
    ...caseFixture({
      id: 'ESCALATION-PERMIT-72',
      subject: 'Permit application review',
      summary: 'A permit application needs review.',
      categoryHint: 'permits',
      deadline: atHoursFromNow(72),
      fields: [{ label: 'Requested service', value: 'Permit application', sensitive: false }],
      documents: [
        { type: 'permit-application', status: 'received', content: 'Synthetic application' },
        { type: 'site-plan', status: 'received', content: 'Synthetic site plan' },
        { type: 'owner-authorization', status: 'received', content: 'Synthetic authorization' },
      ],
    }),
  };
  const atBoundary = evaluateCase(completePermit, { now: DEMO_NOW });
  assert.equal(atBoundary.priority.level, 'high');
  assert.equal(atBoundary.route.teamId, 'team-permits');
  assert.equal(atBoundary.route.needsReview, true);
  assert.ok(atBoundary.escalation.triggers.includes('Deadline is at or inside the 72-hour service review boundary'));
  assert.ok(atBoundary.route.flags.some((flag) => flag.includes('within 72 hours inclusive')));

  const oneMillisecondBeyond = evaluateCase({ ...completePermit, id: 'ESCALATION-PERMIT-72-PLUS', deadline: new Date(Date.parse(DEMO_NOW) + 72 * HOUR + 1).toISOString() }, { now: DEMO_NOW });
  assert.equal(oneMillisecondBeyond.priority.level, 'normal');
  assert.equal(oneMillisecondBeyond.route.needsReview, false);
  assert.deepEqual(oneMillisecondBeyond.escalation.triggers, []);
});

test('returns explicit case state for routed, review-required, incomplete, and unassigned outcomes', () => {
  const routed = evaluateCase(caseFixture({ id: 'STATE-ROUTED', deadline: atHoursFromNow(96) }), { now: DEMO_NOW });
  assert.deepEqual(routed.caseState, {
    status: 'routed',
    label: 'Routed',
    reason: 'The intake is accepted and has a capability-compatible service destination.',
    intake: 'accepted',
    documentStatus: 'complete',
    deadlineStatus: 'scheduled',
    escalationStatus: 'standard',
    priority: 'normal',
    requiresHumanReview: false,
    isAssigned: true,
    canProgress: true,
  });

  const incomplete = evaluateCase(caseFixture({ id: 'STATE-INCOMPLETE', categoryHint: 'permits', subject: 'Permis', summary: 'Demande de permis urgente.', deadline: atHoursFromNow(48), fields: [{ label: 'Requested service', value: 'Permit application', sensitive: false }], documents: [] }), { now: DEMO_NOW });
  assert.equal(incomplete.caseState.status, 'review-required');
  assert.equal(incomplete.caseState.documentStatus, 'incomplete');
  assert.equal(incomplete.caseState.intake, 'accepted');
  assert.equal(incomplete.caseState.canProgress, false);

  const unassigned = evaluateCase(caseFixture({ id: 'STATE-UNASSIGNED', deadline: atHoursFromNow(96) }), { now: DEMO_NOW, teams: [] });
  assert.equal(unassigned.caseState.status, 'unassigned');
  assert.equal(unassigned.caseState.label, 'Manual assignment');
  assert.equal(unassigned.caseState.isAssigned, false);
  assert.equal(unassigned.caseState.requiresHumanReview, true);
  assert.equal(unassigned.caseState.canProgress, false);
});

test('accepts incomplete intake, reports missing documents, and preserves urgency', () => {
  const input = caseFixture({
    id: 'MISSING-DOCS',
    subject: 'Permis de construire',
    summary: 'La demande de permis est urgente.',
    categoryHint: 'permits',
    language: 'fr',
    languageLabel: 'Français',
    deadline: atHoursFromNow(24),
    fields: [],
    documents: [
      { id: 'PERMIT-1', type: 'permit-application', status: 'received', content: 'Application received' },
    ],
  });
  const result = evaluateCase(input, { now: DEMO_NOW });

  assert.deepEqual(result.missingDocuments, [
    { type: 'site-plan', label: 'Site plan showing the proposed work' },
    { type: 'owner-authorization', label: 'Property owner authorization or applicant declaration' },
  ]);
  assert.equal(result.priority.level, 'urgent');
  assert.equal(result.route.teamId, 'team-permits');
  assert.equal(result.route.needsReview, true);
  assert.ok(hasFlag(result.route, 'Required documents are outstanding'));
  assert.deepEqual(result.flags.find((flag) => flag.type === 'documents'), {
    type: 'documents',
    label: '2 required documents missing — intake accepted',
  });
  assert.match(
    result.audit.find((entry) => entry.action === 'Documents').reason,
    /intake remains accepted, urgency is preserved/,
  );
});

test('retains access requests and distinguishes eligible teams from language and capability gaps', () => {
  const eligible = evaluateCase(caseFixture({
    id: 'ACCESS-ELIGIBLE',
    language: 'ar',
    languageLabel: 'Arabic',
    accommodations: ['interpreter', 'step-free'],
  }), { now: DEMO_NOW });
  const unsupportedLanguage = evaluateCase(caseFixture({
    id: 'ACCESS-LANGUAGE-GAP',
    language: 'de',
    languageLabel: 'German',
    accommodations: ['interpreter'],
  }), { now: DEMO_NOW });
  const unsupportedAccess = evaluateCase(caseFixture({
    id: 'ACCESS-CAPABILITY-GAP',
    language: 'ar',
    languageLabel: 'Arabic',
    accommodations: ['interpreter', 'wheelchair'],
  }), { now: DEMO_NOW });

  assert.deepEqual(eligible.accommodations, ['interpreter', 'step-free']);
  assert.equal(eligible.route.teamId, 'team-health');
  assert.equal(eligible.route.needsReview, false);
  assert.deepEqual(eligible.flags.filter((flag) => flag.type === 'access'), [
    { type: 'access', label: 'Step-free access' },
  ]);

  assert.equal(unsupportedLanguage.route.teamId, 'team-health');
  assert.equal(unsupportedLanguage.route.needsReview, true);
  assert.ok(hasFlag(unsupportedLanguage.route, 'Preferred language is not supported'));
  assert.deepEqual(unsupportedLanguage.flags.find((flag) => flag.type === 'language'), {
    type: 'language',
    label: 'Preferred language: German',
  });

  assert.deepEqual(unsupportedAccess.accommodations, ['interpreter', 'wheelchair']);
  assert.equal(unsupportedAccess.route.teamId, 'team-health');
  assert.equal(unsupportedAccess.route.needsReview, true);
  assert.ok(hasFlag(unsupportedAccess.route, 'Requested access support is not fully supported'));
  assert.deepEqual(unsupportedAccess.flags.find((flag) => flag.type === 'access'), {
    type: 'access',
    label: 'Unrecognized access request — confirm support',
  });
});

// An unrelated document type prevents classification evidence from hiding field failures.
for (const fixture of [
  { language: 'es', label: 'Español', text: 'ATENCIÓN SANITARIA', category: 'health' },
  { language: 'fr', label: 'Français', text: 'HE\u0301BERGEMENT', category: 'housing' },
  { language: 'ar', label: 'العربية', text: 'الإِخْـلَاء', category: 'housing' },
]) {
  for (const evidence of ['subject', 'summary', 'field value', 'field label']) {
    test(`classifies ${fixture.label} using only ${evidence}, without a category hint`, () => {
      const input = caseFixture({
        subject: 'Request',
        summary: 'Please help.',
        categoryHint: null,
        language: fixture.language,
        languageLabel: fixture.label,
        fields: [],
        documents: [],
      });
      if (evidence === 'subject' || evidence === 'summary') input[evidence] = fixture.text;
      else input.fields = [{
        label: evidence === 'field label' ? fixture.text : 'Request',
        value: evidence === 'field value' ? fixture.text : 'Please help.',
        sensitive: false,
      }];

      const result = evaluateCase(input, { now: DEMO_NOW });
      assert.equal(result.classification.category, fixture.category);
      assert.equal(result.classification.source, 'keywords');
      assert.equal(result.route.teamId, `team-${fixture.category}`);
      assert.equal(result.subject, input.subject);
      assert.equal(result.summary, input.summary);
      assert.deepEqual(result.fields, input.fields);
      assert.equal(result.redacted.subject, input.subject);
      assert.equal(result.redacted.summary, input.summary);
      assert.deepEqual(result.redacted.fields, input.fields);
      assert.equal(result.language, fixture.language);
      assert.equal(result.redacted.languageLabel, fixture.label);
    });
  }
}

for (const { offset, level, label } of [
  { offset: -1, level: 'urgent', label: 'one millisecond overdue' },
  { offset: 0, level: 'urgent', label: 'due now' },
  { offset: 24 * HOUR - 1, level: 'urgent', label: 'just inside 24 hours' },
  { offset: 24 * HOUR + 1, level: 'high', label: 'just beyond 24 hours' },
  { offset: 72 * HOUR - 1, level: 'high', label: 'just inside 72 hours' },
  { offset: 72 * HOUR + 1, level: 'normal', label: 'just beyond 72 hours' },
]) {
  test(`deadline priority is ${level} for ${label}`, () => {
    const result = evaluateCase(caseFixture({
      deadline: new Date(Date.parse(DEMO_NOW) + offset).toISOString(),
    }), { now: DEMO_NOW });
    assert.equal(result.priority.level, level);
    assert.equal(result.hoursRemaining, offset / HOUR);
    assert.equal(hasFlag(result.route, 'Urgent case'), level === 'urgent');
    if (offset === 0) assert.equal(result.dueLabel, 'Due now');
    if (level === 'normal') assert.ok(!result.flags.some((flag) => flag.type === 'deadline'));
  });
}

test('safety risk escalates to urgent even when the deadline is outside the escalation window', () => {
  const result = evaluateCase(caseFixture({ safetyRisk: true }), { now: DEMO_NOW });
  assert.equal(result.priority.level, 'urgent');
  assert.ok(hasFlag(result.route, 'Urgent case'));
  assert.match(result.priority.reasons.join(' '), /safety risk/i);
});

for (const hours of [24, 72]) {
  test(`documents with missing or pending status cannot postpone a ${hours}-hour case`, () => {
    const complete = caseFixture({ deadline: atHoursFromNow(hours) });
    const incomplete = caseFixture({
      deadline: atHoursFromNow(hours),
      documents: [
        { type: 'service-referral', status: 'missing', content: '' },
        { type: 'contact-consent', status: 'pending', content: 'Not yet received' },
        { type: 'optional-photo', status: 'received', content: 'Not a required document' },
      ],
    });
    const expected = evaluateCase(complete, { now: DEMO_NOW });
    const actual = evaluateCase(incomplete, { now: DEMO_NOW });

    assert.deepEqual(actual.missingDocuments.map((document) => document.type), [
      'service-referral', 'contact-consent',
    ]);
    assert.equal(actual.priority.level, hours === 24 ? 'urgent' : 'high');
    assert.equal(actual.priority.level, expected.priority.level);
    assert.equal(actual.hoursRemaining, expected.hoursRemaining);
    assert.equal(actual.route.teamId, expected.route.teamId);
    assert.ok(hasFlag(actual.route, 'keeping the case accepted'));
    assert.match(actual.audit.find((entry) => entry.action === 'Documents').reason, /follow-up review/);
  });
}

const ALL_ACCESS = ['interpreter', 'step-free', 'large-print', 'screen-reader'];

function teamFixture(id, overrides = {}) {
  return {
    id,
    name: `Service ${id}`,
    capacity: 10,
    baseline: 0,
    languages: ['en', 'ar'],
    accommodations: [...ALL_ACCESS],
    ...overrides,
  };
}

function healthConfiguration(configuredTeams) {
  const policy = policies.find((entry) => entry.category === 'health');
  return {
    now: DEMO_NOW,
    teams: configuredTeams,
    policies: configuredTeams.map((team) => ({ ...policy, id: `POL-${team.id}`, teamId: team.id })),
  };
}

test('chooses a fully capable service team over lighter teams with language or access gaps', () => {
  const configuredTeams = [
    teamFixture('access-gap', { accommodations: ['interpreter'] }),
    teamFixture('language-gap', { languages: ['en'] }),
    teamFixture('eligible', { baseline: 8 }),
  ];
  const input = caseFixture({
    language: 'AR-eg',
    languageLabel: 'Arabic',
    accommodations: [...ALL_ACCESS],
  });
  const result = evaluateCase(input, healthConfiguration(configuredTeams));

  assert.equal(result.route.teamId, 'eligible');
  assert.equal(result.route.needsReview, false);
  assert.deepEqual(result.accommodations, ALL_ACCESS);
  assert.deepEqual(result.redacted.accommodations, ALL_ACCESS);
  for (const label of ['Interpreter', 'Step-free access', 'Large print', 'Screen-reader compatible format']) {
    assert.ok(result.flags.some((flag) => flag.label === label), `${label} must remain visible`);
  }
  assert.equal(result.priority.level, 'normal');
  assert.ok(result.priority.score > evaluateCase(caseFixture(), { now: DEMO_NOW }).priority.score);
});

test('provisionally routes to the smallest capability gap and requests accessibility review', () => {
  const configuredTeams = [
    teamFixture('many-gaps', { languages: ['en'], accommodations: [] }),
    teamFixture('one-gap', { baseline: 7, accommodations: ['interpreter'] }),
  ];
  const input = caseFixture({
    language: 'ar',
    languageLabel: 'العربية',
    accommodations: ['interpreter', 'step-free'],
  });
  const result = evaluateCase(input, healthConfiguration(configuredTeams));
  assert.equal(result.route.teamId, 'one-gap');
  assert.equal(result.route.needsReview, true);
  assert.ok(hasFlag(result.route, 'manual accessibility handoff'));
  assert.ok(!hasFlag(result.route, 'Preferred language is not supported'));
  assert.deepEqual(result.accommodations, input.accommodations);
  assert.deepEqual(result.redacted.accommodations, input.accommodations);
  assert.ok(result.flags.some((flag) => flag.type === 'review'));
});

test('unsupported or absent preferred languages require explicit language review', () => {
  for (const language of ['ja-JP', '']) {
    const result = evaluateCase(caseFixture({ language, languageLabel: language ? 'Japanese' : '' }), {
      now: DEMO_NOW,
    });
    assert.equal(result.route.teamId, 'team-health');
    assert.equal(result.route.needsReview, true);
    assert.ok(hasFlag(result.route, 'confirmed language support through manual review'));
    assert.ok(result.flags.some((flag) => flag.type === 'language'));
    assert.equal(result.language, language);
  }
});

test('balances a batch deterministically and carries each assignment into workload totals', () => {
  const configuredTeams = [teamFixture('team-b'), teamFixture('team-a')];
  const options = healthConfiguration(configuredTeams);
  const input = ['D', 'B', 'C', 'A'].map((id) => caseFixture({
    id,
    deadline: atHoursFromNow(id === 'A' ? 24 : 96),
  }));
  const result = evaluateAll(input, options);

  assert.deepEqual(result.map((entry) => [entry.id, entry.route.teamId]), [
    ['A', 'team-a'], ['B', 'team-b'], ['C', 'team-a'], ['D', 'team-b'],
  ]);
  assert.deepEqual(evaluateAll([...input].reverse(), options), result);
  assert.deepEqual(evaluateAll(input, {
    ...options,
    teams: [...options.teams].reverse(),
  }), result);
  assert.deepEqual(getWorkloads(result, configuredTeams).map((entry) => ({
    id: entry.id,
    assigned: entry.assigned,
    active: entry.active,
    available: entry.available,
    utilization: entry.utilization,
    urgent: entry.urgent,
  })), [
    { id: 'team-b', assigned: 2, active: 2, available: 8, utilization: 20, urgent: 0 },
    { id: 'team-a', assigned: 2, active: 2, available: 8, utilization: 20, urgent: 1 },
  ]);
});

test('uses projected utilization, then active count, then team ID for routing ties', () => {
  const scenarios = [
    {
      label: 'projected utilization includes baseline and batch load',
      teams: [
        teamFixture('low-active', { baseline: 1, capacity: 2 }),
        teamFixture('low-utilization', { baseline: 3, capacity: 20 }),
      ],
      loads: { 'low-utilization': 2 },
      expected: 'low-utilization',
    },
    {
      label: 'lower active count wins when projected ratios tie',
      teams: [
        teamFixture('a-more-active', { baseline: 3, capacity: 8 }),
        teamFixture('z-less-active', { baseline: 1, capacity: 4 }),
      ],
      loads: {},
      expected: 'z-less-active',
    },
    {
      label: 'team ID wins a complete tie regardless of array order',
      teams: [teamFixture('z-last'), teamFixture('a-first')],
      loads: {},
      expected: 'a-first',
    },
  ];
  for (const scenario of scenarios) {
    const result = evaluateCase(caseFixture(), {
      ...healthConfiguration(scenario.teams),
      loads: scenario.loads,
    });
    assert.equal(result.route.teamId, scenario.expected, scenario.label);
  }
});

test('capacity overflow requests supervisor review without rejecting or downgrading the case', () => {
  const configuredTeams = [teamFixture('small-team', { capacity: 2, baseline: 1 })];
  const options = healthConfiguration(configuredTeams);
  const result = evaluateAll([
    caseFixture({ id: 'B', deadline: atHoursFromNow(24) }),
    caseFixture({ id: 'A', deadline: atHoursFromNow(1) }),
  ], options);

  assert.deepEqual(result.map((entry) => entry.route.teamId), ['small-team', 'small-team']);
  assert.equal(hasFlag(result[0].route, 'exceeds team capacity'), false, 'filling capacity is allowed');
  assert.ok(hasFlag(result[1].route, 'exceeds team capacity'));
  assert.ok(hasFlag(result[1].route, 'The case remains accepted'));
  assert.equal(result[1].route.needsReview, true);
  assert.equal(result[1].priority.level, 'urgent');
  const [workload] = getWorkloads(result, configuredTeams);
  assert.equal(workload.active, 3, 'baseline is counted once');
  assert.equal(workload.assigned, 2);
  assert.equal(workload.urgent, 2);
  assert.equal(workload.available, 0);
  assert.equal(workload.utilization, 150, 'overflow must remain visible');
});

test('sorts by priority, deadline, attention, intake time, and ID without changing the input order', () => {
  const inputs = [
    caseFixture({ id: 'normal', deadline: atHoursFromNow(96) }),
    caseFixture({ id: 'high', deadline: atHoursFromNow(48) }),
    caseFixture({ id: 'urgent-overdue', deadline: atHoursFromNow(-2) }),
    caseFixture({ id: 'urgent-due', deadline: atHoursFromNow(1) }),
    caseFixture({ id: 'attention', deadline: atHoursFromNow(4), accommodations: ['large-print'] }),
    caseFixture({ id: 'earlier-intake', deadline: atHoursFromNow(4), receivedAt: atHoursFromNow(-1) }),
    caseFixture({ id: 'id-b', deadline: atHoursFromNow(4) }),
    caseFixture({ id: 'id-a', deadline: atHoursFromNow(4) }),
    caseFixture({ id: 'safety-without-deadline', safetyRisk: true, receivedAt: null, deadline: null }),
  ];
  const expected = [
    'urgent-overdue', 'urgent-due', 'attention', 'earlier-intake', 'id-a', 'id-b',
    'safety-without-deadline', 'high', 'normal',
  ];
  const evaluated = inputs.map((input) => evaluateCase(input, { now: DEMO_NOW }));
  const originalOrder = evaluated.map((entry) => entry.id);
  const sorted = sortCases(evaluated);
  assert.deepEqual(sorted.map((entry) => entry.id), expected);
  assert.deepEqual(evaluated.map((entry) => entry.id), originalOrder);
  assert.deepEqual(sortCases([...evaluated].reverse()).map((entry) => entry.id), expected);
  assert.deepEqual(evaluateAll(inputs, { now: DEMO_NOW }).map((entry) => entry.id), expected);
});

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

test('does not mutate caller data or options and produces identical fixed-clock reruns', () => {
  const inputs = deepFreeze([
    caseFixture({ id: 'IMMUTABLE-B', accommodations: ['large-print'] }),
    caseFixture({ id: 'IMMUTABLE-A', deadline: atHoursFromNow(24) }),
  ]);
  const options = deepFreeze({
    ...healthConfiguration([teamFixture('team-a'), teamFixture('team-b')]),
    loads: { 'team-a': 2 },
  });
  const before = structuredClone({ inputs, options });
  const first = evaluateCase(inputs[0], options);
  assert.deepEqual(evaluateCase(inputs[0], options), first);
  assert.deepEqual(evaluateCase(deepFreeze(structuredClone(first)), options), first);

  const batch = evaluateAll(inputs, options);
  assert.deepEqual(evaluateAll(inputs, options), batch);
  assert.deepEqual(evaluateAll(deepFreeze(structuredClone(batch)), options), batch);
  assert.deepEqual({ inputs, options }, before);
  for (const entry of batch) {
    assert.ok(entry.audit.every((audit) => audit.at === DEMO_NOW));
    assert.ok(!Object.hasOwn(entry.redacted, 'redacted'), 'reruns must not nest stale snapshots');
  }

  // Returned operational copies can be edited without changing the caller's record or rules.
  first.fields[0].value = 'Changed output';
  first.documents[0].content = 'Changed output body';
  first.policy.requiredDocuments[0].label = 'Changed output policy';
  first.redacted.accommodations.push('step-free');
  assert.deepEqual({ inputs, options }, before);
  const workloads = getWorkloads(batch, options.teams);
  workloads[0].languages.push('fr');
  assert.deepEqual({ inputs, options }, before);
});

for (const fixture of [
  { category: 'housing', sla: 24, team: 'team-housing', priority: 'urgent' },
  { category: 'benefits', sla: 48, team: 'team-benefits', priority: 'high' },
  { category: 'health', sla: 72, team: 'team-health', priority: 'high' },
  { category: 'permits', sla: 120, team: 'team-permits', priority: 'normal' },
  { category: 'public-works', sla: 168, team: 'team-public-works', priority: 'normal' },
]) {
  test(`uses the ${fixture.sla}-hour ${fixture.category} policy SLA when deadline is absent`, () => {
    const input = caseFixture({
      subject: 'Request', summary: '', fields: [], documents: [],
      categoryHint: fixture.category,
    });
    delete input.deadline;
    const result = evaluateCase(input, { now: DEMO_NOW });
    assert.equal(result.hoursRemaining, fixture.sla);
    assert.equal(result.priority.level, fixture.priority);
    assert.equal(result.route.teamId, fixture.team);
    assert.match(result.audit.find((entry) => entry.action === 'Deadline & priority').reason, /receivedAt .*policy SLA/);
    assert.ok(!hasFlag(result.route, 'usable deadline is unavailable'));
  });
}

test('SLA is anchored to receivedAt, recognizes null/empty deadlines, and preserves explicit deadlines', () => {
  for (const deadline of [undefined, null, '']) {
    const result = evaluateCase(caseFixture({ receivedAt: atHoursFromNow(-48), deadline }), { now: DEMO_NOW });
    assert.equal(result.hoursRemaining, 24);
    assert.equal(result.priority.level, 'urgent');
  }
  const overdue = evaluateCase(caseFixture({ receivedAt: atHoursFromNow(-73), deadline: null }), { now: DEMO_NOW });
  assert.equal(overdue.hoursRemaining, -1);
  assert.equal(overdue.priority.level, 'urgent');

  const explicit = evaluateCase(caseFixture({ receivedAt: atHoursFromNow(-48) }), { now: DEMO_NOW });
  assert.equal(explicit.hoursRemaining, 96);
  assert.equal(explicit.priority.level, 'normal');
  assert.match(explicit.audit.find((entry) => entry.action === 'Deadline & priority').reason, /submitted deadline/);

  const invalid = evaluateCase(caseFixture({ deadline: 'not a date' }), { now: DEMO_NOW });
  assert.equal(invalid.hoursRemaining, null);
  assert.equal(invalid.dueLabel, 'Deadline needs review');
  assert.ok(hasFlag(invalid.route, 'confirm the deadline'));
  const unavailable = evaluateCase(caseFixture({ deadline: null, receivedAt: null }), { now: DEMO_NOW });
  assert.equal(unavailable.hoursRemaining, null);
  assert.equal(unavailable.dueLabel, 'No deadline available');
  assert.ok(hasFlag(unavailable.route, 'confirm the deadline'));
});
