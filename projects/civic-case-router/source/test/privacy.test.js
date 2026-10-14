import test from 'node:test';
import assert from 'node:assert/strict';

import { DEMO_NOW, policies, teams } from '../src/data.js';
import { evaluateCase, redactCase } from '../src/engine.js';

const MASK = 'xxxxxxxx';

test('fixture names are masked as literals without corrupting routing metadata or other words', () => {
  const input = {
    person: { name: 'Ada Brookfield', email: 'ada.brookfield@example.test' },
    summary: 'Ada Brookfield needs an adapted format. Preserve routing metadata in Canada. Contact ADA.BROOKFIELD@example.test.',
    fields: [{ label: 'Task', value: 'Ada requests large print.', sensitive: false }],
    documents: [],
  };
  const result = redactCase(input);
  assert.equal(result.summary, 'xxxxxxxx needs an adapted format. Preserve routing metadata in Canada. Contact ubuntu.');
  assert.equal(result.fields[0].value, 'xxxxxxxx requests large print.');
});

function privacyInput() {
  return {
    id: 'PRIVACY-1',
    receivedAt: DEMO_NOW,
    subject: 'A.*B requested health support; ALICE+ROUTER@example.test should not appear.',
    summary: 'The caller is A.*B at 17 Birch Road. Phone +1 (202) 555-0199.',
    categoryHint: 'health',
    language: 'ar',
    languageLabel: 'العربية',
    person: {
      name: 'A.*B',
      email: 'alice+router@example.test',
      phone: '+1 (202) 555-0199',
      address: '17 Birch Road, Demo Borough',
      metadata: { preferredContact: 'alice+router@example.test' },
    },
    fields: [
      { label: 'Requested service', value: 'Community health appointment', sensitive: false },
      { label: 'Identity reference', value: 'A.*B / ALICE+ROUTER@example.test', sensitive: false },
      { label: 'Private account details', value: 'Account [123]. Diagnosis: never infer.', sensitive: true },
      { label: 'Nested private details', value: { account: 'private value' }, sensitive: true },
    ],
    documents: [
      { id: 'DOC-ONE', type: 'service-referral', status: 'received', content: 'A.*B referral body with +1 (202) 555-0199.' },
      { id: 'DOC-TWO', type: 'contact-consent', status: 'received', content: 'ALICE+ROUTER@example.test consent body.' },
      { id: 'DOC-THREE', type: 'extra', status: 'missing', content: '' },
    ],
    deadline: 'not a date',
    safetyRisk: false,
    accommodations: ['interpreter'],
  };
}

function assertDoesNotContain(value, secrets) {
  const text = JSON.stringify(value);
  for (const secret of secrets) assert.equal(text.includes(secret), false, `privacy leak: ${secret}`);
}

test('redactCase returns an independent share-safe copy with complete identity and document-body redaction', () => {
  const input = privacyInput();
  const original = structuredClone(input);
  const redacted = redactCase(input);
  const secrets = [
    'A.*B',
    'a.*b',
    'alice+router@example.test',
    'ALICE+ROUTER@example.test',
    '+1 (202) 555-0199',
    '17 Birch Road, Demo Borough',
    'Account [123]. Diagnosis: never infer.',
    'private value',
    'A.*B referral body with +1 (202) 555-0199.',
    'ALICE+ROUTER@example.test consent body.',
  ];

  assert.deepEqual(input, original);
  assert.notStrictEqual(redacted, input);
  assert.notStrictEqual(redacted.person, input.person);
  assert.notStrictEqual(redacted.fields, input.fields);
  assert.notStrictEqual(redacted.documents, input.documents);
  assert.deepEqual(redacted.person, {
    name: MASK,
    email: MASK,
    phone: MASK,
    address: MASK,
    metadata: { preferredContact: MASK },
  });
  assert.equal(redacted.fields[0].value, 'Community health appointment');
  assert.equal(redacted.fields[1].value, `${MASK} / ${MASK}`);
  assert.equal(redacted.fields[2].value, MASK);
  assert.equal(redacted.fields[3].value, MASK);
  assert.deepEqual(redacted.documents.map((document) => document.content), [MASK, MASK, MASK]);
  assert.equal(redacted.documents[0].type, 'service-referral');
  assert.equal(redacted.documents[1].status, 'received');
  assert.equal(redacted.documents[2].status, 'missing');
  assertDoesNotContain(redacted, secrets);

  redacted.person.name = 'changed';
  redacted.fields[1].value = 'changed';
  redacted.documents[0].content = 'changed';
  assert.deepEqual(input, original);
});

test('evaluation preserves routing metadata while making raw and share-safe audits privacy-safe', () => {
  const input = privacyInput();
  const healthPolicy = policies.find((policy) => policy.category === 'health');
  const privatePolicy = {
    ...healthPolicy,
    escalationRule: 'Review A.*B and alice+router@example.test before the appointment.',
  };
  const result = evaluateCase(input, {
    now: DEMO_NOW,
    policies: [privatePolicy],
    teams,
  });
  const secrets = [
    'A.*B',
    'a.*b',
    'alice+router@example.test',
    'ALICE+ROUTER@example.test',
    '+1 (202) 555-0199',
    '17 Birch Road, Demo Borough',
    'Account [123]. Diagnosis: never infer.',
    'A.*B referral body with +1 (202) 555-0199.',
    'ALICE+ROUTER@example.test consent body.',
  ];

  assert.equal(result.route.teamId, 'team-health');
  assert.equal(result.classification.category, 'health');
  assert.equal(result.language, 'ar');
  assert.equal(result.languageLabel, 'العربية');
  assert.deepEqual(result.accommodations, ['interpreter']);
  assert.deepEqual(result.redacted.accommodations, ['interpreter']);
  assert.deepEqual(result.documents.map((document) => document.content), [
    'A.*B referral body with +1 (202) 555-0199.',
    'ALICE+ROUTER@example.test consent body.',
    '',
  ]);
  assert.deepEqual(result.redacted.documents.map((document) => document.content), [MASK, MASK, MASK]);
  assert.equal(result.redacted.route.teamId, 'team-health');
  assert.equal(result.redacted.classification.category, 'health');
  assert.equal(result.redacted.languageLabel, 'العربية');
  assert.equal(result.redacted.flags.some((flag) => flag.type === 'language'), true);
  assert.equal(result.redacted.flags.some((flag) => flag.label === 'Interpreter'), true);

  assert.ok(result.audit.length >= 5);
  assert.ok(result.audit.some((entry) => entry.action === 'Escalate / review'));
  for (const audit of result.audit) {
    assert.equal(audit.actor, 'Local policy engine');
    assert.equal(audit.at, DEMO_NOW);
    assertDoesNotContain(audit, secrets);
  }
  assert.ok(result.audit.some((entry) => entry.reason.includes(MASK)), 'identity-bearing audit text must be masked');
  for (const audit of result.redacted.audit) {
    assertDoesNotContain(audit, secrets);
  }
  assertDoesNotContain(result.audit, secrets);
  assertDoesNotContain(result.redacted, secrets);
});

test('literal redaction does not reinterpret identity punctuation as a pattern', () => {
  const input = {
    ...privacyInput(),
    person: { name: 'A.*B', email: 'x+y@example.test' },
    subject: 'A.*B and x+y@example.test are literal identities; AxB must remain visible.',
    summary: 'A.*B is the submitted name.',
    fields: [{ label: 'Note', value: 'x+y@example.test; AxB', sensitive: false }],
    documents: [{ type: 'service-referral', status: 'received', content: 'A.*B x+y@example.test AxB' }],
  };
  const redacted = redactCase(input);

  assert.equal(redacted.subject, `${MASK} and ${MASK} are literal identities; AxB must remain visible.`);
  assert.equal(redacted.summary, `${MASK} is the submitted name.`);
  assert.equal(redacted.fields[0].value, `${MASK}; AxB`);
  assert.equal(redacted.documents[0].content, MASK);
  assert.equal(redacted.person.name, MASK);
  assert.equal(redacted.person.email, MASK);
});
