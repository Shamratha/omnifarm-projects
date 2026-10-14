import test from 'node:test';
import assert from 'node:assert/strict';
import { modelCards } from '../src/data/modelCards.js';
import { auditModelCard, exportReviewPacket, inspectClaimEvidence } from '../src/lib/audit.js';
import { getThreatFixtures, threatFixtures } from '../src/data/threatFixtures.js';
import { getScoringRule, scoringPolicy, scoringRules } from '../src/data/scoringRules.js';

const atlas = modelCards.find((card) => card.id === 'atlas-assist');
const harbor = modelCards.find((card) => card.id === 'harbor-screen');
const lumen = modelCards.find((card) => card.id === 'lumen-caption');
const dimension = (audit, id) => audit.dimensions.find((item) => item.id === id);
const hasFinding = (audit, id) => audit.findings.some((finding) => finding.id === id);
const metric = (overrides = {}) => ({ group: 'Group A', sampleSize: 50, accuracy: 90, falsePositiveRate: 5, ...overrides });
const statement = (id, text, requiresConsent = true, scope = 'training') => ({ id, text, requiresConsent, scope });

function withConsent(statements, consent = 'Fictional policy for generated records.') {
  const card = structuredClone(lumen);
  card.dataUse.statements = [
    ...statements,
    statement('eval', 'Evaluation requires consent.', true, 'evaluation'),
    statement('retain', 'Retention requires consent.', true, 'retention'),
  ];
  card.dataUse.consent = consent;
  return card;
}

function assertEvidenceOnlyPacket(packet) {
  assert.match(packet, /\*\*Synthetic notice:\*\*.*explicitly synthetic and fictional/);
  assert.match(packet, /not a safety certification or permission to deploy/);
  assert.match(packet, /Coverage measures documentation and recorded checks, not model quality, legal compliance, fairness guarantees, privacy guarantees, or overall safety\./);
  assert.match(packet, /Evidence-reference coverage does not verify the evidence or establish the truth of the claim\./);
  assert.match(packet, /Missing findings, zero gaps, and 100% coverage are not assurance or certification/);
  assert.doesNotMatch(packet, /\b(?:safe to deploy|ready for deployment|approved for deployment|approved for production|deployment[- ]ready|safety certified|guarantees safety|provides assurance)\b/i);
}

test('all three complete scenario contracts are explicitly synthetic and fictional', () => {
  assert.deepEqual(modelCards.map((card) => card.id), ['atlas-assist', 'harbor-screen', 'lumen-caption']);
  for (const card of modelCards) {
    assert.equal(card.synthetic, true);
    for (const key of ['id', 'name', 'version', 'type', 'description', 'owner', 'lastReviewed', 'intendedUse']) {
      assert.equal(typeof card[key], 'string', `${card.id}.${key}`);
      assert.ok(card[key].length > 0);
    }
    assert.match(card.description, /fictional/i);
    assert.match(card.owner, /fictional/i);
    for (const key of ['limitations', 'expectedSubgroups']) assert.ok(card[key].every((item) => typeof item === 'string'));
    for (const row of card.metrics) {
      assert.equal(typeof row.group, 'string');
      assert.ok(Number.isInteger(row.sampleSize) && row.sampleSize > 0);
      for (const key of ['accuracy', 'falsePositiveRate']) assert.ok(Number.isFinite(row[key]) && row[key] >= 0 && row[key] <= 100);
    }
    for (const claim of card.claims) {
      assert.equal(typeof claim.id, 'string');
      assert.equal(typeof claim.text, 'string');
      assert.ok(claim.evidenceIds.every((id) => typeof id === 'string'));
    }
    for (const evidence of card.evidence) {
      for (const key of ['id', 'title', 'description']) assert.equal(typeof evidence[key], 'string');
      assert.match(evidence.description, /synthetic|fictional|generated/i);
    }
    for (const policy of card.dataUse.statements) {
      assert.equal(typeof policy.id, 'string');
      assert.equal(typeof policy.text, 'string');
      assert.ok(['training', 'evaluation', 'retention'].includes(policy.scope));
      assert.equal(typeof policy.requiresConsent, 'boolean');
    }
    assert.ok(Number.isInteger(card.dataUse.retentionDays));
    for (const key of ['collection', 'consent', 'sensitiveAttributes']) assert.equal(typeof card.dataUse[key], 'string');
    for (const threat of card.threats) {
      assert.ok(['high', 'medium', 'low'].includes(threat.severity));
      assert.ok(['open', 'mitigated'].includes(threat.status));
      for (const key of ['id', 'name', 'mitigation']) assert.equal(typeof threat[key], 'string');
    }
    for (const check of card.accessibility) {
      assert.ok(['pass', 'fail', 'not-tested'].includes(check.status));
      for (const key of ['id', 'name', 'detail']) assert.equal(typeof check[key], 'string');
    }
    assert.ok(card.tradeoffs.length >= 2);
    assert.equal(card.tradeoffs.filter((strategy) => strategy.current).length, 1);
    for (const strategy of card.tradeoffs) {
      for (const key of ['id', 'name', 'description']) assert.equal(typeof strategy[key], 'string');
      assert.ok(strategy.privacyRisk >= 0 && strategy.privacyRisk <= 100);
      assert.ok(strategy.fairnessVisibility >= 0 && strategy.fairnessVisibility <= 100);
      assert.equal(typeof strategy.current, 'boolean');
    }
  }
});

test('Atlas has the required snapshot, subgroup gap, claim support, and bounded findings', () => {
  assert.equal(atlas.name, 'Atlas Assist');
  assert.equal(atlas.version, '2.1');
  assert.equal(atlas.type, 'Text classification');
  assert.deepEqual(atlas.expectedSubgroups, ['Age 18–34', 'Age 35–64', 'Age 65+', 'English', 'Spanish', 'Arabic']);
  assert.equal(atlas.metrics.length, 5);
  const audit = auditModelCard(atlas);
  assert.deepEqual(Object.keys(audit).sort(), ['coverage', 'dimensions', 'fairnessGap', 'findings', 'subgroups', 'supportedClaims', 'totalClaims']);
  assert.equal(audit.supportedClaims, 8);
  assert.equal(audit.totalClaims, 12);
  assert.equal(audit.fairnessGap, 8.4);
  assert.strictEqual(audit.subgroups, atlas.metrics);
  assert.ok(audit.findings.length >= 6 && audit.findings.length <= 9);
  assert.equal(audit.findings.filter((finding) => finding.id === 'claims-unsupported').length, 1);
  assert.equal(audit.findings.filter((finding) => finding.id === 'fairness-missing-data').length, 1);
  assert.match(audit.findings.find((finding) => finding.id === 'fairness-missing-data').evidence, /Age 65\+/);
  assert.ok(hasFinding(audit, 'privacy-consent-conflict'));
  assert.equal(new Set(audit.findings.map((finding) => finding.id)).size, audit.findings.length);
  for (const finding of audit.findings) {
    assert.ok(['high', 'medium', 'low'].includes(finding.severity));
    assert.ok(['fairness', 'privacy', 'claims', 'security', 'accessibility'].includes(finding.category));
    for (const key of ['id', 'title', 'description', 'recommendation', 'evidence']) assert.ok(typeof finding[key] === 'string' && finding[key].length > 0);
  }
});

test('coverage is deterministic, transparent, rounded, and does not mutate cards', () => {
  const card = structuredClone(atlas);
  const before = structuredClone(card);
  const freeze = (value) => {
    if (value && typeof value === 'object') {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  };
  freeze(card);
  const audit = auditModelCard(card);
  assert.deepEqual(auditModelCard(card), audit);
  assert.equal(audit.coverage, 70);
  assert.deepEqual(audit.dimensions, [
    { id: 'documentation', label: 'Documentation', score: 82, covered: 18, total: 22 },
    { id: 'fairness', label: 'Fairness', score: 83, covered: 5, total: 6 },
    { id: 'privacy', label: 'Privacy', score: 86, covered: 6, total: 7 },
    { id: 'security', label: 'Security', score: 67, covered: 2, total: 3 },
    { id: 'accessibility', label: 'Accessibility', score: 33, covered: 1, total: 3 },
  ]);
  assert.equal(exportReviewPacket(card, audit, 'Fictional review.'), exportReviewPacket(card, audit, 'Fictional review.'));
  assert.deepEqual(card, before);
});

test('Harbor exposes sparse data while stronger Lumen has recorded coverage, not certification', () => {
  const weaker = auditModelCard(harbor);
  const stronger = auditModelCard(lumen);
  assert.ok(weaker.coverage < auditModelCard(atlas).coverage);
  assert.ok(hasFinding(weaker, 'fairness-small-samples'));
  assert.ok(hasFinding(weaker, 'privacy-consent-conflict'));
  assert.equal(weaker.fairnessGap, 21);
  assert.equal(stronger.coverage, 100);
  assert.equal(stronger.fairnessGap, 2.7);
  assert.equal(stronger.findings.length, 0);
  const packet = exportReviewPacket(lumen, stronger);
  assertEvidenceOnlyPacket(packet);
  assert.match(packet, /Evidence coverage: \*\*100%\*\*/);
  assert.match(packet, /No findings generated\. This does not establish safety or completeness beyond the documented checks\./);
});

test('empty and non-card inputs return zero coverage without throwing', () => {
  for (const card of [undefined, null, {}, '', 42, false, []]) {
    const audit = auditModelCard(card);
    assert.equal(audit.coverage, 0);
    assert.equal(audit.supportedClaims, 0);
    assert.equal(audit.totalClaims, 0);
    assert.equal(audit.fairnessGap, 0);
    assert.deepEqual(audit.subgroups, []);
    assert.ok(audit.dimensions.every((item) => item.covered === 0 && item.total > 0 && item.score === 0));
    assert.ok(hasFinding(audit, 'fairness-missing-data'));
    assert.ok(hasFinding(audit, 'claims-unsupported'));
    assert.ok(hasFinding(audit, 'privacy-missing-data'));
    assert.ok(hasFinding(audit, 'security-unmitigated'));
    assert.ok(hasFinding(audit, 'accessibility-missing'));
    assert.doesNotThrow(() => exportReviewPacket(card, audit));
  }
});

test('malformed nested entries remain uncovered and partial cards remain usable', () => {
  const card = {
    name: 'Fictional partial card', expectedSubgroups: ['Group A', null, 'Group A'],
    claims: [null, {}, { evidenceIds: [null, 7] }], evidence: [null, {}],
    metrics: [null, {}, { group: 'Group A' }],
    dataUse: { statements: [null, { scope: 'unknown' }], retentionDays: '30' },
    threats: [null, { status: 'mitigated' }], accessibility: [null, { status: 'pass' }], tradeoffs: [null],
  };
  const audit = auditModelCard(card);
  assert.equal(audit.totalClaims, 3);
  assert.equal(audit.supportedClaims, 0);
  assert.equal(dimension(audit, 'fairness').score, 0);
  assert.equal(dimension(audit, 'security').score, 0);
  assert.equal(dimension(audit, 'accessibility').score, 0);
  assert.ok(Number.isInteger(audit.coverage));
  assert.doesNotThrow(() => exportReviewPacket(card, audit));
  assert.doesNotThrow(() => exportReviewPacket(card, {}));
  assert.doesNotThrow(() => auditModelCard({ metrics: {}, claims: 'invalid', dataUse: null }));
});

test('all missing expected groups are combined in one finding', () => {
  const audit = auditModelCard({ expectedSubgroups: ['Group A', 'Group B', 'Group C'], metrics: [metric()] });
  assert.deepEqual(dimension(audit, 'fairness'), { id: 'fairness', label: 'Fairness', score: 33, covered: 1, total: 3 });
  const findings = audit.findings.filter((finding) => finding.id === 'fairness-missing-data');
  assert.equal(findings.length, 1);
  assert.match(findings[0].evidence, /Group B, Group C/);
});

test('invalid metric fields never count as present or enter the accuracy gap', async (t) => {
  const invalid = [
    ['missing accuracy', { accuracy: undefined }], ['null accuracy', { accuracy: null }],
    ['string accuracy', { accuracy: '90' }], ['NaN accuracy', { accuracy: NaN }],
    ['infinite accuracy', { accuracy: Infinity }], ['negative accuracy', { accuracy: -1 }],
    ['accuracy above 100', { accuracy: 101 }], ['missing false-positive rate', { falsePositiveRate: undefined }],
    ['negative false-positive rate', { falsePositiveRate: -1 }], ['false-positive rate above 100', { falsePositiveRate: 101 }],
    ['string false-positive rate', { falsePositiveRate: '5' }], ['zero sample', { sampleSize: 0 }],
    ['negative sample', { sampleSize: -5 }], ['fractional sample', { sampleSize: 3.5 }],
    ['string sample', { sampleSize: '50' }], ['empty group', { group: '' }], ['missing group', { group: undefined }],
  ];
  for (const [name, overrides] of invalid) {
    await t.test(name, () => {
      const row = metric(overrides);
      const audit = auditModelCard({ expectedSubgroups: ['Group A'], metrics: [row] });
      assert.equal(dimension(audit, 'fairness').covered, 0);
      assert.equal(audit.fairnessGap, 0);
      assert.ok(hasFinding(audit, 'fairness-missing-data'));
      const packet = exportReviewPacket({ expectedSubgroups: ['Group A'], metrics: [row] }, audit);
      assert.match(packet, /Invalid metric/);
    });
  }
});

test('valid boundary values, small samples, and the strict 5pp threshold are respected', () => {
  const card = { expectedSubgroups: ['Group A', 'Group B'], metrics: [metric({ sampleSize: 29, accuracy: 100, falsePositiveRate: 0 }), metric({ group: 'Group B', sampleSize: 30, accuracy: 95, falsePositiveRate: 100 })] };
  const audit = auditModelCard(card);
  assert.equal(dimension(audit, 'fairness').score, 100);
  assert.equal(audit.fairnessGap, 5);
  assert.ok(hasFinding(audit, 'fairness-small-samples'));
  assert.match(audit.findings.find((finding) => finding.id === 'fairness-small-samples').evidence, /Group A: n=29/);
  assert.equal(hasFinding(audit, 'fairness-accuracy-gap'), false);
  card.metrics[1].accuracy = 94.99;
  assert.equal(auditModelCard(card).fairnessGap, 5.01);
  assert.ok(hasFinding(auditModelCard(card), 'fairness-accuracy-gap'));
});

test('invalid and duplicate rows cannot inflate subgroup coverage or the gap', () => {
  const card = {
    expectedSubgroups: ['Group A', 'Group A', 'Group B'],
    metrics: [metric({ accuracy: -10 }), metric(), metric({ accuracy: 10 }), metric({ group: 'Group B', accuracy: 88 })],
  };
  const audit = auditModelCard(card);
  assert.equal(dimension(audit, 'fairness').covered, 2);
  assert.equal(dimension(audit, 'fairness').total, 2);
  assert.equal(audit.fairnessGap, 2);
  assert.ok(hasFinding(audit, 'fairness-missing-data'));
});

test('claims require all references, not merely one reference or a nonempty ID list', () => {
  const card = {
    claims: [
      { id: 'complete', text: 'A fictional supported claim.', evidenceIds: ['e1', 'e2'] },
      { id: 'empty', text: 'No references.', evidenceIds: [] },
      { id: 'absent-list', text: 'No list.' },
      { id: 'nonexistent', text: 'Unknown reference.', evidenceIds: ['missing'] },
      { id: 'partly-valid', text: 'One existing reference is insufficient.', evidenceIds: ['e1', 'missing'] },
      { id: 'incomplete-evidence', text: 'Incomplete evidence does not count.', evidenceIds: ['e3'] },
      { id: 'invalid-id', text: 'Invalid reference.', evidenceIds: [null] },
      { id: 'no-text', evidenceIds: ['e1'] },
    ],
    evidence: [
      { id: 'e1', title: 'Synthetic source 1', description: 'Fictional record 1.' },
      { id: 'e2', title: 'Synthetic source 2', description: 'Fictional record 2.' },
      { id: 'e3', title: 'Incomplete source' },
    ],
  };
  const audit = auditModelCard(card);
  assert.equal(audit.totalClaims, 8);
  assert.equal(audit.supportedClaims, 1);
  const unsupported = audit.findings.filter((finding) => finding.category === 'claims');
  assert.equal(unsupported.length, 1);
  assert.match(unsupported[0].evidence, /partly-valid: missing or incomplete evidence: missing/);
  assert.match(unsupported[0].evidence, /incomplete-evidence/);
  const withoutEvidence = auditModelCard({ claims: card.claims });
  assert.equal(withoutEvidence.supportedClaims, 0);
});

test('conflicting structured consent flags are found even without consent keywords', () => {
  const card = withConsent([
    statement('one', 'First fictional training policy.', true),
    statement('two', 'Second fictional training policy.', false),
  ]);
  const audit = auditModelCard(card);
  assert.ok(hasFinding(audit, 'privacy-consent-conflict'));
  assert.equal(dimension(audit, 'privacy').covered, 6);
  const finding = audit.findings.find((item) => item.id === 'privacy-consent-conflict');
  assert.match(finding.evidence, /training:.*one:.*requiresConsent=true.*two:.*requiresConsent=false/);
});

test('unsafe affirmative/negative wording is caught even when all consent flags agree', async (t) => {
  const negativePolicies = [
    'Training may proceed without consent.',
    'Training may proceed without obtaining consent.',
    'Training may proceed without explicit consent.',
    'Training does not require consent.',
    "Training doesn't require consent.",
    'Consent is not required for training.',
    "Consent isn't required for training.",
    'No consent is needed for training.',
    'Consent is optional for training.',
    'Consent is not necessary for training.',
    'Training has no need to obtain consent.',
    'Training requires no consent.',
    'Consent is never required for training.',
    'Consent is not always required for training.',
    'Training proceeds without prior consent.',
    'Training proceeds with no consent.',
    'Training may proceed even if consent is not given.',
    'Training proceeds without user consent.',
  ];
  for (const text of negativePolicies) {
    await t.test(text, () => {
      const card = withConsent([statement('affirmative', 'Training requires consent.'), statement('negative', text)]);
      const audit = auditModelCard(card);
      assert.ok(hasFinding(audit, 'privacy-consent-conflict'), text);
      assert.equal(dimension(audit, 'privacy').covered, 6);
      assert.match(audit.findings.find((finding) => finding.id === 'privacy-consent-conflict').evidence, /negative:/);
    });
  }
});

test('contradictory consent text stays scoped and is exported when structured flags agree', async (t) => {
  for (const scope of ['training', 'evaluation', 'retention']) {
    for (const requiresConsent of [true, false]) {
      await t.test(`${scope}: both flags are ${requiresConsent}`, () => {
        const card = withConsent([statement('train', 'Training requires consent.')]);
        const label = scope[0].toUpperCase() + scope.slice(1);
        const conflicting = [
          statement('affirmative', `${label} requires explicit consent.`, requiresConsent, scope),
          statement('negative', `${label} does not require consent.`, requiresConsent, scope),
        ];
        card.dataUse.statements = card.dataUse.statements.flatMap((item) => (
          item.scope === scope ? conflicting : [item]
        ));
        const audit = auditModelCard(card);
        assert.deepEqual(audit.findings.map((finding) => finding.id), ['privacy-consent-conflict']);
        assert.deepEqual(dimension(audit, 'privacy'), { id: 'privacy', label: 'Privacy', score: 86, covered: 6, total: 7 });
        const [finding] = audit.findings;
        assert.equal(finding.severity, 'high');
        assert.equal(finding.category, 'privacy');
        assert.ok(finding.evidence.startsWith(`${scope}: `));
        assert.equal(finding.evidence.split('\n').length, 1);
        assert.deepEqual(finding.sources.map((entry) => entry.path), conflicting.map((item) => (
          `dataUse.statements[${card.dataUse.statements.indexOf(item)}]`
        )));

        const packet = exportReviewPacket(card, audit);
        assertEvidenceOnlyPacket(packet);
        assert.match(packet, /### privacy-consent-conflict: Consent contradiction: requirements are contradictory/);
        for (const [index, item] of conflicting.entries()) {
          assert.ok(finding.sources[index].detail.includes(item.text));
          assert.ok(finding.sources[index].detail.includes(`requiresConsent=${requiresConsent}`));
          assert.ok(packet.includes(`| ${item.id} | ${scope} | ${requiresConsent} | ${item.text} |`));
          assert.ok(packet.includes(finding.sources[index].path.replace(/([\[\]])/g, '\\$1')));
          assert.ok(packet.includes(finding.sources[index].detail));
        }
      });
    }
  }
});

test('a statement can contradict its own flag or its own text', () => {
  for (const text of ['Training proceeds without consent.', 'Training requires consent; training can also proceed without consent.']) {
    const audit = auditModelCard(withConsent([statement('conflicting', text)]));
    assert.ok(hasFinding(audit, 'privacy-consent-conflict'));
  }
});

test('negated permission and other affirmative consent wording do not create false conflicts', async (t) => {
  const affirmativePolicies = [
    'Training requires consent.',
    'Consent is required for training.',
    'Training is performed only with opt-in consent.',
    'Training cannot proceed without consent.',
    'Training does not proceed without consent.',
    'Training data is not collected without consent.',
    'Training is not allowed without consent.',
    'Training must not use records without consent.',
    'Training may not proceed without obtaining consent.',
    'Training never proceeds without consent.',
    'No training is performed without consent.',
    'Training is not performed without consent.',
    'Consent is not optional for training.',
    'Training does not waive consent.',
    "Training can't proceed without consent.",
    'Training is not permitted without prior consent.',
  ];
  for (const text of affirmativePolicies) {
    await t.test(text, () => {
      const audit = auditModelCard(withConsent([statement('affirmative', text)]));
      assert.equal(hasFinding(audit, 'privacy-consent-conflict'), false, text);
      assert.equal(dimension(audit, 'privacy').score, 100);
    });
  }
});

test('consent comparison respects scope and includes the general consent policy', () => {
  const scoped = withConsent([statement('train', 'Training proceeds without consent.', false)]);
  assert.equal(hasFinding(auditModelCard(scoped), 'privacy-consent-conflict'), false);
  assert.equal(dimension(auditModelCard(scoped), 'privacy').score, 100);
  const explicitPolicy = withConsent([statement('train', 'Training requires consent.')], 'Training proceeds without consent.');
  const explicitAudit = auditModelCard(explicitPolicy);
  assert.ok(hasFinding(explicitAudit, 'privacy-consent-conflict'));
  assert.match(explicitAudit.findings.find((finding) => finding.id === 'privacy-consent-conflict').evidence, /dataUse.consent/);
  const general = withConsent([statement('train', 'Training requires consent.')], 'Records may be used without consent.');
  const generalAudit = auditModelCard(general);
  assert.ok(hasFinding(generalAudit, 'privacy-consent-conflict'));
  assert.equal(dimension(generalAudit, 'privacy').covered, 4);
});

test('missing and invalid data-use fields do not earn privacy coverage', () => {
  const card = structuredClone(lumen);
  card.dataUse.statements = [statement('training', 'Training requires consent.'), { id: 'bad', text: 'Fictional unknown scope.', scope: 'unknown', requiresConsent: true }];
  card.dataUse.retentionDays = -1;
  card.dataUse.sensitiveAttributes = '';
  const audit = auditModelCard(card);
  assert.equal(dimension(audit, 'privacy').covered, 2);
  assert.ok(hasFinding(audit, 'privacy-missing-data'));
  const zeroRetention = structuredClone(lumen);
  zeroRetention.dataUse.retentionDays = 0;
  assert.equal(dimension(auditModelCard(zeroRetention), 'privacy').score, 100);
});

test('threat and accessibility statuses need complete records to earn coverage', () => {
  const card = structuredClone(lumen);
  card.threats[0].mitigation = '';
  card.threats[1].status = 'open';
  card.accessibility[0].detail = '';
  card.accessibility[1].status = 'fail';
  card.accessibility[2].status = 'not-tested';
  const audit = auditModelCard(card);
  assert.equal(dimension(audit, 'security').score, 0);
  assert.equal(dimension(audit, 'accessibility').score, 0);
  assert.ok(hasFinding(audit, 'security-unmitigated'));
  assert.ok(hasFinding(audit, 'accessibility-failed'));
  assert.ok(hasFinding(audit, 'accessibility-missing'));
});

test('Markdown packet includes the whole review flow and missing expected subgroup rows', () => {
  const audit = auditModelCard(atlas);
  const notes = 'Fictional reviewer: reconcile training consent and collect Age 65+ samples.';
  const packet = exportReviewPacket(atlas, audit, notes);
  for (const heading of [
    'Card snapshot', 'Scoring methodology and caveats', 'Coverage dimensions',
    'Claims and evidence references', 'Bundled evidence', 'Subgroup evaluation',
    'Data use and consent', 'Threat scenarios and mitigations', 'Accessibility checks',
    'Privacy / fairness strategy tradeoffs', 'Findings and suggested actions', 'Reviewer notes', 'Limitations',
  ]) assert.ok(packet.includes(heading), heading);
  for (const value of [atlas.name, atlas.id, atlas.version, atlas.type, atlas.owner, atlas.lastReviewed, atlas.intendedUse, notes]) assert.ok(packet.includes(value), value);
  assertEvidenceOnlyPacket(packet);
  assert.match(packet, /equal-weight mean/);
  assert.match(packet, /Evidence coverage: \*\*70%\*\*/);
  assert.match(packet, /8 \/ 12/);
  assert.match(packet, /8\.4 percentage points/);
  assert.match(packet, /\| Age 65\+ \| — \| — \| — \| Missing expected group \|/);
  for (const claim of atlas.claims) {
    assert.ok(packet.includes(claim.id));
    assert.ok(packet.includes(claim.text));
    for (const id of claim.evidenceIds) assert.ok(packet.includes(id));
  }
  for (const item of atlas.evidence) for (const value of Object.values(item)) assert.ok(packet.includes(value));
  for (const item of atlas.dataUse.statements) assert.ok(packet.includes(item.text));
  for (const item of atlas.threats) assert.ok(packet.includes(item.mitigation));
  for (const item of atlas.accessibility) assert.ok(packet.includes(item.detail));
  for (const item of atlas.tradeoffs) assert.ok(packet.includes(item.description));
  for (const finding of audit.findings) {
    assert.ok(packet.includes(finding.title));
    assert.ok(packet.includes(finding.recommendation));
  }
  for (const limitation of atlas.limitations) assert.ok(packet.includes(limitation));
});

test('export works with no audit, default notes, partial data, and Markdown-sensitive text', () => {
  const packet = exportReviewPacket(atlas);
  assert.match(packet, /No reviewer notes provided/);
  assert.equal(packet, exportReviewPacket(atlas, auditModelCard(atlas)));
  assert.match(exportReviewPacket(), /No expected subgroups or metrics documented/);
  assert.match(exportReviewPacket(), /No evidence documented/);
  const card = { name: 'Fictional <script>alert(1)</script> | demo', description: 'line one\nline two', expectedSubgroups: ['A | B'], metrics: [] };
  const escaped = exportReviewPacket(card, undefined, 'Review <b>fictional</b> *notes*.');
  assert.equal(escaped.includes('<script>'), false);
  assert.ok(escaped.includes('&lt;script&gt;'));
  assert.ok(escaped.includes('A \\| B'));
  assert.ok(escaped.includes('line one<br>line two'));
  assert.ok(escaped.includes('Review &lt;b&gt;fictional&lt;/b&gt; \\*notes\\*.'));
});

test('every flag includes explicit source paths and record content, including absent data', () => {
  for (const card of [atlas, harbor, {}]) {
    for (const finding of auditModelCard(card).findings) {
      assert.ok(finding.sources.length > 0, finding.id);
      for (const entry of finding.sources) {
        assert.ok(typeof entry.path === 'string' && entry.path.length > 0);
        assert.ok(typeof entry.label === 'string' && entry.label.length > 0);
        assert.ok(typeof entry.detail === 'string' && entry.detail.length > 0);
        assert.equal(entry.path.includes('[-1]'), false);
      }
    }
  }
  const audit = auditModelCard(atlas);
  const flag = (id) => audit.findings.find((finding) => finding.id === id);
  assert.ok(flag('fairness-missing-data').sources.some((entry) => entry.path === 'expectedSubgroups[2]' && entry.label === 'Age 65+'));
  assert.ok(flag('fairness-accuracy-gap').sources.some((entry) => entry.path === 'metrics[2]' && entry.detail.includes('accuracy: 94.2%')));
  assert.deepEqual(flag('privacy-consent-conflict').sources.map((entry) => entry.path), ['dataUse.statements[0]', 'dataUse.statements[1]']);
  for (const entry of flag('privacy-consent-conflict').sources) {
    const row = atlas.dataUse.statements[Number(entry.path.match(/\[(\d+)\]/)[1])];
    assert.ok(entry.detail.includes(row.text));
    assert.ok(entry.detail.includes(`requiresConsent=${row.requiresConsent}`));
  }
  const threat = flag('security-unmitigated').sources[0];
  assert.equal(threat.path, 'threats[1]');
  assert.ok(threat.label.includes('atlas-t2'));
  assert.ok(threat.detail.includes(atlas.threats[1].mitigation));
  const access = flag('accessibility-missing').sources[0];
  assert.equal(access.path, 'accessibility[2]');
  assert.ok(access.detail.includes(atlas.accessibility[2].detail));
  assert.ok(flag('claims-unsupported').sources.some((entry) => entry.path === 'claims[10]' && entry.detail.includes('atlas-missing-evidence')));
});

test('sources remain scoped, include general policy wording, and identify sparse samples', () => {
  const audit = auditModelCard(harbor);
  const consent = audit.findings.find((finding) => finding.id === 'privacy-consent-conflict');
  assert.ok(consent.sources.some((entry) => entry.path === 'dataUse.consent' && entry.detail === harbor.dataUse.consent));
  assert.equal(consent.sources.some((entry) => entry.path === 'dataUse.statements[2]'), false);
  const small = audit.findings.find((finding) => finding.id === 'fairness-small-samples');
  assert.equal(small.sources[0].path, 'metrics[1]');
  assert.match(small.sources[0].detail, /Sample size: 18/);
  const spaced = auditModelCard({ expectedSubgroups: ['  Group A  '], metrics: [] });
  assert.ok(spaced.findings[0].sources.some((entry) => entry.path === 'expectedSubgroups[0]'));
});

test('comparison estimates cannot change findings or coverage', () => {
  const before = auditModelCard(atlas);
  const comparison = structuredClone(atlas);
  comparison.tradeoffs = comparison.tradeoffs.map((strategy) => ({ ...strategy, current: !strategy.current, privacyRisk: 0, fairnessVisibility: 100 }));
  assert.deepEqual(auditModelCard(comparison), before);
});

test('exports attach each flag’s same source evidence and keep input notes inert', () => {
  const audit = auditModelCard(atlas);
  const packet = exportReviewPacket(atlas, audit);
  for (const finding of audit.findings) {
    for (const entry of finding.sources) {
      assert.ok(packet.includes(entry.path.replace(/\[/g, '\\[').replace(/\]/g, '\\]')));
      assert.ok(packet.includes(entry.detail));
    }
  }
  assert.match(packet, /Source records \(bundled card paths; content not independently verified\)/);
  const notes = '<iframe src="https://synthetic.invalid/frame"></iframe>\n\nhttps://synthetic.invalid/literal';
  const safe = exportReviewPacket(atlas, audit, notes);
  assert.equal(safe.includes('<iframe'), false);
  assert.ok(safe.includes('https\\://synthetic.invalid/frame'));
  assert.ok(safe.includes('&lt;/iframe&gt;'));
  assert.ok(safe.includes('https\\://synthetic.invalid/literal'));
});

test('claim inspection exposes unsupported references without making a truth judgment', () => {
  const inspected = inspectClaimEvidence(atlas);
  const claim = inspected.find((item) => item.id === 'atlas-c11');
  assert.equal(claim.referenceComplete, false);
  assert.equal(claim.path, 'claims[10]');
  assert.match(claim.text, /Arabic-language/);
  assert.deepEqual(claim.references.map((item) => [item.id, item.status, item.path]), [
    ['atlas-e3', 'resolved', 'evidence[2]'],
    ['atlas-missing-evidence', 'missing', null],
  ]);
  assert.ok(claim.references[0].title.includes('Spanish'));
  assert.match(claim.reasons.join(' '), /atlas-missing-evidence/);
  const empty = inspected.find((item) => item.id === 'atlas-c10');
  assert.deepEqual(empty.references, []);
  assert.deepEqual(empty.reasons, ['no evidence references']);
  assert.equal(inspectClaimEvidence(lumen).every((item) => item.referenceComplete), true);
});

test('synthetic threat fixtures are inert, scoped, complete, and never alter audit scoring', () => {
  assert.equal(threatFixtures.length, 8);
  for (const card of modelCards) {
    const fixtures = getThreatFixtures(card);
    assert.equal(fixtures.every((fixture) => fixture.synthetic && fixture.kind === 'narrative-only'), true);
    assert.equal(fixtures.every((fixture) => fixture.modelId === card.id && card.threats.some((threat) => threat.id === fixture.threatId)), true);
    for (const fixture of fixtures) {
      for (const key of ['id', 'modelId', 'threatId', 'title', 'setup', 'input', 'expectedBehavior', 'explanation', 'reviewCheck']) {
        assert.equal(typeof fixture[key], 'string', `${fixture.id}.${key}`);
      }
      assert.match(fixture.input, /fictional|invented|generated|pretend|paper|imaginary/i);
      assert.match(fixture.explanation, /not|does not|without/i);
    }
    assert.deepEqual(auditModelCard(card), auditModelCard({ ...card, threats: card.threats.map((threat) => ({ ...threat })) }));
  }
  assert.deepEqual(getThreatFixtures({ ...atlas, synthetic: false }), []);
  assert.deepEqual(getThreatFixtures({ ...atlas, id: 'other-card' }), []);
});

test('scoring rule explanations cover every finding, thresholds, units, and uncertainty caveats', () => {
  assert.equal(scoringPolicy.accuracyGapThreshold, 5);
  assert.equal(scoringPolicy.minimumSubgroupSample, 30);
  assert.equal(scoringRules.length, 11);
  for (const id of ['fairness-missing-data', 'fairness-small-samples', 'fairness-accuracy-gap', 'claims-unsupported', 'privacy-consent-conflict', 'privacy-missing-data', 'security-unmitigated', 'accessibility-failed', 'accessibility-missing', 'documentation-coverage', 'overall-coverage']) {
    const rule = getScoringRule(id);
    assert.ok(rule, id);
    for (const key of ['id', 'title', 'category', 'trigger', 'effect', 'limit']) assert.ok(rule[key].length > 0, `${id}.${key}`);
  }
  assert.match(getScoringRule('fairness-accuracy-gap').trigger, /strictly > 5/);
  assert.match(getScoringRule('fairness-small-samples').trigger, /n < 30/);
  assert.match(getScoringRule('claims-unsupported').limit, /truth/i);
  assert.match(getScoringRule('security-unmitigated').limit, /fixture/i);
  assert.equal(getScoringRule('unknown-rule'), undefined);
});

test('packet includes claim inspection, all fixture fields, linked threats, and every scoring explanation', () => {
  const audit = auditModelCard(atlas);
  const packet = exportReviewPacket(atlas, audit);
  for (const heading of ['Claim evidence inspection', 'Synthetic threat fixtures', 'Scoring-rule explanations']) assert.match(packet, new RegExp(heading));
  for (const claim of inspectClaimEvidence(atlas)) {
    assert.ok(packet.includes(claim.path.replace(/\[/g, '\\[').replace(/\]/g, '\\]')));
    assert.ok(packet.includes(claim.id));
    for (const reference of claim.references) assert.ok(packet.includes(`Claim reference: ${reference.id}`));
  }
  for (const fixture of getThreatFixtures(atlas)) {
    for (const field of ['id', 'modelId', 'threatId', 'title', 'kind', 'setup', 'input', 'expectedBehavior', 'explanation', 'reviewCheck']) assert.ok(packet.includes(String(fixture[field])), `${fixture.id}.${field}`);
  }
  for (const rule of scoringRules) for (const field of ['id', 'title', 'category', 'trigger', 'effect', 'limit']) {
    const escaped = rule[field].replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    assert.ok(packet.includes(escaped), `${rule.id}.${field}`);
  }
});
