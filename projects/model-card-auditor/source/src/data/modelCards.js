// Every scenario in this file is deliberately synthetic and fictional.

const atlasAssist = {
  id: 'atlas-assist',
  name: 'Atlas Assist',
  version: '2.1',
  type: 'Text classification',
  description:
    'A fictional text classifier that routes synthetic customer-support tickets to queues for a fictional service desk.',
  owner: 'Fictional Northstar Support Lab',
  lastReviewed: '2026-09-15',
  intendedUse:
    'Prioritize and route fictional customer-support requests for a trained service team; it does not make eligibility, employment, medical, or financial decisions.',
  limitations: [
    'It may miss context in short, multilingual, or code-switched tickets.',
    'It is not validated for autonomous customer decisions or for use outside the fictional service desk.',
    'The Arabic subgroup has a smaller evaluation sample and the Age 65+ subgroup is not reported.',
  ],
  expectedSubgroups: [
    'Age 18–34',
    'Age 35–64',
    'Age 65+',
    'English',
    'Spanish',
    'Arabic',
  ],
  metrics: [
    { group: 'Age 18–34', sampleSize: 120, accuracy: 91.6, falsePositiveRate: 4.1 },
    { group: 'Age 35–64', sampleSize: 140, accuracy: 87.4, falsePositiveRate: 5.0 },
    { group: 'English', sampleSize: 220, accuracy: 94.2, falsePositiveRate: 3.2 },
    { group: 'Spanish', sampleSize: 100, accuracy: 90.5, falsePositiveRate: 5.7 },
    { group: 'Arabic', sampleSize: 46, accuracy: 85.8, falsePositiveRate: 7.4 },
  ],
  claims: [
    {
      id: 'atlas-c1',
      text: 'The fictional model routes routine support tickets to the correct queue in most tested cases.',
      evidenceIds: ['atlas-e1', 'atlas-e2'],
    },
    {
      id: 'atlas-c2',
      text: 'The model has been evaluated on synthetic English-language support tickets.',
      evidenceIds: ['atlas-e2'],
    },
    {
      id: 'atlas-c3',
      text: 'The evaluation includes a synthetic Spanish-language subgroup.',
      evidenceIds: ['atlas-e3'],
    },
    {
      id: 'atlas-c4',
      text: 'The evaluation reports false-positive rates for the listed subgroups.',
      evidenceIds: ['atlas-e4'],
    },
    {
      id: 'atlas-c5',
      text: 'Synthetic annotators reviewed a sample of routing errors.',
      evidenceIds: ['atlas-e5'],
    },
    {
      id: 'atlas-c6',
      text: 'The model is intended to assist a human service-desk team rather than replace it.',
      evidenceIds: ['atlas-e6'],
    },
    {
      id: 'atlas-c7',
      text: 'The fictional training set contains examples of common billing and access requests.',
      evidenceIds: ['atlas-e7'],
    },
    {
      id: 'atlas-c8',
      text: 'A synthetic red-team exercise tested prompt-like ticket content.',
      evidenceIds: ['atlas-e8'],
    },
    {
      id: 'atlas-c9',
      text: 'The model is equally accurate for every expected subgroup.',
      evidenceIds: ['atlas-e9'],
    },
    {
      id: 'atlas-c10',
      text: 'The model never exposes sensitive attributes in its routing output.',
      evidenceIds: [],
    },
    {
      id: 'atlas-c11',
      text: 'The model can safely route all Arabic-language tickets without additional review.',
      evidenceIds: ['atlas-e3', 'atlas-missing-evidence'],
    },
    {
      id: 'atlas-c12',
      text: 'The fictional service desk may retain every source ticket indefinitely.',
      evidenceIds: [],
    },
  ],
  evidence: [
    {
      id: 'atlas-e1',
      title: 'Synthetic routing benchmark',
      description: 'A fictional benchmark of generated support tickets and queue labels.',
    },
    {
      id: 'atlas-e2',
      title: 'English evaluation slice',
      description: 'A held-out synthetic evaluation slice for English tickets.',
    },
    {
      id: 'atlas-e3',
      title: 'Spanish evaluation slice',
      description: 'A held-out synthetic evaluation slice for Spanish tickets.',
    },
    {
      id: 'atlas-e4',
      title: 'Subgroup error table',
      description: 'Synthetic subgroup accuracy and false-positive calculations.',
    },
    {
      id: 'atlas-e5',
      title: 'Annotation review notes',
      description: 'Fictional review notes from synthetic annotators examining routing errors.',
    },
    {
      id: 'atlas-e6',
      title: 'Human-review workflow',
      description: 'A fictional operating procedure requiring a service-desk reviewer.',
    },
    {
      id: 'atlas-e7',
      title: 'Synthetic training inventory',
      description: 'An inventory of fictional billing and account-access examples.',
    },
    {
      id: 'atlas-e8',
      title: 'Prompt robustness exercise',
      description: 'A fictional red-team exercise using adversarial ticket-like text.',
    },
  ],
  dataUse: {
    statements: [
      {
        id: 'atlas-du1',
        text: 'Synthetic training examples may be collected and used only with opt-in consent from fictional contributors.',
        scope: 'training',
        requiresConsent: true,
      },
      {
        id: 'atlas-du2',
        text: 'Synthetic training examples may be collected and used without obtaining consent from fictional contributors.',
        scope: 'training',
        requiresConsent: false,
      },
      {
        id: 'atlas-du3',
        text: 'Evaluation tickets are reviewed with consent from fictional evaluators.',
        scope: 'evaluation',
        requiresConsent: true,
      },
      {
        id: 'atlas-du4',
        text: 'Retention records are kept only for the documented retention period and do not require new collection.',
        scope: 'retention',
        requiresConsent: false,
      },
    ],
    retentionDays: 180,
    collection: 'Synthetic ticket text and labels are generated for this fictional audit exercise.',
    consent: 'The training statements conflict; evaluation consent is described separately.',
    sensitiveAttributes: 'Synthetic age bands and language labels are used for subgroup analysis only.',
  },
  threats: [
    {
      id: 'atlas-t1',
      name: 'Instruction-like ticket injection',
      severity: 'high',
      mitigation: 'Human review and a synthetic adversarial test set are required before routing.',
      status: 'mitigated',
    },
    {
      id: 'atlas-t2',
      name: 'Label leakage from copied ticket metadata',
      severity: 'medium',
      mitigation: 'A mitigation owner and completion date have not yet been assigned.',
      status: 'open',
    },
    {
      id: 'atlas-t3',
      name: 'Over-routing urgent fictional requests',
      severity: 'low',
      mitigation: 'The fictional workflow sends high-risk queues to a human reviewer.',
      status: 'mitigated',
    },
  ],
  accessibility: [
    {
      id: 'atlas-a1',
      name: 'Keyboard navigation',
      status: 'pass',
      detail: 'Synthetic workflow checks cover keyboard-only queue review.',
    },
    {
      id: 'atlas-a2',
      name: 'Screen-reader status announcements',
      status: 'fail',
      detail: 'Queue confidence changes are not announced in the fictional review panel.',
    },
    {
      id: 'atlas-a3',
      name: 'Translated reviewer guidance',
      status: 'not-tested',
      detail: 'No synthetic check has been recorded for translated guidance.',
    },
  ],
  tradeoffs: [
    {
      id: 'atlas-tradeoff-baseline',
      name: 'Minimal retention baseline',
      privacyRisk: 25,
      fairnessVisibility: 35,
      description: 'Short retention reduces privacy exposure but leaves less subgroup error history.',
      current: false,
    },
    {
      id: 'atlas-tradeoff-expanded',
      name: 'Expanded subgroup evaluation',
      privacyRisk: 55,
      fairnessVisibility: 85,
      description: 'More subgroup slices improve fairness visibility while increasing synthetic record handling.',
      current: true,
    },
  ],
  synthetic: true,
};

const harborScreen = {
  id: 'harbor-screen',
  name: 'Harbor Screen',
  version: '0.8',
  type: 'Eligibility screening',
  description: 'A problematic fictional system ranking synthetic applications for a fictional community program.',
  owner: 'Fictional Harbor Decision Studio',
  lastReviewed: '2026-08-20',
  intendedUse: 'Explore eligibility-screening failure modes with generated applications in a local simulation.',
  limitations: [
    'The synthetic labels reproduce a fictional historical selection bias.',
    'This scenario has no basis for real eligibility decisions or deployment.',
    'Several expected subgroups have no evaluation records.',
  ],
  expectedSubgroups: ['Urban applicants', 'Rural applicants', 'Applicants with disabilities', 'Multilingual applicants'],
  metrics: [
    { group: 'Urban applicants', sampleSize: 180, accuracy: 92.0, falsePositiveRate: 4.0 },
    { group: 'Rural applicants', sampleSize: 18, accuracy: 71.0, falsePositiveRate: 19.0 },
  ],
  claims: [
    { id: 'harbor-c1', text: 'Generated applications have been tested in a local simulation.', evidenceIds: ['harbor-e1'] },
    { id: 'harbor-c2', text: 'Eligibility decisions are equally accurate for every subgroup.', evidenceIds: [] },
    { id: 'harbor-c3', text: 'Every fictional applicant can appeal a screening result.', evidenceIds: ['harbor-missing-appeals'] },
    { id: 'harbor-c4', text: 'Sensitive features cannot influence the screening score.', evidenceIds: ['harbor-e1', 'harbor-missing-features'] },
  ],
  evidence: [
    { id: 'harbor-e1', title: 'Synthetic application simulation', description: 'Fictional urban and rural application outcomes, with sparse rural coverage.' },
  ],
  dataUse: {
    statements: [
      { id: 'harbor-du1', text: 'Training requires affirmative consent from fictional applicants.', scope: 'training', requiresConsent: true },
      { id: 'harbor-du2', text: 'Consent is not required for training on generated application records.', scope: 'training', requiresConsent: true },
      { id: 'harbor-du3', text: 'Evaluation is performed without consent from fictional applicants.', scope: 'evaluation', requiresConsent: false },
      { id: 'harbor-du4', text: 'Retention requires consent for each fictional application record.', scope: 'retention', requiresConsent: true },
    ],
    retentionDays: 730,
    collection: 'Generated applications include synthetic location, income bands, and disability indicators.',
    consent: 'The structured training flags agree, but one statement explicitly permits training without consent.',
    sensitiveAttributes: 'Fictional disability indicators and location proxies are retained in raw simulation records.',
  },
  threats: [
    { id: 'harbor-t1', name: 'Proxy discrimination through location', severity: 'high', mitigation: 'No proxy-feature review has been completed.', status: 'open' },
    { id: 'harbor-t2', name: 'Synthetic record re-identification', severity: 'high', mitigation: 'Aggregation and access controls are still proposed.', status: 'open' },
    { id: 'harbor-t3', name: 'Bulk submission abuse', severity: 'medium', mitigation: 'The simulation has a local rate limit.', status: 'mitigated' },
  ],
  accessibility: [
    { id: 'harbor-a1', name: 'Keyboard-only application review', status: 'fail', detail: 'A fictional review action is only available by pointer.' },
    { id: 'harbor-a2', name: 'Accessible appeal explanation', status: 'not-tested', detail: 'No synthetic accessible appeal workflow has been evaluated.' },
  ],
  tradeoffs: [
    { id: 'harbor-tr1', name: 'Raw feature retention', privacyRisk: 90, fairnessVisibility: 65, description: 'Raw synthetic features allow some subgroup analysis but create broad privacy exposure.', current: true },
    { id: 'harbor-tr2', name: 'Aggregated review with minimum samples', privacyRisk: 30, fairnessVisibility: 75, description: 'Aggregate synthetic records and require additional samples before comparing groups.', current: false },
  ],
  synthetic: true,
};

const lumenCaption = {
  id: 'lumen-caption',
  name: 'Lumen Caption',
  version: '1.4',
  type: 'Caption generation',
  description: 'A stronger fictional captioning model evaluated on generated audio clips and transcripts.',
  owner: 'Fictional Lumen Accessibility Lab',
  lastReviewed: '2026-09-25',
  intendedUse: 'Assist a human caption editor in a synthetic media-accessibility demonstration.',
  limitations: [
    'Only generated audio is evaluated; real-world caption quality has not been established.',
    'Noise, overlapping speakers, and unseen dialects can still produce errors.',
    'Human review is required for names, timing, and meaningful non-speech sounds.',
  ],
  expectedSubgroups: ['English', 'Spanish', 'Arabic', 'Quiet audio', 'Noisy audio'],
  metrics: [
    { group: 'English', sampleSize: 300, accuracy: 96.0, falsePositiveRate: 1.8 },
    { group: 'Spanish', sampleSize: 280, accuracy: 95.0, falsePositiveRate: 2.1 },
    { group: 'Arabic', sampleSize: 260, accuracy: 94.2, falsePositiveRate: 2.4 },
    { group: 'Quiet audio', sampleSize: 350, accuracy: 96.5, falsePositiveRate: 1.4 },
    { group: 'Noisy audio', sampleSize: 250, accuracy: 93.8, falsePositiveRate: 2.8 },
  ],
  claims: [
    { id: 'lumen-c1', text: 'All listed synthetic language groups have caption accuracy measurements.', evidenceIds: ['lumen-e1'] },
    { id: 'lumen-c2', text: 'Synthetic noisy audio is included in evaluation.', evidenceIds: ['lumen-e1', 'lumen-e2'] },
    { id: 'lumen-c3', text: 'Human caption review is part of the fictional workflow.', evidenceIds: ['lumen-e3'] },
    { id: 'lumen-c4', text: 'Keyboard and screen-reader editing checks have been recorded.', evidenceIds: ['lumen-e4'] },
  ],
  evidence: [
    { id: 'lumen-e1', title: 'Synthetic caption benchmark', description: 'Generated audio and transcripts for every expected language and audio condition.' },
    { id: 'lumen-e2', title: 'Synthetic noise evaluation', description: 'A fictional noise-injection exercise with subgroup error analysis.' },
    { id: 'lumen-e3', title: 'Caption review procedure', description: 'A fictional human-editing procedure for timing, speaker changes, and non-speech events.' },
    { id: 'lumen-e4', title: 'Accessibility check record', description: 'Synthetic keyboard, screen-reader, and caption-timing checks.' },
  ],
  dataUse: {
    statements: [
      { id: 'lumen-du1', text: 'Training uses generated clips only after obtaining consent from fictional contributors.', scope: 'training', requiresConsent: true },
      { id: 'lumen-du2', text: 'Evaluation does not proceed without consent from fictional evaluators.', scope: 'evaluation', requiresConsent: true },
      { id: 'lumen-du3', text: 'Retention requires consent for the stated thirty-day period.', scope: 'retention', requiresConsent: true },
    ],
    retentionDays: 30,
    collection: 'Audio, transcripts, and labels are generated locally for this fictional scenario.',
    consent: 'Fictional contributors opt in for training, evaluation, and thirty-day retention.',
    sensitiveAttributes: 'Synthetic language labels are aggregated; no real voice or identity data is collected.',
  },
  threats: [
    { id: 'lumen-t1', name: 'Injected transcript instructions', severity: 'high', mitigation: 'Treat transcripts as data and verify outputs in a synthetic adversarial suite.', status: 'mitigated' },
    { id: 'lumen-t2', name: 'Unintended identity labels', severity: 'medium', mitigation: 'Remove identity guesses and require human review of speaker labels.', status: 'mitigated' },
  ],
  accessibility: [
    { id: 'lumen-a1', name: 'Keyboard caption editing', status: 'pass', detail: 'All fictional editing actions have tested keyboard alternatives.' },
    { id: 'lumen-a2', name: 'Screen-reader editor feedback', status: 'pass', detail: 'Synthetic checks verify labels, focus, and update announcements.' },
    { id: 'lumen-a3', name: 'Caption timing and sound labels', status: 'pass', detail: 'Synthetic captions include reviewed timing and non-speech sound labels.' },
  ],
  tradeoffs: [
    { id: 'lumen-tr1', name: 'Aggregated short-retention evaluation', privacyRisk: 20, fairnessVisibility: 80, description: 'Short-lived synthetic records and aggregate subgroup measures support review.', current: true },
    { id: 'lumen-tr2', name: 'Long-retention detailed diagnostics', privacyRisk: 65, fairnessVisibility: 90, description: 'More detailed synthetic diagnostics improve visibility while increasing record exposure.', current: false },
  ],
  synthetic: true,
};

export const modelCards = [atlasAssist, harborScreen, lumenCaption];
