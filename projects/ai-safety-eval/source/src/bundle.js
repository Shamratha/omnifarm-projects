import { createHash } from 'node:crypto';
import { scorecardCsv } from './workspace.js';

export const DETERMINISTIC_EVIDENCE_FILES = Object.freeze([
  'scorecard.json',
  'accounting.json',
  'case-evidence.json',
  'cases.csv',
  'summary.md',
  'reproduce.mjs',
]);

// This is deliberately an explicit project-only allowlist.  The bundle is a
// review artifact, so it must not accidentally become a copy of the checkout.
export const SOURCE_FILES = Object.freeze([
  'index.html',
  'styles.css',
  'favicon.svg',
  'server.js',
  'package.json',
  'package-lock.json',
  'README.md',
  'src/app.js',
  'src/bundle.js',
  'src/evaluation.js',
  'src/fixtures.js',
  'src/icons.js',
  'src/presentation.js',
  'src/workspace.js',
  'scripts/browser-check.js',
  'scripts/evidence-bundle.js',
  'scripts/scorecard.js',
  'scripts/verify-evidence.js',
  'tests/bundle.test.js',
  'tests/evaluation.test.js',
  'tests/presentation.test.js',
  'tests/scorecard.test.js',
  'tests/server.test.js',
  'tests/server.test.js',
  'tests/workspace.test.js',
]);

export const OPTIONAL_BUNDLE_FILES = Object.freeze([
  'screenshots/evidence-detail.png',
]);

export const REQUIRED_ARTIFACT_FILES = Object.freeze([
  'screenshots/matrix-desktop.png',
  'screenshots/matrix-mobile.png',
  'source/scorecard.json',
]);

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function assertScorecard(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) throw new TypeError('Evidence bundle requires a scorecard object.');
  if (report.schemaVersion !== 2) throw new TypeError('Evidence bundle requires a schema v2 scorecard.');
  for (const field of ['datasetId', 'baselineId', 'candidateId', 'scoring', 'summaries', 'comparisonSummary', 'comparisons', 'explanations', 'snapshot']) {
    if (!(field in report)) throw new TypeError(`Scorecard is missing ${field}.`);
  }
  if (!Array.isArray(report.comparisons) || !Array.isArray(report.explanations) || report.comparisons.length !== report.explanations.length) {
    throw new TypeError('Scorecard comparisons and explanations must be aligned arrays.');
  }
  if (!report.snapshot || report.snapshot.schemaVersion !== 1) throw new TypeError('Scorecard snapshot must be a schema v1 dataset.');
}

function statusOf(explanation) {
  return explanation.resultType === 'abstention'
    ? `abstention-${explanation.abstentionStatus}`
    : explanation.resultType;
}

function summaryLines(label, runId, summary) {
  return [
    `### ${label} \`${runId}\``,
    '',
    `- Score: **${summary.score}/100**`,
    `- Counts: ${summary.passed} ordinary passes + ${summary.failed} ordinary failures + ${summary.abstentions} abstentions (${summary.acceptedAbstentions} accepted, ${summary.rejectedAbstentions} rejected) + ${summary.missing} missing = ${summary.total} total.`,
    `- Credit partition: ${summary.creditedResponses} credited responses; ${summary.uncreditedResponses} uncredited responses; missing outputs are separate.`,
    `- Review coverage: ${summary.reviewed}/${summary.total} present responses annotated (${summary.coverage}%).`,
    `- Weights: ${summary.weightedPassed} ordinary-pass weight + ${summary.weightedAbstentions} accepted-abstention weight = ${summary.weightedEarned}/${summary.weightedTotal} earned/denominator.`,
    `- Contribution points: pass **${summary.contributions.pass.points}**, abstention **${summary.contributions.abstention.points}**, missing **${summary.contributions.missing.points}**.`,
    '',
  ];
}

function summaryMarkdown(report) {
  const baseline = report.summaries.baseline;
  const candidate = report.summaries.candidate;
  const comparison = report.comparisonSummary;
  const lines = [
    '# Guardrail evidence bundle',
    '',
    `Deterministic evidence for the fixed local dataset \`${report.datasetId}\`, comparing \`${report.baselineId}\` with \`${report.candidateId}\`. The scorecard is schema v${report.schemaVersion}; the input snapshot is dataset schema v${report.snapshot.schemaVersion}.`,
    '',
    'These core files describe authored fixed responses, not live model measurements. Fixed input timestamps and provenance seeds are preserved; no generation clock or randomness enters the deterministic core.',
    '',
    '## Accounting rules',
    '',
    '- Counts are disjoint: `passed + failed + abstentions + missing = total`.',
    '- `creditedResponses = passed + acceptedAbstentions`; `uncreditedResponses = failed + rejectedAbstentions`; missing is separate.',
    '- `weightedEarned = weightedPassed + weightedAbstentions`; contribution points use the full run denominator.',
    '- Review annotations affect coverage only. They do not affect automated outcomes or scores.',
    `- Severity weights: ${Object.entries(report.scoring.severityWeights).map(([severity, weight]) => `${severity} = ${weight}`).join(', ')}.`,
    `- Formula: \`${report.scoring.formula}\`.`,
    '- Scores round to two decimals after full-precision aggregation; contributions round to four decimals. Rounded case contributions are not summed to calculate scores.',
    '',
    ...summaryLines('Baseline', report.baselineId, baseline),
    ...summaryLines('Candidate', report.candidateId, candidate),
    '## Transitions',
    '',
    `- ${comparison.regressions} regressions`,
    `- ${comparison.improvements} improvements`,
    `- ${comparison.unchanged} unchanged`,
    `- ${comparison.incomparable} incomparable`,
    `- ${comparison.accountingChanges} transitions changed response accounting`,
    `- Score delta: ${comparison.deltas.score}; earned-weight delta: ${comparison.deltas.weightedEarned}.`,
    '',
    '| Case | Transition | Change | Accounting changed | Earned-weight delta | Pass-weight delta | Abstention-weight delta |',
    '| --- | --- | --- | --- | ---: | ---: | ---: |',
    ...report.comparisons.map((row) => `| ${String(row.prompt.id).replaceAll('|', '\\|').replaceAll('\n', ' ')} | ${row.transition} | ${row.change} | ${row.accountingChanged} | ${row.earnedWeightDelta ?? 'incomparable'} | ${row.contributionDelta.pass ?? 'incomparable'} | ${row.contributionDelta.abstention ?? 'incomparable'} |`),
    '',
    '## Known fixture limitation',
    '',
    `The candidate has ${candidate.reviewed}/${candidate.total} annotated responses. The ${candidate.reviewed} reviews are fixture reviews, not live measurements; all people, prompts, responses, failures, and annotations are synthetic authored examples.`,
    '',
    '## Reproduction',
    '',
    'Run `node reproduce.mjs` from this bundle. It recomputes the scorecard from `scorecard.snapshot` using the copied evaluation source, regenerates the deterministic core files, validates their bytes, and verifies the manifest.',
    '',
    '`checks.json` and `screenshots/` record an actual local verification run. They are hash-checked artifacts, not deterministically regenerated results, and are not claimed to be bit-identical across machines. Reproduction verifies those recorded artifacts; it does not rerun unit or browser checks.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function reproduceSource() {
  return `import { fileURLToPath } from 'node:url';
import { verifyEvidence } from './source/scripts/verify-evidence.js';

const bundleRoot = fileURLToPath(new URL('.', import.meta.url));
const result = await verifyEvidence(bundleRoot);
console.log(JSON.stringify({ ...result, reproduced: true }, null, 2));
`;
}

/**
 * Build only deterministic, report-derived files.  No filesystem, clock,
 * randomness, environment, or workspace state is consulted here.
 */
export function buildEvidenceFiles(report) {
  assertScorecard(report);
  const explanations = new Map(report.explanations.map((item) => [item.promptId, item]));
  const runById = new Map(report.snapshot.runs.map((run) => [run.id, run]));
  const caseEvidence = {
    schemaVersion: 1,
    datasetId: report.datasetId,
    baselineId: report.baselineId,
    candidateId: report.candidateId,
    context: {
      dataset: {
        schemaVersion: report.snapshot.schemaVersion,
        id: report.snapshot.id,
        name: report.snapshot.name,
        description: report.snapshot.description,
      },
      properties: report.snapshot.properties,
      categories: report.snapshot.categories,
      runs: [runById.get(report.baselineId), runById.get(report.candidateId)],
    },
    cases: report.comparisons.map((row) => {
      const explanation = explanations.get(row.prompt.id);
      if (!explanation) throw new TypeError(`Scorecard is missing an explanation for ${row.prompt.id}.`);
      return {
        prompt: row.prompt,
        baseline: {
          status: statusOf(explanation.baseline),
          evaluation: row.baseline,
          explanation: explanation.baseline,
          record: row.baseline.record,
        },
        candidate: {
          status: statusOf(explanation.candidate),
          evaluation: row.candidate,
          explanation: explanation.candidate,
          record: row.candidate.record,
        },
        transition: {
          change: row.change,
          transition: row.transition,
          accountingChanged: row.accountingChanged,
          earnedWeightDelta: row.earnedWeightDelta,
          contributionDelta: row.contributionDelta,
        },
      };
    }),
  };
  return {
    'scorecard.json': json(report),
    'accounting.json': json({
      scoring: report.scoring,
      baselineId: report.baselineId,
      candidateId: report.candidateId,
      summaries: report.summaries,
      comparisonSummary: report.comparisonSummary,
    }),
    'case-evidence.json': json(caseEvidence),
    'cases.csv': scorecardCsv(report),
    'summary.md': summaryMarkdown(report),
    'reproduce.mjs': reproduceSource(),
  };
}

function bytesFor(value) {
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value;
  throw new TypeError('Manifest content must be a string or Uint8Array.');
}

export function sha256(value) {
  return createHash('sha256').update(bytesFor(value)).digest('hex');
}

/** Create the manifest payload without including manifest.json itself. */
export function createManifest(files) {
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw new TypeError('Manifest files must be a mapping.');
  const entries = Object.entries(files)
    .filter(([relative]) => relative !== 'manifest.json')
    .map(([relative, content]) => {
      const bytes = bytesFor(content);
      return { path: relative, sha256: sha256(bytes), bytes: bytes.byteLength };
    })
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  if (entries.some(({ path }) => !path || !/^[\w./-]+$/u.test(path) || path.startsWith('/') || path.split('/').some((part) => part === '' || part === '.' || part === '..'))) {
    throw new TypeError('Manifest paths must be safe relative POSIX paths.');
  }
  if (new Set(entries.map(({ path }) => path)).size !== entries.length) throw new TypeError('Manifest paths must be unique.');
  return { schemaVersion: 1, complete: true, files: entries };
}
